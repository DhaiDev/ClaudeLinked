# ClaudeLinked

Lets a Claude Code session on one PC ask a question to a Claude Code session on another PC. The answer is delivered back to the session that asked. It works in both directions.

```
 PC-A: Claude Code                      relay (any machine both PCs can reach)          PC-B: Claude Code
 ┌──────────────────────┐   POST /send   ┌──────────────────────────┐   SSE push   ┌──────────────────────┐
 │ ask_peer("PC-B", q) ─┼───────────────►│ routes by peer name,     ├─────────────►│ <channel kind=       │
 │                      │                │ queues if offline,       │              │   "question">  wakes │
 │ answer returned  ◄───┼────────────────┤ redelivers until acked   │◄─────────────┼─ reply(message_id,a) │
 └──────────────────────┘   SSE push     └──────────────────────────┘  POST /send   └──────────────────────┘
```

Each session loads `channel/claudelinked.mjs`, a Claude Code [channel](https://code.claude.com/docs/en/channels-reference).
It's an MCP server that can push events into a running session, so an idle Session B wakes up and answers without anyone typing.

> **Check the built-in option first.** Claude Code's own [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
> can also reach sessions on other machines. Requirements: both PCs signed in to the **same claude.ai account** and both sessions
> connected to **Remote Control**. Messages then go through Anthropic's servers. Use ClaudeLinked when the PCs use different accounts, when you
> can't use Remote Control, or when you want traffic to stay on your own network.

## Requirements

- Node.js 20+ on every PC (and on the relay machine)
- Claude Code with channels support, signed in with claude.ai or a Console API key (tested with v2.1.272).
  On claude.ai **Team/Enterprise** plans, an Owner must enable channels (Admin settings → Claude Code → Channels).
- The PCs must reach the relay's port: same LAN, VPN, or [Tailscale](https://tailscale.com)

## Setup

### 1. Start the relay (on one machine only)

This can be PC-A, PC-B, or any always-on box.

```cmd
cd C:\Dev\ClaudeLinked
npm install
start-relay.cmd
```

The relay prints the addresses it's reachable at and a **token**. The token is generated on first run and saved in `relay-data\token.txt`.
Options: `--port 7878` `--host 0.0.0.0` `--token <secret>` `--data <dir>`.

Allow the port through Windows Firewall on the relay machine (in an admin PowerShell):

```powershell
New-NetFirewallRule -DisplayName "ClaudeLinked relay" -Direction Inbound -Protocol TCP -LocalPort 7878 -Action Allow -Profile Private
```

### 2. Configure each PC

Copy this folder to each PC and run `npm install` there. Then run setup with a **unique** peer name:

```cmd
node scripts\setup.mjs --peer PC-A --relay http://192.168.1.20:7878 --token <token>
```

This writes `config\` (it contains the token, so keep it private) and checks that the relay answers.

### 3. Start Claude Code through the launcher

From any project folder:

```cmd
C:\Dev\ClaudeLinked\claude-linked.cmd
```

Extra arguments are passed straight to `claude`. On startup:

1. Choose **"I am using this for local development"**. Custom channels need this confirmation while channels are a research preview.
2. Wait for ClaudeLinked to finish loading. Check with `/mcp`: `claudelinked` should show as connected. If you have many other MCP servers, this can take ~30s.
   You may see `server:claudelinked · no MCP server configured with that name` at the very top. That line is printed before
   the launcher's MCP config finishes loading, and the channel still registers. For a faster start that loads only ClaudeLinked,
   run `claude-linked.cmd --strict-mcp-config`.

## Using it

Just ask in plain language:

> Ask PC-B what port the payments API runs on in their checkout of the repo.

Claude uses these tools:

| Tool | What it does |
|---|---|
| `ask_peer` | Sends a question and waits for the answer (default 300s, `wait_seconds` 0–3600). If the wait runs out, the answer still arrives later as an event. |
| `reply` | Answers an incoming question by `message_id`. |
| `send_message` | Sends a one-way note (no answer expected). |
| `list_peers` | Shows who is online and how many messages are queued for each peer. |
| `check_inbox` | Shows recent traffic, questions awaiting your reply, and your questions still waiting for an answer. |

Incoming traffic appears in the session as `<channel source="claudelinked" kind="question|answer|message" from="PC-A" message_id="...">`.

## How it behaves

- **Idle session:** Claude Code starts a new turn as soon as the question arrives. In testing, PC-B answered a file-lookup question in 5–60s.
- **Busy session:** the question is queued and handled when the current turn ends. If that takes longer than the asker's wait, the answer shows up in the asker's session as a `kind="answer"` event.
- **Offline peer:** the relay stores the message on disk (kept 7 days) and delivers it when that peer connects. Messages are redelivered until the receiver acknowledges them, and duplicates are ignored.
- **One session per peer name:** if a second session connects as `PC-B`, it takes over, and the older one gets a notice.
- **Permissions still apply on the answering PC.** The launcher pre-allows only ClaudeLinked's own tools (`mcp__claudelinked`).
  If answering needs, say, a `Bash` approval, that session waits at the prompt. For unattended answering, allow those tools in that PC's settings.
- **Interactive sessions only.** `claude -p` ignores `--dangerously-load-development-channels`, so a headless session never receives the events.

## Security

- All relay calls need the bearer token. Anyone holding the token can put text in front of every connected Claude session, so treat it like a password.
- The relay speaks plain HTTP. Use it on a trusted LAN, over Tailscale/VPN, or behind an HTTPS reverse proxy (`--relay https://...` works as-is).
- The channel tells Claude that peer messages come from another session, not from the local user. Claude is told to check with the local user before destructive or outward-facing actions.

## Development

```cmd
npm test
```

This runs `test/e2e.mjs`: a real relay plus two real channel servers, driven over MCP stdio the way Claude Code drives them. It covers blocking and non-blocking asks, late answers, both directions, offline queueing, acks, bad tokens, and name takeover.

```
relay/server.mjs          relay (no dependencies): SSE stream, /send, /ack, /peers, disk-backed queue
channel/claudelinked.mjs  channel MCP server loaded by each Claude Code session
scripts/setup.mjs         writes config/ for this PC and checks the relay
claude-linked.cmd         starts claude with the channel enabled
start-relay.cmd           starts the relay
```
