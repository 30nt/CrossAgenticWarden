#!/usr/bin/env node

// Deterministic `codex exec --json` stand-in. It keeps the event stream on stdout and writes the
// canonical final object only to --output-last-message, matching the measured native transport.

import { appendFileSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

if (process.argv.includes('--version')) {
  process.stdout.write(`${process.env.CAW_FAKE_CODEX_VERSION || 'codex-cli 0.150.0-alpha.12.2'}\n`)
  process.exit(0)
}

const queuePath = process.env.CAW_FAKE_QUEUE
const callsPath = process.env.CAW_FAKE_CALLS
if (!queuePath || !callsPath) {
  process.stderr.write('CAW_FAKE_QUEUE and CAW_FAKE_CALLS are required\n')
  process.exit(64)
}

const arg = (name) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1]
}
const input = readFileSync(0, 'utf8')
const queue = JSON.parse(readFileSync(queuePath, 'utf8'))
if (!Array.isArray(queue) || !queue.length) {
  process.stderr.write('fake provider response queue is empty\n')
  process.exit(65)
}
const role = process.env.CAW_ROLE || ''
const selected = queue.findIndex((entry) => !entry.role || entry.role === role)
const index = selected === -1 ? 0 : selected
const next = queue[index]
queue.splice(0, index + 1)
const DENIED_BY_BOUNDARY = new Set(['EPERM', 'EROFS', 'EACCES'])
const denied = (error) => DENIED_BY_BOUNDARY.has(error?.code)

try { writeFileSync(queuePath, `${JSON.stringify(queue, null, 2)}\n`) }
catch (error) { if (!denied(error)) throw error }

const schemaPath = arg('--output-schema')
const finalResponsePath = arg('--output-last-message')
const call = {
  provider: 'codex',
  argv: process.argv.slice(2),
  input,
  cwd: process.cwd(),
  role,
  cawSpec: process.env.CAW_SPEC ?? null,
  schema: schemaPath ? JSON.parse(readFileSync(schemaPath, 'utf8')) : null,
  schemaMode: schemaPath ? lstatSync(schemaPath).mode & 0o777 : null,
  transportMode: finalResponsePath ? lstatSync(dirname(finalResponsePath)).mode & 0o777 : null,
  finalResponsePath,
}
try { appendFileSync(callsPath, `${JSON.stringify(call)}\n`) }
catch (error) { if (!denied(error)) throw error }
try { appendFileSync(resolve(process.cwd(), '.fake-codex-calls.jsonl'), `${JSON.stringify(call)}\n`) }
catch (error) { if (!denied(error)) throw error }

if (next.probeWrites) {
  const match = input.match(/write ("(?:\\.|[^"\\])*") to ("(?:\\.|[^"\\])*") and to ("(?:\\.|[^"\\])*")/i)
  if (!match) throw new Error(`could not parse Codex probe prompt: ${input}`)
  const sentinel = JSON.parse(match[1])
  const inside = JSON.parse(match[2])
  const outside = JSON.parse(match[3])
  next.writeFiles = { ...(next.writeFiles || {}), [inside]: sentinel,
    ...(next.probeWrites === 'escape' ? { [outside]: sentinel } : {}) }
}

if (next.probeReads) {
  const value = next.value ?? next.envelope?.structured_output ?? next.structured_output ?? next
  value.observed_nonce = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8')
}

for (const [path, body] of Object.entries(next.writeFiles || {})) {
  const target = resolve(process.cwd(), path)
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
  } catch (error) {
    if (!next.probeWrites || !denied(error)) throw error
  }
}

if (next.status) {
  const events = next.events || [
    { type: 'turn.failed', error: { message: next.error || 'fake Codex failure' } },
  ]
  process.stdout.write(events.map((event) => JSON.stringify(event)).join('\n') + '\n')
  if (next.stderr) process.stderr.write(next.stderr)
  process.exit(next.status)
}

const value = next.value ?? next.envelope?.structured_output ?? next.structured_output ?? next
const body = next.finalText ?? `${JSON.stringify(value)}\n`
if (finalResponsePath && next.finalSymlink) symlinkSync(next.finalSymlink, finalResponsePath)
else if (finalResponsePath) writeFileSync(finalResponsePath, body)
const events = next.events || [
  { type: 'thread.started', thread_id: 'fake-thread' },
  { type: 'turn.completed', usage: {
    input_tokens: 17,
    cached_input_tokens: 5,
    output_tokens: 7,
    reasoning_output_tokens: 2,
  } },
]
process.stdout.write(events.map((event) => JSON.stringify(event)).join('\n') + '\n')
