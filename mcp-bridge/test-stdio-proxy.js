// test-stdio-proxy.js — 验证多会话 stdio 自动透明代理与主从晋升
// 1. 启动 Bridge A (stdio Master, 占 19294 WS + 19295 HTTP)
// 2. 启动 Bridge B (stdio Worker, 发现 19294 被占，自动转为透明代理)
// 3. 验证 Bridge B 通过 stdio 进行 MCP initialize / tools/list / tools/call
// 4. 杀死 Bridge A，验证 Bridge B 自动晋升为主桥并继续工作
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const assert = require('assert');

const node = process.execPath;
const bridgeScript = path.join(__dirname, 'chrome-bridge.js');

const env = {
  ...process.env,
  CHROME_BRIDGE_WS_PORT: '19294',
  CHROME_BRIDGE_HTTP_PORT: '19295'
};

function createStdioClient(proc) {
  const rl = readline.createInterface({ input: proc.stdout, terminal: false });
  const pending = new Map();
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    try {
      const msg = JSON.parse(t);
      if (msg.id != null && pending.has(msg.id)) {
        const resolve = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch {}
  });

  let idCounter = 1;
  return {
    send(method, params = {}) {
      const id = idCounter++;
      return new Promise((resolve, reject) => {
        pending.set(id, resolve);
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`调用 ${method} 超时 (id=${id})`));
          }
        }, 5000);
      });
    }
  };
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('--- 步骤 1: 启动 Bridge A (Master) ---');
  const procA = spawn(node, [bridgeScript], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const clientA = createStdioClient(procA);
  await wait(800);

  const initA = await clientA.send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'session-1', version: '1.0' } });
  assert.strictEqual(initA.result?.serverInfo?.name, 'chrome-bridge', 'Bridge A 应正常初始化');
  console.log('[OK] Bridge A (Master) stdio 初始化成功');

  const toolsA = await clientA.send('tools/list');
  assert.strictEqual(toolsA.result?.tools?.length, 20, 'Bridge A 应返回 20 个工具');
  console.log('[OK] Bridge A 返回 20 个工具');

  console.log('\n--- 步骤 2: 启动 Bridge B (Worker Proxy，模拟第 2 个 DSH 会话) ---');
  const procB = spawn(node, [bridgeScript], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const clientB = createStdioClient(procB);
  await wait(800);

  const initB = await clientB.send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'session-2', version: '1.0' } });
  assert.strictEqual(initB.result?.serverInfo?.name, 'chrome-bridge', 'Bridge B 应通过中继返回正常初始化结果');
  console.log('[OK] Bridge B (Worker) 通过透明中继成功初始化');

  const toolsB = await clientB.send('tools/list');
  assert.strictEqual(toolsB.result?.tools?.length, 20, 'Bridge B 应通过中继获取 20 个工具');
  console.log('[OK] Bridge B (Worker) 成功获取全部 20 个工具');

  const callInboxB = await clientB.send('tools/call', { name: 'chrome_inbox', arguments: { action: 'list' } });
  assert(Array.isArray(callInboxB.result?.content), 'Bridge B 应成功执行 chrome_inbox 工具');
  console.log('[OK] Bridge B 成功执行 chrome_inbox 工具调用');

  console.log('\n--- 步骤 3: 模拟第 1 个会话关闭 (杀死 Bridge A)，验证 Bridge B 自动晋升 ---');
  procA.kill();
  await wait(800);

  const toolsBAfter = await clientB.send('tools/list');
  assert.strictEqual(toolsBAfter.result?.tools?.length, 20, 'Bridge A 退出后，Bridge B 应自晋升为主桥并继续提供服务');
  console.log('[OK] Bridge B 成功自动晋升为主桥并继续工作');

  procB.kill();
  console.log('\n=== 全部通过：stdio 自动透明中继与主从晋升验证成功 ===');
  process.exit(0);
})().catch((err) => {
  console.error('[FAIL]', err);
  process.exit(1);
});
