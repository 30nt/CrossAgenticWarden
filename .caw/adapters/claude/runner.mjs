#!/usr/bin/env node

import { spawn } from 'node:child_process'

const [executable, ...args] = process.argv.slice(2)
if (!executable) {
  process.stderr.write('Claude runner requires an executable\n')
  process.exit(64)
}

const positiveLimit = (name) => {
  const raw = process.env[name]
  if (!raw) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}
const toolEventLimit = positiveLimit('CAW_EXECUTOR_MAX_TOOL_EVENTS')
const eventByteLimit = positiveLimit('CAW_EXECUTOR_MAX_EVENT_BYTES')

const child = spawn(executable, args, {
  cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
})
process.stdin.pipe(child.stdin)
child.stderr.pipe(process.stderr)

let pending = ''
let toolEvents = 0
let eventBytes = 0
let budgetExceeded = null
let hardKill = null
const stopForBudget = (kind, observed, limit) => {
  if (budgetExceeded) return
  budgetExceeded = { kind, observed, limit }
  process.stderr.write(`\nCAW_EXECUTOR_BUDGET_EXHAUSTED ${kind} ${observed}/${limit}\n`)
  child.kill('SIGINT')
  hardKill = setTimeout(() => child.kill('SIGKILL'), 2000)
}

child.stdout.on('data', (chunk) => {
  const body = chunk.toString()
  process.stdout.write(body)
  eventBytes += chunk.length
  if (eventByteLimit && eventBytes > eventByteLimit) {
    stopForBudget('event-bytes', eventBytes, eventByteLimit)
  }
  pending += body
  let newline
  while ((newline = pending.indexOf('\n')) !== -1) {
    const line = pending.slice(0, newline)
    pending = pending.slice(newline + 1)
    try {
      const event = JSON.parse(line)
      const content = event?.message?.content
      toolEvents += Array.isArray(content)
        ? content.filter((item) => item?.type === 'tool_use').length : 0
      if (toolEventLimit && toolEvents >= toolEventLimit) {
        stopForBudget('tool-events', toolEvents, toolEventLimit)
      }
    } catch { /* non-JSON diagnostics pass through unchanged */ }
  }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.on('error', (error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 127
})
child.on('exit', (code, signal) => {
  if (hardKill) clearTimeout(hardKill)
  if (budgetExceeded) process.exitCode = 86
  else if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
