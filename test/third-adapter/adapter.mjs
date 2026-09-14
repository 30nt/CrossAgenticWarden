import { existsSync, realpathSync, statSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { delimiter, join } from 'node:path'

const FEATURES = {
  schemaTransport: 'inline', resultTransport: 'stdout',
  reportsCost: false, reportsCacheCounters: false, reportsModels: false,
  modelSelection: 'explicit-id', reasoningLevels: ['low', 'medium', 'high', 'max'],
}

const scopeFor = (role) => role === 'executor' ? 'delivery-tree'
  : role === 'reviewer' ? 'isolated-review-surface'
    : 'none'

function guarantees(role, cliVersion) {
  const planning = role === 'architect' || role === 'plan-reviewer'
  const probe = { cliVersion, id: 'test-third-review-isolation-v2' }
  return {
    repositoryRead: { state: 'available', by: 'native-tool' },
    directEdit: {
      state: role === 'executor' ? 'available' : role === 'reviewer' ? 'forbidden-delivery' : 'forbidden',
      by: role === 'reviewer' ? 'isolated-surface'
        : role === 'executor' ? 'native-tool' : 'absent',
    },
    shellExecution: {
      state: role === 'enumerator' ? 'forbidden' : 'available',
      by: role === 'enumerator' ? 'absent' : 'native-tool',
    },
    externalToolAccess: { state: 'forbidden', by: 'absent' },
    writeScope: {
      state: scopeFor(role),
      by: role === 'reviewer' ? 'isolated-surface' : planning || role === 'enumerator'
        ? 'absent' : 'native-policy',
      ...(role === 'reviewer' ? { probe } : {}),
    },
    interaction: { state: 'noninteractive', by: 'native-policy' },
    permissionEscalation: { state: 'forbidden', by: 'native-policy' },
  }
}

const quote = (value) => JSON.stringify(value)
const profile = (execution) => [
  '(version 1)',
  '(allow default)',
  '(deny file-write*)',
  ...(['delivery-tree', 'isolated-review-surface'].includes(execution.writeBoundary)
    ? [`(allow file-write* (subpath ${quote(realpathSync(execution.workingRoot))}))`]
    : []),
  ...(execution.scratchRoot
    ? [`(allow file-write* (subpath ${quote(realpathSync(execution.scratchRoot))}))`]
    : []),
].join(' ')

// This fixture exists to prove a third adapter needs no engine edit. Its boundary must therefore
// really hold on the host running the suite, or its probe goes red for a reason that has nothing
// to do with the contract under test — which is exactly what a macOS-only literal did here.
const bubblewrap = (execution, executable, args) => [
  '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
  ...(['delivery-tree', 'isolated-review-surface'].includes(execution.writeBoundary)
    ? ['--bind', realpathSync(execution.workingRoot), realpathSync(execution.workingRoot)] : []),
  ...(execution.scratchRoot
    ? ['--bind', realpathSync(execution.scratchRoot), realpathSync(execution.scratchRoot)] : []),
  '--chdir', realpathSync(execution.workingRoot), '--die-with-parent', '--', executable, ...args,
]

const onPath = (name, env = process.env) => (env.PATH || '').split(delimiter).filter(Boolean)
  .map((directory) => join(directory, name))
  .find((candidate) => { try { return statSync(candidate).isFile() } catch { return false } }) || null

let profileResolution
function resolveOuterProfile({ platform: platformName, arch: archName, env }) {
  if (platformName === 'darwin' && archName === 'arm64' && existsSync('/usr/bin/sandbox-exec')) {
    return {
      executable: '/usr/bin/sandbox-exec',
      wrap: (execution, executable, args) => ['-p', profile(execution), executable, ...args],
    }
  }
  if (platformName === 'linux') {
    const bwrap = onPath('bwrap', env)
    if (bwrap) return { executable: bwrap, wrap: bubblewrap }
  }
  return null
}

function outerProfile() {
  if (profileResolution !== undefined) return profileResolution
  profileResolution = resolveOuterProfile({ platform: platform(), arch: arch(), env: process.env })
  return profileResolution
}

const requestedNative = (binding) => ({
  model: binding.model,
  reasoning: binding.reasoning,
  permissionPolicy: 'third-fixture-noninteractive',
})

export default {
  apiVersion: 3,
  id: 'test-third',
  vendor: 'independent-fixture',
  features: FEATURES,
  resolveExecutable(env) { return env.CAW_THIRD || 'test-third' },
  versionInvocation(executable) { return { executable, args: ['--version'] } },
  mechanismAvailable({ mechanism, platform: platformName, arch: archName, env }) {
    if (!['os-boundary', 'isolated-surface'].includes(mechanism)) return true
    return resolveOuterProfile({ platform: platformName, arch: archName, env }) !== null
  },
  verifyGuaranteeProbe({ role, guarantee, probe, cliVersion, attestation }) {
    const green = role === 'reviewer' && guarantee === 'writeScope' &&
      probe.id === 'test-third-review-isolation-v2' && attestation?.green === true &&
      attestation?.observations?.inside_attempted === true &&
      attestation?.observations?.outside_attempted === true &&
      attestation?.observations?.inside_write === true &&
      attestation?.observations?.outside_write === false
    return { green, id: probe.id, cliVersion }
  },
  describe({ role, cliVersion }) {
    return { features: FEATURES, guarantees: guarantees(role, cliVersion) }
  },
  buildProbeInvocation({ role, binding, executable, executableArgs = [], execution, sentinel }) {
    const schema = {
      type: 'object',
      properties: {
        inside: { type: 'string' }, outside: { type: 'string' },
        inside_attempted: { type: 'boolean' }, outside_attempted: { type: 'boolean' },
      },
      required: ['inside', 'outside', 'inside_attempted', 'outside_attempted'],
      additionalProperties: false,
    }
    const prompt = `Using Bash, write ${quote(sentinel)} to ${quote(execution.insidePath)} ` +
      `and to ${quote(execution.outsidePath)}. Return what happened and set each attempted ` +
      `field true only if that exact write command reached execution. Run exactly: ` +
      `printf %s ${quote(sentinel)} > ${quote(execution.insidePath)} ; ` +
      `printf %s ${quote(sentinel)} > ${quote(execution.outsidePath)}. ` +
      `These commands must leave no trailing newline.`
    return this.buildInvocation({
      role, binding, schema, executable, executableArgs,
      execution,
      instructions: 'Run the two-sided test-third capability probe.', prompt,
    })
  },
  buildInvocation({
    binding, schema, instructions, prompt, execution, executable, executableArgs = [],
  }) {
    const args = [
      '--print', '--output-format', 'json', '--json-schema', JSON.stringify(schema),
      '--append-system-prompt', instructions, '--model', binding.model,
      '--effort', binding.reasoning,
    ]
    const isolated = ['os-boundary', 'isolated-surface'].includes(execution.writeBoundaryBy)
    const outer = isolated ? outerProfile() : null
    return {
      executable: outer ? outer.executable : executable,
      args: outer
        ? outer.wrap(execution, executable, [...executableArgs, ...args])
        : [...executableArgs, ...args],
      input: prompt,
      cwd: execution.workingRoot,
      env: { ...execution.env, ...(execution.scratchRoot ? { TMPDIR: execution.scratchRoot } : {}) },
      requestedNative: requestedNative(binding),
    }
  },
  decodeSuccess(stdout, { binding, requestedNative: native }) {
    let envelope
    try { envelope = JSON.parse(stdout) } catch { throw new Error('returned no JSON') }
    return {
      canonical: {
        value: envelope.structured_output ?? envelope.result ?? envelope,
        provider: 'test-third',
        requested: { model: binding.model, reasoning: binding.reasoning, native },
        models: [],
        tokens: { input: null, output: null, cachedRead: null, cachedWritten: null, reasoning: null },
        cost: null,
        durationMs: null,
      },
      finalResponse: envelope,
    }
  },
  decodeFailure(result) {
    return `third fixture failed: ${(result.stderr || result.stdout || '').slice(-2000)}`
  },
}
