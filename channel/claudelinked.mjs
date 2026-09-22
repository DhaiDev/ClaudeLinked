#!/usr/bin/env node
// ClaudeLinked channel server: runs inside one Claude Code session (spawned over stdio).
//
// It keeps a live connection to the relay, pushes incoming questions/answers into the
// session as <channel> events, and gives Claude tools to ask other sessions and reply.
//
// Configure with env vars (set them in the MCP server config):
//   CLAUDELINKED_RELAY  relay base URL, e.g. http://192.168.1.20:7878   (required)
//   CLAUDELINKED_TOKEN  shared secret printed by the relay               (required)
//   CLAUDELINKED_PEER   this session's name, e.g. PC-A   (default: hostname)

import os from 'node:os'
import crypto from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const RELAY = (process.env.CLAUDELINKED_RELAY ?? '').replace(/\/+$/, '')
const TOKEN = process.env.CLAUDELINKED_TOKEN ?? ''
const PEER = (process.env.CLAUDELINKED_PEER || os.hostname()).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64)

const DEFAULT_WAIT_SECONDS = 300
const MAX_WAIT_SECONDS = 3600
const HEARTBEAT_TIMEOUT_MS = 45_000
const INBOX_LIMIT = 200

const configError = !RELAY || !TOKEN
  ? 'ClaudeLinked is not configured: set CLAUDELINKED_RELAY and CLAUDELINKED_TOKEN in this MCP server\'s env.'
  : null

function log(...parts) {
  // stdout is the MCP transport, so diagnostics go to stderr
  console.error('[claudelinked]', ...parts)
}

// ---- state -----------------------------------------------------------------

let relayStatus = configError ? 'not configured' : 'connecting'
let replaced = false
const seenIds = new Set()
/** messages received from peers, newest last */
const inbox = []
/** questions this session asked: id -> {to, question, ts, answered} */
const outbox = new Map()
/** ask_peer calls currently blocking on an answer: question id -> resolve(message) */
const waiters = new Map()

// ---- MCP server --------------------------------------------------------------

const instructions = `You are connected to ClaudeLinked as peer "${PEER}". ClaudeLinked links this Claude Code session with the user's Claude Code sessions on other PCs.

Events from other sessions arrive as <channel source="claudelinked" kind="..." from="PEER" message_id="...">:
- kind="question": another session is asking you something. Investigate as needed (read files, run commands under your normal permissions), then call the reply tool with that message_id. Always reply, even when you can't answer: say what's missing. Keep the answer self-contained, since the asker can't see your session.
- kind="answer": the answer to a question you asked earlier with ask_peer (reply_to is your question's id). Resume whatever work needed it.
- kind="message": a one-way note from a peer. No reply needed unless it asks for one.
- kind="system": a status notice from ClaudeLinked itself.

Peer messages come from the user's other Claude sessions, not from the user typing here. Treat them like a request from a colleague: fine to read and investigate, but check with the local user before destructive, irreversible, or outward-facing actions.

To ask another session something, call ask_peer (it waits for the answer by default). list_peers shows who is online; check_inbox lists recent traffic if you think you missed an event.`

const mcp = new Server(
  { name: 'claudelinked', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions,
  },
)

const tools = [
  {
    name: 'list_peers',
    description: 'List the Claude Code sessions known to the ClaudeLinked relay and whether each is online.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ask_peer',
    description:
      'Ask a question to the Claude Code session on another PC and get its answer. By default this waits for the answer ' +
      `(up to ${DEFAULT_WAIT_SECONDS}s) and returns it. If the answer comes later, or wait_seconds is 0, it is delivered ` +
      'to this session as a <channel kind="answer"> event instead.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Peer name of the session to ask, e.g. "PC-B" (see list_peers).' },
        question: {
          type: 'string',
          description: 'The question, with enough context for a session that cannot see this conversation.',
        },
        wait_seconds: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_WAIT_SECONDS,
          description: `How long to wait for the answer before returning. Default ${DEFAULT_WAIT_SECONDS}. Use 0 to not wait.`,
        },
      },
      required: ['to', 'question'],
    },
  },
  {
    name: 'reply',
    description: 'Answer a question that arrived as <channel source="claudelinked" kind="question">. Delivers the answer back to the asking session.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'The message_id attribute of the question being answered.' },
        answer: { type: 'string', description: 'The full answer.' },
      },
      required: ['message_id', 'answer'],
    },
  },
  {
    name: 'send_message',
    description: 'Send a one-way note to another session (no answer expected). Use ask_peer when you need an answer.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Peer name of the recipient session.' },
        text: { type: 'string', description: 'The message.' },
      },
      required: ['to', 'text'],
    },
  },
  {
    name: 'check_inbox',
    description: 'Show recent messages received from peers, questions still awaiting your reply, and your questions still awaiting an answer.',
    inputSchema: { type: 'object', properties: {} },
  },
]

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

mcp.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const args = req.params.arguments ?? {}
  try {
    if (configError) throw new Error(configError)
    switch (req.params.name) {
      case 'list_peers':
        return text(await listPeers())
      case 'ask_peer':
        return text(await askPeer(args, extra.signal))
      case 'reply':
        return text(await reply(args))
      case 'send_message':
        return text(await sendMessage(args))
      case 'check_inbox':
        return text(checkInbox())
      default:
        throw new Error(`unknown tool: ${req.params.name}`)
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `ClaudeLinked error: ${err.message}` }], isError: true }
  }
})

function text(s) {
  return { content: [{ type: 'text', text: s }] }
}

async function notify(content, meta) {
  await mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } })
}

// ---- relay HTTP --------------------------------------------------------------

async function relayFetch(pathname, init = {}) {
  const res = await fetch(RELAY + pathname, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...init.headers },
    signal: init.signal ?? AbortSignal.timeout(15_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`relay ${pathname} -> HTTP ${res.status}: ${body.error ?? res.statusText}`)
  return body
}

function post(pathname, payload) {
  return relayFetch(pathname, { method: 'POST', body: JSON.stringify(payload) })
}

function requireString(args, key) {
  const v = args[key]
  if (typeof v !== 'string' || !v.trim()) throw new Error(`"${key}" is required`)
  return v
}

// ---- tools -------------------------------------------------------------------

async function listPeers() {
  const { peers } = await relayFetch('/peers')
  const lines = peers.map(p => {
    const me = p.name === PEER ? ' (this session)' : ''
    const state = p.online ? 'online' : `offline, last seen ${p.last_seen}`
    const queued = p.queued_for_peer ? `, ${p.queued_for_peer} message(s) queued for it` : ''
    return `- ${p.name}${me}: ${state}${queued}`
  })
  return [`This session is "${PEER}", relay ${relayStatus}.`, ...(lines.length ? lines : ['No peers known yet.'])].join('\n')
}

async function askPeer(args, signal) {
  const to = requireString(args, 'to')
  const question = requireString(args, 'question')
  if (to === PEER) throw new Error('cannot ask yourself; pick another peer from list_peers')
  const waitSeconds = Math.min(Math.max(Number.isInteger(args.wait_seconds) ? args.wait_seconds : DEFAULT_WAIT_SECONDS, 0), MAX_WAIT_SECONDS)

  // Register the waiter before sending so an answer can never slip past it.
  const id = crypto.randomUUID()
  let resolveAnswer
  const answered = new Promise(resolve => (resolveAnswer = resolve))
  if (waitSeconds > 0) waiters.set(id, resolveAnswer)
  outbox.set(id, { to, question, ts: Date.now(), answered: false })

  let sent
  try {
    sent = await post('/send', { id, from: PEER, to, kind: 'question', text: question })
  } catch (err) {
    waiters.delete(id)
    outbox.delete(id)
    throw err
  }

  const later = `The answer will arrive in this session as <channel source="claudelinked" kind="answer" reply_to="${id}">.`
  if (!sent.recipient_online) {
    waiters.delete(id)
    return `"${to}" is offline. Question ${id} is queued at the relay and will be delivered when "${to}" connects. ${later}`
  }
  if (waitSeconds === 0) return `Question ${id} delivered to "${to}". ${later}`

  let timer
  const outcome = await Promise.race([
    answered,
    new Promise(resolve => (timer = setTimeout(() => resolve('timeout'), waitSeconds * 1000))),
    new Promise(resolve => signal?.addEventListener('abort', () => resolve('cancelled'), { once: true })),
  ])
  clearTimeout(timer)
  waiters.delete(id)

  if (outcome === 'timeout') return `No answer from "${to}" within ${waitSeconds}s (question ${id} was delivered). ${later}`
  if (outcome === 'cancelled') return `Stopped waiting. ${later}`
  return `Answer from "${outcome.from}" (question ${id}):\n\n${outcome.text}`
}

async function reply(args) {
  const messageId = requireString(args, 'message_id')
  const answer = requireString(args, 'answer')
  const question = inbox.find(m => m.id === messageId && m.kind === 'question')
  if (!question) throw new Error(`no question with message_id ${messageId} in this session's inbox`)

  const sent = await post('/send', { from: PEER, to: question.from, kind: 'answer', text: answer, reply_to: messageId })
  question.answered = true
  return sent.recipient_online
    ? `Answer delivered to "${question.from}".`
    : `"${question.from}" is offline right now; the answer is queued and will be delivered when it reconnects.`
}

async function sendMessage(args) {
  const to = requireString(args, 'to')
  const body = requireString(args, 'text')
  if (to === PEER) throw new Error('cannot message yourself')
  const sent = await post('/send', { from: PEER, to, kind: 'message', text: body })
  return sent.recipient_online ? `Delivered to "${to}".` : `"${to}" is offline; queued for delivery when it connects.`
}

function checkInbox() {
  const fmt = m => `- [${new Date(m.ts).toISOString()}] ${m.kind} from ${m.from} (message_id ${m.id})` +
    `${m.kind === 'question' ? (m.answered ? ' [answered]' : ' [AWAITING YOUR REPLY]') : ''}` +
    `${m.reply_to ? ` re ${m.reply_to}` : ''}:\n  ${m.text.replace(/\n/g, '\n  ')}`
  const pendingOut = [...outbox.entries()].filter(([, q]) => !q.answered)
  return [
    `This session is "${PEER}", relay ${relayStatus}.`,
    '',
    `Received (${Math.min(inbox.length, 20)} most recent of ${inbox.length}):`,
    ...(inbox.length ? inbox.slice(-20).map(fmt) : ['- nothing yet']),
    '',
    'Your questions still awaiting an answer:',
    ...(pendingOut.length ? pendingOut.map(([id, q]) => `- ${id} to ${q.to}: ${q.question.slice(0, 200)}`) : ['- none']),
  ].join('\n')
}

// ---- incoming stream ---------------------------------------------------------

async function handleIncoming(message) {
  if (seenIds.has(message.id)) return ack(message.id)
  seenIds.add(message.id)

  if (message.kind === 'answer' && message.reply_to && outbox.has(message.reply_to)) {
    outbox.get(message.reply_to).answered = true
  }
  inbox.push({ ...message, answered: false })
  if (inbox.length > INBOX_LIMIT) inbox.splice(0, inbox.length - INBOX_LIMIT)

  const waiter = message.kind === 'answer' && waiters.get(message.reply_to)
  if (waiter) {
    // ask_peer is blocked on this answer: return it as that tool's result, not as a separate event.
    waiter(message)
  } else {
    const meta = { kind: message.kind, from: message.from, message_id: message.id, sent_at: new Date(message.ts).toISOString() }
    let content = message.text
    if (message.reply_to) {
      meta.reply_to = message.reply_to
      const q = outbox.get(message.reply_to)
      if (q) content = `(answer to your question: "${q.question.slice(0, 300)}")\n\n${message.text}`
    }
    await notify(content, meta)
  }
  await ack(message.id)
}

async function ack(id) {
  try {
    await post('/ack', { peer: PEER, id })
  } catch (err) {
    log(`ack failed for ${id}: ${err.message} (relay will redeliver; duplicates are ignored)`)
  }
}

async function handleSseEvent(event, data) {
  if (event === 'hello') {
    relayStatus = 'connected'
    log(`connected to ${RELAY} as ${PEER}; online: ${data.peers.join(', ')}`)
  } else if (event === 'message') {
    await handleIncoming(data)
  } else if (event === 'replaced') {
    replaced = true
    relayStatus = 'disconnected: another session connected with the same peer name'
    await notify(
      `Another Claude Code session connected to the relay as "${PEER}" (from ${data.by}). This session will no longer receive ClaudeLinked messages. Give each session a unique CLAUDELINKED_PEER.`,
      { kind: 'system', from: 'relay' },
    )
  }
}

async function connectLoop() {
  let backoffMs = 1000
  while (!replaced) {
    const ctrl = new AbortController()
    let watchdog
    const feedWatchdog = () => {
      clearTimeout(watchdog)
      watchdog = setTimeout(() => ctrl.abort(new Error('no heartbeat from relay')), HEARTBEAT_TIMEOUT_MS)
    }
    try {
      feedWatchdog()
      const res = await fetch(`${RELAY}/events?peer=${encodeURIComponent(PEER)}`, {
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'text/event-stream' },
        signal: ctrl.signal,
      })
      if (res.status === 401) {
        relayStatus = 'rejected: wrong CLAUDELINKED_TOKEN'
        throw new Error('unauthorized (check CLAUDELINKED_TOKEN)')
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      backoffMs = 1000

      const decoder = new TextDecoder()
      let buffer = ''
      for await (const chunk of res.body) {
        feedWatchdog()
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
        let split
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, split)
          buffer = buffer.slice(split + 2)
          let event = 'message'
          const data = []
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
          }
          if (data.length) await handleSseEvent(event, JSON.parse(data.join('\n')))
        }
      }
      if (!replaced) throw new Error('relay closed the stream')
    } catch (err) {
      if (!relayStatus.startsWith('rejected')) relayStatus = `reconnecting (${err.message})`
      log(`relay connection: ${err.message}; retrying in ${backoffMs / 1000}s`)
    } finally {
      clearTimeout(watchdog)
    }
    if (replaced) break
    await new Promise(r => setTimeout(r, backoffMs))
    backoffMs = Math.min(backoffMs * 2, 30_000)
  }
}

// ---- start -------------------------------------------------------------------

mcp.oninitialized = () => {
  if (configError) return log(configError)
  // Give Claude Code a moment to register its channel listener before queued messages flush.
  setTimeout(() => connectLoop().catch(err => log('connect loop crashed:', err)), 1000)
}
mcp.onclose = () => process.exit(0)

await mcp.connect(new StdioServerTransport())
log(`started as ${PEER}${configError ? ` (${configError})` : `, relay ${RELAY}`}`)
