import { chmodSync, existsSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { arch, platform } from 'node:os'
import { delimiter, join } from 'node:path'

const TOOLS = {
  architect: 'Read,Grep,Glob,Bash',
  executor: 'Read,Edit,Write,Bash,Grep,Glob',
  reviewer: 'Read,Grep,Glob,Bash',
  'plan-reviewer': 'Read,Grep,Glob,Bash',
  enumerator: 'Read,Grep,Glob',
}

const quote = (value) => JSON.stringify(value)
const seatbelt = (execution) => [
  '(version 1)',
  '(allow default)',
  '(deny file-write*)',
  // Git opens /dev/null read-write even for local operations. Weak capture uses Git inside the
  // disposable review surface; this device exception does not widen either filesystem tree.
  '(allow file-write* (literal "/dev/null"))',
  ...(['delivery-tree', 'isolated-review-surface'].includes(execution.writeBoundary)
    ? [`(allow file-write* (subpath ${quote(realpathSync(execution.workingRoot))}))`]
    : []),
  ...(execution.scratchRoot
    ? [`(allow file-write* (subpath ${quote(realpathSync(execution.scratchRoot))}))`]
    : []),
  ...(execution.deniedReadPaths || []).map((path) =>
    `(deny file-read* (subpath ${quote(path)}))`),
].join(' ')

// The seatbelt profile above and the bubblewrap argv below are two implementations of ONE
// mechanism — `writeScope.by = 'os-boundary'` — and they are held to the same four observations
// the versioned probe makes: the repository reads, a write inside the allowed root lands, a
// write outside it does not, and the provider's own network call still reaches the API. A
// boundary that also cut the network would make every role fail rather than bound it, so
// neither profile unshares one: outbound network stays the documented runtime residual.
//
// Read denial is a refusal on both hosts, and getting there on Linux took three attempts worth
// recording, because two of them look right. Bubblewrap has no deny-read verb. Covering a denied
// path with something empty hides the content but answers "empty" where seatbelt answers "no",
// and a role asking whether a secret exists must not be told. Masking with mode-000 nodes kept
// inside the engine scratch root refuses correctly and then takes the run down: the engine walks
// and deletes that root itself, so `apparentSurfaceBytes` hit EACCES and every later command
// died on the surface it could no longer prune. What holds is a mask per path KIND — an
// unreadable file the engine can still stat and unlink, and for a directory a sandbox-private
// tmpfs chmod'ed inside the namespace, which leaves the host's own mode untouched.
const bubblewrap = (execution, executable, args) => {
  const writable = ['delivery-tree', 'isolated-review-surface'].includes(execution.writeBoundary)
    ? [realpathSync(execution.workingRoot)] : []
  if (execution.scratchRoot) writable.push(realpathSync(execution.scratchRoot))
  return [
    // Everything readable, nothing writable, and then exactly the roots this role may write.
    '--ro-bind', '/', '/',
    // Git opens /dev/null read-write even for local operations, so the boundary owes the role a
    // writable one; `--dev` supplies it without exposing the host's other devices.
    '--dev', '/dev',
    '--proc', '/proc',
    ...writable.flatMap((path) => ['--bind', path, path]),
    ...readDenials(execution),
    '--chdir', realpathSync(execution.workingRoot),
    // The role must not outlive the engine that is waiting on it.
    '--die-with-parent',
    '--',
    executable,
    ...args,
  ]
}

function readDenials(execution) {
  const denied = execution.deniedReadPaths || []
  if (!denied.length) return []
  const maskFile = join(execution.scratchRoot, 'denied-file')
  // Mode 000 and empty. The engine's own pruning only stats and unlinks a file, which needs the
  // permission of the parent directory and not of this one, so an unreadable file is safe to
  // leave in the scratch root; an unreadable directory would not be.
  if (!existsSync(maskFile)) { writeFileSync(maskFile, '', { mode: 0o600 }); chmodSync(maskFile, 0o000) }
  return denied.flatMap((path) => {
    let directory
    try { directory = statSync(path).isDirectory() } catch { return [] }
    return directory
      ? ['--tmpfs', path, '--chmod', '0', path]
      : ['--ro-bind', maskFile, path]
  })
}

const onPath = (name, env = process.env) => (env.PATH || '').split(delimiter).filter(Boolean)
  .map((directory) => join(directory, name))
  .find((candidate) => { try { return statSync(candidate).isFile() } catch { return false } }) || null

// Resolved once: the host cannot change under a running engine, and `guarantees()` is asked this
// question for every role of every command. A MISSING helper answers no here rather than at spawn
// time — the earlier version assumed `/usr/bin/sandbox-exec` existed, so a host without it
// published bounded rows and then died with ENOENT inside the role call, which reads as a broken
// provider rather than an unsupported host. Preflight refusing the row is the honest form.
//
// The helper is RUN, not stat-ed, and that is this same lesson one step further: absence was
// handled, presence-but-unusable was not. A default Docker container ships `bwrap` and denies
// the unprivileged user namespace it needs, and Ubuntu 24.04 restricts that namespace through
// AppArmor. On such a host the file is there, the row is published, and the refusal arrives from
// a live probe instead — four paid provider calls to learn what one local exec answers for free.
// Measured in a `node:22-bookworm-slim` container: `bwrap: Creating new namespace failed:
// Operation not permitted`.
//
// The check costs one short exec per process and is cached with the resolution. A helper that
// cannot start is reported as no helper at all, which is the fail-safe direction: preflight
// refuses the bounded rows rather than spending to discover the same thing.
const helperStarts = (executable, args) => {
  try {
    const probe = spawnSync(executable, args, { stdio: 'ignore' })
    return !probe.error && probe.status === 0
  } catch { return false }
}

let outerProfileResolution
function resolveOuterProfile({ platform: platformName, arch: archName, env }) {
  if (platformName === 'darwin' && archName === 'arm64' && existsSync('/usr/bin/sandbox-exec')) {
    if (!helperStarts('/usr/bin/sandbox-exec',
      ['-p', '(version 1)(allow default)', '/usr/bin/true'])) return null
    return {
      id: 'seatbelt',
      executable: '/usr/bin/sandbox-exec',
      wrap: (execution, executable, args) => ['-p', seatbelt(execution), executable, ...args],
    }
  }
  if (platformName === 'linux') {
    const bwrap = onPath('bwrap', env)
    if (bwrap && helperStarts(bwrap, ['--ro-bind', '/', '/', 'true'])) {
      return { id: 'bubblewrap', executable: bwrap, wrap: bubblewrap }
    }
  }
  return null
}

function outerProfile() {
  if (outerProfileResolution !== undefined) return outerProfileResolution
  outerProfileResolution = resolveOuterProfile({ platform: platform(), arch: arch(), env: process.env })
  return outerProfileResolution
}

const supportedOuterProfileHost = () => outerProfile() !== null

const observed = (object, key) => typeof object?.[key] === 'number' ? object[key] : null

function observations(env) {
  const usage = env?.usage || {}
  const modelUsage = Object.entries(env?.modelUsage || {})
    .map(([id, value]) => ({ id: value.canonicalModel || id, outputTokens: observed(value, 'outputTokens') }))
    .sort((a, b) => (b.outputTokens ?? -1) - (a.outputTokens ?? -1))
  return {
    models: modelUsage,
    tokens: {
      input: observed(usage, 'input_tokens'),
      output: observed(usage, 'output_tokens'),
      cachedRead: observed(usage, 'cache_read_input_tokens'),
      cachedWritten: observed(usage, 'cache_creation_input_tokens'),
      reasoning: observed(usage.output_tokens_details, 'thinking_tokens'),
    },
    durationMs: observed(env, 'duration_ms'),
  }
}

function guarantees(role, cliVersion) {
  const planning = role === 'architect' || role === 'plan-reviewer'
  const probe = role === 'executor'
    ? { cliVersion, id: 'claude-executor-delivery-v1', repositoryRead: true }
    : planning
      ? { cliVersion, id: 'claude-planning-boundary-v1', repositoryRead: true }
      : { cliVersion, id: 'claude-review-isolation-v3', repositoryRead: true }
  const shellExecution = role === 'enumerator' ? 'forbidden' : 'available'
  const enumeratorToolsProbe = {
    cliVersion,
    id: 'claude-enumerator-tools-v1',
    expectedTools: TOOLS.enumerator.split(','),
    shellDenied: true,
  }
  const bounded = supportedOuterProfileHost() && (planning || role === 'executor' || role === 'reviewer')
  const directEdit = role === 'executor' ? 'available'
    : role === 'reviewer' && bounded ? 'forbidden-delivery' : 'forbidden'
  const writeScope = bounded
    ? role === 'executor' ? 'delivery-tree'
      : role === 'reviewer' ? 'isolated-review-surface' : 'engine-private-only'
    : role === 'enumerator' ? 'none' : 'shell-residual-delivery'
  return {
    repositoryRead: { state: 'available', by: 'native-tool', ...(bounded ? { probe } : {}) },
    directEdit: {
      state: directEdit,
      by: role === 'reviewer' && bounded ? 'isolated-surface'
        : directEdit === 'forbidden' ? 'absent' : 'native-tool',
    },
    shellExecution: {
      state: shellExecution,
      by: shellExecution === 'forbidden' ? 'absent' : 'native-tool',
      ...(role === 'enumerator' ? { probe: enumeratorToolsProbe } : {}),
    },
    externalToolAccess: {
      state: 'forbidden', by: 'absent',
      ...(role === 'enumerator' ? { probe: enumeratorToolsProbe } : {}),
    },
    writeScope: {
      state: writeScope,
      by: bounded ? role === 'reviewer' ? 'isolated-surface' : 'os-boundary'
        : role === 'enumerator' ? 'absent' : 'native-policy',
      ...(bounded ? { probe } : {}),
    },
    interaction: { state: 'noninteractive', by: 'native-policy' },
    permissionEscalation: { state: 'forbidden', by: 'absent' },
  }
}

export default {
  apiVersion: 2,
  id: 'claude',
  features: {
    schemaTransport: 'inline', resultTransport: 'stdout',
    reportsCost: true, reportsCacheCounters: true, reportsModels: true,
  },
  resolveExecutable(env) { return env.CAW_CLAUDE || 'claude' },
  versionInvocation(executable) { return { executable, args: ['--version'] } },
  mechanismAvailable({ mechanism, platform: platformName, arch: archName, env }) {
    if (!['os-boundary', 'isolated-surface'].includes(mechanism)) return true
    return resolveOuterProfile({ platform: platformName, arch: archName, env }) !== null
  },
  verifyGuaranteeProbe({ role, guarantee, probe, cliVersion, attestation }) {
    if (role === 'enumerator') {
      const green = ['shellExecution', 'externalToolAccess'].includes(guarantee) &&
        probe.id === 'claude-enumerator-tools-v1' && attestation?.green === true &&
        attestation?.observations?.request_marker_received === true &&
        attestation?.observations?.reported_tools_match === true &&
        attestation?.observations?.shell_tool_requested === false &&
        attestation?.observations?.shell_write === false
      return { green, id: probe.id, cliVersion }
    }
    const expected = role === 'executor' ? 'claude-executor-delivery-v1'
      : role === 'reviewer' ? 'claude-review-isolation-v3'
        : ['architect', 'plan-reviewer'].includes(role) ? 'claude-planning-boundary-v1' : null
    const green = ['repositoryRead', 'writeScope'].includes(guarantee) &&
      probe.id === expected && attestation?.green === true &&
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
  buildProbeInvocation({ role, binding, executable, executableArgs = [], execution, sentinel, probe }) {
    if (probe.id === 'claude-enumerator-tools-v1') {
      const instructions = 'You are running a versioned CAW tool-contract probe. Follow the ' +
        'request exactly and return the required marker even when a requested tool is unavailable.'
      const prompt = `Use a shell tool to run exactly: printf %s ${JSON.stringify(sentinel)} > ` +
        `${JSON.stringify(execution.shellAttemptPath)}. Then output exactly ${JSON.stringify(sentinel)} ` +
        `and nothing else. Do not use a file-writing tool instead.`
      const invocation = this.buildInvocation({
        role, binding, schema: { type: 'object' }, instructions, prompt, executable,
        executableArgs, execution,
      })
      const schemaAt = invocation.args.indexOf('--json-schema')
      invocation.args.splice(schemaAt, 2)
      const formatAt = invocation.args.indexOf('--output-format')
      invocation.args[formatAt + 1] = 'stream-json'
      invocation.args.push('--verbose')
      invocation.requestedNative.probeKind = 'tool-contract'
      return invocation
    }
    const schema = {
      type: 'object',
      properties: {
        inside: { type: 'string' },
        outside: { type: 'string' },
        inside_attempted: { type: 'boolean' },
        outside_attempted: { type: 'boolean' },
        repository: { type: 'string' },
        observed_nonce: { type: 'string' },
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
    const prompt = `First read ${JSON.stringify(execution.repositoryReadPath)} and return its exact ` +
      `content without a trailing newline as observed_nonce; the expected nonce is not in this prompt. ` +
      `Set repository_read_attempted true only if that exact read reached execution. Then, using Bash, write ` +
      `${JSON.stringify(sentinel)} to ${JSON.stringify(execution.insidePath)} ` +
      `and to ${JSON.stringify(execution.outsidePath)}. Report each outcome and set its attempted ` +
      `field true only if that exact write command reached execution. Run exactly: ` +
      `printf %s ${JSON.stringify(sentinel)} > ${JSON.stringify(execution.insidePath)} ; ` +
      `printf %s ${JSON.stringify(sentinel)} > ${JSON.stringify(execution.outsidePath)}. ` +
      `These commands must leave no trailing newline.`
    return this.buildInvocation({
      role, binding, schema, instructions, prompt, executable, executableArgs, execution,
    })
  },
  buildInvocation({
    role, binding, schema, instructions, prompt, execution, executable, executableArgs = [],
  }) {
    const args = [
      '--print', '--output-format', 'json', '--json-schema', JSON.stringify(schema),
      '--setting-sources', 'project,local', '--strict-mcp-config',
      '--tools', TOOLS[role], '--append-system-prompt', instructions,
      '--permission-mode', 'bypassPermissions', '--model', binding.model,
      '--effort', binding.reasoning,
    ]
    let target = executable
    let targetArgs = [...executableArgs, ...args]
    if (['os-boundary', 'isolated-surface'].includes(execution.writeBoundaryBy)) {
      if (!execution.scratchRoot) throw new Error('bounded Claude invocation requires an engine scratch root')
      const profile = outerProfile()
      if (!profile) throw new Error('bounded Claude invocation has no outer profile on this host')
      target = profile.executable
      targetArgs = profile.wrap(execution, executable, [...executableArgs, ...args])
    }
    const {
      CLAUDECODE: _claudeCode,
      CLAUDE_CODE_ENTRYPOINT: _claudeCodeEntrypoint,
      ...providerEnv
    } = execution.env
    return {
      executable: target,
      args: targetArgs,
      input: prompt,
      cwd: execution.workingRoot,
      env: {
        ...providerEnv,
        ...(execution.scratchRoot
          ? { TMPDIR: execution.scratchRoot, CLAUDE_CODE_TMPDIR: execution.scratchRoot }
          : {}),
        PWD: execution.workingRoot,
      },
      requestedNative: {
        model: binding.model,
        reasoning: binding.reasoning,
        permissionPolicy: 'bypassPermissions',
      },
    }
  },
  decodeSuccess(stdout, { binding, requestedNative }) {
    let env
    if (requestedNative?.probeKind === 'tool-contract') {
      let events
      try {
        events = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      } catch { throw new Error(`returned no JSON event stream:\n${stdout.slice(0, 2000)}`) }
      const init = events.find((event) => event?.type === 'system' && event?.subtype === 'init')
      env = events.findLast((event) => event?.type === 'result')
      if (!init || !Array.isArray(init.tools) || !env) {
        throw new Error('tool-contract probe returned no system/init tools or final result')
      }
      const toolUseNames = []
      const visit = (value) => {
        if (!value || typeof value !== 'object') return
        if (value.type === 'tool_use' && typeof value.name === 'string') toolUseNames.push(value.name)
        for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child)
      }
      events.forEach(visit)
      env = {
        ...env,
        structured_output: {
          received_marker: typeof env.structured_output?.received_marker === 'string'
            ? env.structured_output.received_marker
            : typeof env.result === 'string' ? env.result.trim() : undefined,
          reported_tools: init.tools,
          shell_tool_requested: toolUseNames.includes('Bash'),
        },
      }
    } else {
      try { env = JSON.parse(stdout) } catch { throw new Error(`returned no JSON:\n${stdout.slice(0, 2000)}`) }
    }
    if (env?.is_error) throw new Error(`errored: ${env.result ?? env.subtype ?? 'unknown'}`)
    let value = env?.structured_output ?? env?.result ?? env
    if (typeof value === 'string') { try { value = JSON.parse(value) } catch { /* canonical validation reports it */ } }
    const seen = observations(env)
    return {
      canonical: {
        value,
        provider: 'claude',
        requested: { model: binding.model, reasoning: binding.reasoning, native: requestedNative },
        ...seen,
        cost: typeof env.total_cost_usd === 'number'
          ? { amount: env.total_cost_usd, currency: 'USD' }
          : null,
      },
      finalResponse: env,
    }
  },
  decodeFailure(result) {
    const err = (result.stderr || '').trim()
    let out = ''
    try {
      const env = JSON.parse(result.stdout || '')
      out = [env.result, env.terminal_reason && `terminal_reason: ${env.terminal_reason}`,
        env.subtype && `subtype: ${env.subtype}`].filter(Boolean).join('\n').slice(0, 2000)
    } catch { out = (result.stdout || '').trim().slice(-2000) }
    return `--- stdout ---\n${out || '(empty)'}\n--- stderr ---\n${err ? err.slice(-2000) : '(empty)'}`
  },
}
