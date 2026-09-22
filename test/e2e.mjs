// End-to-end test: a real relay plus two real channel servers, driven the way Claude Code
// drives them (MCP over stdio, channel events captured as notifications).
//
//   node test/e2e.mjs

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 17000 + Math.floor(Math.random() * 1000)
const RELAY = `http://127.0.0.1:${PORT}`
const TOKEN = 'test-token-' + Math.random().toString(36).slice(2)
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudelinked-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))

const relay = spawn(process.execPath, [path.join(root, 'relay/server.mjs'), '--port', PORT, '--host', '127.0.0.1', '--token', TOKEN, '--data', dataDir], { stdio: ['ignore', 'pipe', 'inherit'] })
await new Promise((resolve, reject) => {
  relay.stdout.on('data', d => d.toString().includes('listening') && resolve())
  relay.on('exit', code => reject(new Error(`relay exited ${code}`)))
})

/** Start a channel server as Claude Code would, collecting its <channel> events. */
async function session(peer, token = TOKEN) {
  const events = []
  const client = new Client({ name: 'fake-claude-code', version: '0' })
  client.fallbackNotificationHandler = async n => {
    if (n.method === 'notifications/claude/channel') events.push(n.params)
  }
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'channel/claudelinked.mjs')],
    env: { ...process.env, CLAUDELINKED_RELAY: RELAY, CLAUDELINKED_TOKEN: token, CLAUDELINKED_PEER: peer },
    stderr: 'ignore',
  }))
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args })
    return { text: r.content[0].text, isError: !!r.isError }
  }
  const nextEvent = async (pred, timeoutMs = 8000) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const i = events.findIndex(pred)
      if (i !== -1) return events.splice(i, 1)[0]
      await sleep(50)
    }
    throw new Error(`${peer}: timed out waiting for channel event`)
  }
  return { peer, client, call, events, nextEvent, close: () => client.close() }
}

async function waitOnline(s, peer) {
  for (let i = 0; i < 100; i++) {
    if ((await s.call('list_peers')).text.includes(`${peer}: online`) || (await s.call('list_peers')).text.includes(`${peer} (this session): online`)) return
    await sleep(100)
  }
  throw new Error(`${peer} never came online`)
}

let passed = 0
async function test(name, fn) {
  await fn()
  passed++
  console.log(`  ok  ${name}`)
}

try {
  const A = await session('PC-A')
  const B = await session('PC-B')
  await waitOnline(A, 'PC-A')
  await waitOnline(A, 'PC-B')

  await test('tools are listed', async () => {
    const { tools } = await A.client.listTools()
    assert.deepEqual(tools.map(t => t.name).sort(), ['ask_peer', 'check_inbox', 'list_peers', 'reply', 'send_message'])
  })

  await test('list_peers shows both sessions online', async () => {
    const { text } = await A.call('list_peers')
    assert.match(text, /PC-A \(this session\): online/)
    assert.match(text, /PC-B: online/)
  })

  await test('A asks B and gets the answer back as the tool result (blocking)', async () => {
    const pending = A.call('ask_peer', { to: 'PC-B', question: 'What port does the API use?', wait_seconds: 10 })
    const q = await B.nextEvent(e => e.meta.kind === 'question')
    assert.equal(q.content, 'What port does the API use?')
    assert.equal(q.meta.from, 'PC-A')
    assert.match(q.meta.message_id, /^[0-9a-f-]{36}$/)
    for (const key of Object.keys(q.meta)) assert.match(key, /^[A-Za-z0-9_]+$/, 'meta keys must be identifiers')

    const r = await B.call('reply', { message_id: q.meta.message_id, answer: 'Port 8080, see config/api.json' })
    assert.equal(r.text, 'Answer delivered to "PC-A".')

    const answer = await pending
    assert.equal(answer.isError, false)
    assert.match(answer.text, /^Answer from "PC-B"/)
    assert.match(answer.text, /Port 8080, see config\/api.json/)
    await sleep(300)
    assert.equal(A.events.length, 0, 'answer consumed by the tool must not also arrive as a channel event')
  })

  await test('A asks without waiting; the answer arrives in A as a channel event', async () => {
    const r = await A.call('ask_peer', { to: 'PC-B', question: 'Which branch are you on?', wait_seconds: 0 })
    const qid = r.text.match(/Question ([0-9a-f-]{36})/)[1]
    const q = await B.nextEvent(e => e.meta.kind === 'question')
    assert.equal(q.meta.message_id, qid)
    await B.call('reply', { message_id: qid, answer: 'feature/login' })
    const ans = await A.nextEvent(e => e.meta.kind === 'answer')
    assert.equal(ans.meta.reply_to, qid)
    assert.equal(ans.meta.from, 'PC-B')
    assert.match(ans.content, /Which branch are you on\?/)
    assert.match(ans.content, /feature\/login/)
  })

  await test('an answer that misses the wait window is still delivered as an event', async () => {
    const r = await A.call('ask_peer', { to: 'PC-B', question: 'Slow question', wait_seconds: 1 })
    assert.match(r.text, /No answer from "PC-B" within 1s/)
    const q = await B.nextEvent(e => e.meta.kind === 'question')
    await B.call('reply', { message_id: q.meta.message_id, answer: 'late but here' })
    const ans = await A.nextEvent(e => e.meta.kind === 'answer')
    assert.equal(ans.meta.reply_to, q.meta.message_id)
    assert.match(ans.content, /late but here/)
  })

  await test('B can ask A too (both directions)', async () => {
    const pending = B.call('ask_peer', { to: 'PC-A', question: 'Ready to deploy?', wait_seconds: 10 })
    const q = await A.nextEvent(e => e.meta.kind === 'question')
    await A.call('reply', { message_id: q.meta.message_id, answer: 'yes' })
    assert.match((await pending).text, /Answer from "PC-A"[\s\S]*yes/)
  })

  await test('send_message delivers a one-way note', async () => {
    assert.equal((await B.call('send_message', { to: 'PC-A', text: 'build finished' })).text, 'Delivered to "PC-A".')
    const m = await A.nextEvent(e => e.meta.kind === 'message')
    assert.equal(m.content, 'build finished')
  })

  await test('reply to an unknown message_id is an error', async () => {
    const r = await B.call('reply', { message_id: 'nope-nope-nope', answer: 'x' })
    assert.equal(r.isError, true)
  })

  let B2
  await test('question to an offline peer is queued and delivered when it reconnects', async () => {
    await B.close()
    for (let i = 0; i < 50 && (await A.call('list_peers')).text.includes('PC-B: online'); i++) await sleep(100)

    const r = await A.call('ask_peer', { to: 'PC-B', question: 'Are you back?' })
    assert.match(r.text, /"PC-B" is offline\. Question .* is queued/)

    B2 = await session('PC-B')
    const q = await B2.nextEvent(e => e.meta.kind === 'question')
    assert.equal(q.content, 'Are you back?')
    await B2.call('reply', { message_id: q.meta.message_id, answer: 'back online' })
    const ans = await A.nextEvent(e => e.meta.kind === 'answer')
    assert.match(ans.content, /back online/)
  })

  await test('delivered messages are acknowledged and not redelivered', async () => {
    await sleep(300)
    const queue = JSON.parse(fs.readFileSync(path.join(dataDir, 'queue.json'), 'utf8'))
    assert.equal(queue.length, 0)
  })

  await test('check_inbox reports answered questions', async () => {
    const { text } = await B2.call('check_inbox')
    assert.match(text, /question from PC-A .*\[answered\]/)
    assert.doesNotMatch(text, /AWAITING YOUR REPLY/)
  })

  await test('a wrong token is rejected', async () => {
    const bad = await session('PC-X', 'wrong-token')
    const r = await bad.call('list_peers')
    assert.equal(r.isError, true)
    assert.match(r.text, /401/)
    await bad.close()
  })

  await test('a second session with the same name takes over and the old one is told', async () => {
    const B3 = await session('PC-B')
    const notice = await B2.nextEvent(e => e.meta.kind === 'system')
    assert.match(notice.content, /same peer name|connected to the relay as "PC-B"/)
    const pending = A.call('ask_peer', { to: 'PC-B', question: 'who has PC-B now?', wait_seconds: 10 })
    const q = await B3.nextEvent(e => e.meta.kind === 'question')
    await B3.call('reply', { message_id: q.meta.message_id, answer: 'the newest session' })
    assert.match((await pending).text, /the newest session/)
    await B3.close()
  })

  await Promise.allSettled([A.close(), B2?.close()])
  console.log(`\n${passed} passed`)
} catch (err) {
  console.error(`\nFAILED after ${passed} passed:`, err)
  process.exitCode = 1
} finally {
  relay.kill()
  fs.rmSync(dataDir, { recursive: true, force: true })
  setTimeout(() => process.exit(), 200)
}
