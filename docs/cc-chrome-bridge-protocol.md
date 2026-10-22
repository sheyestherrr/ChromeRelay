# Claude Code "Claude in Chrome" 桥接协议规范（逆向工程）

> 来源：`claude.exe`（`@anthropic-ai/claude-code` v2.1.162，Bun 编译，BUILD_TIME `2026-06-03T07:02:50Z`，GIT_SHA `9c0de1e1…`）内嵌 JS 的字符串/代码提取。
> 文中 `qB5`、`SJ$`、`vp8` 等为压缩后的标识符；所有消息字段名、类型名、常量均为二进制原文。
> 版本注意：**2.1.162 中 `createChromeContext(BA4)` 无条件设置 `bridgeConfig`，因此默认走"云桥 WebSocket"路径**；命名管道 + native host 路径完整保留在二进制中（由扩展通过 native messaging 启动 host，或当 context 不含 `bridgeConfig` 时由 `No6` 选择管道客户端）。

---

## 1. 整体架构（文字版）

```
┌──────────────────────────── Claude Code 进程 ───────────────────────────┐
│  MCP server "Claude in Chrome"   (createClaudeForChromeMcpServer = _Q8) │
│    ├─ ListTools  → BROWSER_TOOLS (C98, 22 个工具)                        │
│    ├─ CallTool   → $Q8 → backend.callTool(name, args, opts)             │
│    └─ 后端客户端三选一 (No6):                                            │
│         bridgeConfig  → Np8 → vp8  (云桥 WebSocket 客户端)  【默认】     │
│         getSocketPaths→ zT$ → AT$  (管道连接池, 含 tabId 路由)           │
│         否则          → Zp8 → SJ$  (单管道客户端)                        │
└──────────────┬───────────────────────────────────┬─────────────────────┘
               │ (A) WebSocket                      │ (B) 命名管道/Unix socket
               │ wss://bridge.claudeusercontent.com │ \\.\pipe\claude-mcp-browser-bridge-<user>
               │     /chrome/<userId>               │ /tmp/claude-mcp-browser-bridge-<user>/<pid>.sock
               ▼                                    ▼
   ┌────────────────────┐            ┌─────────────────────────────────┐
   │  Anthropic 云桥     │            │ native host 进程                 │
   │  (按 userId 房间    │            │ claude.exe --chrome-native-host │
   │   路由 CC↔扩展)     │            │ (runChromeNativeHost = qB5)     │
   └─────────┬──────────┘            │  cA4 = 管道服务器 + 消息路由      │
             │ 扩展同样连云桥          └───────────────┬─────────────────┘
             ▼                                        │ (C) native messaging stdio
   ┌────────────────────────────────┐                 │ 4 字节 LE 长度前缀 JSON
   │  Chrome 扩展                    │◄────────────────┘
   │  id: fcoeoabgfenejglbffodgkkbkcdhcgfn
   │  (执行浏览器工具, 弹配对/权限提示) │
   └────────────────────────────────┘
```

三种进程角色（同一二进制，按 argv 分流，证据 @237510844）：
- `claude.exe --claude-in-chrome-mcp` → `runClaudeInChromeMcpServer (eU5)`：stdio MCP server。
- `claude.exe --chrome-native-host` → `runChromeNativeHost (qB5)`：管道↔扩展桥。
- 正常 CLI：通过 `mcpConfig {type:"stdio", command:process.execPath, args:["--claude-in-chrome-mcp"], scope:"dynamic"}` 把自身注册为 MCP server（证据 @233436116）；或 in-process 方式（`createLinkedTransportPair` + `UGH` stdio transport，@231827336）。

---

## 2. 分帧方式（三条链路各不相同）

| 链路 | 分帧 | 上限 | 证据 |
|---|---|---|---|
| (A) 云桥 WebSocket | WebSocket 消息 = 一个完整 JSON（`JSON.stringify`/`JSON.parse`） | — | `this.ws.send(JSON.stringify(D))` |
| (B) 命名管道/Unix socket | **4 字节小端 UInt32 长度前缀 + UTF-8 JSON** | **1 MiB**（`j5$=1048576`；长度 0 或超限 → `socket.destroy()`） | host 端 `cA4.handleMcpClient`：`let _=$.buffer.readUInt32LE(0); if(_===0||_>j5$){…H.destroy();return}`；客户端 `SJ$`：`O.writeUInt32LE(Y.length,0); K.write(Buffer.concat([O,Y]))` |
| (C) native messaging stdio | **4 字节小端 UInt32 长度前缀 + UTF-8 JSON**（Chrome 标准） | 1 MiB（同一 `j5$`） | `lzH(H){let q=Buffer.from(H,"utf-8"),$=Buffer.alloc(4); $.writeUInt32LE(q.length,0),process.stdout.write($),process.stdout.write(q)}`；读取端 `class lA4`（同前缀格式） |
| MCP stdio / in-process transport | **NDJSON**（`\n` 分隔，去尾部 `\r`） | — | `class U58{readMessage(){let H=this._buffer.indexOf('\n'); …replace(/\r$/,"")…}}` + `fQ8(H){return JSON.stringify(H)+'\n'}`；`class UGH{constructor(H=stdin,q=stdout){this._readBuffer=new U58…}}` |

**结论：管道上不是换行 JSON，是 4 字节 LE 长度前缀。** `U58` 仅用于 MCP stdio/内存 transport，与管道无关。

---

## 3. (B) 命名管道层协议（第三方对接的核心）

### 3.1 端点

- Windows：`\\.\pipe\claude-mcp-browser-bridge-<username>`
- POSIX：host 监听 `/tmp/claude-mcp-browser-bridge-<username>/<pid>.sock`（目录 0700、socket 0600、属主校验；host 启动时清理 stale `<pid>.sock`）
- 证据（@226469080）：
  ```js
  function Xz6(){if(platform()==="win32")return`\\\\.\\pipe\\${Bj7()}`;
                 return join(K28(),`${process.pid}.sock`)}
  function Uj7(){/* win32: 同 Xz6；POSIX: 枚举目录下全部 *.sock + 候选路径 */}
  function Bj7(){return`claude-mcp-browser-bridge-${hkq()}`}  // hkq=os.userInfo().username
  ```

### 3.2 握手：**没有握手**

host 端接受连接后立即可用（`cA4.handleMcpClient`）：

```js
handleMcpClient(H){let q=this.nextClientId++, $={id:q,socket:H,buffer:Buffer.alloc(0)};
  this.mcpClients.set(q,$);
  lzH(RH({type:"mcp_connected"}));            // host → 扩展（native messaging）
  H.on("data",(K)=>{ $.buffer=Buffer.concat([$.buffer,K]);
    while($.buffer.length>=4){ let _=$.buffer.readUInt32LE(0);
      if(_===0||_>j5$){ H.destroy(); return }
      if($.buffer.length<4+_)break;
      let f=$.buffer.slice(4,4+_); $.buffer=$.buffer.slice(4+_);
      let A=B8(f.toString("utf-8"));
      lzH(RH({type:"tool_request",method:A.method,params:A.params})) }})
  H.on("close",()=>{ …; lzH(RH({type:"mcp_disconnected"})) })}
```

- `chrome_bridge_handshake_timeout` / `routing_ack` / `peer_connected` 等**全部属于云桥路径**，管道层没有任何 hello/init/routing 消息。

### 3.3 客户端 → host（管道）消息格式

CC 单管道客户端 `SJ$`（工厂 `Zp8`）的 `callTool`：

```js
async callTool(H,q,$){
  let K={ method:"execute_tool",
          params:{ client_id:this.context.clientTypeId,   // "claude-code"
                   tool:H,                                // 工具名, 如 "navigate"
                   args:q,                                // 工具参数对象
                   ...$?.sessionScope?{session_scope:$.sessionScope}:{}}};
  return this.sendRequestWithRetry(K) }
```

即管道上就是一个 JSON 对象 `{"method":"execute_tool","params":{...}}`，外加 4 字节 LE 前缀。
**注意：没有 JSON-RPC `id` 字段**；`SJ$` 用单一 `responseCallback` 匹配响应（同一时刻只允许一个未决请求），默认超时 30 s（`sendRequest(H,q=30000)`）。

### 3.4 host → 客户端（管道）消息格式

host 收到扩展的 `tool_response` / `notification` 后，**剥掉 `type` 字段、其余原样转发**（重新加 4 字节前缀）：

```js
case"tool_response":{ let{type:_,...f}=K;
  let A=Buffer.from(RH(f),"utf-8"), z=Buffer.alloc(4); z.writeUInt32LE(A.length,0);
  for(let[O,M]of this.mcpClients) M.socket.write(Buffer.concat([z,A])) }
```

客户端 `SJ$` 的分类逻辑：

```js
function XQ4(H){return"result"in H||"error"in H}   // → 工具响应, 交给 responseCallback
function JQ4(H){return"method"in H&&typeof H.method==="string"}  // → 通知, 交给 notificationHandler
```

- 工具成功响应：`{"result":{"content":[...]}}`（MCP 风格 content 数组）
- 工具失败响应：`{"error":{"content":[...]}}`
- 通知：`{"method":"<method>","params":{...}}` → `createClaudeForChromeMcpServer` 直接转成 MCP notification：`f.notification({method,params})`

### 3.5 客户端连接/重连行为（`SJ$`）

- `connect()`：POSIX 先 `validateSocketSecurity`（目录 0700、socket 0600、uid 属主校验，win32 跳过）；`net.createConnection(path)`；5 s 连接超时。
- 断线重连：`ECONNREFUSED/ECONNRESET/EPIPE/ENOENT/EOPNOTSUPP/ECONNABORTED` 触发；退避 `min(1000*1.5^(n-1), 30000)` ms；超过 100 次放弃（"Will retry on next tool call"）。
- `sendRequestWithRetry`：请求失败且为 `SocketConnectionError` 时强制重连重发一次。
- 错误类：`SocketConnectionError (qG)`、`NoExtensionConnectedError (YGH)`、`ToolCallTimeoutError (OGH)`、`ExtensionDisconnectedMidCallError (V3H)`。

### 3.6 管道连接池（`AT$`，工厂 `zT$`；POSIX 多浏览器场景）

- `refreshClients()`：对 `getSocketPaths()` 返回的每个路径建一个 `Zp8` 客户端（`disableAutoReconnect=true`），移除失效路径。
- `callTool` 路由：`tabs_context_mcp` 广播到所有已连接 socket 并聚合 tab 列表，同时建立 `tabId → socketPath` 路由表（`tabRoutes`）；带 `args.tabId` 的后续调用按路由表定向到对应 socket；无 tabId 时发第一个已连接 socket。
- Windows 上 `getSocketPaths()` 只返回单个管道名，池退化为单客户端。

---

## 4. (C) native messaging 层协议（host ↔ 扩展）

host 从 stdin 读扩展消息（4 字节 LE 前缀 JSON），用 zod 校验 `{type:string}.passthrough()`，按 `type` 分发（`cA4.handleMessage`）：

| 方向 | type | 字段 | 处理 |
|---|---|---|---|
| 扩展→host | `ping` | — | 回 `{type:"pong",timestamp:Date.now()}` |
| 扩展→host | `get_status` | — | 回 `{type:"status_response",native_host_version:"1.0.0"}`（`HB5="1.0.0"`） |
| 扩展→host | `tool_response` | `{result\u007Cerror, ...}`（除 type 外原样） | 转发给**所有**管道客户端 |
| 扩展→host | `notification` | `{method,params,...}` | 转发给所有管道客户端 |
| host→扩展 | `tool_request` | `{method, params}`（来自管道消息的 method/params） | 扩展执行 |
| host→扩展 | `mcp_connected` / `mcp_disconnected` | 无额外字段 | 管道客户端数变化通知 |
| host→扩展 | `error` | `{error:"Invalid message format"\u007C"Unknown message type: <t>"}` | 错误回报 |
| host→扩展 | `pong` / `status_response` | 见上 | — |

时序：扩展启动 host → host 创建管道服务器监听 → 管道客户端（CC MCP 后端）连接 → host 发 `mcp_connected` 给扩展 → 之后 `tool_request`/`tool_response` 双向透传。host 版本常量 `HB5="1.0.0"`。

---

## 5. (A) 云桥 WebSocket 层协议（2.1.162 默认路径）

客户端 `vp8`（工厂 `Np8`，即遥测里的 BridgeClient）。

### 5.1 连接与认证（握手）

```js
// bridgeConfig: {url, getUserId/getUserIdResult, getOAuthToken, devUserId?, wsOptions/getWsOptions}
// url 三选一: wss://bridge.claudeusercontent.com (默认)
//             wss://bridge-staging.claudeusercontent.com (USE_STAGING_OAUTH)
//             ws://localhost:8765 (USE_LOCAL_OAUTH / LOCAL_BRIDGE)
let A=`${$.url}/chrome/${userId}`;          // userId = oauthAccount.accountUuid || CLAUDE_CODE_ACCOUNT_UUID
this.ws=new WebSocket(A, wsOptions);
ws.on("open",()=>{ ws.send(JSON.stringify(
  {type:"connect", client_type:"claude-code", oauth_token:"<OAuth accessToken>"}));
  // dev 模式: {type:"connect", client_type, dev_user_id:"dev_user_local"} 替代 oauth_token
});
```

- 握手超时：`IJ$=30000` ms 未完成 → 遥测 `chrome_bridge_handshake_timeout`，断开重连。
- 桥 → CC 的首批响应之一：
  - `{type:"paired"}` — 已有扩展在线，连接就绪；
  - `{type:"waiting"}` — 认证成功但无扩展在线，等待扩展。
  两者都使 `connected=authenticated=true` 并启动 keepalive。
- Keepalive：每 `LQ4=30000` ms 发 `{type:"ping"}`；桥也会发 `{type:"ping"}`（CC 回 `{type:"pong"}`）；`RJ$=90000` ms 没收到 pong → 判定死连接，断开重连。

### 5.2 工具调用

CC → 桥：

```js
{type:"tool_call",
 tool_use_id:"<uuid>",              // crypto.randomUUID()
 client_type:"claude-code",
 tool:"<工具名>", args:{...},
 target_device_id:"<deviceId>",     // 可选, 选定扩展后带上
 permission_mode:"ask"|"skip_all_permission_checks"|"follow_a_plan",  // 可选
 allowed_domains:[...],             // 可选
 handle_permission_prompts:true,    // 可选, 有 onPermissionRequest 时
 session_scope:{sessionId,userMessageUuid}}  // 可选
```

桥 → CC：

- `{type:"routing_ack", tool_use_id, routed_to, target_connected_at, target_pong_age_ms, extension_sockets, mcp_sockets}` — 路由回执（遥测 `chrome_bridge_routing_ack`）。
- `{type:"tool_result", tool_use_id, result?|error?|content?, is_error?}` — 最终结果。归一化：无 `result/error` 时 `content`+`is_error` 映射为 `{result:{content}}` 或 `{error:{content}}`。
- 默认超时 `Gp8=60000` ms（`DEFAULT_TOOL_CALL_TIMEOUT_MS`）。

### 5.3 扩展发现与选择

- CC → 桥 `{type:"list_extensions"}` → 桥回 `{type:"extensions_list", extensions:[{deviceId,name,osPlatform,connectedAt}]}`（发现超时 `Vp8=5000` ms）。
- `{type:"peer_connected"[, deviceId]}` / `{type:"peer_disconnected",{deviceId}}` — 扩展上下线；选中的扩展掉线则 pending 调用以 `ExtensionDisconnectedMidCallError` 拒绝。无扩展时最多等 `TpH=10000` ms（`PEER_WAIT_TIMEOUT_MS`）。
- 自动选择：仅 1 个扩展 → 直接选；多个 → 若有 persistedDeviceId 且在线则自动重选；否则走配对或要求用户选择（`select_browser` / `switch_browser` 工具）。

### 5.4 权限提示（扩展侧确认）

- 桥 → CC：`{type:"permission_request", tool_use_id, request_id, tool_type, url, action_data}`（暂停该调用计时器）。
- CC → 桥：`{type:"permission_response", request_id, allowed:boolean, target_device_id?}`。

### 5.5 通知与错误

- 桥 → CC `{type:"notification", method, params}` → 转发为 MCP notification。
- 桥 → CC `{type:"error", error:"..."}`；未识别类型仅告警。

### 5.6 重连

指数退避 `min(2000*1.5^(n-1), 30000)` ms，100 次后放弃（遥测 `chrome_bridge_reconnect_exhausted`），下次工具调用再触发。

---

## 6. 配对（Pairing）流程

**仅云桥路径有配对；管道/nat​​ive-host 路径完全没有配对**（本机安全依赖 POSIX 0700/0600 文件权限与属主校验，Windows 依赖管道 ACL 与同名用户隔离）。

时序：

```
CC                                云桥                       Chrome 扩展
 │ {type:"pairing_request",        │                            │
 │  request_id:"<uuid>",           │                            │
 │  client_type:"claude-code"}     │                            │
 │────────────────────────────────►│  广播给同账号所有扩展 ─────►│ 弹出配对确认界面
 │  (CC 侧同时 firePairingPrompt,  │                            │  (用户可命名浏览器)
 │   120 s 超时 abort)             │                            │
 │                                 │◄──── 用户在某扩展点击 Connect
 │◄─── {type:"pairing_response",   │                            │
 │      request_id:"<同上的uuid>", │                            │
 │      device_id:"<deviceId>",    │                            │
 │      name:"<浏览器显示名>"}      │                            │
 │  → selectExtension(device_id)   │                            │
 │  → onExtensionPaired → 写配置   │                            │
```

- 用户关闭提示：扩展回报 `{type:"pairing_response", request_id, dismissed:true}` → CC `abortPairingPrompt()`。
- 字段消毒：`device_id` 截 64 字符、`name` 截 50 字符、去控制字符（`S98`）。
- `switch_browser` 工具同样用 `pairing_request` 广播，120 s 无响应返回 null。
- **配对持久化（免再配对）**：CC 写入全局配置（证据 @234830877）：
  ```js
  onExtensionPaired:(f,A)=>{ Z6((z)=>({...z,
    chromeExtension:{pairedDeviceId:f, pairedDeviceName:A}})) }
  getPersistedDeviceId:()=> C8().chromeExtension?.pairedDeviceId
  ```
  即 `~/.claude.json` 的 `chromeExtension.pairedDeviceId` / `pairedDeviceName`（token 形态就是 deviceId，无单独密钥）。后续连接 `discoverAndSelectExtension` 自动重选该 deviceId；`getRequirePairedDevice()` 为真时拒绝自动选择其他设备。

---

## 7. MCP server 层与工具清单

`createClaudeForChromeMcpServer (_Q8)`：`new McpServer({name:serverName, version:"1.0.0"}, {capabilities:{tools:{},logging:{}}})`。

- ListTools：返回 `BROWSER_TOOLS (C98)`；非云桥（管道）路径过滤掉 `CJ$ = {"switch_browser","list_connected_browsers","select_browser"}` 三个工具。
- CallTool `$Q8`：特殊处理 `switch_browser`/`list_connected_browsers`/`select_browser`；其余 `backend.callTool`；错误映射：`SocketConnectionError/NoExtensionConnectedError` → "扩展未连接"提示；`ToolCallTimeoutError` → `{..., _meta:{isBridgeTimeout:true}}`；`ExtensionDisconnectedMidCallError` → 重试提示；`result.content`/`error.content` 归一化为 MCP content 数组（image 的 `source.data/media_type` 被拍平为 `{type:"image",data,mimeType}`）。
- 通知：`backend.setNotificationHandler(({method,params}) => server.notification({method,params}))`。

`BROWSER_TOOLS`（22 个，`name` 原文）：`javascript_tool`、`read_page`、`find`、`form_input`、`computer`、`browser_batch`、`navigate`、`resize_window`、`gif_creator`、`upload_image`、`get_page_text`、`tabs_context_mcp`、`tabs_create_mcp`、`tabs_close_mcp`、`read_console_messages`、`read_network_requests`、`shortcuts_list`、`shortcuts_execute`、`file_upload`、`switch_browser`、`list_connected_browsers`、`select_browser`。
（工具在 MCP 层的全名：`mcp__claude-in-chrome__<name>`。）

---

## 8. Native host 安装（`ji_` / `wi_` / `YZ5`，证据 @233437365 起）

**Manifest**（文件名 `com.anthropic.claude_code_browser_extension.json`，2 空格缩进 JSON）：

```json
{
  "name": "com.anthropic.claude_code_browser_extension",
  "description": "Claude Code Browser Extension Native Host",
  "path": "<wrapper 脚本绝对路径>",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/"]
}
```

- 写入位置：Windows = `%APPDATA%\Claude Code\ChromeNativeHost\`（`%APPDATA%` 缺省 `~/AppData/Local`）；POSIX = 各浏览器 `NativeMessagingHosts` 目录（Chrome/Brave/Arc/Chromium 等的 `~/.config/<browser>/NativeMessagingHosts` 或 macOS `~/Library/Application Support/...`）。
- **Wrapper**：`~/.claude/chrome/chrome-native-host.bat`（POSIX 为无后缀 `chrome-native-host`，chmod 0755），内容模板：
  ```bat
  @echo off
  REM Chrome native host wrapper script
  REM Generated by Claude Code - do not edit manually
  "C:\...\claude.exe" --chrome-native-host
  ```
  （POSIX：`#!/bin/sh` + 相同注释 + `exec "<claude>" --chrome-native-host`）
- **注册表**（`YZ5`，对每个浏览器执行 `reg add <key>\com.anthropic.claude_code_browser_extension /ve /t REG_SZ /d <manifest路径> /f`）：
  - `HKCU\Software\Google\Chrome\NativeMessagingHosts`
  - `HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts`
  - `HKCU\Software\ArcBrowser\Arc\NativeMessagingHosts`
  - （Chromium 等同类键，见浏览器表 `$28`）
- 首次安装后若检测到扩展已装，自动打开 `https://clau.de/chrome/reconnect`。
- 启用开关：`CLAUDE_CODE_ENABLE_CFC` 环境变量、全局配置 `claudeInChromeDefaultEnabled`、`chromeExtension.pairedDeviceId` 是否存在、feature flag `tengu_chrome_auto_enable`。

---

## 9. 第三方 MCP 客户端对接：最小协议子集

目标：让自己的进程伪装成 CC 的 MCP 后端，使用已安装的 native host + 官方扩展（管道模式）。

1. **连接**：Windows 连 `\\.\pipe\claude-mcp-browser-bridge-<username>`（POSIX 连 `/tmp/claude-mcp-browser-bridge-<username>/<hostPid>.sock`）。
2. **分帧**：读/写均为 `uint32 LE 长度 + UTF-8 JSON`；单条 ≤ 1 MiB；长度字段为 0 或 > 1048576 会被 host 断连。
3. **无握手**：连上即可发请求；无需也不应发送 hello/init。
4. **发请求**：`{"method":"execute_tool","params":{"client_id":"<任意字符串, CC 用 claude-code>","tool":"<BROWSER_TOOLS 之一>","args":{...}}}`（`session_scope` 可选）。host 会包成 `{type:"tool_request",method,params}` 给扩展。
5. **收响应**：消息含 `result` 或 `error` 字段 → 对应最近一次请求的响应（**串行发请求**，host/客户端均按单未决请求设计）；含 `method` 字段 → 异步通知，可忽略或处理。
6. **不需要配对**：管道模式跳过 pairing（pairing 只在云桥路径）。
7. **保活**：管道层无心跳；断线自行重连即可（host 随扩展生命周期存在；扩展未运行时管道不存在，连接会 `ENOENT/ECONNREFUSED`）。

若要对接**云桥**路径（远程浏览器）：WebSocket 连 `wss://bridge.claudeusercontent.com/chrome/<userId>`，发 `{type:"connect",client_type,oauth_token}`，等 `paired/waiting`，`list_extensions` → 选 deviceId → `tool_call`（带 `tool_use_id`、`target_device_id`）→ 收 `tool_result`；每 30 s `ping`、90 s 内必须有 pong。需要有效 Anthropic OAuth token，第三方复现门槛高。

---

## 10. 不确定 / 未找到的点

1. **扩展侧实现不在本二进制内**（扩展 id `fcoeoabgfenejglbffodgkkbkcdhcgfn` 是独立 Chrome 扩展）：`tool_request` 在扩展内如何分发、`notification` 的具体 `method` 枚举、`tool_response` 的精确完整字段集，均需对扩展本身逆向才能 100% 确认。管道侧只能确定：响应必须含 `result` 或 `error`（否则被当作"未知消息"忽略）。
2. **云桥服务端协议**：`connect` 之后桥与扩展之间的房间管理、`routing_ack` 的生成逻辑在服务端，二进制只有客户端视角。
3. `notification` 的 `method` 具体取值未在 CC 二进制中枚举（CC 只透传）。
4. 2.1.162 的 `BA4` 恒设 `bridgeConfig`，因此**何时真正回落到管道路径**（`getSocketPaths`/`socketPath` 分支）未在二进制中看到触发条件——可能留给旧版 context、测试或未来功能；native host 安装路径（kK$）仍在，说明扩展 native messaging 模式仍受支持。
5. `pairing` 在**管道路径**完全不存在——若第三方走管道对接，无需实现配对；若未来扩展在管道上要求配对，二进制中无此代码。
6. `QA4`（native host 日志文件路径）默认 `void 0`，未找到设置入口（日志只走 stderr，Chrome 会捕获到扩展 native messaging 日志）。
