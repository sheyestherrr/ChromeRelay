// test-e2e.js — 真实端到端测试：等待真扩展接入，然后调用 tabs_context_mcp 拿真实标签页
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');

const LOG = require('path').join(__dirname, 'bridge.log');
try { fs.writeFileSync(LOG, ''); } catch { }

const bridge = spawn(process.execPath, ['chrome-bridge.js'], { stdio: ['pipe', 'pipe', 'inherit'] });
let mcpOut = '';
bridge.stdout.on('data', d => { mcpOut += d.toString(); });
const sendRpc = (o) => bridge.stdin.write(JSON.stringify(o) + '\n');

function waitFor(pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      let ok = false;
      try { ok = pred(); } catch { }
      if (ok) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error('超时: ' + label)); }
    }, 200);
  });
}

(async () => {
  sendRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } });
  await waitFor(() => mcpOut.includes('"id":1'), 5000, 'initialize');
  console.log('[OK] 桥已启动，WS 监听 ws://127.0.0.1:19288');
  console.log('[..] 等待真实扩展接入…… 请现在到 chrome://extensions 点"重新加载" Claude 扩展（180 秒窗口）');

  await waitFor(() => {
    try { return fs.readFileSync(LOG, 'utf-8').includes('扩展已通过 WebSocket 连接'); } catch { return false; }
  }, 180000, '等待扩展接入');
  console.log('[OK] 扩展已接入！');

  await new Promise(r => setTimeout(r, 1500)); // 等 mcp_connected 状态就位
  sendRpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tabs_context_mcp', arguments: {} } });
  await waitFor(() => mcpOut.includes('"id":2'), 60000, 'tabs_context_mcp 调用');
  const line = mcpOut.split('\n').find(l => l.includes('"id":2'));
  console.log('[OK] 真实浏览器数据返回:');
  console.log(line.slice(0, 1200));

  bridge.kill();
  console.log('\n=== 端到端测试通过 ===');
  process.exit(0);
})().catch(e => { console.error('[X]', e.message); bridge.kill(); process.exit(1); });
