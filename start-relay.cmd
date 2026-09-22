@echo off
rem Start the ClaudeLinked relay. Run this on ONE machine that every PC can reach.
node "%~dp0relay\server.mjs" %*
