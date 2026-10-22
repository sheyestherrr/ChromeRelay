# ChromeRelay — 双向连接 Chrome 与任意 AI Agent 的通用 MCP 接力桥

基于 **Claude in Chrome++**（官方扩展的可接第三方 API 修改版）+ **chrome-bridge**（通用 MCP 桥），把 Chrome 浏览器变成任意 AI Agent 的手和眼：导航、点击、填表、截图、读页面、执行 JS、管标签页……共 **20 个工具**，外加一条**浏览器 → Agent 的内容推送通道**（收件箱）。

- ✅ **任意 Agent**：DSH、Claude Code、Cursor、Windsurf、Cline……（标准 stdio MCP）
- ✅ **开箱即用**：零后台脚本、无需开机常驻、由 Agent 自动按需拉起并回收
- ✅ **多会话自愈**：主从透明代理——后续会话自动转为内部中继，主桥退出自动无缝晋升
- ✅ **任意模型**：扩展自身可配第三方 API（apiKey / authToken + 自定义 Base URL + 模型映射）
- ✅ **双向通道**：Agent 调浏览器（19 个操作工具）+ 浏览器推送给 Agent（chrome_inbox 收件箱）
- ✅ **零系统改动**：不碰注册表、不装 native host、不需要 Claude Code、不需要订阅
- ✅ **跨平台**：Windows / macOS / Linux

```
┌─────────────┐   stdio (MCP)   ┌──────────────────┐   WebSocket             ┌──────────────┐
│  AI Agent    │ ◄────────────► │  mcp-bridge/      │ ◄── ws://127.0.0.1 ───► │  Chrome 扩展  │
│ (DSH/CC/...) │ （Agent自动拉起）│  chrome-bridge.js │    :19288 (扩展拨出)     │ (extension/) │
└─────────────┘                └──────────────────┘                         └──────────────┘
                                  ▲
                                  │ 自动透明代理 (多会话无需额外配置，
                                  │ 后续会话自动作为 Worker 中继到主桥)
                               ┌──┴────────────────────────┐
                               │ 额外会话的 stdio 桥 (Worker)│
                               └───────────────────────────┘
```

## 环境要求

| 依赖 | 版本 | 检查 |
|---|---|---|
| Chrome / Edge / Brave 等 Chromium 浏览器 | ≥ 116 | `chrome://version` |
| Node.js | ≥ 18（自检脚本建议 ≥ 22） | `node -v` |

## 一、安装配置（约 2 分钟）

### 第 1 步：加载扩展

1. 浏览器地址栏打开 `chrome://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择本包的 **`extension/`** 文件夹
4. 加载后再点一次该扩展卡片上的 **重新加载**（🔄）

> 说明：扩展是"Claude in Chrome++"修改版，侧边栏 Agent 功能可配自己的 API 使用；即使不配 API，浏览器工具通道（本包核心）也完全可用。

### 第 2 步（可选但推荐）：扩展两项设置

- **权限模式设为 "Act without asking"**：点浏览器工具栏的扩展图标打开侧边栏，在输入框附近的模式切换中选择。否则 AI 的每个浏览器操作都要你去侧边栏手动批准。
- **想用扩展自带的聊天功能**：右键扩展图标 → 选项 → API 配置：选 `API Key` 或 `Auth Token` 模式，填你的 Base URL 和密钥（模型映射页可配 haiku/sonnet/opus 到你的代理模型 ID）。

### 第 3 步：Agent 工具添加 MCP 服务器（开箱即用，零后台脚本）

类型 **stdio**，命令 `node`，参数为本包 `mcp-bridge/chrome-bridge.js` 的**绝对路径**。

> **多会话全自动**：你和同学都**只需要这一行标准配置**，完全不需要在后台单独运行脚本。第 1 个会话启动主桥；后续会话自动转为透明中继；主会话退出后自动无缝晋升。退出 Agent 时所有相关进程自动随之销毁，干干净净。

<details>
<summary><b>DSH（DeepSeek Harness）</b></summary>

编辑 `~/.dsh/profiles/<你的profile>/cordis.patch.yml`，在数组末尾追加（**重启 DSH 生效**）。
**必须用 `- insert:` 包裹**：cordis loader 的顶层条目是"按 id 覆盖"语义，直接写 `- id: mcp-chrome` 会因为找不到同名 bundle 条目而被静默跳过（不加载、不报错）：

```yaml
- insert:
    - id: mcp-chrome
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: chrome
        transport: stdio
        command: "node"            # 或 node 绝对路径
        args: ["C:\\path\\to\\ChromeRelay\\mcp-bridge\\chrome-bridge.js"]
        toolCallTimeoutMs: 150000
```

> **模型报 400（`invalid function call parameters` / `Invalid tool definition`）**：某些模型/中转对工具定义校验严格（已知 kimi-k3 经部分中转时会拒绝）。桥默认已开启 schema 兼容清洗；仍失败时可在配置里用 `env` 精简工具集排查：
> ```yaml
>         env:
>           CHROME_BRIDGE_TOOLS: "navigate,tabs_create_mcp,tabs_context_mcp,computer,get_page_text,read_page"
> ```
</details>

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add chrome -- node /path/to/ChromeRelay/mcp-bridge/chrome-bridge.js
```
</details>

<details>
<summary><b>Cursor / Cline / 其他（MCP JSON 配置）</b></summary>

```json
{
  "mcpServers": {
    "chrome": {
      "command": "node",
      "args": ["/path/to/ChromeRelay/mcp-bridge/chrome-bridge.js"]
    }
  }
}
```
</details>

## 二、快速验证是否生效（三级测试，逐级排查）

### 测试 ①：桥自测（30 秒，不需要浏览器）

```bash
cd ChromeRelay/mcp-bridge
node test-loopback.js
```
看到 `=== 全部通过 ===` 即桥接器本身正常（MCP 握手、19 个工具、WS 服务、回环调用）。**失败**：检查 Node 版本 ≥ 18。

### 测试 ②：端到端（需要浏览器，验证扩展通道）

```bash
node test-e2e.js
```
脚本提示后，到 `chrome://extensions` 点扩展的 **重新加载**（180 秒内）。看到真实标签页数据返回即全链路打通。**失败/超时**：看下方 FAQ 第 1 条。

### 测试 ③：在你的 Agent 里实战一句

重启你的 Agent 工具（加载 MCP 配置），新开一个会话，发：

> 调用 chrome 的工具，帮我在浏览器里打开 example.com，然后截图给我看看。

**预期看到**：Agent 依次调用 `mcp__chrome__tabs_create_mcp` → `mcp__chrome__navigate` → `mcp__chrome__computer(screenshot)`，浏览器真的打开页面，你收到一张截图。

> 也可以先看工具是否注册成功：问 Agent "你现在有哪些 `mcp__chrome__` 开头的工具？"——能列出 20 个就说明 MCP 配置已生效。

### 多会话透明中继原理（完全免配置）

① 无论在 DSH 中开启多少个会话，Agent 均通过 `stdio` 启动 `chrome-bridge.js`；
② **第 1 个会话自动成为 Master**，监听 WS 19288（扩展连接）并在本地开启轻量转发通道；
③ **后续会话自动作为 Worker 透明代理**，检测到主桥运行后自动中继，全会话工具调用串行排队；
④ **主会话关闭时自动晋升**：若第 1 个会话先被关闭，后续会话会自动无缝晋升为主桥并重新接管 WS 端口；
⑤ **全部退出时自动销毁**：关闭所有会话或退出 Agent，全部 node 子进程立即被操作系统清理，没有任何后台残留。

## 三、浏览器 → Agent 推送（收件箱）

与"Agent 操作浏览器"反向：你在浏览器侧把内容**主动推送**给 Agent。两个入口：

| 入口 | 位置 | 推什么 |
|---|---|---|
| **右键菜单"发送到 Agent"** | 任意网页上右键 | 「整页」正文（标题+URL+全文）或「选中内容」 |
| **⤴ 推送 按钮** | 侧边栏输入框工具栏（"教学 Claude"左侧，同款图标样式；锚点缺失时退化为**可拖动**悬浮球，位置自动记忆） | **侧边栏 AI 对话的完整记录**（你在侧边栏让 AI 总结/整理的结果） |

> 桥不在线时推送会**离线暂存**在扩展本地（localStorage，上限 20 条），按钮显示暂存数；桥上线后自动补发（事件驱动，无轮询空耗）。

推送后内容进入桥的**收件箱**（持久化在 `mcp-bridge/inbox.jsonl`，桥重启不丢）。在 Agent 里说：

> 看看浏览器收件箱里有什么，把最新的内容整理成 5 条要点存到桌面。

Agent 会调用 `chrome_inbox`（`action: list/read/clear`）取走内容并加工。

**典型工作流**：打开文章 → 侧边栏让 AI"总结这篇文章" → 点「⤴ 推送到 Agent」→ 到 DSH 说"把收件箱里的总结变成带标题的 Markdown 文档存好"。

### 工具一览（`mcp__chrome__` 前缀）

| 分类 | 工具 |
|---|---|
| 导航 | `navigate`（打开 URL/前进/后退）、`tabs_create_mcp`、`tabs_close_mcp`、`tabs_context_mcp`（列出标签页） |
| 看页面 | `computer`（截图/点击/键盘，动作含 `screenshot`）、`read_page`（结构化元素+ref 引用）、`get_page_text`（纯文本）、`find`（自然语言找元素） |
| 操作 | `computer`（left_click/type/scroll/key/hover…）、`form_input`（填表单）、`browser_batch`（一批动作合并执行，**速度快，推荐**） |
| 高级 | `javascript_tool`（页面里执行 JS）、`read_console_messages`、`read_network_requests`、`upload_image`、`file_upload`、`resize_window`、`gif_creator`（录制操作 GIF）、`shortcuts_list`/`shortcuts_execute`（扩展内快捷指令） |
| 收件箱 | `chrome_inbox`（读取浏览器推送的内容：右键"发送到 Agent" / 侧边栏"推送到 Agent"；桥本地工具，无需浏览器在线） |

### 常用提示词范式

- **查资料**："打开 bilibili 热搜，把前 10 条标题读给我"（navigate → get_page_text）
- **自动化**："帮我把这个表单填了：姓名张三、邮箱 a@b.com，填完先别提交，截图给我确认"（form_input → computer screenshot）
- **取数据**："在这个页面控制台执行 JS，把 `window.__INITIAL_STATE__` 里的列表拿出来"（javascript_tool）
- **排障**："这个页面报错了，把 console 里的错误信息读出来"（read_console_messages）

### 小贴士

- **标签组**：工具以"标签组"为单位工作。第一次使用时 Agent 会自动用 `tabs_create_mcp` 建组；如果看到 `No MCP tab groups found`，让它"创建一个标签组再继续"即可。
- **批量更快**：连续多个动作让 Agent 用 `browser_batch` 一次提交（点击→输入→截图一条龙）。
- **元素引用**：点击优先用 `read_page`/`find` 返回的 `ref` 引用（比坐标更稳）。

## 四、FAQ（常见问题）

1. **测试②超时 / Agent 调工具报"扩展尚未连接"**
   - 最常见：扩展加载后没有点"重新加载"（WS 补丁在扩展启动时生效）。去 `chrome://extensions` 点 🔄。
   - 检查端口占用：若 19288 端口被其他非 bridge 软件占用，请释放该端口。

2. **工具调用了但浏览器没反应/报权限错**
   - 侧边栏权限模式还是 "Ask before acting"：切到 **Act without asking**。
   - 某些页面（chrome://、应用店、PDF 内嵌页）扩展无权操作，属浏览器限制。

3. **截图/大结果很慢或超时**
   - 默认单次调用 150 秒；连续截图建议用 `browser_batch` 合并；检查网络代理是否拖慢页面加载。

4. **扩展聊天功能（侧边栏 Agent）连不上模型**
   - 与浏览器工具通道无关：那是扩展自己的 API 配置（选项页），填好 Base URL + 密钥 + 模型映射即可；不配置也不影响 Agent 通过 MCP 驱动浏览器。

5. **macOS / Linux 有区别吗？**
   - 没有。本方案不走 native messaging，三平台一致（唯一要求：Node ≥ 18、Chromium ≥ 116）。

6. **不想用 19288 端口**
   - 桥：设环境变量 `CHROME_BRIDGE_WS_PORT=<新端口>`；扩展：把 `extension/assets/service-worker.ts-*.js` 末尾补丁里的 `ws://127.0.0.1:19288` 改成相同端口，然后重载扩展。

## 五、包结构

```
ChromeRelay/
├── README.md                ← 本文件
├── extension/               ← Chrome 加载的扩展（Claude in Chrome++ 修改版）
│   ├── manifest.json
│   └── assets/…（含 __ccpp_ws_bridge / __ccpp_no_autolaunch 等补丁）
├── mcp-bridge/              ← 通用 MCP 桥（零依赖 Node 单文件）
│   ├── chrome-bridge.js     ← 主程序（HTTP/stdio MCP ↔ WebSocket）
│   ├── start-bridge.bat / start-bridge.sh   ← 共享模式常驻启动器
│   ├── tools.json           ← 19 个工具 schema
│   ├── test-loopback.js / test-e2e.js / test-stdio-proxy.js / test-http.js / test-sanitize.js  ← 自检脚本
│   └── README.md            ← 桥的技术说明
└── docs/
    └── cc-chrome-bridge-protocol.md   ← 协议逆向文档（二次开发参考）
```

## 安全说明

- 桥只监听 `127.0.0.1`，本机回环，不暴露网络；本机任何进程原则上都可连该端口驱动浏览器，请勿在不可信的多用户环境使用。
- 扩展的遥测（Segment/Sentry/Datadog/Honeycomb）已被 patch 全部关闭；扩展聊天 API 走你自己配置的端点。
- 浏览器操作能力等同于"看着你的屏幕、操作你的鼠标键盘"，请只给你信任的 Agent / 模型开放。
