// test-loopback.js — 无 Chrome 的全链路自测（独立端口，避免与运行中的桥冲突）
// 模拟：Agent(stdio MCP) ←→ chrome-bridge ←WS→ 假扩展
'use strict';
const { spawn } = require('child_process');

const PORT = 19299;
const bridge = spawn(process.execPath, ['chrome-bridge.js'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, CHROME_BRIDGE_WS_PORT: String(PORT) },
});
let mcpOut = '';
bridge.stdout.on('data', d => { mcpOut += d.toString(); });

function sendRpc(obj) { bridge.stdin.write(JSON.stringify(obj) + '\n'); }
function waitFor(pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error('超时: ' + label)); }
    }, 50);
  });
}

(async () => {
  // 1. initialize + tools/list
  sendRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  sendRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await waitFor(() => mcpOut.includes('"id":2'), 5000, 'initialize/tools/list');
  const toolCount = (mcpOut.match(/"name":"/g) || []).length;
  console.log(`[OK] MCP 握手 + tools/list（约 ${toolCount} 个名字段）`);

  // 2. 工具调用（扩展未连接 → 应返回明确错误）
  sendRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tabs_context_mcp', arguments: {} } });
  await waitFor(() => mcpOut.includes('"id":3'), 5000, '无扩展时的错误路径');
  console.log('[OK] 无扩展时 tools/call 返回错误提示:', /尚未连接/.test(mcpOut) ? '文案正确' : '（检查文案）');

  // 3. 假扩展接入（Node 内置 WebSocket 客户端）
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const got = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    got.push(m);
    if (m.type === 'tool_request') {
      // 假扩展执行并回 tool_response
      ws.send(JSON.stringify({
        type: 'tool_response',
        result: { content: [{ type: 'text', text: JSON.stringify({ currentTabId: 42, availableTabs: [{ id: 42, title: 'LoopbackTest', url: 'https://example.com' }], tabCount: 1 }) }] },
      }));
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  await waitFor(() => got.some(m => m.type === 'mcp_connected'), 5000, 'mcp_connected');
  console.log('[OK] 扩展接入后收到 mcp_connected');

  // 4. ping/get_status 应答
  ws.send(JSON.stringify({ type: 'ping' }));
  ws.send(JSON.stringify({ type: 'get_status' }));
  await waitFor(() => got.some(m => m.type === 'pong') && got.some(m => m.type === 'status_response'), 5000, 'pong/status_response');
  console.log('[OK] ping→pong、get_status→status_response');

  // 5. 工具调用全链路：MCP → 桥 → 假扩展 → 回包 → MCP
  sendRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tabs_context_mcp', arguments: {} } });
  await waitFor(() => mcpOut.includes('"id":4') && mcpOut.includes('LoopbackTest'), 8000, '全链路调用');
  console.log('[OK] tools/call 全链路回环成功（假扩展数据已返回到 MCP 层）');

  // 5b. 多客户端共存：模拟侧边栏 ccpp-push 第二个连接——不得顶掉 SW 通道
  const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const got2 = [];
  let ws1Closed = false;
  ws.onclose = () => { ws1Closed = true; };
  ws2.onmessage = (ev) => got2.push(JSON.parse(ev.data));
  await new Promise((res, rej) => { ws2.onopen = res; ws2.onerror = rej; });
  await waitFor(() => got2.some(m => m.type === 'mcp_connected'), 5000, '第二客户端 mcp_connected');
  await new Promise(r => setTimeout(r, 800));
  if (ws1Closed) throw new Error('多客户端接入时 SW 通道被错误顶掉');
  console.log('[OK] 多客户端共存：SW 通道未被顶掉');

  // 5c. 工具请求仍只路由到 SW（ws1）
  sendRpc({ jsonrpc: '2.0', id: 45, method: 'tools/call', params: { name: 'tabs_context_mcp', arguments: {} } });
  await waitFor(() => mcpOut.includes('"id":45') && mcpOut.includes('LoopbackTest'), 8000, '多客户端下的工具路由');
  if (got2.some(m => m.type === 'tool_request')) throw new Error('tool_request 错误地发到了 push 客户端');
  console.log('[OK] 工具请求正确路由到 SW（push 客户端未收到 tool_request）');

  // 6. 收件箱：第二客户端（侧边栏模拟）推送 inbox_push → 桥回 ack → MCP 端 list/read/clear
  ws2.send(JSON.stringify({ type: 'inbox_push', payload: { title: '测试文章', url: 'https://example.com/a', text: '这是正文内容ABC', source: 'sidepanel', ts: Date.now() } }));
  await waitFor(() => got2.some(m => m.type === 'inbox_ack' && m.id >= 1), 5000, 'inbox_ack');
  console.log('[OK] 侧边栏推送收到 inbox_ack（ack 回到了正确的客户端）');

  sendRpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'chrome_inbox', arguments: { action: 'list' } } });
  await waitFor(() => mcpOut.includes('"id":5') && mcpOut.includes('测试文章'), 5000, 'inbox list');
  console.log('[OK] chrome_inbox list 列出推送条目');

  sendRpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'chrome_inbox', arguments: { action: 'read' } } });
  await waitFor(() => mcpOut.includes('"id":6') && mcpOut.includes('这是正文内容ABC'), 5000, 'inbox read');
  console.log('[OK] chrome_inbox read 读到全文');

  sendRpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'chrome_inbox', arguments: { action: 'clear' } } });
  await waitFor(() => mcpOut.includes('"id":7') && mcpOut.includes('已清空'), 5000, 'inbox clear');
  console.log('[OK] chrome_inbox clear 清空');

  ws.close();
  ws2.close();
  bridge.kill();
  console.log('\n=== 全部通过 ===');
  process.exit(0);
})().catch(e => { console.error('[X]', e.message); bridge.kill(); process.exit(1); });
