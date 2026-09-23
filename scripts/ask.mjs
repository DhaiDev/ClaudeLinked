#!/usr/bin/env node
// Ask a connected Claude Code session a question from the command line, and print its answer.
// Handy for testing ClaudeLinked without a second PC, and for scripts that want an answer.
//
//   node scripts/ask.mjs --to PC-B "What is in your working directory?"
//   node scripts/ask.mjs --list
//
// Relay URL and token come from config/claudelinked.mcp.json unless you pass --relay/--token.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

let relay = arg('relay')
let token = arg('token')
if (!relay || !token) {
  const configPath = path.join(root, 'config', 'claudelinked.mcp.json')
  if (!fs.existsSync(configPath)) {
    console.error(`No --relay/--token given and no config at ${configPath}. Run scripts/setup.mjs first.`)
    process.exit(1)
  }
  const env = JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers.claudelinked.env
  relay ??= env.CLAUDELINKED_RELAY
  token ??= env.CLAUDELINKED_TOKEN
}
relay = relay.replace(/\/+$/, '')

const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
const call = async (pathname, init) => {
  const res = await fetch(relay + pathname, { headers, ...init })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${pathname} -> HTTP ${res.status}: ${body.error ?? res.statusText}`)
  return body
}

if (process.argv.includes('--list')) {
  const { peers } = await call('/peers')
  for (const p of peers) console.log(`${p.name}: ${p.online ? 'online' : `offline (last seen ${p.last_seen})`}`)
  process.exit(0)
}

const to = arg('to')
const me = arg('as', 'cli')
const waitSeconds = Number(arg('wait', 300))
const flagsWithValue = new Set(['to', 'as', 'wait', 'relay', 'token'])
const words = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) words.push(argv[i])
  else if (flagsWithValue.has(argv[i].slice(2))) i++
}
const question = words.join(' ')

if (!to || !question) {
  console.error('usage: node scripts/ask.mjs --to <peer> "<question>"   [--as <name>] [--wait <seconds>] [--list]')
  process.exit(1)
}

// Listen first, so the answer can't arrive before we're watching for it.
const ctrl = new AbortController()
const stream = await fetch(`${relay}/events?peer=${encodeURIComponent(me)}`, {
  headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
  signal: ctrl.signal,
})
if (!stream.ok) throw new Error(`relay /events -> HTTP ${stream.status}`)

const id = crypto.randomUUID()
const sent = await call('/send', { method: 'POST', body: JSON.stringify({ id, from: me, to, kind: 'question', text: question }) })
console.error(sent.recipient_online
  ? `asked "${to}" (question ${id}), waiting up to ${waitSeconds}s for an answer...`
  : `"${to}" is offline; the question is queued and will be delivered when it connects. Waiting up to ${waitSeconds}s...`)

const timer = setTimeout(() => {
  console.error(`No answer within ${waitSeconds}s. The question is still queued for "${to}".`)
  ctrl.abort()
  process.exit(2)
}, waitSeconds * 1000)

const decoder = new TextDecoder()
let buffer = ''
for await (const chunk of stream.body) {
  buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
  let split
  while ((split = buffer.indexOf('\n\n')) !== -1) {
    const raw = buffer.slice(0, split)
    buffer = buffer.slice(split + 2)
    const data = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
    if (!data) continue
    const message = JSON.parse(data)
    if (message.kind !== 'answer' || message.reply_to !== id) continue
    clearTimeout(timer)
    await call('/ack', { method: 'POST', body: JSON.stringify({ peer: me, id: message.id }) })
    console.log(message.text)
    ctrl.abort()
    process.exit(0)
  }
}
