#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'

const [authCopyArg, executable, ...args] = process.argv.slice(2)
if (!authCopyArg || !executable) {
  process.stderr.write('Codex runner requires an auth-copy marker and executable\n')
  process.exit(64)
}

const authCopyPath = authCopyArg === '-' ? null : authCopyArg
const removeAuthCopy = () => {
  if (authCopyPath) rmSync(authCopyPath, { force: true })
}

const child = spawn(executable, args, {
  cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
})
process.stdin.pipe(child.stdin)
child.stderr.pipe(process.stderr)

let pending = ''
child.stdout.on('data', (chunk) => {
  const text = chunk.toString()
  process.stdout.write(text)
  pending += text
  let newline
  while ((newline = pending.indexOf('\n')) !== -1) {
    const line = pending.slice(0, newline)
    pending = pending.slice(newline + 1)
    try {
      if (JSON.parse(line)?.type === 'thread.started') removeAuthCopy()
    } catch { /* non-JSON diagnostics are passed through unchanged */ }
  }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.on('error', (error) => {
  removeAuthCopy()
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 127
})
child.on('exit', (code, signal) => {
  removeAuthCopy()
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
