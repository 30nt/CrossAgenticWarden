import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { SCHEMA, roleGuaranteeMismatch } from '../caw.mjs'
import claude from '../.caw/adapters/claude/adapter.mjs'
import codex from '../.caw/adapters/codex/adapter.mjs'
import third from './third-adapter/adapter.mjs'

// An outer profile's argv shape is its own business; what a case may assert is which roots it
// makes writable. Seatbelt states them inside one policy string and bubblewrap as `--bind SRC DEST`
// pairs, so reading the roots back is the only form of this assertion that can hold on both hosts.
// Comparing canonical paths, because a temporary directory is a symlink on one of them.
function writableRoots(invocation) {
  const roots = []
  if (invocation.executable.endsWith('sandbox-exec')) {
    for (const match of invocation.args[1].matchAll(/\(allow file-write\* \(subpath ("(?:[^"\\]|\\.)*")\)\)/g)) {
      roots.push(JSON.parse(match[1]))
    }
  } else {
    invocation.args.forEach((argument, index) => {
      if (argument === '--bind') roots.push(invocation.args[index + 1])
    })
  }
  return roots.map((root) => realpathSync(root))
}

const grants = (invocation, root) => writableRoots(invocation).includes(realpathSync(root))

const expected = {
  architect: {
    repositoryRead: 'available', directEdit: 'forbidden-delivery', shellExecution: 'available',
    externalToolAccess: 'forbidden', writeScope: 'engine-private-only',
  },
  enumerator: {
    repositoryRead: 'available', directEdit: 'forbidden-delivery',
    externalToolAccess: 'forbidden', writeScope: 'engine-private-only',
  },
  'plan-reviewer': {
    repositoryRead: 'available', directEdit: 'forbidden-delivery', shellExecution: 'available',
    externalToolAccess: 'forbidden', writeScope: 'engine-private-only',
  },
  executor: {
    repositoryRead: 'available', directEdit: 'available', shellExecution: 'available',
    externalToolAccess: 'forbidden', writeScope: 'delivery-tree',
  },
  reviewer: {
    repositoryRead: 'available', directEdit: 'forbidden-delivery', shellExecution: 'available',
    externalToolAccess: 'forbidden', writeScope: 'isolated-review-surface',
  },
}

test('every engine object schema requires every property at every nesting level', () => {
  const visit = (node, path) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'object') {
      assert.ok(node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties),
        `${path} has no properties object`)
      assert.ok(Array.isArray(node.required), `${path} has no required array`)
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(),
        `${path} required does not cover every property`)
    }
    for (const [key, child] of Object.entries(node)) {
      if (Array.isArray(child)) child.forEach((item, index) => visit(item, `${path}.${key}[${index}]`))
      else if (child && typeof child === 'object') visit(child, `${path}.${key}`)
    }
  }
  for (const [name, schema] of Object.entries(SCHEMA)) visit(schema, `SCHEMA.${name}`)
})

const descriptor = (role) => Object.fromEntries(Object.entries({
  ...expected[role], interaction: 'noninteractive', permissionEscalation: 'forbidden',
}).map(([key, state]) => [key, { state, by: 'test' }]))

test('every shipped adapter declares explicit model ids and bounded reasoning levels', () => {
  for (const adapter of [claude, codex, third]) {
    assert.equal(adapter.features.modelSelection, 'explicit-id')
    assert.deepEqual(adapter.features.reasoningLevels, ['low', 'medium', 'high', 'max'])
  }
})

test('adapter telemetry reports provider events only when the transport exposes them', () => {
  const codexEvents = [
    { type: 'item.completed', item: { type: 'command_execution' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n'
  const codexResult = codex.decodeSuccess(codexEvents, {
    binding: { provider: 'codex', model: 'fixture', reasoning: 'low' },
    requestedNative: {}, finalResponseText: '{}',
  }).canonical
  assert.deepEqual(codexResult.telemetry, {
    eventCount: 2, toolEventCount: 1, eventBytes: Buffer.byteLength(codexEvents),
  })

  const claudeResult = claude.decodeSuccess(JSON.stringify({
    structured_output: {}, usage: { input_tokens: 10 }, num_turns: 3,
  }), {
    binding: { provider: 'claude', model: 'fixture', reasoning: 'low' },
    requestedNative: {},
  }).canonical
  assert.deepEqual(claudeResult.telemetry, {
    eventCount: null, toolEventCount: null, eventBytes: null,
  })

  const claudeEvents = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } },
    { type: 'result', structured_output: {}, usage: { input_tokens: 10 } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n'
  const streamedClaude = claude.decodeSuccess(claudeEvents, {
    binding: { provider: 'claude', model: 'fixture', reasoning: 'low' },
    requestedNative: {},
  }).canonical
  assert.deepEqual(streamedClaude.telemetry, {
    eventCount: 2, toolEventCount: 1, eventBytes: Buffer.byteLength(claudeEvents),
  })
})

test('Claude runner enforces its live tool-event budget', () => {
  const parent = mkdtempSync(join(tmpdir(), 'caw-claude-runner-budget-'))
  const fake = join(parent, 'events.mjs')
  writeFileSync(fake, [
    "process.on('SIGINT', () => process.exit(130))",
    "const event = {type:'assistant',message:{content:[{type:'tool_use',name:'Read'}]}}",
    'for (let i = 0; i < 20; i++) console.log(JSON.stringify(event))',
    'setTimeout(() => process.exit(0), 5000)',
  ].join('\n'))
  const runner = join(process.cwd(), '.caw', 'adapters', 'claude', 'runner.mjs')
  const result = spawnSync(process.execPath, [runner, process.execPath, fake], {
    input: '', encoding: 'utf8', timeout: 3000,
    env: { ...process.env, CAW_EXECUTOR_MAX_TOOL_EVENTS: '3' },
  })
  rmSync(parent, { recursive: true, force: true })

  assert.equal(result.status, 86, result.stderr)
  assert.match(result.stderr, /CAW_EXECUTOR_BUDGET_EXHAUSTED tool-events 3\/3/)
})

test('role guarantee matcher accepts every exact cell and rejects every missing or incomparable cell', () => {
  const incompatible = {
    repositoryRead: 'unavailable',
    directEdit: 'available',
    shellExecution: 'forbidden',
    externalToolAccess: 'available',
    writeScope: 'delivery-tree',
    interaction: 'interactive',
    permissionEscalation: 'available',
  }
  for (const role of Object.keys(expected)) {
    const valid = descriptor(role)
    assert.equal(roleGuaranteeMismatch(role, valid), null, role)
    for (const key of Object.keys(valid)) {
      const missing = structuredClone(valid)
      delete missing[key]
      assert.match(roleGuaranteeMismatch(role, missing), new RegExp(key), `${role}.${key} missing`)

      const changed = structuredClone(valid)
      changed[key].state = incompatible[key]
      if (changed[key].state === valid[key].state) {
        changed[key].state = key === 'directEdit' ? 'forbidden' : 'none'
      }
      assert.match(roleGuaranteeMismatch(role, changed), new RegExp(key), `${role}.${key} changed`)
    }
  }
})

test('explicit partial orders accept a strictly stronger guarantee without weakening mutation roles', () => {
  const architect = descriptor('architect')
  architect.directEdit.state = 'forbidden'
  architect.writeScope.state = 'none'
  assert.equal(roleGuaranteeMismatch('architect', architect), null)

  const reviewer = descriptor('reviewer')
  reviewer.directEdit.state = 'forbidden'
  assert.equal(roleGuaranteeMismatch('reviewer', reviewer), null)

  const executor = descriptor('executor')
  executor.writeScope.state = 'none'
  assert.match(roleGuaranteeMismatch('executor', executor), /writeScope=delivery-tree/)
})

test('nominally stronger write denial cannot satisfy executor or reviewer mutation requirements', () => {
  const executor = descriptor('executor')
  executor.writeScope.state = 'none'
  assert.match(roleGuaranteeMismatch('executor', executor), /writeScope=delivery-tree/)

  const reviewer = descriptor('reviewer')
  reviewer.writeScope.state = 'none'
  assert.match(roleGuaranteeMismatch('reviewer', reviewer), /writeScope=isolated-review-surface/)
})

test('permission escalation names an active refusal separately from an absent approval path', () => {
  for (const role of Object.keys(expected)) {
    const claudeGuarantee = claude.describe({ role, cliVersion: 'claude fixture' })
      .guarantees.permissionEscalation
    const codexGuarantee = codex.describe({ role, cliVersion: 'codex-cli fixture' })
      .guarantees.permissionEscalation
    assert.deepEqual(claudeGuarantee, { state: 'forbidden', by: 'absent' }, `Claude ${role}`)
    assert.deepEqual(codexGuarantee, { state: 'forbidden', by: 'native-policy' }, `Codex ${role}`)
  }
})

test('every adapter answers host boundary availability without a provider call', () => {
  for (const adapter of [claude, codex, third]) {
    for (const mechanism of ['os-boundary', 'isolated-surface']) {
      assert.equal(adapter.mechanismAvailable({
        mechanism, platform: 'win32', arch: 'x64', env: { PATH: '' },
      }), false, `${adapter.id} ${mechanism} on win32`)
      assert.equal(adapter.mechanismAvailable({
        mechanism, platform: 'linux', arch: 'x64', env: { PATH: '' },
      }), false, `${adapter.id} ${mechanism} without a Linux helper`)
    }
    assert.equal(adapter.mechanismAvailable({
      mechanism: 'native-tool', platform: 'win32', arch: 'x64', env: { PATH: '' },
    }), true, `${adapter.id} non-boundary mechanism`)
  }
})

// The Codex adapter still names the macOS seatbelt directly; only Claude's boundary was
// ported. These cases assert what that unported boundary does, so on a host without it they
// have nothing to measure. Skipping says so; failing would have claimed Codex regressed.
test('Codex publishes probe-backed positive rows for future CLI versions without substituting its default',
  { skip: platform() !== 'darwin' || arch() !== 'arm64' }, () => {
  assert.equal(codex.resolveExecutable({}), 'codex')
  assert.equal(codex.resolveExecutable({ CAW_CODEX: '/explicit/codex' }), '/explicit/codex')

  const measured = codex.describe({ role: 'executor', cliVersion: 'codex-cli 0.150.0-alpha.12.2' })
  if (platform() === 'darwin' && arch() === 'arm64') {
    assert.equal(roleGuaranteeMismatch('executor', measured.guarantees), null)
    assert.equal(measured.guarantees.writeScope.by, 'os-boundary')
    assert.deepEqual(measured.guarantees.writeScope.probe, {
      cliVersion: 'codex-cli 0.150.0-alpha.12.2', id: 'codex-executor-delivery-v3',
      repositoryRead: true,
    })
    assert.deepEqual(measured.guarantees.repositoryRead.probe,
      measured.guarantees.writeScope.probe)
  } else {
    assert.match(roleGuaranteeMismatch('executor', measured.guarantees), /repositoryRead=available/)
  }

  const unknown = codex.describe({ role: 'executor', cliVersion: 'codex-cli future' })
  if (platform() === 'darwin' && arch() === 'arm64') {
    assert.equal(roleGuaranteeMismatch('executor', unknown.guarantees), null)
    assert.equal(unknown.guarantees.writeScope.probe.cliVersion, 'codex-cli future')
    assert.equal(unknown.guarantees.writeScope.probe.id, 'codex-executor-delivery-v3')
  } else {
    assert.match(roleGuaranteeMismatch('executor', unknown.guarantees), /repositoryRead=available/)
  }

  const enumerator = codex.describe({ role: 'enumerator', cliVersion: 'codex-cli 0.150.0-alpha.12.2' })
  if (platform() === 'darwin' && arch() === 'arm64') {
    assert.equal(roleGuaranteeMismatch('enumerator', enumerator.guarantees), null)
    assert.equal(enumerator.guarantees.repositoryRead.probe.id, 'codex-enumerator-boundary-v1')
    assert.equal(enumerator.guarantees.directEdit.state, 'forbidden-delivery')
    assert.equal(enumerator.guarantees.shellExecution.state, 'available')
    assert.equal(enumerator.guarantees.writeScope.state, 'engine-private-only')
    assert.equal(enumerator.guarantees.writeScope.by, 'os-boundary')
  } else {
    assert.match(roleGuaranteeMismatch('enumerator', enumerator.guarantees), /repositoryRead=available/)
  }
  const architect = codex.describe({ role: 'architect', cliVersion: 'codex-cli future' })
  if (platform() === 'darwin' && arch() === 'arm64') {
    assert.equal(roleGuaranteeMismatch('architect', architect.guarantees), null)
    assert.equal(architect.guarantees.directEdit.by, 'os-boundary')
    assert.equal(architect.guarantees.writeScope.state, 'engine-private-only')
    assert.equal(architect.guarantees.writeScope.probe.id, 'codex-planning-boundary-v1')
  } else {
    assert.match(roleGuaranteeMismatch('architect', architect.guarantees), /directEdit=forbidden-delivery/)
  }
  const reviewer = codex.describe({ role: 'reviewer', cliVersion: 'codex-cli 0.150.0-alpha.12.2' })
  assert.equal(reviewer.guarantees.writeScope.probe.id, 'codex-review-isolation-v3')
  const futureReviewer = codex.describe({ role: 'reviewer', cliVersion: 'codex-cli future' })
  if (platform() === 'darwin' && arch() === 'arm64') {
    assert.equal(roleGuaranteeMismatch('reviewer', futureReviewer.guarantees), null)
    assert.equal(futureReviewer.guarantees.repositoryRead.probe.cliVersion, 'codex-cli future')
  } else {
    assert.match(roleGuaranteeMismatch('reviewer', futureReviewer.guarantees), /directEdit=forbidden-delivery/)
  }
})

// The reviewer row is bounded only where the adapter resolves an outer profile; elsewhere this
// case asserted against the engine's own honest refusal and reported it as a contract break.
test('Claude reviewer isolates provider scratch and removes nested-session markers',
  { skip: claude.describe({ role: 'architect', cliVersion: 'fixture' })
    .guarantees.writeScope.by === 'os-boundary'
    ? false
    : 'this host publishes no bounded Claude row: the adapter resolves no outer profile' },
  () => {
  const root = mkdtempSync(join(tmpdir(), 'caw-claude-contract-'))
  const workingRoot = join(root, 'surface')
  const scratchRoot = join(root, 'provider-tmp')
  mkdirSync(workingRoot)
  mkdirSync(scratchRoot)
  try {
    const invocation = claude.buildInvocation({
      role: 'reviewer',
      binding: { provider: 'claude', model: 'fixture', reasoning: 'high' },
      schema: { type: 'object' }, instructions: 'fixture', prompt: 'fixture',
      executable: '/fixture/claude',
      execution: {
        workingRoot, scratchRoot, writeBoundary: 'isolated-review-surface',
        writeBoundaryBy: 'isolated-surface',
        deniedReadPaths: [], env: {
          SAFE: 'kept', CLAUDECODE: 'nested', CLAUDE_CODE_ENTRYPOINT: 'cli', TMPDIR: '/host/tmp',
        },
      },
    })
    assert.equal(invocation.env.SAFE, 'kept')
    assert.equal(invocation.env.CLAUDECODE, undefined)
    assert.equal(invocation.env.CLAUDE_CODE_ENTRYPOINT, undefined)
    assert.equal(invocation.env.TMPDIR, scratchRoot)
    assert.equal(invocation.env.CLAUDE_CODE_TMPDIR, scratchRoot)
    assert.equal(invocation.cwd, workingRoot)
    assert.equal(invocation.args[invocation.args.indexOf('--setting-sources') + 1], 'project,local')
    assert.equal(invocation.args.includes('--strict-mcp-config'), true)
    assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], 'fixture')
    assert.equal(invocation.args[invocation.args.indexOf('--effort') + 1], 'high')
    assert.equal(grants(invocation, scratchRoot), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('planning invocations keep repository reads and shell but grant writes only to engine-private roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'caw-planning-boundary-contract-'))
  const workingRoot = join(root, 'delivery')
  const scratchRoot = join(root, 'provider-tmp')
  mkdirSync(workingRoot)
  mkdirSync(scratchRoot)
  let codexInvocation
  try {
    const claudeDescriptor = claude.describe({ role: 'architect', cliVersion: 'claude fixture' })
    // Ask the adapter whether it has an outer profile here rather than naming a host. The earlier
    // form asked `darwin && arm64`, so on every other host this case asserted nothing at all and
    // reported that as a pass — the boundary went unmeasured exactly where it was unimplemented.
    if (claudeDescriptor.guarantees.writeScope.by === 'os-boundary') {
      assert.equal(roleGuaranteeMismatch('architect', claudeDescriptor.guarantees), null)
      assert.equal(claudeDescriptor.guarantees.directEdit.state, 'forbidden')
      assert.equal(claudeDescriptor.guarantees.writeScope.state, 'engine-private-only')
      assert.equal(claudeDescriptor.guarantees.writeScope.by, 'os-boundary')

      const claudeInvocation = claude.buildInvocation({
        role: 'architect',
        binding: { provider: 'claude', model: 'fixture', reasoning: 'high' },
        schema: { type: 'object' }, instructions: 'fixture', prompt: 'fixture',
        executable: '/fixture/claude',
        execution: {
          workingRoot, scratchRoot, writeBoundary: 'engine-private-only',
          writeBoundaryBy: 'os-boundary',
          deniedReadPaths: [], env: { PWD: workingRoot },
        },
      })
      assert.equal(claudeInvocation.executable !== '/fixture/claude', true)
      assert.equal(grants(claudeInvocation, scratchRoot), true)
      assert.equal(grants(claudeInvocation, workingRoot), false)

      const claudeExecutor = claude.describe({ role: 'executor', cliVersion: 'claude fixture' })
      assert.equal(roleGuaranteeMismatch('executor', claudeExecutor.guarantees), null)
      assert.equal(claudeExecutor.guarantees.writeScope.by, 'os-boundary')
      assert.equal(claudeExecutor.guarantees.writeScope.probe.id, 'claude-executor-delivery-v1')
      const executorInvocation = claude.buildInvocation({
        role: 'executor',
        binding: { provider: 'claude', model: 'fixture', reasoning: 'high' },
        schema: { type: 'object' }, instructions: 'fixture', prompt: 'fixture',
        executable: '/fixture/claude',
        execution: {
          workingRoot, scratchRoot, writeBoundary: 'delivery-tree',
          writeBoundaryBy: 'os-boundary', deniedReadPaths: [], env: { PWD: workingRoot },
        },
      })
      assert.equal(grants(executorInvocation, workingRoot), true)
    }

    if (platform() === 'darwin' && arch() === 'arm64') {
      codexInvocation = codex.buildInvocation({
        role: 'architect',
        binding: { provider: 'codex', model: 'fixture', reasoning: 'low' },
        schema: { type: 'object' }, instructions: 'fixture', prompt: 'fixture',
        executable: '/fixture/codex',
        execution: {
          workingRoot, scratchRoot, writeBoundary: 'engine-private-only',
          deniedReadPaths: [], env: { PWD: workingRoot },
        },
      })
      assert.equal(codexInvocation.executable, '/usr/bin/sandbox-exec')
      assert.match(codexInvocation.args[1], new RegExp(scratchRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.doesNotMatch(codexInvocation.args[1], new RegExp(workingRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
  } finally {
    if (codexInvocation) rmSync(codexInvocation.transport.root, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('Codex enumerator uses one outer write boundary with native execution enabled',
  { skip: !(platform() === 'darwin' && arch() === 'arm64') }, () => {
    const root = mkdtempSync(join(tmpdir(), 'caw-enumerator-boundary-contract-'))
    const workingRoot = join(root, 'delivery')
    const scratchRoot = join(root, 'provider-tmp')
    mkdirSync(workingRoot)
    mkdirSync(scratchRoot)
    let invocation
    try {
      invocation = codex.buildInvocation({
        role: 'enumerator',
        binding: { provider: 'codex', model: 'fixture', reasoning: 'low' },
        schema: { type: 'object' }, instructions: 'fixture', prompt: 'fixture',
        executable: '/fixture/codex',
        execution: {
          workingRoot, scratchRoot, writeBoundary: 'engine-private-only',
          writeBoundaryBy: 'os-boundary', deniedReadPaths: [], env: { PWD: workingRoot },
        },
      })
      assert.equal(invocation.executable, '/usr/bin/sandbox-exec')
      assert.equal(invocation.args.includes('read-only'), false)
      assert.equal(invocation.args.includes('danger-full-access'), true)
      assert.doesNotMatch(invocation.args.join(' '), /features\.(?:shell_tool|unified_exec)=false/)
      assert.match(invocation.args[1], new RegExp(scratchRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.doesNotMatch(invocation.args[1],
        new RegExp(workingRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.match(invocation.requestedNative.permissionPolicy,
        /sandbox=danger-full-access,outer=seatbelt/)
    } finally {
      if (invocation) rmSync(invocation.transport.root, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

test('Codex keeps canonical schemas marker-free and stages explicit auth only in private transport', () => {
  const root = mkdtempSync(join(tmpdir(), 'caw-codex-contract-'))
  const delivery = join(root, 'delivery')
  const authFile = join(root, 'auth.json')
  mkdirSync(delivery)
  writeFileSync(authFile, '{"fixture":"secret"}\n', { mode: 0o600 })
  const schema = { type: 'object', properties: {}, additionalProperties: false }
  let invocation
  try {
    invocation = codex.buildInvocation({
      role: 'executor', binding: { provider: 'codex', model: 'fixture', reasoning: 'max' },
      schema, instructions: 'fixture', prompt: 'fixture', executable: '/fixture/codex',
      execution: {
        workingRoot: delivery,
        env: { PWD: delivery, CAW_CODEX_AUTH_FILE: authFile },
      },
    })
    const privateAuth = join(invocation.transport.root, 'codex-home', 'auth.json')
    assert.equal(codex.features.resultTransport, 'file')
    const manifest = JSON.parse(readFileSync(join(invocation.transport.root, 'manifest.json'), 'utf8'))
    assert.equal(manifest.state, 'active')
    assert.deepEqual(manifest.sensitive_paths, ['codex-home/auth.json'])
    assert.equal(readFileSync(privateAuth, 'utf8'), '{"fixture":"secret"}\n')
    assert.equal(invocation.env.CAW_CODEX_AUTH_FILE, undefined)
    assert.equal(invocation.env.CODEX_HOME, join(invocation.transport.root, 'codex-home'))
    // The profile carries the canonical path as a quoted literal. Resolve it exactly as the
    // adapter does, then preserve JSON quoting: macOS may add /private to a temporary path, while
    // Windows separators must remain escaped in the profile text.
    assert.equal(invocation.args[1].includes(JSON.stringify(realpathSync(authFile))), true)
    assert.equal(JSON.parse(readFileSync(join(invocation.transport.root, 'schema.json'))).$schema,
      'https://json-schema.org/draft/2020-12/schema')
    assert.equal(schema.$schema, undefined)
  } finally {
    if (invocation) rmSync(invocation.transport.root, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('Codex classifies structured provider failures without inventing observations', () => {
  const classify = (stdout = '', stderr = '') => codex.decodeFailure({ stdout, stderr })
  assert.match(classify('{"type":"turn.failed","error":{"message":"401 Unauthorized"}}\n'),
    /^classification: authentication/)
  assert.match(classify('{"type":"error","message":"unknown model fixture"}\n'),
    /^classification: model/)
  assert.match(classify('', 'sandbox denied the write'), /^classification: permission/)
  assert.match(classify('', 'connection reset'), /^classification: provider/)
})
