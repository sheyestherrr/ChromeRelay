#!/bin/sh
# chrome-bridge shared mode (multi-session): persistent HTTP MCP + WebSocket
# After starting, point ALL agent sessions at: http://127.0.0.1:19289/mcp (streamable-http)
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "[chrome-bridge] HTTP MCP: http://127.0.0.1:19289/mcp  (extension WS: ws://127.0.0.1:19288)"
exec node "$DIR/chrome-bridge.js" --http
