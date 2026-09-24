#!/usr/bin/env bash
# Start Claude Code with the ClaudeLinked channel (macOS/Linux).
# Extra arguments are passed straight to claude.
set -e
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "$dir/config/claudelinked.mcp.json" ]; then
  echo "ClaudeLinked is not set up on this machine yet. Run:"
  echo "  node \"$dir/scripts/setup.mjs\" --peer NAME --relay http://RELAY-HOST:7878 --token TOKEN"
  exit 1
fi

exec claude \
  --dangerously-load-development-channels server:claudelinked \
  --mcp-config "$dir/config/claudelinked.mcp.json" \
  --settings "$dir/config/claudelinked.settings.json" \
  "$@"
