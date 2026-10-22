// test-sanitize.js — 直接验证桥内 sanitizeSchema 对 tools.json 的规范化结果
'use strict';
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/chrome-bridge.js', 'utf-8');

// 从桥源码中抽出 SAFE_KEYS 与 sanitizeSchema 定义（保持单源一致）
const start = src.indexOf('const SAFE_KEYS');
const end = src.indexOf('function loadTools');
if (start < 0 || end < 0) { console.error('未找到规范化器代码段'); process.exit(1); }
const { sanitizeSchema, SAFE_KEYS } = new Function(src.slice(start, end) + '; return { sanitizeSchema, SAFE_KEYS };')();

const tools = JSON.parse(fs.readFileSync(__dirname + '/tools.json', 'utf-8'));
const out = tools.map(t => ({ ...t, inputSchema: sanitizeSchema(t.inputSchema || { type: 'object' }, true) }));
const s = JSON.stringify(out);

// 遍历校验：schema 节点的键必须属于安全关键字集（properties 映射内的键是参数名，不校验）；required 必须是非空数组
let badKey = null, badRequired = null;
(function walk(n, path, keyCheck) {
  if (Array.isArray(n)) return n.forEach((v, i) => walk(v, path + `[${i}]`, keyCheck));
  if (!n || typeof n !== 'object') return;
  for (const [k, v] of Object.entries(n)) {
    if (keyCheck && !SAFE_KEYS.has(k) && !badKey) badKey = `${path}.${k}`;
    if (keyCheck && k === 'required' && (!Array.isArray(v) || v.length === 0) && !badRequired) badRequired = `${path}.${k}=${JSON.stringify(v)}`;
    // properties 的值是"参数名→schema"映射：映射本身的键不校验，但其值（子schema）继续校验
    walk(v, path + '.' + k, k === 'properties' ? false : keyCheck ? true : true);
  }
})(out.map(t => t.inputSchema), '$', true);

const checks = [
  ['R1 全部根 schema 为 object', out.every(t => t.inputSchema && t.inputSchema.type === 'object')],
  ['R2 无空 properties', !/"properties":\{\}/.test(s)],
  ['R3/R3b required 均为非空数组（无布尔标记）', !badRequired],
  ['R4 全部键都在安全关键字白名单内', !badKey],
  ['R5 数组均有 items', !/"type":"array"(?![^{]*"items")/.test(s)],
  ['R6 browser_batch 的 object items 已补 additionalProperties', /"actions":\{"type":"array","description":"[^"]*","items":\{"type":"object","additionalProperties":true\}\}/.test(s)],
  ['enum 保留（computer.action）', /"action":\{"type":"string","enum":\["left_click"/.test(s)],
  ['嵌套 properties 保留（computer.coordinate.items.number）', /"coordinate":\{"type":"array","items":\{"type":"number"\}/.test(s)],
  ['工具数量 = 19', out.length === 19],
];
if (badKey) console.log('  (坏键示例:', badKey, ')');
if (badRequired) console.log('  (坏required示例:', badRequired, ')');
let fail = 0;
for (const [name, ok] of checks) { console.log((ok ? '[OK] ' : '[X] ') + name); if (!ok) fail++; }
console.log(fail === 0 ? '\n=== 规范化器全部规则验证通过 ===' : `\n=== ${fail} 项失败 ===`);
process.exit(fail === 0 ? 0 : 1);
