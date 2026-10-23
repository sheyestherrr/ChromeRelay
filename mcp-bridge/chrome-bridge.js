#!/usr/bin/env node
/**
 * chrome-bridge.js — 通用 "Claude in Chrome" 浏览器 MCP 桥（零依赖单文件）
 *
 * 用法：任何支持 stdio MCP 的 Agent 工具（DSH / Claude Code / Cursor / ...）添加：
 *   { "mcpServers": { "chrome": { "command": "node", "args": ["<path>/chrome-bridge.js"] } } }
 * 然后在 Chrome 开发者模式加载配套扩展即可。无需注册表、无需 native host、无需 Claude。
 *
 * 架构：
 *   Agent 工具 ←stdio(NDJSON JSON-RPC, MCP)→ 本桥 ←WebSocket ws://127.0.0.1:19288→ Chrome 扩展（service worker 拨出）
 *
 * 协议（与官方 native-host 通道同源，逆向自 claude.exe v2.1.162）：
 *   桥 → 扩展: {"type":"tool_request","method":"execute_tool","params":{"client_id","tool","args"}}
 *              {"type":"mcp_connected"}
 *   扩展 → 桥: {"type":"tool_response","result"|"error":...}
 *              {"type":"ping"} / {"type":"get_status"} / {"type":"notification",...}
 *
 * 环境变量：
 *   CHROME_BRIDGE_WS_PORT   WebSocket 监听端口（默认 19288）
 *   CHROME_BRIDGE_CALL_TIMEOUT_MS  单次工具调用超时（默认 150000）
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ------------------------------------------------------------ 配置
const WS_PORT = Number(process.env.CHROME_BRIDGE_WS_PORT || 19288);
const HTTP_MCP_PORT = Number(process.env.CHROME_BRIDGE_HTTP_PORT || 19289);
const CALL_TIMEOUT_MS = Number(process.env.CHROME_BRIDGE_CALL_TIMEOUT_MS || 150000);
const MAX_MSG = 32 * 1024 * 1024; // 截图类消息较大，放宽到 32MB
const TOOLS_FILE = path.join(__dirname, 'tools.json');
const LOG_FILE = path.join(__dirname, 'bridge.log');

function log(...args) {
  try {
    fs.appendFileSync(LOG_FILE,
      `[${new Date().toISOString()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`);
  } catch { }
}

// ------------------------------------------------------------ 工具清单
// CHROME_BRIDGE_TOOLS: 逗号分隔的工具白名单（精简工具数 / 排查严苛模型校验时用）
// CHROME_BRIDGE_SCHEMA_COMPAT: 默认开启；设 "0" 关闭。开启后清洗 schema 中易被严格校验拒绝的写法
const TOOL_WHITELIST = (process.env.CHROME_BRIDGE_TOOLS || '').split(',').map(s => s.trim()).filter(Boolean);
const SCHEMA_COMPAT = process.env.CHROME_BRIDGE_SCHEMA_COMPAT !== '0';

/**
 * 规范化 inputSchema —— 规则集（依据）：
 * tools.json 本身 100% 符合 MCP 规范（inputSchema 允许完整 JSON Schema 2020-12；
 * 官方 MCP SDK 只要求根 schema 为 {type:"object"}，properties/required 可选）。
 * 但 MCP 客户端会把 schema 转交给 LLM 供应商的 function-calling 校验器
 * （OpenAI tools / Anthropic tools / Gemini / 各中转网关），它们的接受子集不一。
 * 为保证"任何模型都可用"，向 MCP 客户端通告时统一收敛到各家校验器的交集子集：
 *   R1  根 schema 恒为 {type:"object"}
 *   R2  空 `properties: {}` 删除（部分校验器拒绝；缺省即"无参数"，规范允许）
 *   R3  空 `required: []` 删除（部分校验器拒绝）
 *   R4  仅保留安全关键字: type/properties/required/items/enum/description/additionalProperties；
 *       剔除 minItems/maxItems/minimum/maximum/minLength/maxLength/pattern/format/default/$ref/anyOf/oneOf/allOf/not
 *       （约束仍由扩展服务端执行，通告层删除不影响功能）
 *   R5  数组必须带 items（缺省补 {type:"string"} 占位无意义 → 补 {}）
 *   R6  裸 {type:"object"} 的 items/properties 子节点补 additionalProperties:true
 * 以上均为单向收敛，与具体模型无关；可用 CHROME_BRIDGE_SCHEMA_COMPAT=0 关闭。
 */
const SAFE_KEYS = new Set(['type', 'properties', 'required', 'items', 'enum', 'description', 'additionalProperties']);
function sanitizeSchema(node, isRoot) {
  if (Array.isArray(node)) return node.map((v) => sanitizeSchema(v, false));
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (!SAFE_KEYS.has(k)) continue;                                                  // R4
    if (k === 'required' && !Array.isArray(v)) continue;                              // R3b 剔除扩展按字段的 required:true/false 布尔标记（非法 JSON Schema）
    if (k === 'required' && v.length === 0) continue;                                 // R3
    if (k === 'properties' && v && typeof v === 'object' && Object.keys(v).length === 0) continue; // R2
    if (k === 'properties' && v && typeof v === 'object') {
      // 修复 tools.json 中参数被包成 {type,description} 形态的条目（R4 会剥掉 type/description）：
      // 在递归前剔除此类空占位属性，避免产出生硬的空 properties
      const cleaned = {};
      for (const [pk, pv] of Object.entries(v)) {
        if (pv && typeof pv === 'object' && !Array.isArray(pv)) {
          const sub = sanitizeSchema(pv, false);
          if (Object.keys(sub).length === 0) continue; // 空占位属性：剔除
          cleaned[pk] = sub;
        } else {
          cleaned[pk] = pv;
        }
      }
      if (Object.keys(cleaned).length === 0) continue; // 全部为空则整个 properties 省略
      out[k] = cleaned;
      continue;
    }
    out[k] = sanitizeSchema(v, false);
  }
  if (isRoot) out.type = 'object';                                                    // R1
  if (out.type === 'array' && !out.items) out.items = {};                             // R5
  if (out.type === 'object' && !out.properties && !isRoot && out.additionalProperties === undefined) {
    out.additionalProperties = true;                                                  // R6
  }
  return out;
}

function loadTools() {
  let tools = null;
  try {
    const t = JSON.parse(fs.readFileSync(TOOLS_FILE, 'utf-8'));
    if (Array.isArray(t) && t.length) tools = t;
  } catch (e) { log('tools.json 读取失败, 使用内置最小集:', e.message); }
  if (!tools) {
    tools = [
      { name: 'navigate', description: 'Navigate a browser tab to a URL.', inputSchema: { type: 'object', properties: { url: { type: 'string' }, tabId: { type: 'number' } }, required: ['url'] } },
      { name: 'tabs_context_mcp', description: 'Get context information about all tabs in the current tab group', inputSchema: { type: 'object', properties: {}, required: [] } },
      { name: 'get_page_text', description: 'Get the text content of the current page.', inputSchema: { type: 'object', properties: {}, required: [] } },
      { name: 'computer', description: 'Use a mouse and keyboard to interact with a web browser, and take screenshots.', inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } },
    ];
  }
  if (TOOL_WHITELIST.length) {
    tools = tools.filter(t => TOOL_WHITELIST.includes(t.name));
    log('工具白名单生效:', TOOL_WHITELIST.join(','), '→', tools.length, '个');
  }
  if (SCHEMA_COMPAT) {
    tools = tools.map(t => ({ ...t, inputSchema: sanitizeSchema(t.inputSchema || { type: 'object' }, true) }));
  }
  return tools;
}
const TOOLS = loadTools();

// ------------------------------------------------------------ Agent 收件箱（浏览器 → Agent 推送通道）
// 用户在 Chrome 里通过①页面右键"发送到 Agent"②侧边栏"⤴ 推送到 Agent"按钮，
// 把网页内容/侧边栏对话全文经 WS 推送到这里；Agent 用 chrome_inbox 工具拉取。
const INBOX_FILE = path.join(__dirname, 'inbox.jsonl');
const INBOX_MAX = Number(process.env.CHROME_BRIDGE_INBOX_MAX || 1000);
let inbox = [];
let inboxSeq = 0;
try { // 启动时从 JSONL 恢复（桥重启不丢推送）
  const lines = fs.readFileSync(INBOX_FILE, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines.slice(-INBOX_MAX)) {
    try {
      const it = JSON.parse(line);
      if (it && typeof it.id === 'number') { inbox.push(it); inboxSeq = Math.max(inboxSeq, it.id); }
    } catch { }
  }
  if (inbox.length) log('收件箱恢复', inbox.length, '条');
} catch { }

function inboxPersist() {
  try { fs.writeFileSync(INBOX_FILE, inbox.map(i => JSON.stringify(i)).join('\n') + (inbox.length ? '\n' : '')); } catch { }
}

function inboxPush(p) {
  const item = {
    id: ++inboxSeq,
    ts: Number(p.ts) || Date.now(),
    source: String(p.source || 'unknown').slice(0, 30),
    title: String(p.title || '').slice(0, 300),
    url: String(p.url || '').slice(0, 1000),
    text: String(p.text || '').slice(0, 400 * 1024),
  };
  inbox.push(item);
  if (inbox.length > INBOX_MAX) inbox.splice(0, inbox.length - INBOX_MAX);
  inboxPersist();
  log('收件箱新条目 #' + item.id, '[' + item.source + ']', item.title, item.text.length + '字');
  try { // 提醒 MCP 客户端（DSH 等会以日志通知形式呈现）
    send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', logger: 'chrome-bridge', data: `浏览器收件箱收到新内容 #${item.id}（${item.source}）：${item.title} —— 用 chrome_inbox 工具读取` } });
  } catch { }
  return item;
}

const INBOX_TOOL = {
  name: 'chrome_inbox',
  description: '读取"浏览器收件箱"：用户在 Chrome 里主动推送的内容（网页右键"发送到 Agent"的页面/选中内容、侧边栏"推送到 Agent"按钮发来的完整 AI 对话记录）。action=list 列出条目；action=read 读取（给 id 读指定条目，id=0 读全部，缺省读最新一条）；action=clear 清空（可只删指定 id）。',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'read', 'clear'], description: 'list=列表（默认）, read=读取内容, clear=清空' },
      id: { type: 'number', description: '条目 id。read 时：缺省=最新一条，0=全部；clear 时：给 id 只删该条' },
    },
    required: ['action'],
  },
};
TOOLS.push(INBOX_TOOL);

function handleInbox(args) {
  const action = (args && args.action) || 'list';
  const fmtHead = (it) => `#${it.id} [${it.source}] ${new Date(it.ts).toLocaleString()} — ${it.title}（${it.text.length} 字）${it.url ? '\n  链接: ' + it.url : ''}`;
  if (action === 'list') {
    if (!inbox.length) return { content: [{ type: 'text', text: '收件箱为空。用户可在 Chrome 网页上右键"发送到 Agent"，或在扩展侧边栏点"⤴ 推送到 Agent"（可推送侧边栏 AI 对话全文）。' }] };
    return { content: [{ type: 'text', text: `收件箱共 ${inbox.length} 条（旧→新）：\n` + inbox.map(fmtHead).join('\n') + '\n\n用 chrome_inbox {action:"read"} 读取最新一条，{action:"read", id:N} 读指定条目。' }] };
  }
  if (action === 'read') {
    let items;
    if (args && args.id === 0) items = inbox;
    else if (args && typeof args.id === 'number') items = inbox.filter(i => i.id === args.id);
    else items = inbox.slice(-1);
    if (!items.length) return { content: [{ type: 'text', text: '没有匹配的收件箱条目。' }], isError: true };
    const text = items.map(it => `#${it.id} [${it.source}] ${new Date(it.ts).toLocaleString()}\n标题: ${it.title}\n链接: ${it.url}\n\n${it.text}`).join('\n\n=====\n\n');
    return { content: [{ type: 'text', text }] };
  }
  if (action === 'clear') {
    if (args && typeof args.id === 'number') inbox = inbox.filter(i => i.id !== args.id);
    else inbox = [];
    inboxPersist();
    return { content: [{ type: 'text', text: '收件箱已清空。' }] };
  }
  return { content: [{ type: 'text', text: '未知 action: ' + action + '（可用 list/read/clear）' }], isError: true };
}

const TOOL_SET = new Set(TOOLS.map(t => t.name));

// ------------------------------------------------------------ 迷你 WebSocket 服务器（RFC6455，零依赖）
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** 从 socket 数据缓冲中解析 WS 帧；返回 {frames, rest}。帧: {fin, opcode, payload} */
function wsParse(buf) {
  const frames = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off], b1 = buf[off + 1];
    const fin = !!(b0 & 0x80), opcode = b0 & 0x0f;
    const masked = !!(b1 & 0x80);
    let len = b1 & 0x7f, p = off + 2;
    if (len === 126) { if (buf.length - off < 4) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length - off < 10) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    if (len > MAX_MSG) throw new Error('WS frame too large');
    const maskLen = masked ? 4 : 0;
    if (buf.length - p < maskLen + len) break;
    let payload = buf.subarray(p + maskLen, p + maskLen + len);
    if (masked) {
      const mask = buf.subarray(p, p + 4);
      const un = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i & 3];
      payload = un;
    }
    frames.push({ fin, opcode, payload });
    off = p + maskLen + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/** 构造服务器→客户端帧（不掩码） */
function wsFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.from([0x80 | opcode, len]); }
  else if (len < 65536) { head = Buffer.allocUnsafe(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.allocUnsafe(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

// ------------------------------------------------------------ 扩展连接管理（多客户端）
// 扩展侧可能有两个上下文同时在线：service worker（工具执行者，会发 get_status）
// 和侧边栏 ccpp-push.js（只推送 inbox_push）。角色用首条 get_status 自动识别。
class ExtensionConn {
  constructor() {
    this.clients = new Map(); // sock -> { role: 'unknown'|'sw'|'push', fragBuf: [] }
    this.pending = null;      // {resolve, reject, timer} 单未决请求（与官方一致）
    this.queue = Promise.resolve();
    this.onNotification = null;
  }

  get connected() { return this.primary() != null; }

  primary() { // 工具执行目标：service worker
    for (const [sock, c] of this.clients) {
      if (c.role === 'sw' && !sock.destroyed) return sock;
    }
    return null;
  }

  attach(sock) {
    const client = { role: 'unknown', fragBuf: [] };
    this.clients.set(sock, client);
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let parsed;
      try { parsed = wsParse(buf); } catch (e) { log('WS 解析错误:', e.message); sock.destroy(); return; }
      buf = parsed.rest;
      for (const f of parsed.frames) this.onFrame(sock, client, f);
    });
    const bye = () => {
      if (this.clients.delete(sock)) {
        log('扩展 WS 断开（剩余客户端:', this.clients.size, '）');
        if (client.role === 'sw' && this.pending) {
          const p = this.pending; this.pending = null; clearTimeout(p.timer);
          p.reject(new Error('扩展 WebSocket 断开（Chrome/扩展已关闭？）'));
        }
      }
    };
    sock.on('close', bye);
    sock.on('error', (e) => { log('扩展 WS 错误:', e.message); bye(); });
    this.sendTo(sock, { type: 'mcp_connected' });
    log('扩展客户端接入（当前共', this.clients.size, '个连接）');
  }

  onFrame(sock, client, f) {
    if (f.opcode === 0x8) { try { sock.end(wsFrame(0x8, Buffer.alloc(0))); } catch { } return; } // close
    if (f.opcode === 0x9) { try { sock.write(wsFrame(0xA, f.payload)); } catch { } return; }   // ping→pong
    if (f.opcode === 0xA) return;                                                            // pong
    if (f.opcode === 0x1 || f.opcode === 0x2) { client.fragBuf = [f.payload]; }
    else if (f.opcode === 0x0) { client.fragBuf.push(f.payload); }
    else return;
    if (!f.fin) return;
    const full = Buffer.concat(client.fragBuf);
    client.fragBuf = [];
    let msg;
    try { msg = JSON.parse(full.toString('utf-8')); } catch (e) { log('扩展消息 JSON 解析失败:', e.message); return; }
    this.onMessage(sock, client, msg);
  }

  onMessage(sock, client, msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'ping':
        this.sendTo(sock, { type: 'pong', timestamp: Date.now() });
        return;
      case 'get_status':
        if (client.role !== 'sw') { client.role = 'sw'; log('识别到 service worker（工具执行通道就绪）'); }
        this.sendTo(sock, { type: 'status_response', native_host_version: '1.0.0' });
        return;
      case 'tool_response': {
        const { type, ...rest } = msg;
        if (this.pending) { const p = this.pending; this.pending = null; clearTimeout(p.timer); p.resolve(rest); }
        else log('收到无主的 tool_response:', JSON.stringify(rest).slice(0, 200));
        return;
      }
      case 'notification':
        log('扩展通知:', msg.method, JSON.stringify(msg.params || {}).slice(0, 300));
        if (this.onNotification) { try { this.onNotification({ method: msg.method, params: msg.params }); } catch { } }
        return;
      case 'inbox_push': {
        if (client.role === 'unknown') client.role = 'push';
        const item = inboxPush(msg.payload || {});
        this.sendTo(sock, { type: 'inbox_ack', id: item.id });
        return;
      }
      default:
        log('扩展未知消息:', msg.type);
    }
  }

  sendTo(sock, obj) {
    if (!sock || sock.destroyed) return false;
    const body = Buffer.from(JSON.stringify(obj), 'utf-8');
    try { sock.write(wsFrame(0x1, body)); return true; } catch (e) { log('WS 发送失败:', e.message); return false; }
  }

  send(obj) { return this.sendTo(this.primary(), obj); } // 工具请求只发 service worker

  callTool(tool, args) {
    // 串行化（官方客户端同为单未决请求设计）；上一个请求失败不得毒化队列
    const run = () => this._callOnce(tool, args);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => { });
    return p;
  }

  async _callOnce(tool, args) {
    if (!this.connected) throw new Error('Chrome 扩展尚未连接——请确认扩展已加载且已重载（ws://127.0.0.1:' + WS_PORT + '）');
    if (this.pending) throw new Error('内部错误: 存在未完成的请求');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`工具 ${tool} 调用超时——扩展可能在等待权限确认，请检查侧边栏`));
      }, CALL_TIMEOUT_MS);
      this.pending = { resolve, reject, timer };
      const ok = this.send({ type: 'tool_request', method: 'execute_tool', params: { client_id: 'mcp-bridge', tool, args: args || {} } });
      if (!ok) { clearTimeout(timer); this.pending = null; reject(new Error('扩展连接已断开')); }
    });
  }
}

const ext = new ExtensionConn();

// ------------------------------------------------------------ HTTP 服务（仅用于 WS upgrade：扩展专用通道）
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('chrome-bridge WebSocket server (extension channel). Connect via ws:// with Upgrade header.\n');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`);
  socket.setNoDelay(true);
  ext.attach(socket);
});

let role = 'undecided'; // 'master' | 'worker'
const queue = [];

function probePrimary() {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: HTTP_MCP_PORT,
      path: '/mcp',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      timeout: 1500
    }, (res) => {
      resolve(res.statusCode === 200 || res.statusCode === 202);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }));
    req.end();
  });
}

server.on('error', (e) => {
  log('WS 服务器错误:', e.message);
  if (e.code === 'EADDRINUSE') {
    const isExplicitHttp = process.argv.includes('--http') || process.env.CHROME_BRIDGE_HTTP === '1';
    if (isExplicitHttp) {
      log(`WS 端口 ${WS_PORT} 暂被占用——5s 后重试接管`);
      setTimeout(() => { try { server.listen(WS_PORT, '127.0.0.1'); } catch { } }, 5000);
      return;
    }
    // stdio 默认模式：端口被占，探测已有主桥以切换为透明代理模式
    probePrimary().then((alive) => {
      if (alive) {
        role = 'worker';
        log(`[chrome-bridge] 主桥运行中，当前进程自动切换为 stdio 透明中继模式 (Worker)`);
        drainQueue();
      } else {
        process.stderr.write(`[chrome-bridge] 端口 ${WS_PORT} 已被占用，且主桥不可达。\n`);
        process.exit(1);
      }
    });
    return;
  }
});

server.listen(WS_PORT, '127.0.0.1', () => {
  log(`WS 服务器已监听 ws://127.0.0.1:${WS_PORT}`);
  role = 'master';
  startHttpServer();
  drainQueue();
});

// ------------------------------------------------------------ MCP 结果映射
function toMcpResult(resp) {
  if (resp && typeof resp === 'object' && 'error' in resp && resp.error != null) {
    const e = resp.error;
    const text = typeof e === 'string' ? e : (Array.isArray(e.content) ? e.content.map(b => b && b.text || JSON.stringify(b)).join('\n') : JSON.stringify(e));
    return { content: [{ type: 'text', text }], isError: true };
  }
  let result = resp && typeof resp === 'object' && 'result' in resp ? resp.result : resp;
  if (result == null) return { content: [{ type: 'text', text: 'Tool execution completed' }] };
  const content = result.content;
  if (Array.isArray(content)) {
    const blocks = content.map((b) => {
      if (b && typeof b === 'object' && b.type === 'image' && b.source && b.source.data) {
        return { type: 'image', data: b.source.data, mimeType: b.source.media_type || 'image/png' };
      }
      if (b && typeof b === 'object' && 'type' in b) return b;
      return { type: 'text', text: typeof b === 'string' ? b : JSON.stringify(b) };
    });
    return { content: blocks, ...(result.isError ? { isError: true } : {}) };
  }
  if (typeof result === 'string') return { content: [{ type: 'text', text: result }] };
  if (typeof result === 'object' && typeof result.output === 'string') return { content: [{ type: 'text', text: result.output }] };
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

// ------------------------------------------------------------ stdio MCP server (NDJSON JSON-RPC)
const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function rpcResult(id, result) { send({ jsonrpc: '2.0', id, result }); }
function rpcError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

ext.onNotification = ({ method, params }) => {
  send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', logger: 'chrome-bridge', data: { method, params } } });
};

// ------------------------------------------------------------ 共享处理器（stdio 与 HTTP MCP 共用）
function buildInitResult(params) {
  return {
    protocolVersion: (params && params.protocolVersion) || '2024-11-05',
    capabilities: { tools: {} },
    serverInfo: { name: 'chrome-bridge', version: '2.2.0' },
    instructions: '本服务器提供 Chrome 浏览器工具（导航/点击/截图/读页面等，操作前先用 tabs_context_mcp 或 tabs_create_mcp 确认标签组）。另有"浏览器收件箱"：用户可在 Chrome 网页右键"发送到 Agent"推送页面/选中内容，或在扩展侧边栏点"⤴ 推送到 Agent"推送侧边栏 AI 对话的完整记录；当用户提到"浏览器发来的/推送的/收件箱里的内容"，或要求整理浏览器侧 AI 的产出（如总结、笔记）时，先用 chrome_inbox 工具（action=list/read）读取再处理。',
  };
}

function buildToolsListResult() {
  return {
    tools: TOOLS.map(t => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object' },
    })),
  };
}

async function callToolResult(params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  if (name === 'chrome_inbox') return handleInbox(args); // 桥本地工具，不转发扩展
  try {
    const resp = await ext.callTool(name, args);
    return toMcpResult(resp);
  } catch (e) {
    return { content: [{ type: 'text', text: `桥接错误: ${e.message}` }], isError: true };
  }
}

// ------------------------------------------------------------ HTTP MCP 内部端点（供透明中继与外部调用）
const mcpSessions = new Set();
let mcpHttp = null;

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

async function dispatchRpc(m) {
  try {
    switch (m.method) {
      case 'initialize': return { jsonrpc: '2.0', id: m.id, result: buildInitResult(m.params) };
      case 'ping': return { jsonrpc: '2.0', id: m.id, result: {} };
      case 'tools/list': return { jsonrpc: '2.0', id: m.id, result: buildToolsListResult() };
      case 'tools/call': {
        const name = m.params && m.params.name;
        if (!name) return { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: '缺少工具名' } };
        if (!TOOL_SET.has(name)) return { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `未知工具: ${name}` } };
        return { jsonrpc: '2.0', id: m.id, result: await callToolResult(m.params) };
      }
      case 'resources/list': return { jsonrpc: '2.0', id: m.id, result: { resources: [] } };
      case 'prompts/list': return { jsonrpc: '2.0', id: m.id, result: { prompts: [] } };
      default: return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `方法不存在: ${m.method}` } };
    }
  } catch (e) {
    return { jsonrpc: '2.0', id: m.id, error: { code: -32603, message: String((e && e.message) || e) } };
  }
}

function startHttpServer() {
  if (mcpHttp) return;
  mcpHttp = http.createServer(async (req, res) => {
    try {
      const url = (req.url || '').split('?')[0];
      if (url !== '/mcp' && url !== '/mcp/') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('chrome-bridge HTTP MCP endpoint: POST /mcp\n');
      }
      if (req.method === 'GET') {
        res.writeHead(405, { allow: 'POST, DELETE' });
        return res.end();
      }
      if (req.method === 'DELETE') {
        const sid = req.headers['mcp-session-id'];
        if (sid) mcpSessions.delete(sid);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{}');
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST, DELETE' });
        return res.end();
      }
      const raw = await readBody(req, 32 * 1024 * 1024);
      let payload;
      try { payload = JSON.parse(raw); } catch { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } })); }
      const isBatch = Array.isArray(payload);
      const list = isBatch ? payload : [payload];
      const responses = [];
      let newSession = null;
      for (const m of list) {
        if (!m || m.id === undefined || m.id === null) continue; // notification: 202 无响应体
        const resp = await dispatchRpc(m);
        if (m.method === 'initialize' && !resp.error) {
          newSession = crypto.randomUUID();
          mcpSessions.add(newSession);
          log('HTTP MCP 新会话:', newSession, '（当前', mcpSessions.size, '个）');
        }
        responses.push(resp);
      }
      if (!responses.length) { res.writeHead(202); return res.end(); }
      const headers = { 'content-type': 'application/json' };
      const sid = newSession || req.headers['mcp-session-id'];
      if (sid) headers['mcp-session-id'] = sid;
      res.writeHead(200, headers);
      res.end(JSON.stringify(isBatch ? responses : responses[0]));
    } catch (e) {
      log('HTTP MCP 处理异常:', e.message);
      try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: String(e.message || e) } })); } catch { }
    }
  });

  mcpHttp.on('error', (e) => {
    log('HTTP MCP 服务器错误:', e.message);
    if (e.code === 'EADDRINUSE') {
      log(`[chrome-bridge] HTTP MCP 端口 ${HTTP_MCP_PORT} 被占用`);
    }
  });

  mcpHttp.listen(HTTP_MCP_PORT, '127.0.0.1', () => {
    log(`HTTP MCP 已监听 http://127.0.0.1:${HTTP_MCP_PORT}/mcp（供从桥透明中继）`);
  });
}

// 显式 --http 参数时直接开启 HTTP 服务
if (process.argv.includes('--http') || process.env.CHROME_BRIDGE_HTTP === '1') {
  startHttpServer();
}

// ------------------------------------------------------------ 消息分发（主桥直连 / 从桥透明中继）
const handlers = {
  initialize(id, params) {
    rpcResult(id, buildInitResult(params));
  },

  'tools/list'(id) {
    rpcResult(id, buildToolsListResult());
  },

  async 'tools/call'(id, params) {
    const name = params && params.name;
    if (!name) return rpcError(id, -32602, '缺少工具名');
    if (!TOOL_SET.has(name)) return rpcError(id, -32602, `未知工具: ${name}`);
    rpcResult(id, await callToolResult(params));
  },

  ping(id) { rpcResult(id, {}); },
  'resources/list'(id) { rpcResult(id, { resources: [] }); },
  'prompts/list'(id) { rpcResult(id, { prompts: [] }); },
};

function dispatchMasterLine(line) {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { log('无法解析的 stdin 行:', t.slice(0, 200)); return; }
  if (msg.id === undefined || msg.id === null) return; // notification
  const h = handlers[msg.method];
  if (!h) return rpcError(msg.id, -32601, `方法不存在: ${msg.method}`);
  Promise.resolve(h(msg.id, msg.params)).catch((e) => {
    log('handler 异常:', e.message);
    try { rpcError(msg.id, -32603, e.message); } catch { }
  });
}

let workerSessionId = null;
let isPromoting = false;

function tryPromote() {
  return new Promise((resolve) => {
    try {
      server.listen(WS_PORT, '127.0.0.1', () => {
        role = 'master';
        startHttpServer();
        resolve(true);
      });
      server.once('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

function dispatchWorkerLine(line) {
  const t = line.trim();
  if (!t) return;
  let parsed;
  try { parsed = JSON.parse(t); } catch { return; }
  const isNotification = parsed && (parsed.id === undefined || parsed.id === null);

  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(t)
  };
  if (workerSessionId) headers['mcp-session-id'] = workerSessionId;

  const req = http.request({
    host: '127.0.0.1',
    port: HTTP_MCP_PORT,
    path: '/mcp',
    method: 'POST',
    headers,
    timeout: CALL_TIMEOUT_MS
  }, (res) => {
    const sid = res.headers['mcp-session-id'];
    if (sid) workerSessionId = Array.isArray(sid) ? sid[0] : sid;

    if (res.statusCode === 200) {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8').trim();
        if (body) process.stdout.write(body + '\n');
      });
    } else if (!isNotification && parsed.id != null) {
      rpcError(parsed.id, -32603, `主桥返回状态码: ${res.statusCode}`);
    }
  });

  req.on('error', (err) => {
    log('Worker 转发异常:', err.message);
    if (!isPromoting) {
      isPromoting = true;
      tryPromote().then((promoted) => {
        isPromoting = false;
        if (promoted) {
          log('Worker 成功晋升为主桥 (Master)');
          dispatchMasterLine(line);
        } else if (!isNotification && parsed.id != null) {
          rpcError(parsed.id, -32603, `主桥通信失败: ${err.message}`);
        }
      });
      return;
    }
    if (!isNotification && parsed.id != null) {
      rpcError(parsed.id, -32603, `主桥通信失败: ${err.message}`);
    }
  });

  req.on('timeout', () => {
    req.destroy();
    if (!isNotification && parsed.id != null) {
      rpcError(parsed.id, -32603, '工具调用超时');
    }
  });

  req.write(t);
  req.end();
}

function dispatchLine(line) {
  if (role === 'undecided') {
    queue.push(line);
  } else if (role === 'master') {
    dispatchMasterLine(line);
  } else if (role === 'worker') {
    dispatchWorkerLine(line);
  }
}

function drainQueue() {
  while (queue.length > 0) {
    const l = queue.shift();
    if (role === 'master') dispatchMasterLine(l);
    else if (role === 'worker') dispatchWorkerLine(l);
  }
}

rl.on('line', dispatchLine);
rl.on('close', () => process.exit(0));

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

log('=== chrome-bridge v2.0 启动 ===', 'ws =', WS_PORT, 'tools =', TOOLS.length);
