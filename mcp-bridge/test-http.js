// test-http.js — HTTP MCP（streamable-http 多会话共享模式）冒烟测试
'use strict';
const { spawn } = require('child_process');

const WS_PORT = 19299;   // 扩展通道（测试用独立端口）
const MCP_PORT = 19298;  // HTTP MCP（测试用独立端口）
const BASE = `http://127.0.0.1:${MCP_PORT}/mcp`;

const bridge = spawn(process.execPath, ['chrome-bridge.js', '--http'], {
  stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, CHROME_BRIDGE_WS_PORT: String(WS_PORT), CHROME_BRIDGE_HTTP_PORT: String(MCP_PORT) },
});

async function post(body, headers = {}) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

(async () => {
  await new Promise(r => setTimeout(r, 1200)); // 等服务起来

  // 1. initialize → 应返回结果 + mcp-session-id 头
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  if (init.status !== 200 || !init.json.result) throw new Error('initialize 失败: ' + JSON.stringify(init.json));
  const sid = init.headers.get('mcp-session-id');
  if (!sid) throw new Error('缺少 mcp-session-id 头');
  console.log('[OK] initialize（session:', sid.slice(0, 8), '…）');

  // 2. tools/list（带会话头）→ 20 个工具
  const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': sid });
  const tools = list.json.result.tools;
  if (tools.length !== 20) throw new Error('工具数 ≠ 20: ' + tools.length);
  console.log('[OK] tools/list = 20 个工具');

  // 3. chrome_inbox（桥本地工具，无需扩展在线）
  const inbox = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'chrome_inbox', arguments: { action: 'list' } } }, { 'mcp-session-id': sid });
  if (!inbox.json.result) throw new Error('chrome_inbox 调用失败');
  console.log('[OK] chrome_inbox 本地工具可用');

  // 4. 未知工具 → -32602
  const bad = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  if (!bad.json.error || bad.json.error.code !== -32602) throw new Error('未知工具未正确报错');
  console.log('[OK] 未知工具返回 -32602');

  // 5. 纯 notification → 202 无响应体
  const notif = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  if (notif.status !== 202) throw new Error('notification 应返回 202: ' + notif.status);
  console.log('[OK] notification → 202');

  // 6. GET /mcp → 405
  const g = await fetch(BASE, { method: 'GET' });
  if (g.status !== 405) throw new Error('GET /mcp 应返回 405: ' + g.status);
  console.log('[OK] GET /mcp → 405（无 SSE，规范允许）');

  // 7. 第二个"会话"（无会话头 initialize）→ 也能独立工作（多会话并行）
  const init2 = await post({ jsonrpc: '2.0', id: 9, method: 'initialize', params: {} });
  const sid2 = init2.headers.get('mcp-session-id');
  if (!sid2 || sid2 === sid) throw new Error('第二个会话未获得独立 session id');
  console.log('[OK] 多会话并行：第二个会话独立初始化');

  bridge.kill();
  console.log('\n=== HTTP MCP 冒烟测试全部通过 ===');
  process.exit(0);
})().catch(e => { console.error('[X]', e.message); bridge.kill(); process.exit(1); });
