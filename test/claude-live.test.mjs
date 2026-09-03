import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import claude from '../.caw/adapters/claude/adapter.mjs'

test('live Claude child excludes operator agents while retaining project hooks and authentication', {
  skip: process.env.CAW_LIVE_CLAUDE !== '1'
    ? 'set CAW_LIVE_CLAUDE=1 for paid live child-sealing acceptance'
    : false,
  timeout: 180_000,
}, () => {
  const executable = process.env.CAW_CLAUDE
  const model = process.env.CAW_CLAUDE_MODEL
  assert.ok(executable, 'CAW_CLAUDE must name the exact measured executable')
  assert.ok(model, 'CAW_CLAUDE_MODEL must name the explicit provider-native model')

  const parent = mkdtempSync(join(tmpdir(), 'caw-live-claude-sealing-'))
  const delivery = join(parent, 'delivery')
  const scratchRoot = join(parent, 'provider-tmp')
  const configRoot = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const agentsDir = join(configRoot, 'agents')
  const sentinel = `caw-operator-sealing-${process.pid}-${Date.now()}`
  const operatorAgent = join(agentsDir, `${sentinel}.md`)
  const hookMarker = join(scratchRoot, 'project-hook-fired')

  mkdirSync(join(delivery, '.claude'), { recursive: true, mode: 0o700 })
  mkdirSync(scratchRoot, { mode: 0o700 })
  mkdirSync(agentsDir, { recursive: true, mode: 0o700 })
  try {
    writeFileSync(operatorAgent, [
      '---',
      `name: ${sentinel}`,
      'description: Operator-owned sentinel for the opt-in CAW sealing test.',
      '---',
      'This operator agent must not reach the CAW child.',
      '',
    ].join('\n'), { flag: 'wx', mode: 0o600 })

    const hook = join(delivery, '.claude', 'caw-sealing-hook.sh')
    writeFileSync(hook, [
      '#!/bin/sh',
      ': > "$TMPDIR/project-hook-fired"',
      '',
    ].join('\n'), { mode: 0o700 })
    chmodSync(hook, 0o700)
    writeFileSync(join(delivery, '.claude', 'settings.json'), `${JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: 'Bash',
          hooks: [{
            type: 'command',
            command: '"$CLAUDE_PROJECT_DIR/.claude/caw-sealing-hook.sh"',
          }],
        }],
      },
    }, null, 2)}\n`)
    writeFileSync(join(delivery, 'README.md'), '# live child-sealing fixture\n')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: delivery })
    execFileSync('git', ['config', 'user.name', 'CAW Live Probe'], { cwd: delivery })
    execFileSync('git', ['config', 'user.email', 'probe@example.invalid'], { cwd: delivery })
    execFileSync('git', ['add', '-A'], { cwd: delivery })
    execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: delivery })

    const invocation = claude.buildInvocation({
      role: 'architect',
      binding: { provider: 'claude', model, reasoning: 'low' },
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
      instructions: 'This is the exact live CAW child-sealing acceptance. Follow the request.',
      prompt: 'Use Bash exactly once to run pwd, then report ok=true.',
      executable,
      execution: {
        workingRoot: delivery,
        scratchRoot,
        writeBoundary: 'engine-private-only',
        writeBoundaryBy: 'os-boundary',
        env: { ...process.env, PWD: delivery, CAW_ROLE: 'architect' },
      },
    })
    const formatAt = invocation.args.indexOf('--output-format')
    assert.notEqual(formatAt, -1)
    invocation.args[formatAt + 1] = 'stream-json'
    invocation.args.push('--verbose', '--include-hook-events')

    assert.equal(invocation.args[invocation.args.indexOf('--setting-sources') + 1], 'project,local')
    assert.equal(invocation.args.includes('--strict-mcp-config'), true)
    assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], model)
    assert.equal(invocation.args[invocation.args.indexOf('--effort') + 1], 'low')
    // The outer profile's helper is the host's business — seatbelt here, bubblewrap there — and
    // naming one of them made this case assert a platform instead of the property. What it owes
    // is that the call goes THROUGH a profile rather than straight to the provider: the launcher
    // is not the measured executable, and the measured executable is what that launcher runs.
    assert.notEqual(invocation.executable, executable)
    assert.equal(invocation.args.includes(executable), true)

    const result = spawnSync(invocation.executable, invocation.args, {
      input: invocation.input,
      cwd: invocation.cwd,
      env: invocation.env,
      encoding: 'utf8',
      timeout: 150_000,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)

    const events = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const init = events.find((event) => event.type === 'system' && event.subtype === 'init')
    assert.ok(init, 'native stream must contain system/init')
    assert.ok(Array.isArray(init.agents), 'system/init must expose the discovered agent names')
    assert.deepEqual(init.mcp_servers, [], 'operator account connectors reached the sealed child')
    assert.equal(JSON.stringify(init).includes(sentinel), false,
      'operator-installed agent reached the sealed child')
    assert.equal(existsSync(hookMarker), true, 'project PreToolUse hook did not fire')
    const final = events.findLast((event) => event.type === 'result')
    assert.ok(final, 'authenticated native call must produce a result event')
    assert.equal(final.is_error, false, JSON.stringify(final))
  } finally {
    rmSync(operatorAgent, { force: true })
    rmSync(parent, { recursive: true, force: true })
  }
})
