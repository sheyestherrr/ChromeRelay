# chrome-bridge — ChromeRelay 通用浏览器 MCP 桥（双向流转 + 全自动多会话中继）

让**任何支持 MCP 的 Agent 工具**（DSH、Claude Code、Cursor、Windsurf、Cline……）直接驱动 Chrome 浏览器：19 个浏览器操作工具 + `chrome_inbox` 收件箱（浏览器→Agent 推送通道）。

**零系统改动**：不需要注册表、不需要 native messaging host、不需要 Claude Code、不需要订阅。macOS / Windows / Linux 通用。

## 架构

```
Agent 工具  ←stdio MCP 或 HTTP MCP→  chrome-bridge.js   ←WebSocket ws://127.0.0.1:19288→  Chrome 扩展
（任何 MCP 客户端）                   （本目录, 零依赖 Node ≥18）    （service worker / 侧边栏 主动拨出）
```

- 扩展侧补丁 `__ccpp_ws_bridge`（`assets/service-worker.ts-*.js` 末尾）：启动时向 `ws://127.0.0.1:19288` 拨 WebSocket，把官方 native-host 消息通道（`tool_request`/`tool_response`/`mcp_connected`/`ping`/`get_status`）整体搬到 WS 上；官方 native host 若已连接（装了 Claude Code）则 native 优先、WS 作后备。
- 扩展侧另有 `__ccpp_inbox_push`（右键菜单"发送到 Agent"）与侧边栏 `ccpp-push.js`（"⤴ 推送"按钮，离线暂存+自动补发），把网页/侧边栏对话推入桥的收件箱。
- 桥侧：单文件、零 npm 依赖（内置 RFC6455 WebSocket 服务器实现）。多客户端支持：service worker 与侧边栏可同时在线，靠 `get_status` 自动识别工具执行通道。
- 接入方式：**stdio MCP（默认推荐，零后台脚本，全自动多会话透明中继）**；亦支持 `--http` 显式 HTTP MCP 共享模式。

## 使用（两步）

### 1. Chrome 加载扩展

`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序（选择配套扩展目录）→ 点一次"重新加载"。

> 建议：扩展侧边栏权限模式设为 **Act without asking**，否则部分操作需在侧边栏手动批准。

### 2. Agent 工具添加 MCP 服务器（纯 stdio，开箱即用）

配置中添加类型 **stdio**，命令 `node`，参数为本目录 `chrome-bridge.js` 绝对路径。

- **单会话**：由 Agent 直接拉起并托管，随用随起，退出时干净回收。
- **多会话全自动**：同时开多个会话时，第 1 个会话成为 Master，后续会话的 stdio 桥自动秒变 Worker 透明中继至 Master，所有会话共享同一 Chrome 扩展且均有完整的原生工具列表。先启动的会话关闭后，从桥自动无缝晋升接管。无需任何后台常驻脚本！

配置示例（DSH / Claude Code / Cursor）见包根目录 [README.md](../README.md)。

工具以 `mcp__chrome__<name>` 出现（20 个：navigate、computer、read_page、find、form_input、get_page_text、javascript_tool、tabs_context_mcp、tabs_create_mcp、tabs_close_mcp、read_console_messages、read_network_requests、resize_window、upload_image、file_upload、gif_creator、shortcuts_list、shortcuts_execute、browser_batch、chrome_inbox）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CHROME_BRIDGE_WS_PORT` | `19288` | WS 监听端口（需与扩展补丁里的地址一致） |
| `CHROME_BRIDGE_CALL_TIMEOUT_MS` | `150000` | 单次工具调用超时 |
| `CHROME_BRIDGE_TOOLS` | （全部） | 逗号分隔工具白名单：精简工具数或排查严格模型校验 |
| `CHROME_BRIDGE_SCHEMA_COMPAT` | `1` | 默认开启：schema 规范化（R1-R6，详见代码注释），兼容严格模型校验；设 `0` 关闭 |
| `CHROME_BRIDGE_INBOX_MAX` | `1000` | 收件箱最大持久化容量（超过时自动 FIFO 淘汰） |
| `CHROME_BRIDGE_HTTP_PORT` | `19289`（`--http` 时） | HTTP MCP 监听端口；设置该变量等同 `--http` 启用共享模式 |

> 共享模式下这些变量在**启动桥进程时**设置（桥是独立常驻进程，Agent 的 MCP 配置里的 `env` 到不了桥）。

## 自检

```bash
node test-loopback.js      # 无 Chrome 的全链路回环（假扩展，含多客户端/收件箱）
node test-stdio-proxy.js   # 多会话 stdio 自动透明中继与主从晋升自测
node test-e2e.js           # 真实端到端（提示后去重载扩展）
node test-http.js          # HTTP MCP 共享模式冒烟（多会话并行）
node test-sanitize.js      # schema 规范化规则（R1-R6）
```

日志：`bridge.log`（扩展接入/调用记录）；收件箱持久化：`inbox.jsonl`。

## 协议参考

见 `../docs/cc-chrome-bridge-protocol.md`（完整逆向文档）。
