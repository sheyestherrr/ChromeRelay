@echo off
REM chrome-bridge shared mode (multi-session): persistent HTTP MCP + WebSocket
REM After starting, point ALL agent sessions at: http://127.0.0.1:19289/mcp (streamable-http)
where node >nul 2>nul
if errorlevel 1 (
  echo [chrome-bridge] Node.js ^>= 18 is required and not found in PATH.
  pause
  exit /b 1
)
echo [chrome-bridge] HTTP MCP: http://127.0.0.1:19289/mcp  (extension WS: ws://127.0.0.1:19288)
node "%~dp0chrome-bridge.js" --http
pause
