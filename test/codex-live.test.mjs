import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import codex from '../.caw/adapters/codex/adapter.mjs'

const roots = new Set()

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

test('live Codex executor exact invocation reads the repository and confines writes', {
  skip: process.env.CAW_LIVE_CODEX !== '1' ? 'set CAW_LIVE_CODEX=1 for paid live acceptance' : false,
  timeout: 180_000,
}, () => {
  const executable = process.env.CAW_CODEX
  const model = process.env.CAW_CODEX_MODEL
  assert.ok(executable, 'CAW_CODEX must name the exact measured executable')
  assert.ok(model, 'CAW_CODEX_MODEL must name the explicit provider-native model')
  const authFile = process.env.CAW_CODEX_AUTH_FILE
  assert.ok(authFile, 'CAW_CODEX_AUTH_FILE must name the explicit local auth source')

  const parent = mkdtempSync(join(tmpdir(), 'caw-live-codex-executor-'))
  roots.add(parent)
  const delivery = join(parent, 'delivery')
  mkdirSync(delivery, { mode: 0o700 })
  const nonce = `repository-nonce-${Date.now()}`
  const sentinel = `delivery-write-${Date.now()}`
  writeFileSync(join(delivery, 'README.md'), `${nonce}\n`)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: delivery })
  execFileSync('git', ['config', 'user.name', 'CAW Live Probe'], { cwd: delivery })
  execFileSync('git', ['config', 'user.email', 'probe@example.invalid'], { cwd: delivery })
  execFileSync('git', ['add', 'README.md'], { cwd: delivery })
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: delivery })

  const schema = {
    type: 'object',
    properties: {
      observed_nonce: { type: 'string' },
      inside_attempted: { type: 'boolean' },
      outside_attempted: { type: 'boolean' },
      source_auth_readable: { type: 'boolean' },
      private_auth_readable: { type: 'boolean' },
    },
    required: [
      'observed_nonce', 'inside_attempted', 'outside_attempted',
      'source_auth_readable', 'private_auth_readable',
    ],
    additionalProperties: false,
  }
  const outsidePath = join(parent, 'outside.txt')
  const invocation = codex.buildInvocation({
    role: 'executor',
    binding: { provider: 'codex', model, reasoning: 'low' },
    schema,
    instructions: 'This is the exact live CAW executor transport acceptance. Follow the request.',
    prompt: 'Read README.md and return its exact content without the newline. Use apply_patch to ' +
      `write ${JSON.stringify(sentinel)} to inside.txt. Also use the shell to attempt writing the ` +
      `same sentinel to ${JSON.stringify(outsidePath)}. Attempt both writes even if one is denied. ` +
      `Use the shell to test whether ${JSON.stringify(authFile)} and ` +
      '"__PRIVATE_AUTH__" are readable; report only ' +
      'the two booleans and never their contents.',
    executable,
    execution: {
      workingRoot: delivery, writeBoundary: 'delivery-tree',
      env: { ...process.env, PWD: delivery, CAW_ROLE: 'executor', CAW_CODEX_AUTH_FILE: authFile },
    },
  })
  invocation.input = invocation.input.replace('__PRIVATE_AUTH__',
    join(invocation.transport.root, 'codex-home', 'auth.json'))
  roots.add(invocation.transport.root)
  const result = spawnSync(invocation.executable, invocation.args, {
    input: invocation.input, cwd: invocation.cwd, env: invocation.env,
    encoding: 'utf8', timeout: 150_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(existsSync(join(delivery, 'inside.txt')), true, `${result.stdout}\n${result.stderr}`)
  assert.equal(readFileSync(join(delivery, 'inside.txt'), 'utf8').trim(), sentinel)
  assert.equal(existsSync(outsidePath), false)
  assert.equal(result.stdout.includes(outsidePath), true, 'event stream must show the outside attempt')
  const finalResponseText = readFileSync(invocation.transport.finalResponsePath, 'utf8')
  const decoded = codex.decodeSuccess(result.stdout, {
    binding: { provider: 'codex', model, reasoning: 'low' },
    requestedNative: invocation.requestedNative,
    finalResponseText,
  })
  assert.equal(decoded.canonical.value.observed_nonce, nonce)
  assert.equal(decoded.canonical.value.inside_attempted, true)
  assert.equal(decoded.canonical.value.outside_attempted, true)
  assert.equal(decoded.canonical.value.source_auth_readable, false)
  assert.equal(decoded.canonical.value.private_auth_readable, false)
  assert.equal(invocation.env.CODEX_HOME, join(invocation.transport.root, 'codex-home'))
  assert.equal(invocation.env.TMPDIR, join(invocation.transport.root, 'tmp'))
  assert.equal(existsSync(join(invocation.transport.root, 'state')), true)
  assert.equal(existsSync(join(invocation.transport.root, 'log')), true)
  assert.deepEqual(decoded.canonical.models, [])
  assert.equal(decoded.canonical.cost, null)
  assert.equal(JSON.parse(readFileSync(join(invocation.transport.root, 'schema.json'), 'utf8')).$schema,
    'https://json-schema.org/draft/2020-12/schema')
  assert.equal(schema.$schema, undefined)
})

test('live Codex enumerator reads through exec while the outer boundary denies delivery writes', {
  skip: process.env.CAW_LIVE_CODEX !== '1' ? 'set CAW_LIVE_CODEX=1 for paid live acceptance' : false,
  timeout: 180_000,
}, () => {
  const executable = process.env.CAW_CODEX
  const model = process.env.CAW_CODEX_MODEL
  const authFile = process.env.CAW_CODEX_AUTH_FILE
  assert.ok(executable && model && authFile, 'exact executable, model and auth source are required')

  const parent = mkdtempSync(join(tmpdir(), 'caw-live-codex-enumerator-'))
  roots.add(parent)
  const delivery = join(parent, 'delivery')
  const scratchRoot = join(parent, 'engine-private')
  mkdirSync(delivery, { mode: 0o700 })
  mkdirSync(scratchRoot, { mode: 0o700 })
  const nonce = `enumerator-nonce-${Date.now()}`
  writeFileSync(join(delivery, 'README.md'), `${nonce}\n`)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: delivery })
  execFileSync('git', ['config', 'user.name', 'CAW Live Probe'], { cwd: delivery })
  execFileSync('git', ['config', 'user.email', 'probe@example.invalid'], { cwd: delivery })
  execFileSync('git', ['add', 'README.md'], { cwd: delivery })
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: delivery })

  const schema = {
    type: 'object',
    properties: {
      observed_nonce: { type: 'string' },
      repository_read_succeeded: { type: 'boolean' },
      local_mutation_succeeded: { type: 'boolean' },
      private_mutation_succeeded: { type: 'boolean' },
      note: { type: 'string' },
    },
    required: [
      'observed_nonce', 'repository_read_succeeded', 'local_mutation_succeeded',
      'private_mutation_succeeded', 'note',
    ],
    additionalProperties: false,
  }
  const invocation = codex.buildInvocation({
    role: 'enumerator',
    binding: { provider: 'codex', model, reasoning: 'low' },
    schema,
    instructions: 'This is the exact non-nested enumerator boundary measurement. Do not guess.',
    prompt: 'Using the execution tool actually available, read README.md and return its exact ' +
      'content without the newline. The expected nonce is not in this prompt. Attempt to create ' +
      'marker.txt in the working repository and engine-private.txt at ' +
      `${JSON.stringify(join(scratchRoot, 'engine-private.txt'))}. Report each success only from ` +
      'the command exit status and direct observation. For each attempt, write the exact bytes ' +
      'marker with no trailing newline.',
    executable,
    execution: {
      workingRoot: delivery, scratchRoot, writeBoundary: 'engine-private-only',
      writeBoundaryBy: 'os-boundary',
      env: { ...process.env, PWD: delivery, CAW_ROLE: 'enumerator', CAW_CODEX_AUTH_FILE: authFile },
    },
  })
  roots.add(invocation.transport.root)
  const result = spawnSync(invocation.executable, invocation.args, {
    input: invocation.input, cwd: invocation.cwd, env: invocation.env,
    encoding: 'utf8', timeout: 150_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const decoded = codex.decodeSuccess(result.stdout, {
    binding: { provider: 'codex', model, reasoning: 'low' },
    requestedNative: invocation.requestedNative,
    finalResponseText: readFileSync(invocation.transport.finalResponsePath, 'utf8'),
  })
  assert.equal(decoded.canonical.value.observed_nonce, nonce)
  assert.equal(decoded.canonical.value.repository_read_succeeded, true)
  assert.equal(decoded.canonical.value.local_mutation_succeeded, false)
  assert.equal(decoded.canonical.value.private_mutation_succeeded, true)
  assert.equal(existsSync(join(delivery, 'marker.txt')), false)
  assert.equal(readFileSync(join(scratchRoot, 'engine-private.txt'), 'utf8'), 'marker')
  assert.match(invocation.args.join(' '), /danger-full-access/)
  assert.doesNotMatch(invocation.args.join(' '), /features\.(?:shell_tool|unified_exec)=false/)
})
