import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { arch, platform, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema'
const AUTH_COPY_MAX = 1024 * 1024
const TRANSPORT_PARENT = join(tmpdir(), 'caw-adapter-transports')
// Presence is not capability: the file being there does not mean it can start a sandbox, and a
// host where it cannot must refuse the bounded rows rather than publish them and find out from a
// paid probe. Cached, because it costs one exec. The same check is in the Claude adapter, where
// the Linux half of it was measured against a container that ships bwrap and denies its namespace.
let seatbeltStarts
const supportedOuterProfileHost = (platformName = platform(), archName = arch()) => {
  if (!(platformName === 'darwin' && archName === 'arm64' && existsSync('/usr/bin/sandbox-exec'))) {
    return false
  }
  if (seatbeltStarts === undefined) {
    try {
      const probe = spawnSync('/usr/bin/sandbox-exec',
        ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' })
      seatbeltStarts = !probe.error && probe.status === 0
    } catch { seatbeltStarts = false }
  }
  return seatbeltStarts
}
const quote = (value) => JSON.stringify(value)
const runnerPath = join(dirname(fileURLToPath(import.meta.url)), 'runner.mjs')
const pathAliases = (path) => [...new Set([path, realpathSync(path)])]

const seatbelt = (execution, transport) => [
  '(version 1)',
  '(allow default)',
  '(deny file-write*)',
  '(allow file-write* (literal "/dev/null"))',
  '(allow file-write* (literal "/dev/tty"))',
  '(allow file-write* (literal "/dev/dtracehelper"))',
  ...(['delivery-tree', 'isolated-review-surface'].includes(execution.writeBoundary)
    ? pathAliases(execution.workingRoot).map((path) =>
      `(allow file-write* (subpath ${quote(path)}))`)
    : []),
  ...(execution.scratchRoot
    ? pathAliases(execution.scratchRoot).map((path) =>
      `(allow file-write* (subpath ${quote(path)}))`)
    : []),
  ...pathAliases(transport.root).map((path) =>
    `(allow file-write* (subpath ${quote(path)}))`),
  ...(transport.authSourcePath
    ? [`(deny file-read* (literal ${quote(transport.authSourcePath)}))`]
    : []),
  ...(execution.deniedReadPaths || []).map((path) =>
    `(deny file-read* (subpath ${quote(path)}))`),
].join(' ')

const observed = (object, key) => typeof object?.[key] === 'number' ? object[key] : null

function nativeReasoning(reasoning) {
  return reasoning === 'max' ? 'xhigh' : reasoning
}

function guarantees(role, cliVersion) {
  const planning = role === 'architect' || role === 'plan-reviewer'
  const boundedPlanning = planning || role === 'enumerator'
  const probe = role === 'executor'
    ? { cliVersion, id: 'codex-executor-delivery-v3', repositoryRead: true }
    : role === 'enumerator'
      ? { cliVersion, id: 'codex-enumerator-boundary-v1', repositoryRead: true }
      : planning
        ? { cliVersion, id: 'codex-planning-boundary-v1', repositoryRead: true }
        : { cliVersion, id: 'codex-review-isolation-v3', repositoryRead: true }
  if (boundedPlanning && supportedOuterProfileHost()) {
    return {
      repositoryRead: { state: 'available', by: 'native-tool', probe },
      directEdit: { state: 'forbidden-delivery', by: 'os-boundary', probe },
      shellExecution: { state: 'available', by: 'native-tool' },
      externalToolAccess: { state: 'forbidden', by: 'absent' },
      writeScope: { state: 'engine-private-only', by: 'os-boundary', probe },
      interaction: { state: 'noninteractive', by: 'native-policy' },
      permissionEscalation: { state: 'forbidden', by: 'native-policy' },
    }
  }
  if (role === 'executor' && supportedOuterProfileHost()) {
    return {
      repositoryRead: { state: 'available', by: 'native-tool', probe },
      directEdit: { state: 'available', by: 'native-tool' },
      shellExecution: { state: 'available', by: 'native-tool' },
      externalToolAccess: { state: 'forbidden', by: 'absent' },
      writeScope: {
        state: 'delivery-tree', by: 'os-boundary',
        probe,
      },
      interaction: { state: 'noninteractive', by: 'native-policy' },
      permissionEscalation: { state: 'forbidden', by: 'native-policy' },
    }
  }
  if (role === 'reviewer' && supportedOuterProfileHost()) {
    return {
      repositoryRead: { state: 'available', by: 'native-tool', probe },
      directEdit: { state: 'forbidden-delivery', by: 'isolated-surface' },
      shellExecution: { state: 'available', by: 'native-tool' },
      externalToolAccess: { state: 'forbidden', by: 'absent' },
      writeScope: {
        state: 'isolated-review-surface', by: 'isolated-surface',
        probe,
      },
      interaction: { state: 'noninteractive', by: 'native-policy' },
      permissionEscalation: { state: 'forbidden', by: 'native-policy' },
    }
  }
  if (role === 'enumerator') {
    return {
      repositoryRead: { state: 'unavailable', by: 'native-tool' },
      directEdit: { state: 'available', by: 'native-tool' },
      shellExecution: { state: 'available', by: 'native-tool' },
      externalToolAccess: { state: 'forbidden', by: 'absent' },
      writeScope: { state: 'delivery-tree', by: 'native-policy', probe: null },
      interaction: { state: 'noninteractive', by: 'native-policy' },
      permissionEscalation: { state: 'forbidden', by: 'native-policy' },
    }
  }
  if (role === 'executor') {
    return {
      repositoryRead: { state: 'unavailable', by: 'native-tool' },
      directEdit: { state: 'available', by: 'native-tool' },
      shellExecution: { state: 'available', by: 'native-tool' },
      externalToolAccess: { state: 'forbidden', by: 'absent' },
      writeScope: { state: 'delivery-tree', by: 'native-policy', probe: null },
      interaction: { state: 'noninteractive', by: 'native-policy' },
      permissionEscalation: { state: 'forbidden', by: 'native-policy' },
    }
  }
  return {
    repositoryRead: { state: 'available', by: 'native-tool' },
    directEdit: { state: 'available', by: 'native-tool' },
    shellExecution: { state: 'available', by: 'native-tool' },
    externalToolAccess: { state: 'forbidden', by: 'absent' },
    writeScope: { state: 'delivery-tree', by: 'native-policy', probe: null },
    interaction: { state: 'noninteractive', by: 'native-policy' },
    permissionEscalation: { state: 'forbidden', by: 'native-policy' },
  }
}

function parseEvents(stdout) {
  const events = []
  for (const line of (stdout || '').split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { /* diagnostics remain unavailable, never invented */ }
  }
  return events
}

function observations(events) {
  const completed = [...events].reverse().find((event) => event?.type === 'turn.completed')
  const usage = completed?.usage || {}
  return {
    models: [],
    tokens: {
      input: observed(usage, 'input_tokens'),
      output: observed(usage, 'output_tokens'),
      cachedRead: observed(usage, 'cached_input_tokens'),
      cachedWritten: null,
      reasoning: observed(usage, 'reasoning_output_tokens'),
    },
    durationMs: null,
  }
}

function failureClass(text) {
  if (/unauthori[sz]ed|authentication|log(?:ged)? in|access token|api key|bearer|401\b/i.test(text)) {
    return 'authentication'
  }
  if (/model.*(?:not found|unsupported|unavailable)|unknown model/i.test(text)) return 'model'
  if (/schema|structured output|json schema/i.test(text)) return 'schema'
  if (/permission|sandbox|denied|approval/i.test(text)) return 'permission'
  return 'provider'
}

function createTransport(schema, authFile) {
  mkdirSync(TRANSPORT_PARENT, { recursive: true, mode: 0o700 })
  try { chmodSync(TRANSPORT_PARENT, 0o700) } catch { /* no POSIX modes */ }
  const root = mkdtempSync(join(TRANSPORT_PARENT, 'transport-'))
  try {
    chmodSync(root, 0o700)
    const manifestPath = join(root, 'manifest.json')
    const now = new Date().toISOString()
    const manifest = {
      version: 1,
      transport_id: root.split(/[\\/]/).pop(),
      provider: 'codex',
      pid: process.pid,
      created_at: now,
      updated_at: now,
      state: 'active',
      sensitive_paths: authFile ? ['codex-home/auth.json'] : [],
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    const schemaPath = join(root, 'schema.json')
    const finalResponsePath = join(root, 'final.json')
    mkdirSync(join(root, 'tmp'), { mode: 0o700 })
    mkdirSync(join(root, 'codex-home'), { mode: 0o700 })
    mkdirSync(join(root, 'state'), { mode: 0o700 })
    mkdirSync(join(root, 'log'), { mode: 0o700 })
    let authSourcePath = null
    let authCopyPath = null
    if (authFile) {
      const stat = lstatSync(authFile)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('CAW_CODEX_AUTH_FILE must be a regular file')
      if (stat.size > AUTH_COPY_MAX) {
        throw new Error(`CAW_CODEX_AUTH_FILE exceeds ${AUTH_COPY_MAX} bytes`)
      }
      authSourcePath = realpathSync(authFile)
      authCopyPath = join(root, 'codex-home', 'auth.json')
      copyFileSync(authSourcePath, authCopyPath)
      chmodSync(authCopyPath, 0o600)
    }
    const nativeSchema = { ...schema, $schema: SCHEMA_DIALECT }
    writeFileSync(schemaPath, `${JSON.stringify(nativeSchema, null, 2)}\n`, { mode: 0o600 })
    return { root, schemaPath, finalResponsePath, authSourcePath, authCopyPath }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

export default {
  apiVersion: 3,
  id: 'codex',
  vendor: 'openai',
  features: {
    schemaTransport: 'file', resultTransport: 'file',
    reportsCost: false, reportsCacheCounters: true, reportsModels: false,
    modelSelection: 'explicit-id', reasoningLevels: ['low', 'medium', 'high', 'max'],
  },
  resolveExecutable(env) { return env.CAW_CODEX || 'codex' },
  versionInvocation(executable) { return { executable, args: ['--version'] } },
  mechanismAvailable({ mechanism, platform: platformName, arch: archName }) {
    if (!['os-boundary', 'isolated-surface'].includes(mechanism)) return true
    return supportedOuterProfileHost(platformName, archName)
  },
  verifyGuaranteeProbe({ role, guarantee, probe, cliVersion, attestation }) {
    const expected = role === 'executor' ? 'codex-executor-delivery-v3'
      : role === 'reviewer' ? 'codex-review-isolation-v3'
        : role === 'enumerator' ? 'codex-enumerator-boundary-v1'
          : ['architect', 'plan-reviewer'].includes(role) ? 'codex-planning-boundary-v1' : null
    const green = ['repositoryRead', 'directEdit', 'writeScope'].includes(guarantee) && probe.id === expected &&
      attestation?.green === true &&
      attestation?.observations?.repository_read_attempted === true &&
      attestation?.observations?.repository_read === true &&
      attestation?.observations?.inside_attempted === true &&
      attestation?.observations?.outside_attempted === true &&
      attestation?.observations?.inside_write === true &&
      attestation?.observations?.outside_write === false
    return { green, id: probe.id, cliVersion }
  },
  describe({ role, cliVersion }) {
    return { features: this.features, guarantees: guarantees(role, cliVersion) }
  },
  buildProbeInvocation(input) {
    const schema = {
      type: 'object',
      properties: {
        inside: { type: 'string' }, outside: { type: 'string' },
        inside_attempted: { type: 'boolean' }, outside_attempted: { type: 'boolean' },
        repository: { type: 'string' }, observed_nonce: { type: 'string' },
        repository_read_attempted: { type: 'boolean' },
      },
      required: [
        'inside', 'outside', 'inside_attempted', 'outside_attempted',
        'repository', 'observed_nonce', 'repository_read_attempted',
      ],
      additionalProperties: false,
    }
    const instructions = 'You are running a versioned CAW capability probe. Perform both writes ' +
      'and the repository read exactly as requested, then report their observed outcomes.'
    const prompt = `First read ${JSON.stringify(input.execution.repositoryReadPath)} and return its ` +
      `exact content without a trailing newline as observed_nonce; the expected nonce is not in this prompt. ` +
      `Set repository_read_attempted true only if that exact read reached execution. Then write ` +
      `${JSON.stringify(input.sentinel)} to ${JSON.stringify(input.execution.insidePath)} ` +
      `and to ${JSON.stringify(input.execution.outsidePath)}. Report each outcome and set its attempted ` +
      `field true only if that exact write command reached execution. Run exactly: ` +
      `printf %s ${JSON.stringify(input.sentinel)} > ${JSON.stringify(input.execution.insidePath)} ; ` +
      `printf %s ${JSON.stringify(input.sentinel)} > ${JSON.stringify(input.execution.outsidePath)}. ` +
      `These commands must leave no trailing newline.`
    return this.buildInvocation({ ...input, schema, instructions, prompt })
  },
  buildInvocation({
    role, binding, schema, instructions, prompt, execution, executable, executableArgs = [],
  }) {
    const workingRoot = realpathSync(execution.workingRoot)
    const transport = createTransport(schema, execution.env.CAW_CODEX_AUTH_FILE)
    const reasoning = nativeReasoning(binding.reasoning)
    const sandbox = 'danger-full-access'
    const args = [
      'exec', '--ignore-user-config', '--ignore-rules', '--strict-config', '--ephemeral', '--json',
      '--sandbox', sandbox, '--output-schema', transport.schemaPath,
      '--output-last-message', transport.finalResponsePath,
      '--model', binding.model,
      '-c', 'approval_policy="never"',
      '-c', `model_reasoning_effort=${JSON.stringify(reasoning)}`,
      '-c', `developer_instructions=${JSON.stringify(instructions)}`,
      '-c', 'web_search="disabled"',
      '-c', 'features.apps=false',
      '-c', 'apps._default.enabled=false',
      '-c', 'features.skill_mcp_dependency_install=false',
      '-c', 'features.hooks=false',
      '-c', 'mcp_servers={}',
      '-c', 'shell_environment_policy.inherit="none"',
      '-c', `sqlite_home=${JSON.stringify(join(transport.root, 'state'))}`,
      '-c', `log_dir=${JSON.stringify(join(transport.root, 'log'))}`,
      '-C', workingRoot, '-',
    ]
    const { CAW_CODEX_AUTH_FILE: _authFile, ...providerEnv } = execution.env
    return {
      executable: '/usr/bin/sandbox-exec',
      args: [
        '-p', seatbelt(execution, transport), process.execPath, runnerPath,
        transport.authCopyPath || '-', executable, ...executableArgs, ...args,
      ],
      input: prompt, cwd: workingRoot,
      env: {
        ...providerEnv,
        CODEX_HOME: join(transport.root, 'codex-home'),
        PWD: workingRoot,
        TMPDIR: join(transport.root, 'tmp'),
      },
      transport: { root: transport.root, finalResponsePath: transport.finalResponsePath },
      requestedNative: {
        model: binding.model,
        reasoning,
        permissionPolicy: `approval=never,sandbox=${sandbox},outer=seatbelt,external=disabled,hooks=disabled`,
      },
    }
  },
  decodeSuccess(stdout, { binding, requestedNative, finalResponseText }) {
    if (typeof finalResponseText !== 'string') throw new Error('returned no final response file')
    let value
    try { value = JSON.parse(finalResponseText) }
    catch { throw new Error(`returned malformed final JSON:\n${finalResponseText.slice(0, 2000)}`) }
    const events = parseEvents(stdout)
    return {
      canonical: {
        value,
        provider: 'codex',
        requested: { model: binding.model, reasoning: binding.reasoning, native: requestedNative },
        ...observations(events),
        cost: null,
      },
      finalResponse: value,
    }
  },
  decodeFailure(result) {
    const messages = parseEvents(result.stdout).flatMap((event) => [
      event?.type === 'error' && event.message,
      event?.type === 'turn.failed' && (event.error?.message || event.message),
    ]).filter(Boolean)
    const out = messages.join('\n').slice(-2000) || '(no structured Codex error)'
    const err = (result.stderr || '').trim().slice(-2000) || '(empty)'
    return `classification: ${failureClass(`${out}\n${err}`)}\n` +
      `--- codex events ---\n${out}\n--- stderr ---\n${err}`
  },
}
