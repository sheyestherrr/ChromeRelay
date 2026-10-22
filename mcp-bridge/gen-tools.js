// gen-tools.js — 从扩展提取的工具定义生成 MCP tools.json
// 用法: node gen-tools.js
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = 'F:\\dsh\\ext_tool_defs.txt';
const OUT = path.join(__dirname, 'tools.json');

// CC BROWSER_TOOLS 中管道路径可用的 19 个（去掉云桥专属的 switch/list/select_browser）
const PIPE_TOOLS = [
  'javascript_tool', 'read_page', 'find', 'form_input', 'computer', 'browser_batch',
  'navigate', 'resize_window', 'gif_creator', 'upload_image', 'get_page_text',
  'tabs_context_mcp', 'tabs_create_mcp', 'tabs_close_mcp',
  'read_console_messages', 'read_network_requests',
  'shortcuts_list', 'shortcuts_execute', 'file_upload',
];

const src = fs.readFileSync(SRC, 'utf-8');
const parts = src.split(/========== ([a-z_]+) ==========\r?\n/).slice(1);

const out = [];
const fails = [];
for (let i = 0; i + 1 < parts.length; i += 2) {
  const name = parts[i];
  const text = parts[i + 1].trim();
  if (!PIPE_TOOLS.includes(name)) continue;
  let obj;
  try {
    // 定义是静态字面量（execute 等函数体不会被执行），eval 安全
    obj = (new Function(`return (${text});`))();
  } catch (e) {
    fails.push(`${name}: ${e.message}`);
    continue;
  }
  // 扩展里有两种形态：
  //   a) parameters = 扁平的属性表（多数工具）
  //   b) parameters = 完整的 JSON Schema（已含 type/properties/required，如 tabs_close_mcp）
  // 形态 b 若再包一层 properties，会生成 properties.type/properties.properties 这样的
  // 伪属性，上游函数调用校验会整请求 400（code 11129 invalid_function_parameters）。
  const params = obj.parameters && typeof obj.parameters === 'object' && !Array.isArray(obj.parameters)
    ? obj.parameters
    : {};
  const isFullSchema = params.type === 'object'
    && params.properties && typeof params.properties === 'object'
    && !Array.isArray(params.properties);
  const inputSchema = isFullSchema
    ? { type: 'object', properties: params.properties, required: Array.isArray(params.required) ? params.required : [] }
    : { type: 'object', properties: params, required: Array.isArray(obj.required) ? obj.required : [] };
  out.push({
    name: obj.name,
    description: typeof obj.description === 'string' ? obj.description : '',
    inputSchema,
  });
}

// computer（def 引用外部变量 se=10，eval 失败，手动补全）
if (!out.find(t => t.name === 'computer')) {
  out.push({
    name: 'computer',
    description: "Use a mouse and keyboard to interact with a web browser, and take screenshots. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs. Whenever you intend to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor. Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['left_click', 'right_click', 'type', 'screenshot', 'wait', 'scroll', 'key', 'left_click_drag', 'double_click', 'triple_click', 'zoom', 'scroll_to', 'hover'], description: 'The action to perform.' },
        coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '(x, y) coordinates in pixels. Required for scroll and left_click_drag. For click actions, either coordinate or ref must be provided (not both).' },
        text: { type: 'string', description: 'The text to type (for type action) or the key(s) to press (for key action). Space-separated keys (e.g., "Backspace Delete"); modifiers: "ctrl+a", "cmd+a".' },
        duration: { type: 'number', minimum: 0, maximum: 10, description: 'Seconds to wait. Required for wait. Maximum 10 seconds.' },
        scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Required for scroll.' },
        scroll_amount: { type: 'number', minimum: 1, maximum: 10, description: 'Scroll wheel ticks. Optional for scroll, defaults to 3.' },
        start_coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '(x, y) starting coordinates for left_click_drag.' },
        region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: '(x0, y0, x1, y1) region for zoom. Required for zoom.' },
        repeat: { type: 'number', minimum: 1, maximum: 100, description: 'Repeat count for key action. Default 1.' },
        ref: { type: 'string', description: 'Element reference ID from read_page or find tools (e.g., "ref_1"). Required for scroll_to; alternative to coordinate for clicks.' },
        modifiers: { type: 'string', description: 'Modifier keys for click actions: "ctrl", "shift", "alt", "cmd"/"meta", "win". Combinable with "+". Optional.' },
        tabId: { type: 'number', description: 'Tab ID to execute the action on. Use tabs_context_mcp first if you do not have a valid tab ID.' },
      },
      required: ['action'],
    },
  });
}

// find（def 用了单引号 description，提取正则未命中，手动补全）
if (!out.find(t => t.name === 'find')) {
  out.push({
    name: 'find',
    description: 'Find elements on the page using natural language. Can search for elements by their purpose (e.g., "search bar", "login button") or by text content. Returns up to 20 matching elements with references that can be used with other tools. If you don\'t have a valid tab ID, use tabs_context_mcp first.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language description of what to find (e.g., "search bar", "add to cart button").' },
        tabId: { type: 'number', description: 'Tab ID to search in. Use tabs_context_mcp first if you do not have a valid tab ID.' },
      },
      required: ['query'],
    },
  });
}

// browser_batch（扩展里未按标准形态提取到，按 i18n/用法补一个 schema）
if (!out.find(t => t.name === 'browser_batch')) {
  out.push({
    name: 'browser_batch',
    description: 'Execute a batch of browser actions (e.g. multiple computer actions) in one call. Use this to combine sequences like click→type→key for form fills and multi-step navigation.',
    inputSchema: {
      type: 'object',
      properties: {
        actions: { type: 'array', description: 'List of action objects to execute in order.', items: { type: 'object' } },
        tabId: { type: 'number', description: 'Tab ID to execute on. Use tabs_context_mcp first if you do not have a valid tab ID.' },
      },
      required: ['actions'],
    },
  });
}

// 按 PIPE_TOOLS 顺序排序
out.sort((a, b) => PIPE_TOOLS.indexOf(a.name) - PIPE_TOOLS.indexOf(b.name));

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`OK: ${out.length} tools -> ${OUT}`);
out.forEach(t => console.log('  -', t.name, `(${Object.keys(t.inputSchema.properties).length} params)`));
if (fails.length) { console.log('EVAL FAILS:'); fails.forEach(f => console.log('  !', f)); }
