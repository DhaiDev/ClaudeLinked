#!/usr/bin/env node
// ClaudeLinked relay: routes messages between Claude Code sessions on different PCs.
//
// Each session's channel server holds one Server-Sent Events stream open (GET /events)
// and sends with POST /send. Messages for a peer that is offline are queued (and
// persisted to disk) until that peer connects and acknowledges them.
//
//   node relay/server.mjs [--port 7878] [--host 0.0.0.0] [--token <secret>] [--data <dir>]
//
// Env equivalents: CLAUDELINKED_PORT, CLAUDELINKED_HOST, CLAUDELINKED_TOKEN, CLAUDELINKED_DATA.

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

function arg(name, envName, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]
  return process.env[envName] ?? fallback
}

const PORT = Number(arg('port', 'CLAUDELINKED_PORT', 7878))
const HOST = arg('host', 'CLAUDELINKED_HOST', '0.0.0.0')
const DATA_DIR = path.resolve(arg('data', 'CLAUDELINKED_DATA', path.join(here, '..', 'relay-data')))
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json')
const TOKEN_FILE = path.join(DATA_DIR, 'token.txt')

const MAX_BODY_BYTES = 1024 * 1024
const MAX_TEXT_CHARS = 200_000
const HEARTBEAT_MS = 15_000
const QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const PEER_NAME = /^[A-Za-z0-9._-]{1,64}$/
const KINDS = new Set(['question', 'answer', 'message'])

fs.mkdirSync(DATA_DIR, { recursive: true })

let TOKEN = arg('token', 'CLAUDELINKED_TOKEN', '')
if (!TOKEN) {
  if (fs.existsSync(TOKEN_FILE)) {
    TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
  } else {
    TOKEN = crypto.randomBytes(24).toString('base64url')
    fs.writeFileSync(TOKEN_FILE, TOKEN + '\n')
    console.log(`[relay] generated a new token and saved it to ${TOKEN_FILE}`)
  }
}

// ---- state -----------------------------------------------------------------

/** @type {Map<string, {res: http.ServerResponse, since: number, remote: string}>} */
const connections = new Map()
/** @type {Map<string, number>} last time each peer was connected */
const lastSeen = new Map()
/** @type {Array<object>} messages not yet acknowledged by their recipient */
let queue = []

try {
  queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'))
} catch {
  queue = []
}

function saveQueue() {
  const cutoff = Date.now() - QUEUE_TTL_MS
  queue = queue.filter(m => m.ts >= cutoff)
  const tmp = QUEUE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(queue, null, 2))
  fs.renameSync(tmp, QUEUE_FILE)
}

function log(...parts) {
  console.log(new Date().toISOString(), ...parts)
}

// ---- helpers ---------------------------------------------------------------

function authorized(req) {
  const header = req.headers.authorization ?? ''
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
  const expected = Buffer.from(TOKEN)
  return given.length === expected.length && crypto.timingSafeEqual(given, expected)
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function deliver(message) {
  const conn = connections.get(message.to)
  if (!conn) return false
  sse(conn.res, 'message', message)
  return true
}

// ---- routes ----------------------------------------------------------------

function handleEvents(req, res, url) {
  const peer = url.searchParams.get('peer') ?? ''
  if (!PEER_NAME.test(peer)) return json(res, 400, { error: 'peer must match [A-Za-z0-9._-]{1,64}' })

  const previous = connections.get(peer)
  if (previous) {
    // Newest connection wins: a restarted session on the same PC takes over its name.
    sse(previous.res, 'replaced', { peer, by: req.socket.remoteAddress })
    previous.res.end()
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write(': connected\n\n')

  const conn = { res, since: Date.now(), remote: req.socket.remoteAddress }
  connections.set(peer, conn)
  lastSeen.set(peer, Date.now())
  log(`[relay] ${peer} connected from ${conn.remote}`)

  sse(res, 'hello', { peer, peers: onlinePeers() })
  for (const m of queue.filter(m => m.to === peer)) sse(res, 'message', m)

  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS)
  req.on('close', () => {
    clearInterval(heartbeat)
    if (connections.get(peer) === conn) {
      connections.delete(peer)
      lastSeen.set(peer, Date.now())
      log(`[relay] ${peer} disconnected`)
    }
  })
}

async function handleSend(req, res) {
  const body = await readJson(req)
  const { id, from, to, kind, text, reply_to = null } = body
  // Senders may choose the id so they can start waiting for an answer before the send returns.
  if (id !== undefined && !/^[A-Za-z0-9-]{8,64}$/.test(id)) return json(res, 400, { error: 'id must match [A-Za-z0-9-]{8,64}' })
  if (id !== undefined && queue.some(m => m.id === id)) return json(res, 409, { error: 'duplicate id' })
  if (!PEER_NAME.test(from ?? '') || !PEER_NAME.test(to ?? '')) {
    return json(res, 400, { error: 'from and to must be peer names' })
  }
  if (!KINDS.has(kind)) return json(res, 400, { error: `kind must be one of ${[...KINDS].join(', ')}` })
  if (typeof text !== 'string' || !text.trim()) return json(res, 400, { error: 'text is required' })
  if (text.length > MAX_TEXT_CHARS) return json(res, 413, { error: `text exceeds ${MAX_TEXT_CHARS} chars` })

  const message = {
    id: id ?? crypto.randomUUID(),
    from,
    to,
    kind,
    text,
    reply_to: typeof reply_to === 'string' ? reply_to : null,
    ts: Date.now(),
  }
  queue.push(message)
  saveQueue()
  const delivered = deliver(message)
  log(`[relay] ${kind} ${from} -> ${to} ${message.id}${delivered ? '' : ' (queued, recipient offline)'}`)
  json(res, 200, { id: message.id, delivered, recipient_online: connections.has(to) })
}

async function handleAck(req, res) {
  const { peer, id } = await readJson(req)
  const before = queue.length
  queue = queue.filter(m => !(m.id === id && m.to === peer))
  if (queue.length !== before) saveQueue()
  json(res, 200, { ok: true, removed: before - queue.length })
}

function onlinePeers() {
  return [...connections.keys()].sort()
}

function handlePeers(res) {
  const names = new Set([...connections.keys(), ...lastSeen.keys()])
  const peers = [...names].sort().map(name => ({
    name,
    online: connections.has(name),
    connected_since: connections.has(name) ? new Date(connections.get(name).since).toISOString() : null,
    last_seen: new Date(connections.has(name) ? Date.now() : lastSeen.get(name)).toISOString(),
    queued_for_peer: queue.filter(m => m.to === name).length,
  }))
  json(res, 200, { peers })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://relay')
  try {
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true })
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized: wrong or missing token' })

    if (req.method === 'GET' && url.pathname === '/events') return handleEvents(req, res, url)
    if (req.method === 'GET' && url.pathname === '/peers') return handlePeers(res)
    if (req.method === 'POST' && url.pathname === '/send') return await handleSend(req, res)
    if (req.method === 'POST' && url.pathname === '/ack') return await handleAck(req, res)
    json(res, 404, { error: 'not found' })
  } catch (err) {
    if (!res.headersSent) json(res, err.status ?? 500, { error: err.message })
  }
})

server.listen(PORT, HOST, () => {
  log(`[relay] ClaudeLinked relay listening on http://${HOST}:${PORT}`)
  if (HOST === '0.0.0.0') {
    const addresses = Object.values(os.networkInterfaces()).flat().filter(a => a.family === 'IPv4' && !a.internal)
    for (const a of addresses) log(`[relay] reachable at http://${a.address}:${PORT}`)
  }
  log(`[relay] token: ${TOKEN}`)
  log(`[relay] ${queue.length} queued message(s) loaded from ${QUEUE_FILE}`)
})
