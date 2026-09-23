#!/usr/bin/env node
// Configure ClaudeLinked on this PC and check the relay is reachable.
//
//   node scripts/setup.mjs --peer PC-A --relay http://192.168.1.20:7878 --token <token from relay>

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : undefined
}

const peer = arg('peer')
const relay = arg('relay')?.replace(/\/+$/, '')
const token = arg('token')

if (!peer || !relay || !token) {
  console.error('usage: node scripts/setup.mjs --peer <name for this PC> --relay http://<relay host>:7878 --token <token>')
  process.exit(1)
}
if (!/^[A-Za-z0-9._-]{1,64}$/.test(peer)) {
  console.error('--peer may only contain letters, digits, dot, underscore and hyphen (max 64)')
  process.exit(1)
}
if (!fs.existsSync(path.join(root, 'node_modules', '@modelcontextprotocol', 'sdk'))) {
  console.error(`Dependencies are missing. Run "npm install" in ${root} first.`)
  process.exit(1)
}

const configDir = path.join(root, 'config')
fs.mkdirSync(configDir, { recursive: true })

const mcpConfig = {
  mcpServers: {
    claudelinked: {
      command: process.execPath,
      args: [path.join(root, 'channel', 'claudelinked.mjs')],
      env: { CLAUDELINKED_RELAY: relay, CLAUDELINKED_TOKEN: token, CLAUDELINKED_PEER: peer },
    },
  },
}
// Let the session use ClaudeLinked's own tools without a prompt, so an unattended session
// isn't stuck on "allow reply?" while the asker waits. Other tools keep your normal rules.
const settings = { permissions: { allow: ['mcp__claudelinked'] } }

fs.writeFileSync(path.join(configDir, 'claudelinked.mcp.json'), JSON.stringify(mcpConfig, null, 2) + '\n')
fs.writeFileSync(path.join(configDir, 'claudelinked.settings.json'), JSON.stringify(settings, null, 2) + '\n')
console.log(`Wrote config for peer "${peer}" to ${configDir}`)

try {
  const res = await fetch(`${relay}/peers`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
  if (res.status === 401) throw new Error('the relay rejected the token')
  if (!res.ok) throw new Error(`relay answered HTTP ${res.status}`)
  const { peers } = await res.json()
  const online = peers.filter(p => p.online).map(p => p.name)
  console.log(`Relay OK. Online now: ${online.length ? online.join(', ') : 'nobody yet'}`)
  if (online.includes(peer)) console.log(`Note: a session is already connected as "${peer}". Each PC needs a unique --peer.`)
} catch (err) {
  console.error(`Warning: relay check failed for ${relay}: ${err.cause?.code ?? err.message}`)
  if (!/token|HTTP/.test(err.message)) {
    console.error('Check the relay is running, the address/port is right, and the firewall on the relay PC allows the port.')
  }
  process.exitCode = 2
}

// Install the skill so Claude knows how to use ClaudeLinked in every project on this PC.
if (!process.argv.includes('--no-skill')) {
  const source = path.join(root, 'skills', 'claudelinked', 'SKILL.md')
  const target = path.join(os.homedir(), '.claude', 'skills', 'claudelinked', 'SKILL.md')
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
    console.log(`Installed the claudelinked skill to ${target}`)
  } catch (err) {
    console.error(`Warning: could not install the skill to ${target}: ${err.message}`)
  }
}

console.log(`\nStart Claude Code with ClaudeLinked from any project folder:\n  "${path.join(root, 'claude-linked.cmd')}"`)
