@echo off
rem Start Claude Code with the ClaudeLinked channel. Extra arguments are passed to claude.
setlocal
set "CL_DIR=%~dp0"
if not exist "%CL_DIR%config\claudelinked.mcp.json" (
  echo ClaudeLinked is not set up on this PC yet. Run:
  echo   node "%CL_DIR%scripts\setup.mjs" --peer PC-A --relay http://RELAY-HOST:7878 --token TOKEN
  exit /b 1
)
call claude --dangerously-load-development-channels server:claudelinked --mcp-config "%CL_DIR%config\claudelinked.mcp.json" --settings "%CL_DIR%config\claudelinked.settings.json" %*
