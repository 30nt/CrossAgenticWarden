import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { arch, platform, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  populationBlock, providerLaunch, readProjectPolicies, resolvePopulation, resolvePopulationSource,
  retainWeakVerificationEvents,
} from '../caw.mjs'
import claude from '../.caw/adapters/claude/adapter.mjs'
import {
  assertPrivateMode, outerBoundaryHelperSkip, symlinkSkip,
} from './host-capabilities.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const FAKE = join(HERE, 'fake-claude.mjs')
const DENIED_BY_BOUNDARY = new Set(['EPERM', 'EROFS', 'EACCES'])
const FAKE_CODEX = join(HERE, 'fake-codex.mjs')
const THIRD_ADAPTER = join(HERE, 'third-adapter')
const TEMP_ROOTS = new Set()
const REVIEW_SURFACE_PARENT = join(tmpdir(), 'caw-review-surfaces')
const CODEX_OUTER_PROFILE_HOST = platform() === 'darwin' && arch() === 'arm64'
// Claude's is asked of the adapter rather than named as a host pair: the two providers no longer
// support the same set of hosts, and a shared constant would have kept the Claude cases skipped
// on the machine that is running them.
const CLAUDE_OUTER_PROFILE_HOST =
  claude.describe({ role: 'architect', cliVersion: 'fixture' }).guarantees.writeScope.by === 'os-boundary'
// The constant above existed and gated nothing, so every case needing a bounded Claude row
// failed on a host that publishes none — with the engine's own honest refusal as the assertion
// diff, which reads as a regression in the thing that was working. These two say which
// mechanism is absent, so the skip count keeps meaning what it means here.
const claudeOuterProfileSkip = () => CLAUDE_OUTER_PROFILE_HOST
  ? false
  : 'this host publishes no bounded Claude row: the adapter resolves no outer profile'
const boundedSurfaceSkip = () => claudeOuterProfileSkip() || symlinkSkip()

function writeFixtureAttestation(adapterDir, provider, source) {
  const probeDir = join(adapterDir, 'probes')
  mkdirSync(probeDir)
  writeFileSync(join(probeDir, 'fixture-review-boundary-v2.json'), `${JSON.stringify({
    version: 1,
    provider,
    probe_id: 'fixture-review-boundary-v2',
    adapter_digest: createHash('sha256').update(source).digest('hex'),
    os: `${platform()}-${arch()}`,
    executable: realpathSync(FAKE),
    cli_version: 'fake-claude 1.0.0',
    role: 'reviewer',
    guarantee: 'writeScope',
    shipped: true,
    green: true,
    created_at: '2026-08-28T00:00:00.000Z',
    observations: {
      inside_attempted: true, outside_attempted: true,
      inside_write: true, outside_write: false,
    },
  }, null, 2)}\n`)
}

afterEach(() => {
  if (existsSync(REVIEW_SURFACE_PARENT)) {
    for (const name of readdirSync(REVIEW_SURFACE_PARENT)) {
      const surface = join(REVIEW_SURFACE_PARENT, name)
      try {
        const manifest = JSON.parse(readFileSync(join(surface, 'manifest.json'), 'utf8'))
        if ([...TEMP_ROOTS].some((root) =>
          manifest.source_repository?.startsWith(realpathSync(root)))) {
          rmSync(surface, { recursive: true, force: true })
        }
      } catch { /* not this test's surface */ }
    }
  }
  for (const root of TEMP_ROOTS) rmSync(root, { recursive: true, force: true })
  TEMP_ROOTS.clear()
})

const envelope = (value, overrides = {}) => ({
  structured_output: value,
  total_cost_usd: overrides.cost ?? 0.2,
  duration_ms: overrides.durationMs ?? 1250,
  usage: {
    input_tokens: overrides.input ?? 10,
    cache_creation_input_tokens: overrides.cacheWrite ?? 2,
    cache_read_input_tokens: overrides.cacheRead ?? 3,
    output_tokens: overrides.output ?? 4,
    output_tokens_details: { thinking_tokens: overrides.thinking ?? 1 },
  },
  modelUsage: overrides.modelUsage ?? {
    'claude-sonnet-test': { canonicalModel: 'claude-sonnet-test', outputTokens: 4 },
    'claude-haiku-test': { canonicalModel: 'claude-haiku-test', outputTokens: 1 },
  },
})

const population = (cases = [], requestIssues = []) => ({ cases, request_issues: requestIssues })
const requestSource = (excerpt, occurrence = 1) => ({ kind: 'request', excerpt, occurrence })
const plan = () => ({
  tasks: [{
    slug: 'baseline-task',
    title: 'Baseline task',
    read: ['README.md'],
    change: ['Write the fixture output.'],
    done_when: ['The fixture output exists.'],
  }],
  coverage: [{ case: 'fixture output', task: 'baseline-task' }],
  blocked: '',
  resplit: [],
})
const planReview = () => ({
  uncovered: [], unverifiable: [], misordered: [], out_of_scope: [], undecidable: [],
})
const delivery = (summary) => ({ summary, notes: [], blocked: '' })
const verdict = ({ criteria = [], carried = [], broken = [], uncovered = [], weak = [], noted = [] } = {}) =>
  ({ criteria, carried, broken, uncovered, weak, noted })

test('JavaScript provider paths use the current Node executable on every platform', () => {
  for (const platformName of ['darwin', 'linux', 'win32']) {
    assert.deepEqual(providerLaunch('/provider/fake-cli.mjs', platformName, 'claude'), {
      executable: process.execPath,
      leadingArgs: ['/provider/fake-cli.mjs'],
    })
    assert.deepEqual(providerLaunch('/provider/fake-cli.js', platformName, 'codex'), {
      executable: process.execPath,
      leadingArgs: ['/provider/fake-cli.js'],
    })
  }
})

test('ordinary native provider paths pass through without a shell or extra arguments', () => {
  assert.deepEqual(providerLaunch('C:\\Program Files\\Claude\\claude.exe', 'win32', 'claude'), {
    executable: 'C:\\Program Files\\Claude\\claude.exe',
    leadingArgs: [],
  })
  assert.deepEqual(providerLaunch('/opt/provider/bin/claude', 'linux', 'claude'), {
    executable: '/opt/provider/bin/claude',
    leadingArgs: [],
  })
})

test('Windows command scripts are refused intentionally instead of being launched', () => {
  for (const extension of ['cmd', 'bat', 'ps1']) {
    assert.throws(
      () => providerLaunch(`C:\\npm\\claude.${extension}`, 'win32', 'claude'),
      /command script .* intentionally not launched on Windows because it requires a shell/,
    )
  }
})

test('Windows command-script refusal names the native executable recovery setting', () => {
  assert.throws(
    () => providerLaunch('C:\\npm\\codex.cmd', 'win32', 'codex'),
    /Point CAW_CODEX at a native executable instead.*provider \.exe/,
  )
})

function fixture({
  git = false,
  gateFast = 'node -e "process.exit(0)"',
  gateFastTimeout = '',
  gateFull = '',
  gateFullTimeout = '',
  indexCmd = '',
  indexFormat = '',
  reviewDependencies = '',
  planningIndependence = '',
  taskIndependence = '',
} = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'caw-baseline-'))
  TEMP_ROOTS.add(parent)
  const root = join(parent, 'project')
  mkdirSync(join(root, '.caw'), { recursive: true })
  cpSync(join(ROOT, 'caw.mjs'), join(root, 'caw.mjs'))
  cpSync(join(ROOT, '.caw', 'agents'), join(root, '.caw', 'agents'), { recursive: true })
  cpSync(join(ROOT, '.caw', 'adapters'), join(root, '.caw', 'adapters'), { recursive: true })
  const testAdapterDir = join(root, '.caw', 'adapters', 'test-claude')
  mkdirSync(testAdapterDir)
  const testAdapterSource = `
import base from '../claude/adapter.mjs'
export default {
  ...base,
  id: 'test-claude',
  describe(input) {
    const descriptor = base.describe(input)
    delete descriptor.guarantees.repositoryRead.probe
    if (input.role === 'enumerator') {
      delete descriptor.guarantees.shellExecution.probe
      delete descriptor.guarantees.externalToolAccess.probe
    }
    if (input.role === 'architect' || input.role === 'plan-reviewer') {
      descriptor.guarantees.directEdit = { state: 'forbidden', by: 'absent' }
      descriptor.guarantees.writeScope = { state: 'none', by: 'absent' }
    }
    if (input.role === 'executor') descriptor.guarantees.writeScope = {
      state: 'delivery-tree', by: 'native-policy', probe: null,
    }
    if (input.role === 'reviewer') descriptor.guarantees.writeScope = {
      state: 'isolated-review-surface', by: 'isolated-surface',
      probe: { cliVersion: input.cliVersion, id: 'fixture-review-boundary-v2' },
    }
    return descriptor
  },
  verifyGuaranteeProbe(input) {
    if (input.probe.id === 'fixture-review-boundary-v2') {
      return {
        green: input.attestation?.green === true &&
          input.attestation?.observations?.inside_attempted === true &&
          input.attestation?.observations?.outside_attempted === true &&
          input.attestation?.observations?.inside_write === true &&
          input.attestation?.observations?.outside_write === false,
        id: input.probe.id,
        cliVersion: input.cliVersion,
      }
    }
    return base.verifyGuaranteeProbe(input)
  },
  decodeSuccess(stdout, input) {
    const decoded = base.decodeSuccess(stdout, input)
    decoded.canonical.provider = 'test-claude'
    return decoded
  },
}
`
  writeFileSync(join(testAdapterDir, 'adapter.mjs'), testAdapterSource)
  writeFixtureAttestation(testAdapterDir, 'test-claude', testAdapterSource)
  writeFileSync(join(root, '.caw', 'CAW.md'), `---
name: Baseline fixture
main_branch: main
gate_fast: ${gateFast}
gate_fast_timeout_ms: ${gateFastTimeout}
gate_full: ${gateFull}
gate_full_timeout_ms: ${gateFullTimeout}
index_cmd: ${indexCmd}
index_format: ${indexFormat}
review_dependency_roots: ${reviewDependencies}
docs_language: English
planning_independence: ${planningIndependence}
task_independence: ${taskIndependence}
---

# CAW profile

## Domain

Deterministic baseline fixture.
`)
  writeFileSync(join(root, '.caw', 'runtime.json'), `${JSON.stringify({
    version: 1,
    roles: {
      architect: { provider: 'test-claude', model: 'opus', reasoning: 'high' },
      enumerator: { provider: 'test-claude', model: 'opus', reasoning: 'high' },
      'plan-reviewer': { provider: 'test-claude', model: 'opus', reasoning: 'high' },
      executor: { provider: 'test-claude', model: 'sonnet', reasoning: 'high' },
      reviewer: { provider: 'test-claude', model: 'opus', reasoning: 'high' },
    },
  }, null, 2)}\n`)
  writeFileSync(join(root, 'README.md'), '# fixture\n')

  if (git) {
    writeFileSync(join(root, '.gitignore'), '.caw-tasks/\n.caw-logs/\nnode_modules/\n.env\n.fake-codex-calls.jsonl\n')
    if (reviewDependencies) {
      mkdirSync(join(root, 'node_modules', 'fixture'), { recursive: true })
      writeFileSync(join(root, 'node_modules', 'fixture', 'index.js'), 'dependency\n')
    }
    execFileSync('git', ['init', '-q', '-b', 'feature/baseline'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'CAW Baseline'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'baseline@example.invalid'], { cwd: root })
    execFileSync('git', ['add', '-A'], { cwd: root })
    execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: root })
  }

  const queue = join(parent, 'queue.json')
  const calls = join(parent, 'calls.jsonl')
  writeFileSync(calls, '')
  return { parent, root, queue, calls }
}

function configureProjectPolicies(f, source, stages = ['planning', 'review', 'gate', 'commit']) {
  const root = join(f.root, '.caw', 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'policy.mjs'), source)
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify({
    api_version: 1,
    policies: Object.fromEntries(stages.map((stage) => [stage, {
      id: `${stage}-policy`, command: ['node', '.caw/project/policy.mjs'], timeout_ms: 2000,
    }])),
  }, null, 2)}\n`)
  execFileSync('git', ['add', '.caw/project'], { cwd: f.root })
  execFileSync('git', ['commit', '-q', '-m', 'configure project policies'], { cwd: f.root })
}

const projectPolicySource = `
let text = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) text += chunk
const request = JSON.parse(text)
const outputs = {
  planning: request.context.request?.includes('blocked')
    ? { issues: ['project planning is blocked'], instructions: [] }
    : { issues: [], instructions: ['apply the project planning constraint'] },
  review: {
    criteria: [{ id: 'privacy', section: 'Privacy', criterion: 'No private value is logged.' }],
    instructions: ['trace the project privacy boundary'],
  },
  gate: request.context.task?.includes('policy-stop')
    ? { action: 'stop', reason: 'project gate policy rejected this task' }
    : { action: 'continue', reason: '' },
  commit: { subject: 'project: delivered safely' },
}
process.stdout.write(JSON.stringify(outputs[request.stage]))
`

function run(f, args, responses, extraEnv = {}) {
  writeFileSync(f.queue, `${JSON.stringify(responses, null, 2)}\n`)
  const env = {
    ...process.env,
    CAW_CLAUDE: FAKE,
    CAW_CODEX: FAKE_CODEX,
    CAW_THIRD: FAKE,
    CAW_FAKE_QUEUE: f.queue,
    CAW_FAKE_CALLS: f.calls,
    ...extraEnv,
  }
  // `os.tmpdir()` reads TMPDIR on POSIX and TEMP/TMP on Windows, and the engine derives every
  // transport, surface and scratch root from it. A case redirecting only TMPDIR therefore
  // isolates nothing on Windows: the engine keeps using the real temp root, the staged fixture
  // is not where it looks, and `artifacts list` truthfully answers `(none)` — a red that reads
  // as lost retention and is really a case naming a variable the host does not read. Mirrored
  // here so a case writes one variable and means one thing on every host.
  if (env.TMPDIR) {
    env.TEMP = env.TMPDIR
    env.TMP = env.TMPDIR
  }
  return spawnSync(process.execPath, ['caw.mjs', ...args], { cwd: f.root, encoding: 'utf8', env })
}

function calls(f) {
  return readFileSync(f.calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
}

function codexCalls(f) {
  const path = join(f.root, '.fake-codex-calls.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
}

function findAdapterTransportRoots() {
  const parent = join(tmpdir(), 'caw-adapter-transports')
  return existsSync(parent) ? readdirSync(parent).filter((name) => name.startsWith('transport-')) : []
}

function arg(call, name) {
  const index = call.argv.indexOf(name)
  assert.notEqual(index, -1, `missing ${name} in ${JSON.stringify(call.argv)}`)
  return call.argv[index + 1]
}

function configArg(call, key) {
  const values = call.argv.flatMap((value, index) => call.argv[index - 1] === '-c' ? [value] : [])
  const found = values.find((value) => value.startsWith(`${key}=`))
  assert.ok(found, `missing -c ${key}=... in ${JSON.stringify(call.argv)}`)
  return found.slice(key.length + 1)
}

function assertCommonInvocation(call, { tools, model, spec = null }) {
  assert.equal(call.argv[0], '--print')
  assert.equal(arg(call, '--output-format'), 'json')
  assert.equal(arg(call, '--setting-sources'), 'project,local')
  assert.equal(call.argv.includes('--strict-mcp-config'), true)
  assert.deepEqual(arg(call, '--tools'), tools)
  assert.equal(arg(call, '--permission-mode'), 'bypassPermissions')
  assert.equal(arg(call, '--model'), model)
  assert.equal(arg(call, '--effort'), 'high')
  const schema = JSON.parse(arg(call, '--json-schema'))
  assert.equal(schema.$schema, undefined)
  assert.equal(schema.additionalProperties, false)
  const instructions = arg(call, '--append-system-prompt')
  const pipelineAt = instructions.indexOf('## Pipeline invariants')
  const roleText = readFileSync(join(ROOT, '.caw', 'agents', `${call.role}.md`), 'utf8')
    .replace(/^---\n[\s\S]*?\n---\n/, '').trim()
  const roleAt = instructions.indexOf(roleText)
  const capabilitiesAt = instructions.indexOf('## Capabilities')
  const languageAt = instructions.indexOf('## Language')
  assert.equal(pipelineAt, 0)
  assert.equal(pipelineAt < roleAt && roleAt < capabilitiesAt && capabilitiesAt < languageAt, true)
  assert.doesNotMatch(instructions, /\n\nProfile:\n|\n\nTask spec:\n/)
  assert.equal(call.cawSpec, spec)
}

test('enumerator asks for the shortest resolvable source excerpt instead of review context', () => {
  const instructions = readFileSync(join(ROOT, '.caw', 'agents', 'enumerator.md'), 'utf8')

  assert.match(instructions, /shortest exact excerpt that resolves/)
  assert.match(instructions, /keep it short and use `occurrence`/)
  assert.match(instructions, /the `case` prose does that/)
  assert.match(instructions, /not a source when it is given instead\s+of one of the structured addresses/)
  assert.match(instructions, /valid short `excerpt` inside a repository source/)
  assert.match(instructions, /do not lengthen it merely because it is a symbol/)
  assert.doesNotMatch(instructions, /include enough surrounding text/)
})

test('every admitted population source class resolves a true anchor and rejects an invented peer', () => {
  const f = fixture({ git: true })
  const request = 'Handle a future input that does not exist yet.'
  const indexText = 'closed member alpha\nclosed member beta'
  const indexResult = {
    text: indexText,
    truncated: 0,
    sha256: createHash('sha256').update(indexText).digest('hex'),
  }
  const context = { request, indexResult, workingRoot: f.root }

  assert.equal(resolvePopulationSource({
    kind: 'repository', path: 'README.md', occurrence: 1, excerpt: '# fixture',
  }, context).ok, true)
  assert.match(resolvePopulationSource({
    kind: 'repository', path: 'README.md', occurrence: 1, excerpt: '# invented',
  }, context).reason, /does not exist/)

  assert.equal(resolvePopulationSource({
    kind: 'request', occurrence: 1, excerpt: 'future input',
  }, context).ok, true)
  assert.match(resolvePopulationSource({
    kind: 'request', occurrence: 1, excerpt: 'invented input',
  }, context).reason, /does not exist/)

  assert.equal(resolvePopulationSource({
    kind: 'index', index_sha256: indexResult.sha256,
    occurrence: 1, excerpt: 'closed member beta',
  }, context).ok, true)
  assert.match(resolvePopulationSource({
    kind: 'index', index_sha256: '0'.repeat(64),
    occurrence: 1, excerpt: 'closed member beta',
  }, context).reason, /digest/)

  assert.match(resolvePopulationSource({
    kind: 'repository', path: 'README.md', occurrence: 1,
    excerpt: '# fixture', index_sha256: indexResult.sha256,
  }, context).reason, /unknown index_sha256/)
  assert.match(resolvePopulationSource({
    kind: 'repository', path: '../outside.md', occurrence: 1, excerpt: 'outside',
  }, context).reason, /escapes delivery/)
})

test('population repair uses exact first-line then longest-block anchors and records both forms', () => {
  const f = fixture({ git: true })
  writeFileSync(join(f.root, 'README.md'), [
    '# fixture',
    'repeated repair line',
    'repository unique continuation',
    'repository tail',
    'repeated repair line',
    'other continuation',
  ].join('\n'))
  const indexText = 'index unique first\nindex retained tail'
  const indexResult = {
    text: indexText,
    truncated: 0,
    sha256: createHash('sha256').update(indexText).digest('hex'),
  }
  const direct = resolvePopulation([
    {
      case: 'repository longest block repair',
      source: {
        kind: 'repository', path: 'README.md', occurrence: 1,
        excerpt: 'repeated repair line\nrepository unique continuation\ninvented repository line',
      },
    },
    {
      case: 'index first line repair',
      source: {
        kind: 'index', index_sha256: indexResult.sha256, occurrence: 1,
        excerpt: 'index unique first\ninvented index line',
      },
    },
  ], { request: 'request', indexResult, workingRoot: f.root })

  assert.equal(direct.failures.length, 0)
  assert.equal(direct.repairs.length, 2)
  assert.equal(direct.cases[0].source.excerpt,
    'repeated repair line\nrepository unique continuation')
  assert.equal(direct.cases[0].source.occurrence, 1)
  assert.equal(direct.cases[1].source.excerpt, 'index unique first')

  const description = 'Create the fixture output'
  const original = '# fixture\ninvented copied line'
  const result = run(f, ['plan', description], [
    { envelope: envelope(population([{
      case: 'repair reaches review',
      source: { kind: 'repository', path: 'README.md', occurrence: 1, excerpt: original },
    }])) },
    { envelope: envelope(plan()) },
    { envelope: envelope(planReview()) },
  ])
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /repaired 1 anchor\(s\) by unique exact search/)
  const reviewCall = calls(f).find((call) => call.role === 'plan-reviewer')
  assert.match(reviewCall.input, /README\.md:1 — "# fixture"/)

  const runName = readdirSync(join(f.root, '.caw-logs')).find((name) => name.startsWith('run-'))
  const runPath = join(f.root, '.caw-logs', runName)
  const manifest = JSON.parse(readFileSync(join(runPath, 'manifest.json'), 'utf8'))
  const diagnostic = JSON.parse(readFileSync(join(runPath, manifest.diagnostics[0].file), 'utf8'))
  assert.equal(diagnostic.events[0].original_source.excerpt, original)
  assert.equal(diagnostic.events[0].resolved_source.excerpt, '# fixture')
  assert.equal(diagnostic.events[0].repaired, true)
})

test('population repair refuses a shortened anchor that occurs twice', () => {
  const f = fixture({ git: true })
  writeFileSync(join(f.root, 'README.md'), 'repeated line\nfirst\nrepeated line\nsecond\n')
  const resolved = resolvePopulation([{
    case: 'ambiguous repair must drop',
    source: {
      kind: 'repository', path: 'README.md', occurrence: 1,
      excerpt: 'repeated line\ninvented line',
    },
  }], {
    request: 'request',
    indexResult: { text: '', truncated: 0, sha256: null },
    workingRoot: f.root,
  })
  assert.equal(resolved.repairs.length, 0)
  assert.equal(resolved.failures.length, 1)
  assert.equal(resolved.state, 'none')
})

test('request repair follows the resolver failure gate and records both source forms', () => {
  const f = fixture({ git: true })
  const description = 'Preserve the exact request line\nThen implement the fixture'
  const original = 'Preserve the exact request line\nline omitted by the provider'
  const context = {
    request: description,
    indexResult: { text: '', truncated: 0, sha256: null },
    workingRoot: f.root,
  }
  const unresolved = resolvePopulationSource(requestSource(original), context)
  assert.equal(unresolved.reason, 'excerpt occurrence 1 does not exist in the request')

  const result = run(f, ['plan', description], [
    { envelope: envelope(population([{
      case: 'request repair reaches review', source: requestSource(original),
    }])) },
    { envelope: envelope(plan()) },
    { envelope: envelope(planReview()) },
  ])
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /repaired 1 anchor\(s\) by unique exact search/)
  const reviewCall = calls(f).find((call) => call.role === 'plan-reviewer')
  assert.match(reviewCall.input, /request#1 — "Preserve the exact request line"/)

  const runName = readdirSync(join(f.root, '.caw-logs')).find((name) => name.startsWith('run-'))
  const runPath = join(f.root, '.caw-logs', runName)
  const manifest = JSON.parse(readFileSync(join(runPath, 'manifest.json'), 'utf8'))
  const diagnostic = JSON.parse(readFileSync(join(runPath, manifest.diagnostics[0].file), 'utf8'))
  assert.deepEqual(diagnostic.events[0].original_source, requestSource(original))
  assert.deepEqual(diagnostic.events[0].resolved_source,
    requestSource('Preserve the exact request line'))
  assert.equal(diagnostic.events[0].repaired, true)
})

test('request repair refuses a shortened candidate that occurs twice', () => {
  const resolved = resolvePopulation([{
    case: 'ambiguous request repair must drop',
    source: requestSource('repeated request line\ninvented continuation'),
  }], {
    request: 'repeated request line\nfirst\nrepeated request line\nsecond',
    indexResult: { text: '', truncated: 0, sha256: null },
    workingRoot: process.cwd(),
  })

  assert.equal(resolved.repairs.length, 0)
  assert.equal(resolved.failures.length, 1)
  assert.equal(resolved.state, 'none')
})

test('repaired request source retains exactly the schema fields and resets occurrence', () => {
  const resolved = resolvePopulation([{
    case: 'request source shape survives repair',
    source: requestSource('unique request line\nelided request line', 7),
  }], {
    request: 'prefix\nunique request line\nsuffix',
    indexResult: { text: '', truncated: 0, sha256: null },
    workingRoot: process.cwd(),
  })

  assert.equal(resolved.failures.length, 0)
  assert.equal(resolved.repairs.length, 1)
  assert.deepEqual(resolved.cases[0].source, {
    kind: 'request', occurrence: 1, excerpt: 'unique request line',
  })
  assert.deepEqual(Object.keys(resolved.cases[0].source).sort(),
    ['excerpt', 'kind', 'occurrence'])
})

test('whitespace repair restores the live wrapped request bytes and records both forms', () => {
  const f = fixture({ git: true })
  const description = 'Record every state and the\n' +
    'severity each state maps to is recorded as a decision with its reason'
  const original =
    'and the severity each state maps to is recorded as a decision with its reason'
  const result = run(f, ['plan', description], [
    { envelope: envelope(population([{
      case: 'wrapped request citation', source: requestSource(original),
    }])) },
    { envelope: envelope(plan()) },
    { envelope: envelope(planReview()) },
  ])

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /repaired 1 anchor\(s\) by unique exact search/)
  const runName = readdirSync(join(f.root, '.caw-logs')).find((name) => name.startsWith('run-'))
  const runPath = join(f.root, '.caw-logs', runName)
  const manifest = JSON.parse(readFileSync(join(runPath, 'manifest.json'), 'utf8'))
  const diagnostic = JSON.parse(readFileSync(join(runPath, manifest.diagnostics[0].file), 'utf8'))
  assert.equal(diagnostic.events[0].original_source.excerpt, original)
  assert.equal(diagnostic.events[0].resolved_source.excerpt,
    'and the\nseverity each state maps to is recorded as a decision with its reason')
})

test('whitespace repair remains available after multi-line exact candidates fail', () => {
  const resolved = resolvePopulation([{
    case: 'multi-line wrap drift',
    source: requestSource('shared prefix\nwrapped middle unique tail'),
  }], {
    request: 'shared prefix\nwrapped middle\nunique tail\nshared prefix elsewhere',
    indexResult: { text: '', truncated: 0, sha256: null },
    workingRoot: process.cwd(),
  })

  assert.equal(resolved.failures.length, 0)
  assert.equal(resolved.repairs.length, 1)
  assert.equal(resolved.cases[0].source.excerpt,
    'shared prefix\nwrapped middle\nunique tail')
})

test('whitespace repair restores the live indented CAW prose bytes', () => {
  const f = fixture({ git: true })
  const profile = readFileSync(join(f.root, '.caw', 'CAW.md'), 'utf8') +
    '\nwhich is why\n  `pkg_integration/sensors/server_events.py` refuses\n'
  writeFileSync(join(f.root, '.caw', 'CAW.md'), profile)
  const original = 'which is why `pkg_integration/sensors/server_events.py` refuses'
  const resolved = resolvePopulation([{
    case: 'wrapped profile citation',
    source: {
      kind: 'repository', path: '.caw/CAW.md', occurrence: 1, excerpt: original,
    },
  }], {
    request: 'request',
    indexResult: { text: '', truncated: 0, sha256: null },
    workingRoot: f.root,
  })

  assert.equal(resolved.failures.length, 0)
  assert.equal(resolved.repairs.length, 1)
  assert.equal(resolved.cases[0].source.excerpt,
    'which is why\n  `pkg_integration/sensors/server_events.py` refuses')
})

test('whitespace-repaired source label keeps the real line number', () => {
  const f = fixture({ git: true })
  writeFileSync(join(f.root, 'wrapped.md'),
    'first line\nsecond line\nanchor begins\n  and continues\n')
  execFileSync('git', ['add', 'wrapped.md'], { cwd: f.root })
  execFileSync('git', ['commit', '-q', '-m', 'wrapped fixture'], { cwd: f.root })
  const result = run(f, ['plan', 'Create the fixture output'], [
    { envelope: envelope(population([{
      case: 'line address survives repair',
      source: {
        kind: 'repository', path: 'wrapped.md', occurrence: 1,
        excerpt: 'anchor begins and continues',
      },
    }])) },
    { envelope: envelope(plan()) },
    { envelope: envelope(planReview()) },
  ])

  assert.equal(result.status, 0, result.stderr || result.stdout)
  const reviewCall = calls(f).find((call) => call.role === 'plan-reviewer')
  assert.match(reviewCall.input, /wrapped\.md:3-4 — "anchor begins and continues"/)
  assert.doesNotMatch(reviewCall.input, /wrapped\.md:1/)
})

test('whitespace repair refuses spans made ambiguous by indentation collapse', () => {
  const f = fixture({ git: true })
  writeFileSync(join(f.root, 'ambiguous.py'), [
    'if ready:',
    '  return value',
    'if ready:',
    '    return value',
    '',
  ].join('\n'))
  const resolved = resolvePopulation([{
    case: 'indentation-sensitive spans stay ambiguous',
    source: {
      kind: 'repository', path: 'ambiguous.py', occurrence: 1,
      excerpt: 'if ready: return value',
    },
  }], {
    request: 'request',
    indexResult: { text: '', truncated: 0, sha256: null },
    workingRoot: f.root,
  })

  assert.equal(resolved.repairs.length, 0)
  assert.equal(resolved.failures.length, 1)
  assert.equal(resolved.state, 'none')
})

test('decorated continuation repair restores the live doc-comment bytes', () => {
  const f = fixture({ git: true })
  writeFileSync(join(f.root, 'SupabaseTests.swift'), [
    '/// These integration checks prove there is no',
    '/// fake/stub `SupabaseClient` transport harness anywhere in this test target',
    '',
  ].join('\n'))
  const original = 'no fake/stub `SupabaseClient` transport harness anywhere in this test target'
  const resolved = resolvePopulation([{
    case: 'live doc-comment wrap drift',
    source: {
      kind: 'repository', path: 'SupabaseTests.swift', occurrence: 1, excerpt: original,
    },
  }], {
    request: 'request', indexResult: { text: '', truncated: 0, sha256: null }, workingRoot: f.root,
  })

  assert.equal(resolved.failures.length, 0)
  assert.equal(resolved.repairs.length, 1)
  assert.equal(resolved.cases[0].source.excerpt,
    'no\n/// fake/stub `SupabaseClient` transport harness anywhere in this test target')
})

test('decorated continuation repair refuses an ambiguous flattened address', () => {
  const f = fixture({ git: true })
  writeFileSync(join(f.root, 'ambiguous.swift'), [
    '/// unique words begin', '/// and end', '',
    '/// unique words begin', '/// and end', '',
  ].join('\n'))
  const resolved = resolvePopulation([{
    case: 'decorated duplicates stay ambiguous',
    source: {
      kind: 'repository', path: 'ambiguous.swift', occurrence: 1,
      excerpt: 'unique words begin and end',
    },
  }], {
    request: 'request', indexResult: { text: '', truncated: 0, sha256: null }, workingRoot: f.root,
  })

  assert.equal(resolved.repairs.length, 0)
  assert.equal(resolved.failures.length, 1)
  assert.equal(resolved.state, 'none')
})

test('decorated continuation repair never treats a word as a prefix', () => {
  const f = fixture({ git: true })
  writeFileSync(join(f.root, 'prose.txt'), 'no actual premise\nno implied conclusion\n')
  const resolved = resolvePopulation([{
    case: 'real words are content',
    source: {
      kind: 'repository', path: 'prose.txt', occurrence: 1,
      excerpt: 'actual premise implied conclusion',
    },
  }], {
    request: 'request', indexResult: { text: '', truncated: 0, sha256: null }, workingRoot: f.root,
  })

  assert.equal(resolved.repairs.length, 0)
  assert.equal(resolved.failures.length, 1)
  assert.equal(resolved.state, 'none')
})

test('decorated continuation repair requires the same prefix on adjacent lines', () => {
  const f = fixture({ git: true })
  writeFileSync(join(f.root, 'mixed-list.txt'), '- actual premise\n* implied conclusion\n')
  const resolved = resolvePopulation([{
    case: 'different punctuation is not one decoration run',
    source: {
      kind: 'repository', path: 'mixed-list.txt', occurrence: 1,
      excerpt: 'actual premise implied conclusion',
    },
  }], {
    request: 'request', indexResult: { text: '', truncated: 0, sha256: null }, workingRoot: f.root,
  })

  assert.equal(resolved.repairs.length, 0)
  assert.equal(resolved.failures.length, 1)
  assert.equal(resolved.state, 'none')
})

test('decorated continuation repair preserves the real source line number', () => {
  const f = fixture({ git: true })
  writeFileSync(join(f.root, 'documented.swift'), [
    'first line', 'second line',
    '/// anchor begins', '/// and continues', '',
  ].join('\n'))
  const result = run(f, ['plan', 'Create the fixture output'], [
    { envelope: envelope(population([{
      case: 'decorated address survives repair',
      source: {
        kind: 'repository', path: 'documented.swift', occurrence: 1,
        excerpt: 'anchor begins and continues',
      },
    }])) },
    { envelope: envelope(plan()) },
    { envelope: envelope(planReview()) },
  ])

  assert.equal(result.status, 0, result.stderr || result.stdout)
  const reviewCall = calls(f).find((call) => call.role === 'plan-reviewer')
  assert.match(reviewCall.input,
    /documented\.swift:3-4 — "anchor begins \/\/\/ and continues"/)
  assert.doesNotMatch(reviewCall.input, /documented\.swift:1/)
})

test('source resolution treats CRLF and lone CR as LF but preserves every other byte', () => {
  const f = fixture({ git: true })
  mkdirSync(join(f.root, 'nested'))
  writeFileSync(join(f.root, 'nested', 'anchor.txt'),
    Buffer.from('alpha\r\nbeta\rgamma\r\n', 'utf8'))
  const context = {
    request: 'request',
    indexResult: { text: '', truncated: 0, sha256: null },
    workingRoot: f.root,
  }

  assert.equal(resolvePopulationSource({
    kind: 'repository', path: 'nested/anchor.txt', occurrence: 1,
    excerpt: 'alpha\nbeta\ngamma',
  }, context).ok, true)
  assert.match(resolvePopulationSource({
    kind: 'repository', path: 'nested/anchor.txt', occurrence: 1,
    excerpt: 'alpha\nbeta \ngamma',
  }, context).reason, /does not exist/)
  assert.match(resolvePopulationSource({
    kind: 'repository', path: 'nested\\anchor.txt', occurrence: 1,
    excerpt: 'alpha\nbeta\ngamma',
  }, context).reason, /use \/ separators/)
})

test('first-line repair uses the normalized line-ending space and keeps canonical slash paths', () => {
  const f = fixture({ git: true })
  mkdirSync(join(f.root, 'nested'))
  writeFileSync(join(f.root, 'nested', 'repair.txt'),
    Buffer.from('first line\r\nreal second line\r\n', 'utf8'))
  const resolved = resolvePopulation([{
    case: 'repair across checkout line endings',
    source: {
      kind: 'repository', path: 'nested/repair.txt', occurrence: 1,
      excerpt: 'first line\rinvented line',
    },
  }], {
    request: 'request',
    indexResult: { text: '', truncated: 0, sha256: null },
    workingRoot: f.root,
  })

  assert.equal(resolved.failures.length, 0)
  assert.equal(resolved.repairs.length, 1)
  assert.equal(resolved.cases[0].source.excerpt, 'first line')
  assert.equal(resolved.cases[0].source.path, 'nested/repair.txt')
})

test('mixed line endings increase normalized occurrence counts and therefore refuse repair', () => {
  const f = fixture({ git: true })
  writeFileSync(join(f.root, 'README.md'),
    Buffer.from('repeat\r\nnext\r\nrepeat\nnext\n', 'utf8'))
  const resolved = resolvePopulation([{
    case: 'ambiguous only after line-ending normalization',
    source: {
      kind: 'repository', path: 'README.md', occurrence: 1,
      excerpt: 'repeat\nnext\ninvented',
    },
  }], {
    request: 'request',
    indexResult: { text: '', truncated: 0, sha256: null },
    workingRoot: f.root,
  })

  assert.equal(resolved.repairs.length, 0)
  assert.equal(resolved.failures.length, 1)
  assert.equal(resolved.witnessWithdrawn, true)
})

test('per-case dropping retains below one third and withdraws at the threshold', () => {
  const f = fixture({ git: true })
  const context = {
    request: 'valid anchor',
    indexResult: { text: '', truncated: 0, sha256: null },
    workingRoot: f.root,
  }
  const valid = (name) => ({ case: name, source: requestSource('valid anchor') })
  const invalid = (name) => ({ case: name, source: requestSource('missing anchor') })

  const below = resolvePopulation([
    valid('one'), valid('two'), valid('three'), invalid('one bad of four'),
  ], context)
  assert.equal(below.droppedCount, 1)
  assert.equal(below.retainedCount, 3)
  assert.equal(below.witnessWithdrawn, false)
  assert.deepEqual(below.cases.map((item) => item.case), ['one', 'two', 'three'])

  const at = resolvePopulation([
    valid('one'), valid('two'), invalid('one bad of three'),
  ], context)
  assert.equal(at.droppedCount, 1)
  assert.equal(at.retainedCount, 0)
  assert.equal(at.witnessWithdrawn, true)
  assert.deepEqual(at.cases, [])
})

test('threshold withdrawal keeps a bounded reason and records population none', (t) => {
  const f = fixture({ git: true })
  const description = 'Create the fixture output'
  const invalid = Array.from({ length: 70 }, (_, index) => ({
    case: `sourceless in substance ${index + 1}`,
    source: requestSource(''),
  }))
  const result = run(f, ['plan', description], [
    { envelope: envelope(population([
      { case: 'valid request-derived case', source: requestSource(description) },
      ...invalid,
    ])) },
    { envelope: envelope(plan()) },
    { envelope: envelope(planReview()) },
  ])

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /provenance failure: 70 of 71 case\(s\).*dropped 70 as unsubstantiated/s)
  assert.match(result.stdout, /population: none.*withdrew all 71 returned cases/s)
  assert.match(result.stdout, /cases\[1\] request: excerpt is empty/)
  assert.match(result.stdout, /reviewer judges on its own reading alone; no automatic provider retry/)
  const recordedCalls = calls(f)
  const enumerationCall = recordedCalls.find((call) => call.role === 'enumerator')
  assert.equal(recordedCalls.filter((call) => call.role === 'enumerator').length, 1)
  const schemaAt = enumerationCall.argv.indexOf('--json-schema')
  const deliveredSchema = JSON.parse(enumerationCall.argv[schemaAt + 1])
  const sourceUnion = deliveredSchema.properties.cases.items.properties.source.anyOf
  assert.equal(sourceUnion.length, 3)
  for (const branch of sourceUnion) {
    assert.deepEqual([...branch.required].sort(), Object.keys(branch.properties).sort())
    assert.equal(branch.additionalProperties, false)
  }
  const reviewCall = recordedCalls.find((call) => call.role === 'plan-reviewer')
  assert.match(reviewCall.input, /population: none \(returned 71; repaired 0.*dropped 70 as unsubstantiated\)/)

  const runName = readdirSync(join(f.root, '.caw-logs')).find((name) => name.startsWith('run-'))
  const runPath = join(f.root, '.caw-logs', runName)
  const manifest = JSON.parse(readFileSync(join(runPath, 'manifest.json'), 'utf8'))
  assert.equal(manifest.diagnostics.length, 1)
  const diagnosticPath = join(runPath, manifest.diagnostics[0].file)
  const diagnostic = JSON.parse(readFileSync(diagnosticPath, 'utf8'))
  assert.deepEqual({
    returned: diagnostic.returned_count,
    failed: diagnostic.failed_count,
    discarded: diagnostic.discarded_count,
  }, { returned: 71, failed: 70, discarded: 70 })
  assert.equal(diagnostic.population, 'none')
  assert.equal(diagnostic.witness_withdrawn, true)
  assert.equal(diagnostic.events.length, 32)
  assert.equal(diagnostic.events_truncated, true)
  assert.equal(manifest.population, 'none')
  assert.deepEqual(manifest.population_counts, {
    returned: 71, repaired: 0, dropped_unsubstantiated: 70, retained: 0,
    witness_withdrawn: true,
  })
  assert.ok(manifest.diagnostics[0].bytes <= 16 * 1024)
  assert.equal(Buffer.byteLength(readFileSync(diagnosticPath)), manifest.diagnostics[0].bytes)
  assertPrivateMode(t, assert, diagnosticPath, 0o600, lstatSync)
})

test('population counts and none state travel downstream for partial, empty, and failed draws', () => {
  const description = 'Create the fixture output'
  const partial = fixture({ git: true })
  const partialResult = run(partial, ['plan', description], [
    { envelope: envelope(population([
      { case: 'valid one', source: requestSource(description) },
      { case: 'valid two', source: requestSource(description) },
      { case: 'valid three', source: requestSource(description) },
      { case: 'dropped', source: requestSource('missing') },
    ])) },
    { envelope: envelope(plan()) },
    { envelope: envelope(planReview()) },
  ])
  assert.equal(partialResult.status, 0, partialResult.stderr || partialResult.stdout)
  const partialReview = calls(partial).find((call) => call.role === 'plan-reviewer')
  assert.match(partialReview.input,
    /returned 4; repaired 0 by unique exact search; dropped 1 as unsubstantiated/)
  assert.match(partialReview.input, /valid one/)
  assert.doesNotMatch(partialReview.input, /- dropped  \[/)
  const partialRun = readdirSync(join(partial.root, '.caw-logs')).find((name) => name.startsWith('run-'))
  const partialManifest = JSON.parse(readFileSync(
    join(partial.root, '.caw-logs', partialRun, 'manifest.json'), 'utf8'))
  assert.equal(partialManifest.population, 'sample')
  assert.equal(partialManifest.population_counts.dropped_unsubstantiated, 1)

  const empty = fixture({ git: true })
  const emptyResult = run(empty, ['plan', description], [
    { envelope: envelope(population()) },
    { envelope: envelope(plan()) },
    { envelope: envelope(planReview()) },
  ])
  assert.equal(emptyResult.status, 0, emptyResult.stderr || emptyResult.stdout)
  assert.match(emptyResult.stdout, /population: none — enumerator returned no cases/)
  const emptyReview = calls(empty).find((call) => call.role === 'plan-reviewer')
  assert.match(emptyReview.input, /population: none \(returned 0; repaired 0.*dropped 0/)
  const emptyRun = readdirSync(join(empty.root, '.caw-logs')).find((name) => name.startsWith('run-'))
  const emptyManifest = JSON.parse(readFileSync(
    join(empty.root, '.caw-logs', emptyRun, 'manifest.json'), 'utf8'))
  assert.equal(emptyManifest.population, 'none')

  const failed = fixture({ git: true })
  const failedResult = run(failed, ['plan', description], [{
    status: 1,
    envelope: { result: 'enumeration failed', terminal_reason: 'provider', subtype: 'error' },
  }])
  assert.equal(failedResult.status, 1)
  assert.match(failedResult.stdout, /population: none — enumerator call failed/)
  const failedRun = readdirSync(join(failed.root, '.caw-logs')).find((name) => name.startsWith('run-'))
  const failedManifest = JSON.parse(readFileSync(
    join(failed.root, '.caw-logs', failedRun, 'manifest.json'), 'utf8'))
  assert.equal(failedManifest.population, 'none')
  assert.equal(failedManifest.population_counts.reason, 'call failed')
})

test('population block does not invent counts when array identity loses its summary', () => {
  const population = [{
    case: 'copied case remains visible',
    source: requestSource('copied case'),
  }]

  // This is the future filter/slice/de-duplication shape: the values survive, but the WeakMap
  // identity that owns the measured resolution summary does not.
  const block = populationBlock(population.slice())

  assert.match(block, /One independently enumerated sample/)
  assert.match(block, /copied case remains visible/)
  assert.doesNotMatch(block, /returned \d|repaired \d|dropped \d/)
  assert.doesNotMatch(block, /dropped 0 as unsubstantiated/)
})

test('population block identifies retained cases as one non-exhaustive sample', () => {
  const f = fixture({ git: true })
  const description = 'Create the fixture output'
  const result = run(f, ['plan', description], [
    { envelope: envelope(population([{
      case: 'sampled case', source: requestSource(description),
    }])) },
    { envelope: envelope(plan()) },
    { envelope: envelope(planReview()) },
  ])
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const reviewCall = calls(f).find((call) => call.role === 'plan-reviewer')
  assert.match(reviewCall.input, /One independently enumerated sample/)
  assert.match(reviewCall.input, /This is one draw, not an exhaustive list/)
  assert.doesNotMatch(reviewCall.input, /The population, enumerated by an agent/)
})

test('current plan path constructs three Claude calls and persists an approved queue', (t) => {
  const f = fixture()
  const result = run(f, ['plan', 'Create the fixture output'], [
    { envelope: envelope(population()) },
    { envelope: envelope(plan()) },
    { envelope: envelope(planReview()) },
  ])

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /runtime [0-9a-f]{64}/)
  assert.match(result.stdout, /test-claude\/opus reasoning=high adapter=[0-9a-f]{12} CLI=fake-claude 1\.0\.0/)
  assert.match(result.stdout, /UNBOUNDED RUNTIME RESIDUALS/)
  assert.match(result.stdout,
    /Shell-enabled roles can read outside delivery and make outbound network requests/)
  assert.doesNotMatch(result.stdout, /CAW_CODEX_AUTH_FILE is set/)
  assert.match(result.stdout, /1 task\(s\) written/)
  assert.match(result.stdout, /spent \$0\.60/)
  assert.equal(existsSync(join(f.root, '.caw-tasks', '001_baseline-task.md')), true)
  const planText = readFileSync(join(f.root, '.caw-tasks', 'PLAN.md'), 'utf8')
  assert.match(planText, /approved: true/)
  assert.match(planText, /population_state: none/)
  assert.match(planText, /population_digest: [0-9a-f]{64}/)
  assert.match(planText, /## Runtime provenance/)
  assert.match(planText, /"role": "enumerator"/)
  assert.match(planText, /"role": "architect"/)
  assert.match(planText, /"role": "plan-reviewer"/)

  const runNames = readdirSync(join(f.root, '.caw-logs')).filter((name) => name.startsWith('run-'))
  assert.equal(runNames.length, 1)
  const runPath = join(f.root, '.caw-logs', runNames[0])
  const manifest = JSON.parse(readFileSync(join(runPath, 'manifest.json'), 'utf8'))
  assert.equal(manifest.status, 'completed')
  assert.equal(manifest.calls.length, 3)
  assert.deepEqual(manifest.review_independence.map(({ scope, mode, satisfied }) =>
    [scope, mode, satisfied]), [
    ['planning', 'same-provider', true],
    ['task', 'same-provider', true],
  ])
  assert.deepEqual(manifest.calls.map(({ status }) => status), ['success', 'success', 'success'])
  assert.deepEqual(manifest.calls.map(({ usage_state }) => usage_state),
    ['reported', 'reported', 'reported'])
  assert.equal(new Set(manifest.calls.map(({ attempt_id }) => attempt_id)).size, 3)
  for (const call of manifest.calls) {
    assert.match(call.attempt_id, /^provider-\d{3}$/)
    assert.equal(existsSync(join(runPath, call.attempt_file)), true)
    const attempt = JSON.parse(readFileSync(join(runPath, call.attempt_file), 'utf8'))
    assert.equal(attempt.attempt_id, call.attempt_id)
    assert.equal(attempt.status, 'started')
    assert.equal(attempt.requested.model, 'opus')
    assert.equal(typeof attempt.requested.native.model, 'string')
  }
  const callFiles = readdirSync(runPath).filter((name) => name.startsWith('call-'))
  assert.equal(callFiles.length, 3)
  const retained = JSON.parse(readFileSync(join(runPath, callFiles[0]), 'utf8'))
  assert.ok(retained.final_response.structured_output)
  assert.equal(Object.prototype.hasOwnProperty.call(retained, 'progress_events'), false)
  assertPrivateMode(t, assert, join(runPath, callFiles[0]), 0o600, lstatSync)

  const seen = calls(f)
  assert.equal(seen.length, 3)
  assertCommonInvocation(seen[0], { tools: 'Read,Grep,Glob', model: 'opus' })
  assertCommonInvocation(seen[1], { tools: 'Read,Grep,Glob,Bash', model: 'opus' })
  assertCommonInvocation(seen[2], { tools: 'Read,Grep,Glob,Bash', model: 'opus' })
  assert.match(seen[0].input, /Request from the human:\n\nCreate the fixture output/)
  assert.match(result.stderr, /claude-sonnet-test\+claude-haiku-test/)

  const listed = run(f, ['artifacts', 'list'], [])
  assert.equal(listed.status, 0)
  assert.match(listed.stdout, new RegExp(runNames[0]))
  const purged = run(f, ['artifacts', 'purge', runNames[0]], [])
  assert.equal(purged.status, 0)
  assert.equal(existsSync(runPath), false)
})

test('request preflight stops after enumerator and before architect', () => {
  const f = fixture({ git: true })
  const issue = {
    issue: 'The request conflicts with project authority.',
    request_source: { kind: 'request', occurrence: 1, excerpt: 'do a thing' },
    authority_sources: [{
      kind: 'repository', path: '.caw/CAW.md', occurrence: 1, excerpt: '# CAW profile',
    }],
  }

  const result = run(f, ['plan', 'do a thing'], [
    { envelope: envelope(population([], [issue])) },
  ])

  assert.equal(result.status, 1)
  assert.deepEqual(calls(f).map((call) => call.role), ['enumerator'])
  assert.match(result.stdout, /request preflight stopped before architect; 1 issue/)
  assert.match(result.stdout, /request#1/)
  assert.match(result.stdout, /\.caw\/CAW\.md:/)
  assert.match(result.stderr, /No architect or plan-reviewer call ran/)
  assert.equal(existsSync(join(f.root, '.caw-tasks')), false)
})

test('project planning policy can stop or add instructions before provider calls', () => {
  const stopped = fixture({ git: true })
  configureProjectPolicies(stopped, projectPolicySource)
  const refused = run(stopped, ['plan', 'blocked request'], [])
  assert.equal(refused.status, 1)
  assert.equal(calls(stopped).length, 0)
  assert.match(refused.stdout, /project planning policy planning-policy stopped before enumerator/)

  const allowed = fixture({ git: true })
  configureProjectPolicies(allowed, projectPolicySource)
  const result = run(allowed, ['plan', 'Create the fixture output'], [
    { envelope: envelope(population()) },
    { envelope: envelope(plan()) },
    { envelope: envelope(planReview()) },
  ])
  assert.equal(result.status, 0, result.stderr || result.stdout)
  for (const call of calls(allowed)) {
    assert.match(call.input, /apply the project planning constraint/)
  }
  const runName = readdirSync(join(allowed.root, '.caw-logs'))
    .find((name) => name.startsWith('run-'))
  const manifest = JSON.parse(readFileSync(
    join(allowed.root, '.caw-logs', runName, 'manifest.json'), 'utf8'))
  assert.match(manifest.project_policies.manifest_digest, /^[0-9a-f]{64}$/)
  assert.deepEqual(manifest.policy_calls.map(({ stage, status }) => [stage, status]),
    [['planning', 'success']])
})

test('non-executable JavaScript provider fixture runs through Node for version and roles', () => {
  const f = fixture({ git: true })
  const providerScript = join(f.parent, 'provider-without-exec-bit.mjs')
  cpSync(FAKE, providerScript)
  chmodSync(providerScript, 0o644)
  const attestationPath = join(f.root, '.caw', 'adapters', 'test-claude', 'probes',
    'fixture-review-boundary-v2.json')
  const attestation = JSON.parse(readFileSync(attestationPath, 'utf8'))
  attestation.executable = realpathSync(providerScript)
  writeFileSync(attestationPath, `${JSON.stringify(attestation, null, 2)}\n`)
  const result = run(f, ['plan', 'Create the fixture output'], [
    { envelope: envelope(population()) },
    { envelope: envelope(plan()) },
    { envelope: envelope(planReview()) },
  ], { CAW_CLAUDE: providerScript })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(calls(f).length, 3)
  assert.match(result.stdout, /CLI=fake-claude 1\.0\.0/)
})

test('probe prints the conditional Codex credential residual only when explicit auth is set',
  { skip: !CODEX_OUTER_PROFILE_HOST }, () => {
    const f = fixture({ git: true })
    const runtimePath = join(f.root, '.caw', 'runtime.json')
    const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
    runtime.roles.executor = { provider: 'codex', model: 'gpt-codex-test', reasoning: 'max' }
    writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`)

    const probeResponse = () => ({
      role: 'executor', probeWrites: 'escape', probeReads: true, value: {
        inside: 'written', outside: 'denied', inside_attempted: true, outside_attempted: true,
        repository: 'read', observed_nonce: '', repository_read_attempted: true,
      },
    })
    let result = run(f, ['probe', 'codex'], [probeResponse()])
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /UNBOUNDED RUNTIME RESIDUALS/)
    assert.doesNotMatch(result.stdout, /CAW_CODEX_AUTH_FILE is set/)

    const authFile = join(f.parent, 'auth.json')
    writeFileSync(authFile, '{"fixture":"private"}\n', { mode: 0o600 })
    result = run(f, ['probe', 'codex'], [probeResponse()], { CAW_CODEX_AUTH_FILE: authFile })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout,
      /CAW_CODEX_AUTH_FILE is set: a Codex child can read its private credential copy/)
    assert.doesNotMatch(result.stdout, /fixture|auth\.json/)
  })

test('Codex executor uses file transport and returns the canonical result through the unchanged engine',
  { skip: !CODEX_OUTER_PROFILE_HOST }, () => {
  const f = fixture({ git: true })
  let result = run(f, ['plan', 'Create the fixture output'], [
    { envelope: envelope(population()) },
    { envelope: envelope(plan()) },
    { envelope: envelope(planReview()) },
  ])
  assert.equal(result.status, 0, result.stderr || result.stdout)

  const runtimePath = join(f.root, '.caw', 'runtime.json')
  const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
  runtime.roles.executor = { provider: 'codex', model: 'gpt-codex-test', reasoning: 'max' }
  writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`)
  execFileSync('git', ['add', runtimePath], { cwd: f.root })
  execFileSync('git', ['commit', '-q', '-m', 'select Codex executor'], { cwd: f.root })

  const probed = run(f, ['probe', 'codex'], [
    { role: 'executor', probeWrites: 'escape', probeReads: true, value: {
      inside: 'written', outside: 'written', inside_attempted: true, outside_attempted: true,
      repository: 'read', observed_nonce: '', repository_read_attempted: true,
    } },
  ])
  assert.equal(probed.status, 0, probed.stderr || probed.stdout)
  assert.match(probed.stdout, /codex-executor-delivery-v3: green/)
  writeFileSync(join(f.root, '.fake-codex-calls.jsonl'), '')

  result = run(f, ['build', '--no-full'], [
    { role: 'executor', value: delivery('written by Codex'), writeFiles: { 'output.txt': 'done\n' } },
    { role: 'reviewer', envelope: envelope(verdict({ criteria: [
      { id: 'must-cover-1', state: 'met', evidence: 'traced the fixture output case' },
      { id: 'done-when-1', state: 'met', evidence: 'traced the output and its gate' },
    ] })) },
  ])
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(readFileSync(join(f.root, 'output.txt'), 'utf8'), 'done\n')
  assert.match(`${result.stdout}\n${result.stderr}`, /1 unpriced Codex call/)

  const call = codexCalls(f)[0]
  assert.ok(call)
  assert.equal(call.argv[0], 'exec')
  assert.equal(call.argv.includes('--ignore-user-config'), true)
  assert.equal(call.argv.includes('--ignore-rules'), true)
  assert.equal(call.argv.includes('--strict-config'), true)
  assert.equal(call.argv.includes('--ephemeral'), true)
  assert.equal(call.argv.includes('--json'), true)
  assert.equal(arg(call, '--sandbox'), 'danger-full-access')
  assert.equal(arg(call, '--model'), 'gpt-codex-test')
  assert.equal(configArg(call, 'approval_policy'), '"never"')
  assert.equal(configArg(call, 'model_reasoning_effort'), '"xhigh"')
  assert.equal(configArg(call, 'web_search'), '"disabled"')
  assert.equal(configArg(call, 'features.apps'), 'false')
  assert.equal(configArg(call, 'features.hooks'), 'false')
  assert.equal(configArg(call, 'mcp_servers'), '{}')
  const instructions = JSON.parse(configArg(call, 'developer_instructions'))
  assert.match(instructions, /^## Pipeline invariants/)
  assert.match(instructions, /## Capabilities/)
  assert.equal(call.schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
  assert.equal(call.schema.additionalProperties, false)
  assert.equal(call.schemaMode, 0o600)
  assert.equal(call.transportMode, 0o700)
  assert.equal(existsSync(dirname(call.finalResponsePath)), false, 'adapter transport is cleaned')

  const runNames = readdirSync(join(f.root, '.caw-logs')).filter((name) => name.startsWith('run-')).sort()
  const latest = join(f.root, '.caw-logs', runNames.at(-1))
  const retainedPath = readdirSync(latest).filter((name) => name.startsWith('call-'))
    .map((name) => join(latest, name)).find((path) => path.endsWith('-executor.json'))
  const retained = JSON.parse(readFileSync(retainedPath, 'utf8'))
  assert.equal(retained.provider, 'codex')
  assert.deepEqual(retained.requested.native, {
    model: 'gpt-codex-test', reasoning: 'xhigh',
    permissionPolicy: 'approval=never,sandbox=danger-full-access,outer=seatbelt,external=disabled,hooks=disabled',
  })
  assert.deepEqual(retained.models, [])
  assert.deepEqual(retained.tokens, {
    input: 17, output: 7, cachedRead: 5, cachedWritten: null, reasoning: 2,
  })
  assert.equal(retained.cost, null)
  assert.equal(retained.duration_ms, null)
  assert.deepEqual(retained.final_response, delivery('written by Codex'))
})

test('stale adapter transports scrub credentials, remain bounded and support explicit purge', () => {
  const f = fixture()
  const isolatedTmp = join(f.parent, 'transport-tmp')
  const parent = join(isolatedTmp, 'caw-adapter-transports')
  const name = 'transport-stale-fixture'
  const root = join(parent, name)
  const credential = join(root, 'codex-home', 'auth.json')
  mkdirSync(dirname(credential), { recursive: true, mode: 0o700 })
  writeFileSync(credential, '{"fixture":"secret"}\n', { mode: 0o600 })
  writeFileSync(join(root, 'final.json'), '{"delivery":"sensitive"}\n', { mode: 0o600 })
  const now = new Date().toISOString()
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify({
    version: 1,
    transport_id: name,
    provider: 'codex',
    pid: 2147483647,
    created_at: now,
    updated_at: now,
    state: 'active',
    sensitive_paths: ['codex-home/auth.json'],
  }, null, 2)}\n`, { mode: 0o600 })

  const listed = run(f, ['artifacts', 'list'], [], { TMPDIR: isolatedTmp })
  assert.equal(listed.status, 0, listed.stderr || listed.stdout)
  assert.match(listed.stdout, new RegExp(`transports/${name}`))
  assert.equal(existsSync(credential), false)
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
  assert.equal(manifest.state, 'interrupted')
  assert.deepEqual(manifest.sensitive_paths, [])

  const purged = run(f, ['artifacts', 'purge', `transports/${name}`], [], { TMPDIR: isolatedTmp })
  assert.equal(purged.status, 0, purged.stderr || purged.stdout)
  assert.equal(existsSync(root), false)

  const createInterrupted = (id, updatedAt) => {
    const transportRoot = join(parent, id)
    mkdirSync(transportRoot)
    writeFileSync(join(transportRoot, 'manifest.json'), `${JSON.stringify({
      version: 1, transport_id: id, provider: 'codex', pid: 2147483647,
      created_at: updatedAt, updated_at: updatedAt, state: 'interrupted', sensitive_paths: [],
    }, null, 2)}\n`, { mode: 0o600 })
    return transportRoot
  }
  const clock = Date.now()
  const newest = Array.from({ length: 4 }, (_, index) => createInterrupted(
    `transport-count-${index}`, new Date(clock - index * 1000).toISOString()))
  const expired = createInterrupted('transport-expired',
    new Date(clock - 25 * 60 * 60 * 1000).toISOString())
  const bounded = run(f, ['artifacts', 'list'], [], { TMPDIR: isolatedTmp })
  assert.equal(bounded.status, 0, bounded.stderr || bounded.stdout)
  assert.equal(newest.slice(0, 3).every((path) => existsSync(path)), true)
  assert.equal(existsSync(newest[3]), false)
  assert.equal(existsSync(expired), false)
})

// The Codex adapter still names the macOS seatbelt directly; only Claude's boundary was
// ported. These cases assert what that unported boundary does, so on a host without it they
// have nothing to measure. Skipping says so; failing would have claimed Codex regressed.
test('Codex roles without usable guarantees or evidence refuse generically before a child call',
  { skip: !CODEX_OUTER_PROFILE_HOST }, () => {
  const cases = [
    ['architect', /architect guarantee repositoryRead lacks current green probe evidence/],
    ['enumerator', /enumerator guarantee repositoryRead lacks current green probe evidence/],
    ['plan-reviewer', /plan-reviewer guarantee repositoryRead lacks current green probe evidence/],
    ['reviewer', /reviewer guarantee repositoryRead lacks current green probe evidence/],
  ]
  if (CODEX_OUTER_PROFILE_HOST) {
    cases.push(['executor', /executor guarantee repositoryRead lacks current green probe evidence/])
  }
  for (const [role, pattern] of cases) {
    const f = fixture({ git: true })
    const runtimePath = join(f.root, '.caw', 'runtime.json')
    const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
    runtime.roles[role] = { provider: 'codex', model: 'gpt-codex-test', reasoning: 'high' }
    writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`)
    const result = run(f, ['plan', 'x'], [])
    assert.equal(result.status, 1)
    assert.match(result.stderr, pattern)
    assert.match(result.stderr, /node caw\.mjs probe codex/)
    assert.equal(calls(f).length, 0)
  }
})

test('preflight reports every missing evidence row and one recovery command per provider', () => {
  const f = fixture({ git: true })
  const sourceDir = join(f.root, '.caw', 'adapters', 'test-claude')
  const makeAdapter = (id, condition, probeId) => {
    const directory = join(f.root, '.caw', 'adapters', id)
    cpSync(sourceDir, directory, { recursive: true })
    rmSync(join(directory, 'probes'), { recursive: true, force: true })
    const adapterPath = join(directory, 'adapter.mjs')
    const source = readFileSync(adapterPath, 'utf8')
      .replace("id: 'test-claude',", `id: '${id}',\n  mechanismAvailable() { return true },`)
      .replace('    return descriptor\n  },',
        `    if (${condition}) descriptor.guarantees.repositoryRead.probe = {\n` +
        `      cliVersion: input.cliVersion, id: '${probeId}',\n` +
        `    }\n` +
        `    return descriptor\n  },`)
      .replace("decoded.canonical.provider = 'test-claude'",
        `decoded.canonical.provider = '${id}'`)
    writeFileSync(adapterPath, source)
  }
  makeAdapter('test-alpha', "input.role !== 'enumerator'", 'alpha-boundary-v1')
  makeAdapter('test-beta', "input.role === 'enumerator'", 'beta-boundary-v1')

  const runtimePath = join(f.root, '.caw', 'runtime.json')
  const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
  for (const role of Object.keys(runtime.roles)) {
    runtime.roles[role].provider = role === 'enumerator' ? 'test-beta' : 'test-alpha'
  }
  writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`)

  const result = run(f, ['plan', 'x'], [])
  assert.equal(result.status, 1)
  for (const role of ['architect', 'plan-reviewer', 'executor', 'reviewer']) {
    assert.match(result.stderr, new RegExp(
      `${role} guarantee repositoryRead lacks current green probe evidence \\(alpha-boundary-v1\\)`))
  }
  assert.match(result.stderr,
    /enumerator guarantee repositoryRead lacks current green probe evidence \(beta-boundary-v1\)/)
  assert.match(result.stderr,
    /reviewer guarantee writeScope lacks current green probe evidence \(fixture-review-boundary-v2\)/)
  assert.equal((result.stderr.match(/Run: node caw\.mjs probe test-alpha/g) || []).length, 1)
  assert.equal((result.stderr.match(/Run: node caw\.mjs probe test-beta/g) || []).length, 1)
  assert.equal(calls(f).length, 0)
})

test('repair commands bypass role guarantees while pipeline preflight remains all-five', (t) => {
  const f = fixture({ git: true })
  const runtimePath = join(f.root, '.caw', 'runtime.json')
  const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
  runtime.roles.enumerator = { provider: 'codex', model: 'gpt-codex-test', reasoning: 'high' }
  writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`)

  const isolatedTmp = join(f.parent, 'repair-command-tmp')
  const transportName = 'transport-before-refusal'
  const transportRoot = join(isolatedTmp, 'caw-adapter-transports', transportName)
  const credential = join(transportRoot, 'codex-home', 'auth.json')
  mkdirSync(dirname(credential), { recursive: true })
  writeFileSync(credential, '{"fixture":"secret"}\n')
  const now = new Date().toISOString()
  writeFileSync(join(transportRoot, 'manifest.json'), `${JSON.stringify({
    version: 1, transport_id: transportName, provider: 'codex', pid: 2147483647,
    created_at: now, updated_at: now, state: 'active',
    sensitive_paths: ['codex-home/auth.json'],
  }, null, 2)}\n`)
  const surfaceRoot = join(isolatedTmp, 'caw-review-surfaces', 'surface-before-refusal')
  mkdirSync(surfaceRoot, { recursive: true })
  writeFileSync(join(surfaceRoot, 'manifest.json'), `${JSON.stringify({
    state: 'active', pid: 2147483647, created_at: now, updated_at: now,
    source_repository: f.root,
  }, null, 2)}\n`)

  const pipeline = run(f, ['build'], [], { TMPDIR: isolatedTmp })
  assert.equal(pipeline.status, 1)
  // WHICH way the enumerator row fails depends on the host: where Codex can be bounded it
  // declares repositoryRead and wants probe evidence, and where it cannot it declares the row
  // unavailable and never gets that far. This case is about neither — it is about the sweep
  // happening before the refusal — so it pins that the enumerator row is what refused.
  assert.match(pipeline.stderr, CODEX_OUTER_PROFILE_HOST
    ? /enumerator guarantee repositoryRead lacks current green probe evidence/
    : /enumerator (guarantee|requires)/)
  assert.equal(existsSync(credential), false, 'credential sweep precedes failed preflight')
  const transportManifest = JSON.parse(readFileSync(join(transportRoot, 'manifest.json'), 'utf8'))
  assert.equal(transportManifest.state, 'interrupted')
  assert.deepEqual(transportManifest.sensitive_paths, [])
  const surfaceManifest = JSON.parse(readFileSync(join(surfaceRoot, 'manifest.json'), 'utf8'))
  assert.equal(surfaceManifest.state, 'interrupted')

  const listed = run(f, ['artifacts', 'list'], [], { TMPDIR: isolatedTmp })
  assert.equal(listed.status, 0, listed.stderr || listed.stdout)
  assert.match(listed.stdout, new RegExp(`transports/${transportName}`))

  // Same shape as the Codex tail below, and for the same reason: a probe is a bounded
  // invocation, so where no outer profile resolves the child never starts and this block can
  // say nothing. Announced rather than skipped with the case, because the credential sweep
  // above it is host-neutral, runs here, and is the invariant worth having.
  const boundedSkip = claudeOuterProfileSkip()
  if (boundedSkip) {
    t.diagnostic(`probe evidence half not exercised: ${boundedSkip}`)
  } else {
    const probed = run(f, ['probe', 'test-claude'], [{
      probeWrites: true,
      envelope: envelope({
        inside: 'attempted', outside: 'denied', inside_attempted: true, outside_attempted: true,
      }),
    }], { TMPDIR: isolatedTmp })
    assert.equal(probed.status, 0, probed.stderr || probed.stdout)
    assert.match(probed.stdout, /fixture-review-boundary-v2: green/)
  }

  // Only this tail needs Codex to be bounded; everything above it is host-neutral and runs
  // everywhere. Skipping the whole case would have taken the credential sweep with it.
  if (CODEX_OUTER_PROFILE_HOST) {
    const sameProvider = run(f, ['probe', 'codex'], [{
      role: 'enumerator', probeWrites: 'escape', probeReads: true, value: {
        inside: 'written', outside: 'denied', inside_attempted: true, outside_attempted: true,
        repository: 'read', observed_nonce: '', repository_read_attempted: true,
      },
    }], { TMPDIR: isolatedTmp })
    assert.equal(sameProvider.status, 0, sameProvider.stderr || sameProvider.stdout)
    assert.match(sameProvider.stdout, /codex-enumerator-boundary-v1: green/)
    assert.doesNotMatch(sameProvider.stderr, /enumerator guarantee/)
  }
})

test('artifact inspection and purge do not parse or resolve the runtime matrix', () => {
  const f = fixture({ git: true })
  writeFileSync(join(f.root, '.caw', 'runtime.json'), '{ invalid runtime\n')
  const retained = join(f.root, '.caw-logs', 'run-repair-fixture')
  mkdirSync(retained, { recursive: true })
  const probeRoot = resolve(f.root, execFileSync('git', ['rev-parse', '--git-path', 'caw/probes'], {
    cwd: f.root, encoding: 'utf8',
  }).trim())
  const unboundProbe = join(probeRoot, 'provider-not-in-matrix')
  mkdirSync(unboundProbe, { recursive: true })
  writeFileSync(join(unboundProbe, 'evidence.json'), '{}\n')

  const listed = run(f, ['artifacts', 'list'], [])
  assert.equal(listed.status, 0, listed.stderr || listed.stdout)
  assert.match(listed.stdout, /run-repair-fixture/)
  assert.match(listed.stdout, /probes\/provider-not-in-matrix/)
  const purged = run(f, ['artifacts', 'purge', 'run-repair-fixture'], [])
  assert.equal(purged.status, 0, purged.stderr || purged.stdout)
  assert.equal(existsSync(retained), false)
  const purgedProbe = run(f, ['artifacts', 'purge', 'probes/provider-not-in-matrix'], [])
  assert.equal(purgedProbe.status, 0, purgedProbe.stderr || purgedProbe.stdout)
  assert.equal(existsSync(unboundProbe), false)

  const probe = run(f, ['probe', 'test-claude'], [])
  assert.equal(probe.status, 1)
  assert.match(probe.stderr, /.caw\/runtime.json is not valid JSON/)
})

// The Codex adapter still names the macOS seatbelt directly; only Claude's boundary was
// ported. These cases assert what that unported boundary does, so on a host without it they
// have nothing to measure. Skipping says so; failing would have claimed Codex regressed.
test('Codex reviewer probe records the outer boundary and cleans native transport',
  { skip: !CODEX_OUTER_PROFILE_HOST }, () => {
  const transportsBefore = new Set(findAdapterTransportRoots())
  const f = fixture({ git: true })
  const runtimePath = join(f.root, '.caw', 'runtime.json')
  const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
  runtime.roles.reviewer = { provider: 'codex', model: 'gpt-codex-test', reasoning: 'high' }
  writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`)
  const futureEnv = { CAW_FAKE_CODEX_VERSION: 'codex-cli 9.9.9' }
  const result = run(f, ['probe', 'codex'], [
    { role: 'reviewer', probeWrites: 'escape', probeReads: true, value: {
      inside: 'written', outside: 'written', inside_attempted: true, outside_attempted: true,
      repository: 'read', observed_nonce: '', repository_read_attempted: true,
    } },
  ], futureEnv)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /codex-review-isolation-v3: green/)
  assert.deepEqual(findAdapterTransportRoots().filter((name) => !transportsBefore.has(name)), [])
  const probeRoot = resolve(f.root, execFileSync('git', ['rev-parse', '--git-path', 'caw/probes'], {
    cwd: f.root, encoding: 'utf8',
  }).trim())
  const evidenceName = readdirSync(join(probeRoot, 'codex'))[0]
  const evidence = JSON.parse(readFileSync(join(probeRoot, 'codex', evidenceName), 'utf8'))
  assert.equal(evidence.green, true)
  assert.equal(evidence.cli_version, 'codex-cli 9.9.9')
  assert.equal(evidence.observations.inside_write, true)
  assert.equal(evidence.observations.outside_write, false)
  assert.equal(evidence.observations.repository_read_attempted, true)
  assert.equal(evidence.observations.repository_read, true)

  const preflight = run(f, ['plan', 'probe-backed Codex reviewer'], [
    { envelope: envelope(population()) },
    { envelope: envelope(plan()) },
    { envelope: envelope(planReview()) },
  ], futureEnv)
  assert.equal(preflight.status, 0, preflight.stderr || preflight.stdout)
})

// The Codex adapter still names the macOS seatbelt directly; only Claude's boundary was
// ported. These cases assert what that unported boundary does, so on a host without it they
// have nothing to measure. Skipping says so; failing would have claimed Codex regressed.
test('Codex planning probe writes engine-private scratch, denies delivery, and preserves read',
  { skip: !CODEX_OUTER_PROFILE_HOST }, () => {
  const f = fixture({ git: true })
  const isolatedTmp = join(f.parent, 'planning-boundary-tmp')
  const runtimePath = join(f.root, '.caw', 'runtime.json')
  const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
  runtime.roles.architect = { provider: 'codex', model: 'gpt-codex-test', reasoning: 'high' }
  writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`)
  const result = run(f, ['probe', 'codex'], [{
    role: 'architect', probeWrites: 'escape', probeReads: true, value: {
      inside: 'written', outside: 'denied', inside_attempted: true, outside_attempted: true,
      repository: 'read', observed_nonce: '', repository_read_attempted: true,
    },
  }], { CAW_FAKE_CODEX_VERSION: 'codex-cli 9.9.9', TMPDIR: isolatedTmp })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /codex-planning-boundary-v1: green/)
  const probeRoot = resolve(f.root, execFileSync('git', ['rev-parse', '--git-path', 'caw/probes'], {
    cwd: f.root, encoding: 'utf8',
  }).trim())
  const evidenceName = readdirSync(join(probeRoot, 'codex'))[0]
  const evidence = JSON.parse(readFileSync(join(probeRoot, 'codex', evidenceName), 'utf8'))
  assert.equal(evidence.role, 'architect')
  assert.equal(evidence.green, true)
  assert.equal(evidence.observations.inside_write, true)
  assert.equal(evidence.observations.outside_write, false)
  assert.equal(evidence.observations.repository_read, true)

  const planned = run(f, ['plan', 'exercise the bounded Codex architect'], [
    { role: 'enumerator', envelope: envelope(population()) },
    { role: 'architect', value: plan() },
    { role: 'plan-reviewer', envelope: envelope(planReview()) },
  ], { CAW_FAKE_CODEX_VERSION: 'codex-cli 9.9.9', TMPDIR: isolatedTmp })
  assert.equal(planned.status, 0, planned.stderr || planned.stdout)
  const scratchParent = join(isolatedTmp, 'caw-invocation-scratch')
  assert.deepEqual(readdirSync(scratchParent), [], 'normal completion must remove invocation scratch')
})

// The Codex adapter still names the macOS seatbelt directly; only Claude's boundary was
// ported. These cases assert what that unported boundary does, so on a host without it they
// have nothing to measure. Skipping says so; failing would have claimed Codex regressed.
test('Codex enumerator probe enables repository execution under the engine-private boundary',
  { skip: !CODEX_OUTER_PROFILE_HOST }, () => {
  const f = fixture({ git: true })
  const isolatedTmp = join(f.parent, 'enumerator-boundary-tmp')
  const runtimePath = join(f.root, '.caw', 'runtime.json')
  const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
  runtime.roles.enumerator = { provider: 'codex', model: 'gpt-codex-test', reasoning: 'high' }
  writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`)

  const result = run(f, ['probe', 'codex'], [{
    role: 'enumerator', probeWrites: 'escape', probeReads: true, value: {
      inside: 'written', outside: 'denied', inside_attempted: true, outside_attempted: true,
      repository: 'read', observed_nonce: '', repository_read_attempted: true,
    },
  }], { CAW_FAKE_CODEX_VERSION: 'codex-cli 9.9.9', TMPDIR: isolatedTmp })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /codex-enumerator-boundary-v1: green/)
  const probeRoot = resolve(f.root, execFileSync('git', ['rev-parse', '--git-path', 'caw/probes'], {
    cwd: f.root, encoding: 'utf8',
  }).trim())
  const evidenceName = readdirSync(join(probeRoot, 'codex'))[0]
  const evidence = JSON.parse(readFileSync(join(probeRoot, 'codex', evidenceName), 'utf8'))
  assert.equal(evidence.role, 'enumerator')
  assert.equal(evidence.green, true)
  assert.equal(evidence.observations.inside_write, true)
  assert.equal(evidence.observations.outside_write, false)
  assert.equal(evidence.observations.repository_read, true)

  const planned = run(f, ['plan', 'exercise the bounded Codex enumerator'], [
    { role: 'enumerator', value: population() },
    { role: 'architect', envelope: envelope(plan()) },
    { role: 'plan-reviewer', envelope: envelope(planReview()) },
  ], { CAW_FAKE_CODEX_VERSION: 'codex-cli 9.9.9', TMPDIR: isolatedTmp })
  assert.equal(planned.status, 0, planned.stderr || planned.stdout)
  const scratchParent = join(isolatedTmp, 'caw-invocation-scratch')
  assert.deepEqual(readdirSync(scratchParent), [], 'normal completion must remove invocation scratch')
})

test('Codex write boundary cannot go green when repository read was not attempted',
  { skip: !CODEX_OUTER_PROFILE_HOST }, () => {
  const f = fixture({ git: true })
  const runtimePath = join(f.root, '.caw', 'runtime.json')
  const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
  runtime.roles.reviewer = { provider: 'codex', model: 'gpt-codex-test', reasoning: 'high' }
  writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`)
  const result = run(f, ['probe', 'codex'], [{
    role: 'reviewer', probeWrites: 'escape', value: {
      inside: 'written', outside: 'denied', inside_attempted: true, outside_attempted: true,
      repository: 'read tool unavailable', observed_nonce: '', repository_read_attempted: false,
    },
  }])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /codex-review-isolation-v3: unavailable.*repository="read tool unavailable"/)
  const probeRoot = resolve(f.root, execFileSync('git', ['rev-parse', '--git-path', 'caw/probes'], {
    cwd: f.root, encoding: 'utf8',
  }).trim())
  const evidenceName = readdirSync(join(probeRoot, 'codex'))[0]
  const evidence = JSON.parse(readFileSync(join(probeRoot, 'codex', evidenceName), 'utf8'))
  assert.equal(evidence.green, false)
  assert.equal(evidence.observations.inside_write, true)
  assert.equal(evidence.observations.outside_write, false)
  assert.equal(evidence.observations.repository_read_attempted, false)
  assert.equal(evidence.observations.repository_read, null)
})

test('Codex file transport refuses malformed, failed and oversized final responses',
  { skip: !CODEX_OUTER_PROFILE_HOST }, () => {
  for (const [response, pattern] of [
    [{ role: 'executor', finalText: '{broken' }, /malformed final JSON/],
    [{ role: 'executor', status: 1, error: 'schema transport rejected' }, /classification: schema[\s\S]*schema transport rejected/],
    [{ role: 'executor', finalText: 'x'.repeat(4 * 1024 * 1024 + 1) }, /final response is 4194305 bytes/],
    [{ role: 'executor', finalSymlink: '/etc/hosts' }, /final response is not a regular file/],
  ]) {
    const f = fixture({ git: true })
    const runtimePath = join(f.root, '.caw', 'runtime.json')
    const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
    runtime.roles.executor = { provider: 'codex', model: 'gpt-codex-test', reasoning: 'high' }
    writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`)
    execFileSync('git', ['add', '.caw/runtime.json'], { cwd: f.root })
    execFileSync('git', ['commit', '-q', '-m', 'select Codex executor'], { cwd: f.root })
    const probed = run(f, ['probe', 'codex'], [
      { role: 'executor', probeWrites: 'escape', probeReads: true, value: {
        inside: 'written', outside: 'written', inside_attempted: true, outside_attempted: true,
        repository: 'read', observed_nonce: '', repository_read_attempted: true,
      } },
    ])
    assert.equal(probed.status, 0, probed.stderr || probed.stdout)
    writeFileSync(join(f.root, '.fake-codex-calls.jsonl'), '')
    mkdirSync(join(f.root, '.caw-tasks'))
    writeFileSync(join(f.root, '.caw-tasks', '001_task.md'), `---\ntitle: Task\n---\n\nDo it.\n`)
    const result = run(f, ['build', '--no-full'], [response])
    assert.equal(result.status, 1)
    assert.match(result.stderr, pattern)
    const call = codexCalls(f)[0]
    assert.ok(call)
    assert.equal(existsSync(dirname(call.finalResponsePath)), false)
  }
})

test('missing runtime refuses with a complete five-role legacy migration', () => {
  const f = fixture()
  rmSync(join(f.root, '.caw', 'runtime.json'))
  const profilePath = join(f.root, '.caw', 'CAW.md')
  writeFileSync(profilePath, readFileSync(profilePath, 'utf8').replace(
    'docs_language: English',
    'permission_mode: bypassPermissions\nmodel_architect: legacy-opus\n' +
      'model_executor: legacy-sonnet\nmodel_reviewer: legacy-reviewer\neffort: medium\n' +
      'docs_language: English'))
  const result = run(f, ['plan', 'x'], [])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /will not execute a derived runtime/)
  const migrated = result.stderr.slice(result.stderr.indexOf('{'), result.stderr.lastIndexOf('}') + 1)
  const parsed = JSON.parse(migrated)
  assert.deepEqual(Object.keys(parsed.roles).sort(),
    ['architect', 'enumerator', 'executor', 'plan-reviewer', 'reviewer'])
  assert.equal(parsed.roles.architect.model, 'legacy-opus')
  assert.equal(parsed.roles.executor.model, 'legacy-sonnet')
  assert.equal(parsed.roles.enumerator.model, 'legacy-reviewer')
  assert.equal(parsed.roles['plan-reviewer'].model, 'legacy-reviewer')
  assert.equal(parsed.roles.reviewer.reasoning, 'medium')
})

test('project review independence is enforced before provider calls', () => {
  const allowed = fixture({ taskIndependence: 'different-model' })
  const result = run(allowed, ['plan', 'x'], [
    { envelope: envelope(population()) },
    { envelope: envelope(plan()) },
    { envelope: envelope(planReview()) },
  ])
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout,
    /task independence: different-model — anthropic\/sonnet -> anthropic\/opus/)

  const sameModel = fixture({ taskIndependence: 'different-model' })
  const runtimePath = join(sameModel.root, '.caw', 'runtime.json')
  const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
  runtime.roles.reviewer.model = runtime.roles.executor.model
  writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`)
  const refused = run(sameModel, ['plan', 'x'], [])
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /task independence requires different-model/)
  assert.equal(calls(sameModel).length, 0)

  const crossVendor = fixture({ taskIndependence: 'cross-vendor' })
  const crossRefused = run(crossVendor, ['plan', 'x'], [])
  assert.equal(crossRefused.status, 1)
  assert.match(crossRefused.stderr, /task independence requires cross-vendor/)
  assert.match(crossRefused.stderr, /anthropic\/sonnet -> anthropic\/opus/)
  assert.equal(calls(crossVendor).length, 0)

  const human = fixture({ planningIndependence: 'human-review' })
  const humanRefused = run(human, ['plan', 'x'], [])
  assert.equal(humanRefused.status, 1)
  assert.match(humanRefused.stderr, /planning independence requires human-review/)
  assert.match(humanRefused.stderr, /Automated approval is disabled/)
  assert.equal(calls(human).length, 0)
})

test('runtime rejects legacy mixing, unknown fields and incomplete or invalid rows', () => {
  const cases = [
    ['unknown document field', (v) => { v.fallback = 'claude' }, /unknown field.*fallback/],
    ['missing role', (v) => { delete v.roles.enumerator }, /missing: enumerator/],
    ['extra role', (v) => { v.roles.other = v.roles.architect }, /unknown field.*other/],
    ['unknown row field', (v) => { v.roles.executor.tools = ['Bash'] }, /unknown field.*tools/],
    ['unknown provider', (v) => { v.roles.executor.provider = 'missing-provider' }, /untrusted or unavailable adapter "missing-provider"/],
    ['blank model', (v) => { v.roles.executor.model = '' }, /model must be nonempty/],
    ['unknown reasoning', (v) => { v.roles.executor.reasoning = 'extreme' }, /reasoning must be one of/],
  ]
  for (const [name, mutate, pattern] of cases) {
    const f = fixture()
    const runtimePath = join(f.root, '.caw', 'runtime.json')
    const value = JSON.parse(readFileSync(runtimePath, 'utf8'))
    mutate(value)
    writeFileSync(runtimePath, `${JSON.stringify(value, null, 2)}\n`)
    const result = run(f, ['plan', 'x'], [])
    assert.equal(result.status, 1, name)
    assert.match(result.stderr, pattern, name)
  }

  const mixed = fixture()
  const profilePath = join(mixed.root, '.caw', 'CAW.md')
  writeFileSync(profilePath, readFileSync(profilePath, 'utf8').replace(
    'docs_language: English', 'model_architect: opus\ndocs_language: English'))
  const result = run(mixed, ['plan', 'x'], [])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /legacy runtime field.*model_architect/)
})

test('runtime preflight refuses a missing provider executable before a paid call', () => {
  const f = fixture()
  const result = run(f, ['plan', 'x'], [], { CAW_CLAUDE: join(f.parent, 'missing-claude') })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /runtime provider executable is unavailable/)
  assert.equal(calls(f).length, 0)
})

// Measured, not assumed: each of these received
// `caw: reviewer adapter could not construct invocation: bounded Claude invocation has no
// outer profile on this host` (and the preflight case its writeScope twin) on stderr, with
// status 1 and no verdict on stdout. The absent mechanism is the bounded row, same as the
// probe family; what differed is only that the refusal went to a stream the assertion did
// not read, so each looked like its own defect.
test('generic preflight rejects unavailable, stale, and failed reviewer guarantees',
  { skip: claudeOuterProfileSkip() }, () => {
  const unavailable = fixture()
  const runtimePath = join(unavailable.root, '.caw', 'runtime.json')
  const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
  runtime.roles.reviewer.provider = 'claude'
  writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`)
  let result = run(unavailable, ['plan', 'x'], [])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /reviewer guarantee (?:repositoryRead|writeScope) lacks current green probe evidence/)
  assert.match(result.stderr, /node caw\.mjs probe claude/)
  assert.equal(calls(unavailable).length, 0)

  const stale = fixture()
  const adapterPath = join(stale.root, '.caw', 'adapters', 'test-claude', 'adapter.mjs')
  writeFileSync(adapterPath, readFileSync(adapterPath, 'utf8').replace(
    'cliVersion: input.cliVersion, id:', "cliVersion: 'older-cli', id:"))
  result = run(stale, ['plan', 'x'], [])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /stale probe for older-cli/)
  assert.equal(calls(stale).length, 0)

  const failed = fixture()
  const failedProbe = join(failed.root, '.caw', 'adapters', 'test-claude', 'probes',
    'fixture-review-boundary-v2.json')
  const failedEvidence = JSON.parse(readFileSync(failedProbe, 'utf8'))
  failedEvidence.green = false
  failedEvidence.observations.outside_write = true
  writeFileSync(failedProbe, `${JSON.stringify(failedEvidence, null, 2)}\n`)
  result = run(failed, ['plan', 'x'], [])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /lacks current green probe evidence/)
  assert.equal(calls(failed).length, 0)
})

// Every case below drives the probe command against the fixture provider, and a probe is a
// BOUNDED invocation by definition: with no outer profile the child never starts, so each of
// them received `launch failure: probe child did not start: bounded Claude invocation has no
// outer profile on this host` instead of the staged condition it meant to observe. That is the
// same absent mechanism the rest of this file already gates on, and finding 63 is what made it
// legible: before it, all five printed `unavailable` with an empty reason and looked like five
// different defects.
test('probe command writes bounded Git-private evidence that unblocks exact preflight',
  { skip: claudeOuterProfileSkip() }, (t) => {
  const f = fixture({ git: true })
  rmSync(join(f.root, '.caw', 'adapters', 'test-claude', 'probes'), { recursive: true })
  const probeResponse = () => ({
    probeWrites: true,
    envelope: envelope({
      inside: 'attempted', outside: 'denied', inside_attempted: true, outside_attempted: true,
    }),
  })
  const probed = run(f, ['probe', 'test-claude'], [probeResponse()], {
    CLAUDECODE: 'must-not-reach-child',
    CLAUDE_CODE_ENTRYPOINT: 'must-not-reach-child-either',
  })
  assert.equal(probed.status, 0, probed.stderr || probed.stdout)
  assert.match(probed.stdout, /fixture-review-boundary-v2: green/)
  const greenSummary = probed.stdout.split('\n').find((line) =>
    line.startsWith('fixture-review-boundary-v2: green'))
  assert.doesNotMatch(greenSummary, /answer:|failure:/)
  const gitProbeRoot = resolve(f.root, execFileSync('git',
    ['rev-parse', '--git-path', 'caw/probes'], { cwd: f.root, encoding: 'utf8' }).trim())
  const providerRoot = join(gitProbeRoot, 'test-claude')
  const evidenceFiles = readdirSync(providerRoot)
  assert.equal(evidenceFiles.length, 1)
  const evidencePath = join(providerRoot, evidenceFiles[0])
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
  assert.equal(evidence.green, true)
  assert.equal(Object.prototype.hasOwnProperty.call(evidence, 'reason'), false)
  assert.equal(evidence.observations.inside_write, true)
  assert.equal(evidence.observations.outside_write, false)
  assert.deepEqual(evidence.environment.removed_keys.filter((key) => key.startsWith('CLAUDE')), [
    'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT',
  ])
  // Whether redirecting TMPDIR reads as changed or added depends on the host, not on the engine:
  // macOS always hands a process one and Linux usually does not. What the evidence owes is that
  // the child's TMPDIR is engine-owned either way.
  assert.equal(evidence.environment.changed_keys.includes('TMPDIR') ||
    evidence.environment.added_keys.includes('TMPDIR'), true)
  assert.doesNotMatch(JSON.stringify(evidence), /must-not-reach-child/)
  assertPrivateMode(t, assert, evidencePath, 0o600, lstatSync)
  assert.equal(lstatSync(evidencePath).size <= 64 * 1024, true)

  evidence.shipped = true
  evidence.created_at = '2020-01-01T00:00:00.000Z'
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  const forgedShipped = run(f, ['plan', 'x'], [])
  assert.equal(forgedShipped.status, 1)
  assert.match(forgedShipped.stderr, /lacks current green probe evidence/)

  const refreshed = run(f, ['probe', 'test-claude'], [probeResponse()])
  assert.equal(refreshed.status, 0, refreshed.stderr || refreshed.stdout)
  assert.equal(readdirSync(providerRoot).length, 1, 'an exact-key refresh replaces prior evidence')
  const listed = run(f, ['artifacts', 'list'], [])
  assert.equal(listed.status, 0)
  assert.match(listed.stdout, /probes\/test-claude/)

  const planRun = run(f, ['plan', 'probe-backed runtime'], [
    { envelope: envelope(population()) },
    { envelope: envelope(plan()) },
    { envelope: envelope(planReview()) },
  ])
  assert.equal(planRun.status, 0, planRun.stderr || planRun.stdout)

  // The CLI build is recorded and reported, never matched. A provider update must not refuse the
  // pipeline: the probe measures an OS write boundary the kernel enforces against any build, and
  // paying three live calls to re-observe it after every routine update bought nothing. This is
  // the case that stops the version being quietly put back into the key.
  const drifted = JSON.parse(readFileSync(join(providerRoot, readdirSync(providerRoot)[0]), 'utf8'))
  assert.equal(typeof drifted.cli_version, 'string')
  assert.equal(Object.prototype.hasOwnProperty.call(drifted, 'cli_version'), true)
  drifted.cli_version = 'fake-claude 0.0.1-from-an-older-build'
  writeFileSync(join(providerRoot, readdirSync(providerRoot)[0]),
    `${JSON.stringify(drifted, null, 2)}\n`)
  const olderBuild = run(f, ['round', '999_absent.md'], [])
  assert.equal(olderBuild.status, 1)
  assert.doesNotMatch(olderBuild.stderr, /lacks current green probe evidence/)
  assert.match(olderBuild.stderr, /999_absent\.md is not in the queue/)
  assert.match(olderBuild.stdout,
    /test-claude: probe evidence observed on CLI fake-claude 0\.0\.1-from-an-older-build; running fake-claude 1\.0\.0/)

  const adapterPath = join(f.root, '.caw', 'adapters', 'test-claude', 'adapter.mjs')
  writeFileSync(adapterPath, `${readFileSync(adapterPath, 'utf8')}\n// digest changed\n`)
  const stale = run(f, ['build', '--no-full'], [])
  assert.equal(stale.status, 1)
  assert.match(stale.stderr, /lacks current green probe evidence/)
  assert.match(stale.stderr, /node caw\.mjs probe test-claude/)
  const purged = run(f, ['artifacts', 'purge', 'probes/test-claude'], [])
  assert.equal(purged.status, 0)
  assert.equal(existsSync(providerRoot), false)
})

test('four independent Claude probe ids survive one recovery command and unblock all-Claude preflight',
  { skip: !CLAUDE_OUTER_PROFILE_HOST }, () => {
    const f = fixture({ git: true })
    const runtimePath = join(f.root, '.caw', 'runtime.json')
    const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
    for (const role of Object.keys(runtime.roles)) runtime.roles[role].provider = 'claude'
    writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`)

    const probeAnswer = (role) => ({
      role, probeWrites: true, probeReads: true,
      envelope: envelope({
        inside: 'attempted', outside: 'denied', inside_attempted: true, outside_attempted: true,
        repository: 'read', observed_nonce: '', repository_read_attempted: true,
      }),
    })
    const probed = run(f, ['probe', 'claude'], [
      probeAnswer('architect'), { role: 'enumerator', probeTools: true },
      probeAnswer('executor'), probeAnswer('reviewer'),
    ])
    assert.equal(probed.status, 0, probed.stderr || probed.stdout)
    for (const id of [
      'claude-planning-boundary-v1',
      'claude-enumerator-tools-v1',
      'claude-executor-delivery-v1',
      'claude-review-isolation-v3',
    ]) assert.match(probed.stdout, new RegExp(`${id}: green`))

    const probeRoot = resolve(f.root, execFileSync('git',
      ['rev-parse', '--git-path', 'caw/probes'], { cwd: f.root, encoding: 'utf8' }).trim())
    const evidenceNames = readdirSync(join(probeRoot, 'claude')).sort()
    assert.equal(evidenceNames.length, 4)
    for (const id of [
      'claude-planning-boundary-v1',
      'claude-enumerator-tools-v1',
      'claude-executor-delivery-v1',
      'claude-review-isolation-v3',
    ]) assert.equal(evidenceNames.some((name) => name.startsWith(`${id}-`)), true, id)

    const toolEvidenceName = evidenceNames.find((name) =>
      name.startsWith('claude-enumerator-tools-v1-'))
    const toolEvidence = JSON.parse(readFileSync(join(probeRoot, 'claude', toolEvidenceName), 'utf8'))
    assert.deepEqual(toolEvidence.observations.reported_tools, ['Read', 'Grep', 'Glob'])
    assert.equal(toolEvidence.observations.reported_tools_match, true)
    assert.equal(toolEvidence.observations.shell_tool_requested, false)
    assert.equal(toolEvidence.observations.shell_write, false)
    assert.equal(toolEvidence.observations.request_marker_received, true)

    const planned = run(f, ['plan', 'prove all three attestations survive'], [
      { role: 'enumerator', envelope: envelope(population()) },
      { role: 'architect', envelope: envelope(plan()) },
      { role: 'plan-reviewer', envelope: envelope(planReview()) },
    ])
    assert.equal(planned.status, 0, planned.stderr || planned.stdout)
  })

test('Claude enumerator tool probe independently rejects every tool-contract violation',
  { skip: !CLAUDE_OUTER_PROFILE_HOST }, () => {
    const boundary = (role) => ({
      role, probeWrites: true, probeReads: true,
      envelope: envelope({
        inside: 'attempted', outside: 'denied', inside_attempted: true,
        outside_attempted: true, repository: 'read', observed_nonce: '',
        repository_read_attempted: true,
      }),
    })
    for (const fault of [
      { reportedTools: ['Read', 'Grep', 'Glob', 'Bash'], observation: 'reported_tools_match' },
      { probeShellToolUse: true, observation: 'shell_tool_requested' },
      { probeShellWrite: true, observation: 'shell_write' },
    ]) {
      const f = fixture({ git: true })
      const runtimePath = join(f.root, '.caw', 'runtime.json')
      const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
      for (const role of Object.keys(runtime.roles)) runtime.roles[role].provider = 'claude'
      writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`)
      const probed = run(f, ['probe', 'claude'], [
        boundary('architect'), { role: 'enumerator', probeTools: true, ...fault },
        boundary('executor'), boundary('reviewer'),
      ])
      assert.equal(probed.status, 1, fault.observation)
      assert.match(probed.stdout, /claude-enumerator-tools-v1: unavailable/)
      const probeRoot = resolve(f.root, execFileSync('git',
        ['rev-parse', '--git-path', 'caw/probes'], { cwd: f.root, encoding: 'utf8' }).trim())
      const name = readdirSync(join(probeRoot, 'claude')).find((candidate) =>
        candidate.startsWith('claude-enumerator-tools-v1-'))
      const evidence = JSON.parse(readFileSync(join(probeRoot, 'claude', name), 'utf8'))
      assert.equal(evidence.green, false)
      assert.equal(evidence.observations[fault.observation],
        fault.observation === 'reported_tools_match' ? false : true)
    }
  })

test('red probe evidence remains unavailable and never weakens preflight',
  { skip: claudeOuterProfileSkip() }, () => {
  const f = fixture({ git: true })
  rmSync(join(f.root, '.caw', 'adapters', 'test-claude', 'probes'), { recursive: true })
  const longAccount = `policy declined ${'x'.repeat(20 * 1024)}`
  const probed = run(f, ['probe', 'test-claude'], [
    { envelope: envelope({
      inside: 'not attempted', outside: longAccount,
      inside_attempted: false, outside_attempted: false,
    }) },
  ])
  assert.equal(probed.status, 1)
  const summary = probed.stdout.split('\n').find((line) =>
    line.startsWith('fixture-review-boundary-v2: unavailable'))
  assert.match(summary, /answer: inside="not attempted", outside="policy declined/)
  assert.equal(Buffer.byteLength(summary) < 1024, true)
  const probeRoot = resolve(f.root, execFileSync('git', ['rev-parse', '--git-path', 'caw/probes'], {
    cwd: f.root, encoding: 'utf8',
  }).trim())
  const evidencePath = join(probeRoot, 'test-claude',
    readdirSync(join(probeRoot, 'test-claude'))[0])
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
  assert.equal(evidence.green, false)
  assert.equal(evidence.reason.kind, 'structured-probe-answer')
  assert.equal(evidence.reason.answer.inside, 'not attempted')
  assert.equal(evidence.reason.answer.inside_attempted, false)
  assert.equal(evidence.reason.answer.outside_attempted, false)
  assert.equal(evidence.observations.inside_write, null)
  assert.equal(evidence.observations.outside_write, null)
  assert.match(evidence.reason.answer.outside, /^policy declined/)
  assert.equal(evidence.reason.truncated, true)
  assert.equal(lstatSync(evidencePath).size <= 64 * 1024, true)
  const refused = run(f, ['plan', 'x'], [])
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /lacks current green probe evidence/)
})

test('non-zero probe retains and prints only the adapter-decoded bounded failure',
  { skip: claudeOuterProfileSkip() }, () => {
  const f = fixture({ git: true })
  rmSync(join(f.root, '.caw', 'adapters', 'test-claude', 'probes'), { recursive: true })
  const adapterPath = join(f.root, '.caw', 'adapters', 'test-claude', 'adapter.mjs')
  writeFileSync(adapterPath, readFileSync(adapterPath, 'utf8').replace(
    '  decodeSuccess(stdout, input) {',
    "  decodeFailure() { return 'classification: authentication ' + 'x'.repeat(20000) },\n" +
      '  decodeSuccess(stdout, input) {'))
  const probed = run(f, ['probe', 'test-claude'], [{
    status: 1,
    stderr: '401 Unauthorized: token expired',
    envelope: envelope({
      inside: 'not reached', outside: 'not reached',
      inside_attempted: false, outside_attempted: false,
    }),
  }])
  assert.equal(probed.status, 1)
  const summary = probed.stdout.split('\n').find((line) =>
    line.startsWith('fixture-review-boundary-v2: unavailable'))
  assert.match(summary, /failure: classification: authentication/)
  assert.equal(Buffer.byteLength(summary) < 1024, true)
  const probeRoot = resolve(f.root, execFileSync('git', ['rev-parse', '--git-path', 'caw/probes'], {
    cwd: f.root, encoding: 'utf8',
  }).trim())
  const evidencePath = join(probeRoot, 'test-claude',
    readdirSync(join(probeRoot, 'test-claude'))[0])
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
  assert.equal(evidence.green, false)
  assert.equal(evidence.reason.kind, 'provider-failure')
  assert.match(evidence.reason.diagnosis, /^classification: authentication/)
  assert.equal(evidence.reason.truncated, true)
  assert.equal(Buffer.byteLength(evidence.reason.diagnosis) <= 8 * 1024, true)
  assert.equal(Object.prototype.hasOwnProperty.call(evidence, 'stdout'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(evidence, 'stderr'), false)
  assert.equal(lstatSync(evidencePath).size <= 64 * 1024, true)
  const refused = run(f, ['plan', 'x'], [])
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /lacks current green probe evidence/)
})

test('zero-exit probe without an answer retains and prints the exact transport path',
  { skip: claudeOuterProfileSkip() }, () => {
  const f = fixture({ git: true })
  rmSync(join(f.root, '.caw', 'adapters', 'test-claude', 'probes'), { recursive: true })
  const transportParent = join(tmpdir(), 'caw-adapter-transports')
  mkdirSync(transportParent, { recursive: true })
  const transportRoot = mkdtempSync(join(transportParent, 'transport-'))
  const finalResponsePath = join(transportRoot, 'missing-final.json')
  const adapterPath = join(f.root, '.caw', 'adapters', 'test-claude', 'adapter.mjs')
  writeFileSync(adapterPath, readFileSync(adapterPath, 'utf8').replace(
    "  id: 'test-claude',",
    `  id: 'test-claude',\n` +
      `  features: { ...base.features, resultTransport: 'file' },\n` +
      `  buildProbeInvocation(input) {\n` +
      `    return { ...base.buildProbeInvocation(input), transport: {\n` +
      `      root: ${JSON.stringify(transportRoot)},\n` +
      `      finalResponsePath: ${JSON.stringify(finalResponsePath)},\n` +
      `    } }\n` +
      `  },`))
  const probed = run(f, ['probe', 'test-claude'], [{ stdoutText: '', status: 0 }])
  assert.equal(probed.status, 1)
  const summary = probed.stdout.split('\n').find((line) =>
    line.startsWith('fixture-review-boundary-v2: unavailable'))
  assert.match(summary, /provider exited 0 but no structured probe answer was recovered from/)
  assert.equal(summary.includes(JSON.stringify(finalResponsePath)), true)
  const probeRoot = resolve(f.root, execFileSync('git', ['rev-parse', '--git-path', 'caw/probes'], {
    cwd: f.root, encoding: 'utf8',
  }).trim())
  const evidencePath = join(probeRoot, 'test-claude',
    readdirSync(join(probeRoot, 'test-claude'))[0])
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
  assert.equal(evidence.green, false)
  assert.deepEqual(evidence.reason, {
    kind: 'missing-structured-probe-answer',
    child_status: 0,
    expected_at: finalResponsePath,
    truncated: false,
  })
})

test('probe launch failure retains and prints the spawn error',
  { skip: claudeOuterProfileSkip() }, () => {
  const f = fixture({ git: true })
  rmSync(join(f.root, '.caw', 'adapters', 'test-claude', 'probes'), { recursive: true })
  const missingExecutable = join(f.parent, 'provider-does-not-exist')
  const adapterPath = join(f.root, '.caw', 'adapters', 'test-claude', 'adapter.mjs')
  writeFileSync(adapterPath, readFileSync(adapterPath, 'utf8').replace(
    "  id: 'test-claude',",
    `  id: 'test-claude',\n` +
      `  buildProbeInvocation(input) {\n` +
      `    return { ...base.buildProbeInvocation(input),\n` +
      `      executable: ${JSON.stringify(missingExecutable)}, args: [] }\n` +
      `  },`))
  const probed = run(f, ['probe', 'test-claude'], [{ stdoutText: '', status: 0 }])
  assert.equal(probed.status, 1)
  const summary = probed.stdout.split('\n').find((line) =>
    line.startsWith('fixture-review-boundary-v2: unavailable'))
  assert.match(summary, /launch failure: probe child did not start:/)
  assert.match(summary, /ENOENT/)
  assert.equal(summary.includes(missingExecutable), true)
  const probeRoot = resolve(f.root, execFileSync('git', ['rev-parse', '--git-path', 'caw/probes'], {
    cwd: f.root, encoding: 'utf8',
  }).trim())
  const evidencePath = join(probeRoot, 'test-claude',
    readdirSync(join(probeRoot, 'test-claude'))[0])
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
  assert.equal(evidence.green, false)
  assert.equal(evidence.reason.kind, 'probe-launch-failure')
  assert.match(evidence.reason.diagnosis, /ENOENT/)
  assert.equal(evidence.reason.diagnosis.includes(missingExecutable), true)
  assert.equal(evidence.reason.truncated, false)
})

test('host mechanism refusal happens before a provider probe call', () => {
  const f = fixture({ git: true })
  rmSync(join(f.root, '.caw', 'adapters', 'test-claude', 'probes'), { recursive: true })
  const adapterPath = join(f.root, '.caw', 'adapters', 'test-claude', 'adapter.mjs')
  writeFileSync(adapterPath, readFileSync(adapterPath, 'utf8').replace(
    "  id: 'test-claude',",
    `  id: 'test-claude',\n` +
      `  mechanismAvailable({ mechanism }) {\n` +
      `    return !['os-boundary', 'isolated-surface'].includes(mechanism)\n` +
      `  },`))
  const probed = run(f, ['probe', 'test-claude'], [{ stdoutText: '', status: 0 }])
  assert.equal(probed.status, 1)
  assert.match(probed.stderr,
    /reviewer adapter cannot resolve host mechanism isolated-surface; provider probe was not started/)
  assert.equal(calls(f).length, 0)
  assert.equal(JSON.parse(readFileSync(f.queue, 'utf8')).length, 1)
})

test('adapter discovery rejects malformed contracts before execution', () => {
  const legacy = fixture()
  const legacyAdapterPath = join(legacy.root, '.caw', 'adapters', 'test-claude', 'adapter.mjs')
  writeFileSync(legacyAdapterPath, readFileSync(legacyAdapterPath, 'utf8').replace(
    "id: 'test-claude',", "id: 'test-claude',\n  apiVersion: 1,"))
  const legacyResult = run(legacy, ['plan', 'x'], [])
  assert.equal(legacyResult.status, 1)
  assert.match(legacyResult.stderr,
    /adapter test-claude has malformed contract; API version is 1, expected 3/)
  assert.equal(calls(legacy).length, 0)

  const f = fixture()
  const adapterPath = join(f.root, '.caw', 'adapters', 'test-claude', 'adapter.mjs')
  writeFileSync(adapterPath, readFileSync(adapterPath, 'utf8').replace(
    "id: 'test-claude',", "id: 'test-claude',\n  projectExecutable: '/tmp/run-me',"))
  const result = run(f, ['plan', 'x'], [])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /malformed contract.*unknown projectExecutable/)
  assert.equal(calls(f).length, 0)

  const traversal = fixture()
  const runtimePath = join(traversal.root, '.caw', 'runtime.json')
  const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
  runtime.roles.executor.provider = '../claude'
  writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`)
  const refused = run(traversal, ['plan', 'x'], [])
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /untrusted or unavailable adapter "\.\.\/claude"/)
  assert.equal(calls(traversal).length, 0)

  const transport = fixture()
  const transportAdapterPath = join(transport.root, '.caw', 'adapters', 'test-claude', 'adapter.mjs')
  writeFileSync(transportAdapterPath, readFileSync(transportAdapterPath, 'utf8').replace(
    'const descriptor = base.describe(input)',
    "const descriptor = base.describe(input)\n    descriptor.features.resultTransport = 'pipe'"))
  const unsupportedTransport = run(transport, ['plan', 'x'], [])
  assert.equal(unsupportedTransport.status, 1)
  assert.match(unsupportedTransport.stderr, /unsupported result transport pipe/)
  assert.equal(calls(transport).length, 0)

  const unprobedBoundary = fixture()
  const boundaryAdapterPath = join(unprobedBoundary.root, '.caw', 'adapters', 'test-claude', 'adapter.mjs')
  writeFileSync(boundaryAdapterPath, readFileSync(boundaryAdapterPath, 'utf8').replace(
    "descriptor.guarantees.writeScope = { state: 'none', by: 'absent' }",
    "descriptor.guarantees.writeScope = { state: 'engine-private-only', by: 'os-boundary' }"))
  const missingProbe = run(unprobedBoundary, ['plan', 'x'], [])
  assert.equal(missingProbe.status, 1)
  assert.match(missingProbe.stderr, /uses os-boundary without a versioned probe/)
  assert.equal(calls(unprobedBoundary).length, 0)
})

// Measured on the first host with neither helper: the probe RAN and honestly reported the
// escape it saw — `inside_write: true, outside_write: true`, so not green, so exit 1 against
// the 0 this case wants. Nothing is broken in the contract under test; there is simply no
// boundary here for the fixture to hold. Note the asymmetry it exposes, which is not gated
// away by this line: unlike the Claude adapter, this fixture keeps declaring
// `isolated-review-surface` with a probe where it resolves no profile, so the shortfall costs
// a probe call to discover instead of being refused before spend.
test('an independent third adapter completes the public contract without an engine edit',
  { skip: outerBoundaryHelperSkip() }, () => {
  const f = fixture({ git: true })
  const engineBefore = createHash('sha256').update(readFileSync(join(f.root, 'caw.mjs'))).digest('hex')
  const source = readFileSync(join(THIRD_ADAPTER, 'adapter.mjs'), 'utf8')
  assert.doesNotMatch(source, /from\s+['"].*claude|import\s+base/)
  cpSync(THIRD_ADAPTER, join(f.root, '.caw', 'adapters', 'test-third'), { recursive: true })

  const runtimePath = join(f.root, '.caw', 'runtime.json')
  const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
  for (const role of Object.keys(runtime.roles)) {
    runtime.roles[role] = { provider: 'test-third', model: `third-${role}`, reasoning: 'high' }
  }
  writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`)

  const greenProbe = (role) => ({
    role, probeWrites: true,
    envelope: envelope({
      inside: 'attempted', outside: 'denied', inside_attempted: true, outside_attempted: true,
    }),
  })
  const probed = run(f, ['probe', 'test-third'], [greenProbe('reviewer')])
  assert.equal(probed.status, 0, probed.stderr || probed.stdout)
  assert.match(probed.stdout, /test-third-review-isolation-v2: green/)
  writeFileSync(f.calls, '')

  const planned = run(f, ['plan', 'exercise the independent third adapter'], [
    { envelope: envelope(population()) },
    { envelope: envelope(plan()) },
    { envelope: envelope(planReview()) },
  ])
  assert.equal(planned.status, 0, planned.stderr || planned.stdout)
  assert.equal(calls(f).length, 3)
  assert.equal(createHash('sha256').update(readFileSync(join(f.root, 'caw.mjs'))).digest('hex'), engineBefore)
  assert.match(readFileSync(join(f.root, '.caw-tasks', 'PLAN.md'), 'utf8'), /test-third/)
})

test('current build stop and round resume preserve carried findings and commit',
  { skip: claudeOuterProfileSkip() }, () => {
  const f = fixture({ git: true })
  mkdirSync(join(f.root, '.caw-tasks'))
  writeFileSync(join(f.root, '.caw-tasks', '001_baseline-task.md'), `---
title: Baseline task
---

## Change

- Write the fixture output.

## Done when

- The fixture output exists.
`)
  const criteria = [{
    id: 'done-when-1', state: 'met', evidence: 'traced the fixture output and its gate',
  }]

  const first = run(f, ['build', '--no-full'], [
    { writeFiles: { 'src/output.txt': 'round one\n' }, envelope: envelope(delivery('first pass')) },
    { recordReviewProbe: true, envelope: envelope(verdict({ criteria, broken: [{
      where: 'src/output.txt:1', fix: 'write the final value', evidence: 'read round one',
    }] })) },
    { writeFiles: { 'src/output.txt': 'round two\n' }, envelope: envelope(delivery('second pass')) },
    { recordReviewProbe: true, envelope: envelope(verdict({ criteria, carried: [{
      id: 'r1.1', state: 'open', evidence: 'the final value is still absent',
    }] })) },
  ])

  assert.equal(first.status, 1)
  assert.match(`${first.stdout}\n${first.stderr}`, /round 2 closed none/)
  const state = join(f.root, '.caw-tasks', '.round-001_baseline-task.md.json')
  assert.equal(existsSync(state), true)
  const saved = JSON.parse(readFileSync(state, 'utf8'))
  assert.equal(saved.history[0].id, 'r1.1')
  assert.equal(saved.state_version, 4)
  assert.match(saved.runtime_digest, /^[0-9a-f]{64}$/)
  assert.equal(saved.runtime_history.some((entry) => entry.role === 'reviewer'), true)
  assert.equal(saved.history[0].origin_runtime.provider, 'test-claude')
  assert.equal(saved.history[0].origin_runtime.requested.model, 'opus')
  assert.equal(saved.accounting.priced.USD, 0.8)
  const reviewProbes = saved.noted.filter((note) => note.startsWith('fake-review-probe:'))
    .map((note) => JSON.parse(note.slice('fake-review-probe:'.length)))
  assert.equal(reviewProbes.length, 2)
  assert.equal(reviewProbes[0].instructionsSha256, reviewProbes[1].instructionsSha256)
  for (const probe of reviewProbes) {
    assert.equal(probe.sectionOffsets.pipeline, 0)
    assert.equal(probe.sectionOffsets.pipeline < probe.sectionOffsets.capabilities &&
      probe.sectionOffsets.capabilities < probe.sectionOffsets.language, true)
  }
  assert.equal(lstatSync(state).mode & 0o777, 0o600)

  const runtimePath = join(f.root, '.caw', 'runtime.json')
  const changedRuntime = JSON.parse(readFileSync(runtimePath, 'utf8'))
  const originalAdapter = join(f.root, '.caw', 'adapters', 'test-claude', 'adapter.mjs')
  const otherAdapterDir = join(f.root, '.caw', 'adapters', 'other')
  mkdirSync(otherAdapterDir)
  const otherSource = readFileSync(originalAdapter, 'utf8').replaceAll('test-claude', 'other')
  writeFileSync(join(otherAdapterDir, 'adapter.mjs'), otherSource)
  writeFixtureAttestation(otherAdapterDir, 'other', otherSource)
  changedRuntime.roles.reviewer.provider = 'other'
  changedRuntime.roles.reviewer.model = 'opus-next'
  changedRuntime.roles.reviewer.reasoning = 'medium'
  writeFileSync(runtimePath, `${JSON.stringify(changedRuntime, null, 2)}\n`)

  const unpricedReview = envelope(verdict({ criteria, carried: [{
    id: 'r1.1', state: 'closed', evidence: 'read final',
  }] }))
  delete unpricedReview.total_cost_usd

  const second = run(f, ['round', '001_baseline-task.md'], [
    { writeFiles: { 'src/output.txt': 'final\n' }, envelope: envelope(delivery('final pass')) },
    { envelope: unpricedReview },
  ])

  assert.equal(second.status, 0, second.stderr || second.stdout)
  assert.match(second.stdout, /RUNTIME DIVERGENCE: carried findings originated under/)
  assert.equal(existsSync(state), false)
  assert.equal(existsSync(join(f.root, '.caw-tasks', '001_baseline-task.md')), false)
  assert.equal(readFileSync(join(f.root, 'src', 'output.txt'), 'utf8'), 'final\n')
  assert.match(execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: f.root, encoding: 'utf8' }),
    /Review: accepted with LIMITED certification, round 3/)
  assert.match(second.stdout, /at least \$1\.00, plus 1 unpriced Other call on this task/)

  const seen = calls(f)
  // Reviewer children are OS-confined and cannot append to the harness log beside the delivery.
  assert.equal(seen.length, 3)
  assertCommonInvocation(seen[0], {
    tools: 'Read,Edit,Write,Bash,Grep,Glob', model: 'sonnet', spec: '001_baseline-task.md',
  })
  assert.match(seen[1].input, /r1\.1/)
  assert.match(seen[2].input, /r1\.1/)
})

test('one resumed carried set preserves and renders several runtime origins',
  { skip: claudeOuterProfileSkip() }, () => {
  const f = fixture({ git: true })
  mkdirSync(join(f.root, '.caw-tasks'))
  const spec = '001_origins.md'
  writeFileSync(join(f.root, '.caw-tasks', spec), 'title: Origins\n')
  writeFileSync(join(f.root, 'delivery.txt'), 'ready\n')
  const origins = [
    { id: 'r1.1', provider: 'alpha', model: 'm1', digest: 'a'.repeat(64) },
    { id: 'r2.1', provider: 'beta', model: 'm2', digest: 'b'.repeat(64) },
  ]
  const history = origins.map((origin, index) => ({
    id: origin.id,
    slot: index ? 'uncovered' : 'broken',
    round: index + 1,
    where: 'delivery.txt:1',
    fix: `close ${origin.id}`,
    evidence: `read ${origin.id}`,
    state: 'open',
    origin_runtime: {
      runtime_digest: origin.digest,
      provider: origin.provider,
      requested: { model: origin.model, reasoning: 'high' },
    },
  }))
  writeFileSync(join(f.root, '.caw-tasks', `.round-${spec}.json`), `${JSON.stringify({
    state_version: 3,
    round: 2,
    history,
    noted: [],
    accounting: { priced: { USD: 0.4 }, unpriced: {} },
    runtime_digest: 'c'.repeat(64),
    runtime_history: [],
    ex: { summary: 'hand delivery', notes: [] },
  }, null, 2)}\n`)
  const expectedOrigins = origins.map((origin) =>
    `origin: ${origin.provider}/${origin.model} runtime=${origin.digest.slice(0, 12)}`)
  const result = run(f, ['review', spec], [{
    recordReviewProbe: true,
    observeInputStrings: expectedOrigins,
    envelope: envelope(verdict({ carried: origins.map((origin) => ({
      id: origin.id, state: 'closed', evidence: `closed ${origin.id}`,
    })) })),
  }])
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /RUNTIME DIVERGENCE/)
  const message = execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: f.root, encoding: 'utf8' })
  const observation = JSON.parse(message.match(/fake-review-probe:(\{.*\})/)[1])
  assert.deepEqual(observation.inputMatches,
    Object.fromEntries(expectedOrigins.map((origin) => [origin, true])))
})

test('fake provider can expose malformed output and structured failures without a network', () => {
  const malformed = fixture()
  const badJson = run(malformed, ['plan', 'x'], [{ stdoutText: 'not-json' }])
  assert.equal(badJson.status, 1)
  assert.match(badJson.stderr, /enumerator returned no JSON/)

  const failed = fixture()
  const refusal = run(failed, ['plan', 'x'], [{
    status: 1,
    envelope: { result: 'authentication refused', terminal_reason: 'authentication', subtype: 'auth' },
    stderr: 'provider stderr\n',
  }])
  assert.equal(refusal.status, 1)
  assert.match(refusal.stderr, /authentication refused/)
  assert.match(refusal.stderr, /terminal_reason: authentication/)
  assert.match(refusal.stderr, /provider stderr/)
  const runName = readdirSync(join(failed.root, '.caw-logs')).find((name) => name.startsWith('run-'))
  const runPath = join(failed.root, '.caw-logs', runName)
  const manifest = JSON.parse(readFileSync(join(runPath, 'manifest.json'), 'utf8'))
  assert.equal(manifest.calls.length, 1)
  assert.equal(manifest.calls[0].status, 'failure')
  assert.equal(manifest.calls[0].failure_kind, 'nonzero-exit')
  assert.equal(manifest.calls[0].usage_state, 'unknown')
  assert.equal(existsSync(join(runPath, manifest.calls[0].attempt_file)), true)
  const failure = JSON.parse(readFileSync(join(runPath, manifest.calls[0].file), 'utf8'))
  assert.equal(failure.attempt_id, manifest.calls[0].attempt_id)
  assert.equal(failure.exit_status, 1)
})

test('engine structural validation rejects missing, mistyped, and unknown canonical fields', () => {
  const mistyped = fixture()
  const wrongArray = run(mistyped, ['plan', 'x'], [
    { envelope: envelope({ cases: 'not-an-array', request_issues: [] }) },
  ])
  assert.equal(wrongArray.status, 1)
  assert.match(wrongArray.stderr, /invalid canonical output at \$\.cases: expected array/)
  const mistypedRun = readdirSync(join(mistyped.root, '.caw-logs'))
    .find((name) => name.startsWith('run-'))
  const mistypedManifest = JSON.parse(readFileSync(
    join(mistyped.root, '.caw-logs', mistypedRun, 'manifest.json'), 'utf8'))
  assert.equal(mistypedManifest.calls[0].status, 'failure')
  assert.equal(mistypedManifest.calls[0].failure_kind, 'schema-validation')
  assert.equal(mistypedManifest.calls[0].usage_state, 'reported')
  const mistypedFailure = JSON.parse(readFileSync(join(
    mistyped.root, '.caw-logs', mistypedRun, mistypedManifest.calls[0].file), 'utf8'))
  assert.equal(mistypedFailure.attempt_id, mistypedManifest.calls[0].attempt_id)
  assert.equal(mistypedFailure.cost.amount, 0.2)

  const missing = fixture()
  const missingSource = run(missing, ['plan', 'x'], [
    { envelope: envelope({ cases: [{ case: 'one' }], request_issues: [] }) },
  ])
  assert.equal(missingSource.status, 1)
  assert.match(missingSource.stderr, /\$\.cases\[0\]\.source: required field is missing/)

  const unknown = fixture()
  const extra = run(unknown, ['plan', 'x'], [
    { envelope: envelope({ cases: [], request_issues: [], provider_only: true }) },
  ])
  assert.equal(extra.status, 1)
  assert.match(extra.stderr, /\$\.provider_only: unknown field/)

  const invalidUnion = fixture()
  const missingOccurrence = run(invalidUnion, ['plan', 'x'], [
    { envelope: envelope(population([{
      case: 'future case', source: { kind: 'request', excerpt: 'x' },
    }])) },
  ])
  assert.equal(missingOccurrence.status, 1)
  assert.match(missingOccurrence.stderr, /source: did not match any admitted shape/)
  assert.match(missingOccurrence.stderr, /occurrence: required field is missing/)
})

test('engine semantic validation rejects blocker placeholders and invalid plan relations', () => {
  const placeholder = fixture()
  const blockedPlaceholder = run(placeholder, ['plan', 'x'], [
    { envelope: envelope(population()) },
    { envelope: envelope({ ...plan(), blocked: 'none' }) },
  ])
  assert.equal(blockedPlaceholder.status, 1)
  assert.match(blockedPlaceholder.stderr, /\$\.blocked: use the empty string/)
  assert.equal(existsSync(join(placeholder.root, '.caw-tasks')), false)

  const relation = fixture()
  const unknownTask = run(relation, ['plan', 'x'], [
    { envelope: envelope(population()) },
    { envelope: envelope({ ...plan(), coverage: [{ case: 'fixture output', task: 'missing' }] }) },
  ])
  assert.equal(unknownTask.status, 1)
  assert.match(unknownTask.stderr, /names unknown task/)
  assert.equal(existsSync(join(relation.root, '.caw-tasks')), false)
})

function reviewedOnceWithOpenItem() {
  const f = fixture({ git: true })
  mkdirSync(join(f.root, '.caw-tasks'))
  writeFileSync(join(f.root, '.caw-tasks', '001_baseline-task.md'), 'title: Baseline task\n')
  writeFileSync(join(f.root, 'delivery.txt'), 'delivery\n')
  const first = run(f, ['review', '001_baseline-task.md'], [{
    envelope: envelope(verdict({ broken: [{
      where: 'delivery.txt:1', fix: 'change it', evidence: 'read the delivery',
    }] })),
  }])
  assert.equal(first.status, 1)
  return f
}

test('reviewer must adjudicate every open carried id exactly once',
  { skip: claudeOuterProfileSkip() }, () => {
  const missing = reviewedOnceWithOpenItem()
  const omitted = run(missing, ['review', '001_baseline-task.md'], [
    { envelope: envelope(verdict()) },
  ])
  assert.equal(omitted.status, 1)
  assert.match(omitted.stderr, /missing open id\(s\): r1\.1/)

  const duplicate = reviewedOnceWithOpenItem()
  const repeated = run(duplicate, ['review', '001_baseline-task.md'], [
    { envelope: envelope(verdict({ carried: [
      { id: 'r1.1', state: 'closed', evidence: 'first decision' },
      { id: 'r1.1', state: 'open', evidence: 'second decision' },
    ] })) },
  ])
  assert.equal(repeated.status, 1)
  assert.match(repeated.stderr, /duplicate id "r1\.1"/)

  const unknown = reviewedOnceWithOpenItem()
  const invented = run(unknown, ['review', '001_baseline-task.md'], [
    { envelope: envelope(verdict({ carried: [
      { id: 'r9.9', state: 'closed', evidence: 'invented id' },
    ] })) },
  ])
  assert.equal(invented.status, 1)
  assert.match(invented.stderr, /unknown or settled id "r9\.9"/)
})

test('legacy numeric round spend migrates to known USD without losing recovery',
  { skip: claudeOuterProfileSkip() }, () => {
  const f = fixture({ git: true })
  mkdirSync(join(f.root, '.caw-tasks'))
  const spec = '001_baseline-task.md'
  writeFileSync(join(f.root, '.caw-tasks', spec), 'title: Baseline task\n')
  writeFileSync(join(f.root, 'delivery.txt'), 'delivery\n')
  writeFileSync(join(f.root, '.caw-tasks', `.round-${spec}.json`), `${JSON.stringify({
    spec_digest: 'legacy', round: 0, history: [], how: 'hand', noted: [], spent: 1.25, ex: null,
  })}\n`)

  const result = run(f, ['review', spec], [{ envelope: envelope(verdict()) }])
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /\$1\.45 on this task/)
  assert.equal(existsSync(join(f.root, '.caw-tasks', `.round-${spec}.json`)), false)
})

test('review confirms a red gate once without waking an executor', () => {
  const gateFast = `node -e "require('fs').appendFileSync(process.env.CAW_GATE_LOG,'red\\n');process.exit(1)"`
  const f = fixture({ git: true, gateFast })
  const gateLog = join(f.parent, 'gate-calls.log')
  mkdirSync(join(f.root, '.caw-tasks'))
  const spec = '001_baseline-task.md'
  writeFileSync(join(f.root, '.caw-tasks', spec), 'title: Baseline task\n')
  writeFileSync(join(f.root, 'delivery.txt'), 'hand delivery\n')

  const result = run(f, ['review', spec], [], { CAW_GATE_LOG: gateLog })

  assert.equal(result.status, 1)
  assert.match(`${result.stdout}\n${result.stderr}`,
    /review baseline stayed red after one provider-free confirmation/)
  assert.equal(calls(f).length, 0)
  assert.equal(readFileSync(gateLog, 'utf8').trim().split('\n').length, 2)
  assert.equal(readFileSync(join(f.root, 'delivery.txt'), 'utf8'), 'hand delivery\n')
})

test('project review criteria are additive and commit policy only changes the subject',
  { skip: claudeOuterProfileSkip() }, () => {
  const f = fixture({ git: true })
  configureProjectPolicies(f, projectPolicySource)
  mkdirSync(join(f.root, '.caw-tasks'))
  const spec = '001_policy-review.md'
  writeFileSync(join(f.root, '.caw-tasks', spec), `---
title: Core title
---

## Done when
- Delivery exists.
`)
  writeFileSync(join(f.root, 'delivery.txt'), 'safe delivery\n')

  const result = run(f, ['review', spec], [{
    recordReviewProbe: true,
    observeInputStrings: [
      'project:review-policy:privacy', 'trace the project privacy boundary',
    ],
    envelope: envelope(verdict({ criteria: [
      { id: 'done-when-1', state: 'met', evidence: 'traced Delivery exists.' },
      {
        id: 'project:review-policy:privacy', state: 'met',
        evidence: 'traced No private value is logged.',
      },
    ] })),
  }])

  assert.equal(result.status, 0, result.stderr || result.stdout)
  const message = execFileSync('git', ['log', '-1', '--pretty=%B'], {
    cwd: f.root, encoding: 'utf8',
  })
  assert.match(message, /^project: delivered safely\n/)
  assert.match(message, /Review: accepted with LIMITED certification, round 1/)
  assert.match(message, /--- spec \(001_policy-review\.md\), verbatim/)
  assert.match(message, /"project:review-policy:privacy":true/)
  assert.match(message, /"trace the project privacy boundary":true/)
  const runName = readdirSync(join(f.root, '.caw-logs')).find((name) => name.startsWith('run-'))
  const manifest = JSON.parse(readFileSync(join(f.root, '.caw-logs', runName, 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest.policy_calls.map(({ stage }) => stage), ['gate', 'review', 'commit'])
  assert.equal(manifest.certifications[0].state, 'limited')
  assert.deepEqual(manifest.certifications[0].limitations,
    ['population-unknown', 'author-runtime-unobserved'])
})

test('a planned task retains an approved certification with population and criterion ledger',
  { skip: claudeOuterProfileSkip() }, () => {
  const f = fixture({ git: true, taskIndependence: 'different-model' })
  let result = run(f, ['plan', 'Create the fixture output'], [
    { envelope: envelope(population([{
      case: 'fixture output', source: requestSource('Create the fixture output'),
    }])) },
    { envelope: envelope(plan()) },
    { envelope: envelope(planReview()) },
  ])
  assert.equal(result.status, 0, result.stderr || result.stdout)

  result = run(f, ['build', '--no-full'], [
    { writeFiles: { 'src/output.txt': 'done\n' }, envelope: envelope(delivery('did it')) },
    { envelope: envelope(verdict({ criteria: [
      { id: 'must-cover-1', state: 'met', evidence: 'traced fixture output' },
      { id: 'done-when-1', state: 'met', evidence: 'ran the fixture gate' },
    ] })) },
  ])
  assert.equal(result.status, 0, result.stderr || result.stdout)

  const runNames = readdirSync(join(f.root, '.caw-logs'))
    .filter((name) => name.startsWith('run-')).sort()
  const runPath = join(f.root, '.caw-logs', runNames.at(-1))
  const manifest = JSON.parse(readFileSync(join(runPath, 'manifest.json'), 'utf8'))
  assert.equal(manifest.certifications.length, 1)
  assert.equal(manifest.certifications[0].state, 'approved')
  const certification = JSON.parse(readFileSync(
    join(runPath, manifest.certifications[0].file), 'utf8'))
  assert.equal(certification.population.state, 'sample')
  assert.equal(certification.population.retained, 1)
  assert.equal(certification.author.role, 'executor')
  assert.equal(certification.reviewer.provider, 'test-claude')
  assert.equal(certification.independence.mode, 'different-model')
  assert.deepEqual(certification.criteria.map(({ id }) => id),
    ['must-cover-1', 'done-when-1'])
  assert.match(certification.review_surface.baseline_commit, /^[0-9a-f]{40}$/)
  assert.match(execFileSync('git', ['log', '-1', '--pretty=%B'], {
    cwd: f.root, encoding: 'utf8',
  }), /Review: approved, round 1/)
})

test('project gate policy can stop a green core gate before reviewer', () => {
  const f = fixture({ git: true })
  configureProjectPolicies(f, projectPolicySource)
  mkdirSync(join(f.root, '.caw-tasks'))
  const spec = '001_policy-stop.md'
  writeFileSync(join(f.root, '.caw-tasks', spec), 'title: Policy stop\n')
  writeFileSync(join(f.root, 'delivery.txt'), 'hand delivery\n')

  const result = run(f, ['review', spec], [])

  assert.equal(result.status, 1)
  assert.equal(calls(f).length, 0)
  assert.match(result.stdout,
    /project gate policy gate-policy stopped the run: project gate policy rejected this task/)
  assert.equal(existsSync(join(f.root, '.caw-tasks', `.round-${spec}.json`)), true)
})

test('resume reports a project policy source change even when the manifest is unchanged',
  { skip: claudeOuterProfileSkip() }, () => {
  const f = fixture({ git: true })
  configureProjectPolicies(f, projectPolicySource)
  mkdirSync(join(f.root, '.caw-tasks'))
  const spec = '001_policy-divergence.md'
  writeFileSync(join(f.root, '.caw-tasks', spec), 'title: Policy divergence\n')
  writeFileSync(join(f.root, 'delivery.txt'), 'safe delivery\n')

  const set = readProjectPolicies(f.root)
  const snapshot = {
    api_version: set.apiVersion,
    manifest_digest: set.manifestDigest,
    policies: Object.fromEntries(Object.entries(set.policies)
      .map(([stage, policy]) => [stage, { id: policy.id, digest: policy.digest }])),
  }
  snapshot.set_digest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
  writeFileSync(join(f.root, '.caw-tasks', `.round-${spec}.json`), `${JSON.stringify({
    state_version: 4,
    round: 1,
    history: [{
      id: 'r1.1', slot: 'broken', round: 1, where: 'delivery.txt:1',
      fix: 'keep the safe delivery', evidence: 'read the delivery', state: 'open',
    }],
    noted: [],
    accounting: { priced: {}, unpriced: {} },
    runtime_history: [],
    project_policies: snapshot,
    ex: { summary: 'safe delivery', notes: [] },
  }, null, 2)}\n`)

  const policyPath = join(f.root, '.caw', 'project', 'policy.mjs')
  writeFileSync(policyPath, `${readFileSync(policyPath, 'utf8')}\n// policy revision\n`)
  execFileSync('git', ['add', '.caw/project/policy.mjs'], { cwd: f.root })
  execFileSync('git', ['commit', '-q', '-m', 'revise project policy'], { cwd: f.root })

  const result = run(f, ['review', spec], [{
    envelope: envelope(verdict({
      criteria: [{
        id: 'project:review-policy:privacy', state: 'met',
        evidence: 'traced No private value is logged.',
      }],
      carried: [{ id: 'r1.1', state: 'closed', evidence: 'safe delivery remains' }],
    })),
  }])

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /PROJECT POLICY DIVERGENCE: saved [0-9a-f]{12}/)
})

test('weak canonical values without a mutation object fail before history ingestion',
  { skip: claudeOuterProfileSkip() }, () => {
  const f = fixture({ git: true })
  mkdirSync(join(f.root, '.caw-tasks'))
  writeFileSync(join(f.root, '.caw-tasks', '001_baseline-task.md'), 'title: Baseline task\n')
  writeFileSync(join(f.root, 'delivery.txt'), 'delivery\n')
  const result = run(f, ['review', '001_baseline-task.md'], [{
    envelope: envelope(verdict({ weak: [{
      where: 'delivery.txt:1', fix: 'add a mutation', evidence: 'prose only',
    }] })),
  }])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /\$\.weak\[0\]\.mutation: required field is missing/)
  assert.equal(existsSync(join(f.root, '.caw-tasks', '.round-001_baseline-task.md.json')), false)
})

test('oversized successful final values are rejected instead of truncated and consumed', () => {
  const f = fixture()
  const result = run(f, ['plan', 'x'], [{
    envelope: envelope({
      cases: [{ case: 'x'.repeat(4 * 1024 * 1024), source: 'request' }],
      request_issues: [],
    }),
  }])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /final canonical value is .* limit is 4194304/)
  assert.equal(existsSync(join(f.root, '.caw-tasks')), false)
})

test('blocked patches are private and removed when the task later completes',
  { skip: claudeOuterProfileSkip() }, (t) => {
  const f = fixture({ git: true })
  mkdirSync(join(f.root, '.caw-tasks'))
  const spec = '001_baseline-task.md'
  writeFileSync(join(f.root, '.caw-tasks', spec), 'title: Baseline task\n')
  const blockedRun = run(f, ['build', '--no-full'], [{
    writeFiles: { 'delivery.txt': 'unjudged delivery\n' },
    envelope: envelope(delivery('blocked pass'), { }),
  }].map((entry) => ({
    ...entry,
    envelope: { ...entry.envelope, structured_output: {
      ...entry.envelope.structured_output, blocked: 'the spec is contradictory',
    } },
  })))
  assert.equal(blockedRun.status, 1)
  const patch = readdirSync(join(f.root, '.caw-logs')).find((name) => name.endsWith('.patch'))
  assert.ok(patch)
  assertPrivateMode(t, assert, join(f.root, '.caw-logs', patch), 0o600, lstatSync)
  assertPrivateMode(t, assert, join(f.root, '.caw-logs'), 0o700, lstatSync)

  const completed = run(f, ['review', spec], [{ envelope: envelope(verdict()) }])
  assert.equal(completed.status, 0, completed.stderr || completed.stdout)
  assert.equal(readdirSync(join(f.root, '.caw-logs')).some((name) => name.startsWith('blocked-')), false)
})

test('success suppresses provider warnings but preserves missing price and observations', () => {
  const f = fixture()
  const result = run(f, ['plan', 'x'], [
    { envelope: { structured_output: population() }, stderr: 'successful provider warning\n' },
    { envelope: envelope(plan()) },
    { envelope: envelope(planReview()) },
  ])

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.doesNotMatch(result.stderr, /successful provider warning/)
  assert.match(result.stdout, /spent at least \$0\.40, plus 1 unpriced Test-claude call/)
  assert.match(result.stderr, /unpriced.*in \?  cw \?  cr \?  out \?  think \?  \?s/)
  assert.equal(calls(f).length, 3)
})

test('reviewer mutations stay in the isolated surface and cannot reach the delivery commit',
  { skip: boundedSurfaceSkip() }, () => {
  const f = fixture({ git: true, reviewDependencies: 'node_modules' })
  mkdirSync(join(f.root, '.caw-tasks'))
  writeFileSync(join(f.root, '.caw-tasks', '001_baseline-task.md'), `---
title: Baseline task
---

## Change

- Write the intended fixture output.

## Done when

- The intended fixture output exists.
`)
  mkdirSync(join(f.root, 'src'))
  writeFileSync(join(f.root, 'src', 'output.txt'), 'intended hand delivery\n')

  const result = run(f, ['review', '001_baseline-task.md'], [{
    writeFiles: {
      // Relative mutation succeeds in the disposable review surface.
      'src/reviewer-leak.txt': 'mutation made after the green gate\n',
      // A malicious absolute address back into the delivery is denied by Seatbelt.
      [join(f.root, 'src', 'escaped.txt')]: 'must not escape\n',
      'node_modules/fixture/index.js': 'must remain read-only\n',
    },
    ignoreWriteErrors: true,
    recordReviewProbe: true,
    envelope: envelope(verdict({ criteria: [{
      id: 'done-when-1', state: 'met', evidence: 'traced the intended output and its gate',
    }] })),
  }])

  assert.equal(result.status, 0, result.stderr || result.stdout)
  const committed = execFileSync('git', ['show', '--name-only', '--format='], {
    cwd: f.root, encoding: 'utf8',
  }).trim().split('\n')
  assert.deepEqual(committed, ['src/output.txt'])
  assert.equal(existsSync(join(f.root, 'src', 'reviewer-leak.txt')), false)
  assert.equal(existsSync(join(f.root, 'src', 'escaped.txt')), false)
  assert.equal(readFileSync(join(f.root, 'node_modules', 'fixture', 'index.js'), 'utf8'), 'dependency\n')
  const message = execFileSync('git', ['log', '-1', '--pretty=%B'], {
    cwd: f.root, encoding: 'utf8',
  })
  const observation = message.match(/fake-review-probe:(\{.*\})/)
  assert.ok(observation, message)
  const probe = JSON.parse(observation[1])
  const canonicalSurfaceParent = join(realpathSync(tmpdir()), 'caw-review-surfaces')
  const fromSurfaceParent = relative(canonicalSurfaceParent, probe.cwd)
  assert.equal(fromSurfaceParent.startsWith('..') || isAbsolute(fromSurfaceParent), false)
  assert.equal(probe.sectionOffsets.pipeline, 0)
  assert.equal(probe.sectionOffsets.capabilities < probe.sectionOffsets.language, true)
  assert.deepEqual(probe.writes['src/reviewer-leak.txt'], { ok: true, error: null })
  // Which errno the refusal carries is the outer profile's business — seatbelt says EPERM,
  // bubblewrap's read-only root says EROFS. What this case pins is that the write did not land.
  for (const path of [join(f.root, 'src', 'escaped.txt'), 'node_modules/fixture/index.js']) {
    assert.equal(probe.writes[path].ok, false)
    assert.ok(DENIED_BY_BOUNDARY.has(probe.writes[path].error), probe.writes[path].error)
  }
})

const readmeMutation = (replacement) => `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-# fixture
+# ${replacement}
`

test('weak findings are bound to fresh engine-owned replay events',
  { skip: boundedSurfaceSkip() }, () => {
  const gateFast = `node -e "require('fs').appendFileSync(process.env.CAW_GATE_LOG,process.cwd()+'\\n')"`
  const f = fixture({ git: true, reviewDependencies: 'node_modules', gateFast })
  const gateLog = join(f.parent, 'gate-calls.log')
  mkdirSync(join(f.root, '.caw-tasks'))
  writeFileSync(join(f.root, '.caw-tasks', '001_baseline-task.md'), `---
title: Baseline task
---

## Done when

- The delivery is reviewed.
`)
  mkdirSync(join(f.root, 'src'))
  writeFileSync(join(f.root, 'src', 'output.txt'), 'delivery\n')
  writeFileSync(join(f.root, '.env'), 'SECRET=delivery-only\n')

  const result = run(f, ['review', '001_baseline-task.md'], [{
    envelope: envelope(verdict({ criteria: [{
      id: 'done-when-1', state: 'met', evidence: 'traced the delivery review path',
    }], weak: [
      {
        where: 'README.md:1',
        fix: 'make the gate observe the fixture heading',
        evidence: 'mutated the heading in the isolated surface',
        mutation: { patch: readmeMutation('mutation-one'), breaks: 'the fixture heading' },
      },
      {
        where: 'README.md:1',
        fix: 'make the gate distinguish a second broken heading',
        evidence: 'ran a separate mutation from the same baseline',
        mutation: { patch: readmeMutation('mutation-two'), breaks: 'the alternate heading' },
      },
    ] })),
  }], { CAW_GATE_LOG: gateLog })

  assert.equal(result.status, 1)
  assert.match(`${result.stdout}\n${result.stderr}`, /2 item\(s\) open/)
  const state = JSON.parse(readFileSync(
    join(f.root, '.caw-tasks', '.round-001_baseline-task.md.json'), 'utf8'))
  assert.deepEqual(state.history.map((item) => item.id), ['r1.1', 'r1.2'])
  assert.equal(state.history.every((item) => item.mutation_event.gate_status === 0), true)
  assert.equal(state.history.every((item) =>
    item.mutation_event.state === 'confirmed-weak'), true)
  assert.equal(state.weak_verification.state, 'baseline-green')
  assert.equal(state.weak_verification.mutations.length, 2)
  assert.deepEqual(state.weak_verification.replay_surface, {
    strategy: 'single-reusable-surface', surfaces_created: 1, restores: 3,
  })
  assert.equal(new Set(state.history.map((item) => item.mutation_event.patch_sha256)).size, 2)
  const gateCalls = readFileSync(gateLog, 'utf8').trim().split('\n')
  assert.equal(gateCalls.length, 4) // delivery, one unmutated baseline, then two mutations
  assert.equal(new Set(gateCalls).size, 2) // delivery plus one reused replay surface
  assert.equal(readFileSync(join(f.root, 'README.md'), 'utf8'), '# fixture\n')
  assert.equal(readFileSync(join(f.root, 'node_modules', 'fixture', 'index.js'), 'utf8'), 'dependency\n')
})

test('a committed task retains its confirmed weak verification in the run record',
  { skip: claudeOuterProfileSkip() }, () => {
  const f = fixture({ git: true })
  mkdirSync(join(f.root, '.caw-tasks'))
  writeFileSync(join(f.root, '.caw-tasks', '001_baseline-task.md'), 'title: Baseline task\n')

  const result = run(f, ['build', '--no-full'], [
    { writeFiles: { 'delivery.txt': 'round one\n' }, envelope: envelope(delivery('first pass')) },
    { envelope: envelope(verdict({ weak: [{
      where: 'README.md:1', fix: 'make the gate observe the heading',
      evidence: 'mutated the heading in the isolated surface',
      mutation: { patch: readmeMutation('confirmed'), breaks: 'the fixture heading' },
    }] })) },
    { writeFiles: { 'delivery.txt': 'round two\n' }, envelope: envelope(delivery('fixed weakness')) },
    { envelope: envelope(verdict({ carried: [{
      id: 'r1.1', state: 'closed', evidence: 'the delivery now observes the heading',
    }] })) },
  ])

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(existsSync(join(f.root, '.caw-tasks', '001_baseline-task.md')), false)
  assert.equal(existsSync(join(f.root, '.caw-tasks', '.round-001_baseline-task.md.json')), false)
  const runName = readdirSync(join(f.root, '.caw-logs')).find((name) => name.startsWith('run-'))
  const manifest = JSON.parse(readFileSync(
    join(f.root, '.caw-logs', runName, 'manifest.json'), 'utf8'))
  assert.equal(manifest.status, 'completed')
  assert.deepEqual({
    returned: manifest.weak_verification.returned,
    retained: manifest.weak_verification.retained,
    truncated: manifest.weak_verification.truncated,
  }, { returned: 2, retained: 2, truncated: 0 })
  assert.equal(manifest.weak_verification.events[0].task, '001_baseline-task.md')
  assert.equal(manifest.weak_verification.events[0].state, 'baseline-green')
  assert.equal(manifest.weak_verification.events[1].task, '001_baseline-task.md')
  assert.equal(manifest.weak_verification.events[1].state, 'confirmed-weak')
})

test('weak verification retention reports every event lost beyond its ceiling', () => {
  const events = Array.from({ length: 35 }, (_, index) => ({ state: `event-${index + 1}` }))
  const retained = retainWeakVerificationEvents(null, events)

  assert.equal(retained.returned, 35)
  assert.equal(retained.retained, 32)
  assert.equal(retained.truncated, 3)
  assert.equal(retained.events.length, 32)
})

test('a nonescaping weak mutation that makes the gate red is refuted and noted',
  { skip: claudeOuterProfileSkip() }, () => {
  const gateFast = `node -e "const f=require('fs');const ok=f.readFileSync('README.md','utf8').includes('# fixture');if(!ok)process.stdout.write('MUTATION CAUGHT\\n');process.exit(ok?0:1)"`
  const f = fixture({ git: true, gateFast })
  mkdirSync(join(f.root, '.caw-tasks'))
  writeFileSync(join(f.root, '.caw-tasks', '001_baseline-task.md'), 'title: Baseline task\n')
  writeFileSync(join(f.root, 'delivery.txt'), 'delivery\n')
  const before = new Set(activeSurfaceNames())

  const result = run(f, ['review', '001_baseline-task.md'], [{
    envelope: envelope(verdict({ weak: [{
      where: 'README.md:1', fix: 'reject the claim', evidence: 'mutated the heading',
      mutation: { patch: readmeMutation('red'), breaks: 'the fixture heading' },
    }] })),
  }])

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /open now 0,  noted 1/)
  const message = execFileSync('git', ['log', '-1', '--pretty=%B'], {
    cwd: f.root, encoding: 'utf8',
  })
  assert.match(message, /weak refuted experiment, noted only/)
  assert.match(message, /weak mutation made the gate red/)
  assert.equal(existsSync(join(f.root, '.caw-tasks', '.round-001_baseline-task.md.json')), false)
  assert.equal(readFileSync(join(f.root, 'README.md'), 'utf8'), '# fixture\n')
  const retained = activeSurfaceNames().filter((name) => !before.has(name))
  assert.equal(retained.length, 1)
  const manifest = JSON.parse(readFileSync(
    join(REVIEW_SURFACE_PARENT, retained[0], 'manifest.json'), 'utf8'))
  assert.equal(manifest.state, 'weak-gate-red')
  assert.equal(manifest.weak_gate.state, 'mutation-caught')
  assert.equal(manifest.weak_gate.status, 1)
  assert.match(manifest.weak_gate.output, /MUTATION CAUGHT/)
})

test('captured weak mutations in forbidden paths reject the whole verdict before replay',
  { skip: claudeOuterProfileSkip() }, () => {
  const f = fixture({ git: true })
  mkdirSync(join(f.root, '.caw-tasks'))
  writeFileSync(join(f.root, '.caw-tasks', '001_baseline-task.md'), 'title: Baseline task\n')
  writeFileSync(join(f.root, 'delivery.txt'), 'delivery\n')
  const result = run(f, ['review', '001_baseline-task.md'], [{
    envelope: envelope(verdict({ weak: [{
      where: '.caw-tasks/escaped.txt', fix: 'must be rejected', evidence: 'malicious path',
      mutation: { capturePath: '.caw-tasks/escaped.txt', breaks: 'surface confinement' },
    }] })),
  }])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /invalid weak evidence: weak mutation leaves its permitted surface/)
  assert.equal(existsSync(join(f.root, '.caw-tasks', 'escaped.txt')), false)
})

test('a malformed captured weak is noted without discarding an independent valid weak',
  { skip: claudeOuterProfileSkip() }, () => {
  const f = fixture({ git: true })
  mkdirSync(join(f.root, '.caw-tasks'))
  writeFileSync(join(f.root, '.caw-tasks', '001_baseline-task.md'), 'title: Baseline task\n')
  writeFileSync(join(f.root, 'delivery.txt'), 'delivery\n')
  const malformed = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,7 +1,7 @@
-# fixture
+# malformed
`
  const result = run(f, ['review', '001_baseline-task.md'], [{
    envelope: envelope(verdict({ weak: [
      {
        where: 'README.md:1', fix: 'retain the reproducible weakness',
        evidence: 'the first mutation applies',
        mutation: { patch: readmeMutation('valid'), breaks: 'the fixture heading' },
      },
      {
        where: 'README.md:1', fix: 'retain why this mutation was not reproducible',
        evidence: 'the second mutation has a malformed hunk',
        mutation: { patch: malformed, breaks: 'large limit behavior' },
      },
    ] })),
  }])

  assert.equal(result.status, 1)
  assert.match(result.stdout, /open now 1,  noted 1/)
  const state = JSON.parse(readFileSync(
    join(f.root, '.caw-tasks', '.round-001_baseline-task.md.json'), 'utf8'))
  assert.equal(state.history.length, 1)
  assert.equal(state.history[0].fix, 'retain the reproducible weakness')
  assert.equal(state.history[0].mutation_event.gate_status, 0)
  assert.equal(state.noted.length, 1)
  assert.match(state.noted[0], /weak verification unavailable, noted only/)
  assert.match(state.noted[0], /retain why this mutation was not reproducible/)
  assert.match(state.noted[0], /the second mutation has a malformed hunk/)
  assert.equal(readFileSync(join(f.root, 'README.md'), 'utf8'), '# fixture\n')
})

const activeSurfaceNames = () => existsSync(REVIEW_SURFACE_PARENT)
  ? readdirSync(REVIEW_SURFACE_PARENT).filter((name) => name.startsWith('surface-'))
  : []

test('red weak baseline records non-blocking unavailable evidence with limited certification',
  { skip: claudeOuterProfileSkip() }, () => {
  const gateFast = `node -e "const f=require('fs');const ok=f.existsSync('.env');if(!ok)process.stdout.write('BASELINE MISSING SECRET\\n');process.exit(ok?0:1)"`
  const f = fixture({ git: true, gateFast })
  mkdirSync(join(f.root, '.caw-tasks'))
  writeFileSync(join(f.root, '.caw-tasks', '001_baseline-task.md'), 'title: Baseline task\n')
  writeFileSync(join(f.root, 'delivery.txt'), 'delivery\n')
  writeFileSync(join(f.root, '.env'), 'ignored surface input\n')
  const before = new Set(activeSurfaceNames())

  const result = run(f, ['review', '001_baseline-task.md'], [{
    envelope: envelope(verdict({ weak: [{
      where: 'README.md:1', fix: 'observe the heading', evidence: 'mutated the heading',
      mutation: { patch: readmeMutation('unverified'), breaks: 'the fixture heading' },
    }] })),
  }])

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /weak verification unavailable: unmutated surface gate status 1/)
  assert.match(result.stdout, /recording 1 finding\(s\) as non-blocking unavailable evidence/)
  assert.match(result.stdout, /open now 0,  noted 1/)
  assert.equal(existsSync(
    join(f.root, '.caw-tasks', '.round-001_baseline-task.md.json')), false)
  const message = execFileSync('git', ['log', '-1', '--pretty=%B'], {
    cwd: f.root, encoding: 'utf8',
  })
  assert.match(message, /Review: accepted with LIMITED certification/)
  assert.match(message, /weak verification unavailable, noted only/)

  const runName = readdirSync(join(f.root, '.caw-logs')).find((name) => name.startsWith('run-'))
  const runManifest = JSON.parse(readFileSync(
    join(f.root, '.caw-logs', runName, 'manifest.json'), 'utf8'))
  assert.equal(runManifest.weak_verification.events.length, 1)
  assert.equal(runManifest.weak_verification.events[0].task, '001_baseline-task.md')
  assert.equal(runManifest.weak_verification.events[0].state, 'unverified-baseline-red')
  assert.equal(runManifest.weak_verification.events[0].gate_status, 1)
  assert.match(runManifest.weak_verification.events[0].gate_output, /BASELINE MISSING SECRET/)
  const certification = JSON.parse(readFileSync(join(
    f.root, '.caw-logs', runName, runManifest.certifications[0].file), 'utf8'))
  assert.equal(certification.state, 'limited')
  assert.equal(certification.weak_verification.state, 'unverified-baseline-red')
  assert.equal(certification.limitations.includes('unverified-baseline-red'), true)

  const retained = activeSurfaceNames().filter((name) => !before.has(name))
  assert.equal(retained.length, 1)
  const manifest = JSON.parse(readFileSync(
    join(REVIEW_SURFACE_PARENT, retained[0], 'manifest.json'), 'utf8'))
  assert.equal(manifest.state, 'weak-baseline-red')
  assert.equal(manifest.weak_gate.phase, 'baseline')
  assert.match(manifest.weak_gate.output, /BASELINE MISSING SECRET/)
})

test('mutation gate refusal is non-blocking unavailable evidence',
  { skip: claudeOuterProfileSkip() }, () => {
  const gateFast = `node -e "const f=require('fs');const ok=f.readFileSync('README.md','utf8').includes('# fixture');if(!ok)process.stdout.write('MUTATION REFUSED\\n');process.exit(ok?0:75)"`
  const f = fixture({ git: true, gateFast })
  mkdirSync(join(f.root, '.caw-tasks'))
  writeFileSync(join(f.root, '.caw-tasks', '001_baseline-task.md'), 'title: Baseline task\n')
  writeFileSync(join(f.root, 'delivery.txt'), 'delivery\n')
  const before = new Set(activeSurfaceNames())

  const result = run(f, ['review', '001_baseline-task.md'], [{
    envelope: envelope(verdict({ weak: [{
      where: 'README.md:1', fix: 'observe the heading', evidence: 'mutated the heading',
      mutation: { patch: readmeMutation('refused'), breaks: 'the fixture heading' },
    }] })),
  }])

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /weak mutation made the gate red/)
  assert.match(result.stdout, /open now 0,  noted 1/)
  const message = execFileSync('git', ['log', '-1', '--pretty=%B'], {
    cwd: f.root, encoding: 'utf8',
  })
  assert.match(message, /Review: accepted with LIMITED certification/)
  assert.match(message, /weak verification unavailable, noted only/)
  const runName = readdirSync(join(f.root, '.caw-logs')).find((name) => name.startsWith('run-'))
  const runManifest = JSON.parse(readFileSync(
    join(f.root, '.caw-logs', runName, 'manifest.json'), 'utf8'))
  const certification = JSON.parse(readFileSync(join(
    f.root, '.caw-logs', runName, runManifest.certifications[0].file), 'utf8'))
  assert.equal(certification.state, 'limited')
  assert.equal(certification.weak_verification.state, 'unverified-mutation-refused')
  assert.equal(certification.weak_verification.mutations[0].state, 'unverified-refused')
  assert.equal(certification.weak_verification.mutations[0].gate_status, 75)
  assert.match(certification.weak_verification.mutations[0].gate_output, /MUTATION REFUSED/)

  const retained = activeSurfaceNames().filter((name) => !before.has(name))
  assert.equal(retained.length, 1)
  const manifest = JSON.parse(readFileSync(
    join(REVIEW_SURFACE_PARENT, retained[0], 'manifest.json'), 'utf8'))
  assert.equal(manifest.state, 'weak-gate-refused')
  assert.equal(manifest.weak_gate.status, 75)
  assert.match(manifest.weak_gate.output, /MUTATION REFUSED/)
})

test('weak baseline timeout is non-blocking and limits certification',
  { skip: claudeOuterProfileSkip() }, () => {
  const gateFast = `test -f .env || exec node -e "setTimeout(()=>{},2000)"`
  const f = fixture({ git: true, gateFast, gateFastTimeout: '50' })
  mkdirSync(join(f.root, '.caw-tasks'))
  writeFileSync(join(f.root, '.caw-tasks', '001_baseline-task.md'), 'title: Baseline task\n')
  writeFileSync(join(f.root, 'delivery.txt'), 'delivery\n')
  writeFileSync(join(f.root, '.env'), 'ignored surface input\n')

  const result = run(f, ['review', '001_baseline-task.md'], [{
    envelope: envelope(verdict({ weak: [{
      where: 'README.md:1', fix: 'observe the heading', evidence: 'mutated the heading',
      mutation: { patch: readmeMutation('timeout'), breaks: 'the fixture heading' },
    }] })),
  }])

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /weak verification DID NOT COMPLETE/)
  assert.match(result.stdout, /open now 0,  noted 1/)
  const runName = readdirSync(join(f.root, '.caw-logs')).find((name) => name.startsWith('run-'))
  const manifest = JSON.parse(readFileSync(
    join(f.root, '.caw-logs', runName, 'manifest.json'), 'utf8'))
  const certification = JSON.parse(readFileSync(join(
    f.root, '.caw-logs', runName, manifest.certifications[0].file), 'utf8'))
  assert.equal(certification.state, 'limited')
  assert.equal(certification.weak_verification.state, 'unverified-baseline-timeout')
  assert.equal(certification.weak_verification.baseline.gate_timeout_ms, 50)
})

test('weak mutation timeout is non-blocking and limits certification',
  { skip: claudeOuterProfileSkip() }, () => {
  const gateFast = `grep -q '^# fixture$' README.md || exec node -e "setTimeout(()=>{},2000)"`
  const f = fixture({ git: true, gateFast, gateFastTimeout: '50' })
  mkdirSync(join(f.root, '.caw-tasks'))
  writeFileSync(join(f.root, '.caw-tasks', '001_baseline-task.md'), 'title: Baseline task\n')
  writeFileSync(join(f.root, 'delivery.txt'), 'delivery\n')

  const result = run(f, ['review', '001_baseline-task.md'], [{
    envelope: envelope(verdict({ weak: [{
      where: 'README.md:1', fix: 'observe the heading', evidence: 'mutated the heading',
      mutation: { patch: readmeMutation('timeout'), breaks: 'the fixture heading' },
    }] })),
  }])

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /open now 0,  noted 1/)
  const runName = readdirSync(join(f.root, '.caw-logs')).find((name) => name.startsWith('run-'))
  const manifest = JSON.parse(readFileSync(
    join(f.root, '.caw-logs', runName, 'manifest.json'), 'utf8'))
  const certification = JSON.parse(readFileSync(join(
    f.root, '.caw-logs', runName, manifest.certifications[0].file), 'utf8'))
  assert.equal(certification.state, 'limited')
  assert.equal(certification.weak_verification.state, 'unverified-mutation-timeout')
  assert.equal(certification.weak_verification.mutations[0].state, 'unverified-timeout')
  assert.equal(certification.weak_verification.mutations[0].gate_timeout_ms, 50)
})

test('reviewer timeout retains a bounded interrupted surface',
  { skip: claudeOuterProfileSkip() }, () => {
  const f = fixture({ git: true })
  mkdirSync(join(f.root, '.caw-tasks'))
  writeFileSync(join(f.root, '.caw-tasks', '001_baseline-task.md'), 'title: Baseline task\n')
  writeFileSync(join(f.root, 'delivery.txt'), 'delivery\n')
  const before = new Set(activeSurfaceNames())
  const result = run(f, ['review', '001_baseline-task.md'], [
    { delayMs: 250, envelope: envelope(verdict()) },
  ], { CAW_AGENT_TIMEOUT_MS: '20' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /reviewer did not finish within/)
  const retained = activeSurfaceNames().filter((name) => !before.has(name))
  assert.equal(retained.length, 1)
  const manifest = JSON.parse(readFileSync(
    join(REVIEW_SURFACE_PARENT, retained[0], 'manifest.json'), 'utf8'))
  assert.equal(manifest.state, 'interrupted')
  assert.equal(manifest.apparent_bytes > 0, true)
})

test('SIGINT retains an interrupted isolated review surface', { skip: !CLAUDE_OUTER_PROFILE_HOST }, async () => {
  const f = fixture({ git: true })
  mkdirSync(join(f.root, '.caw-tasks'))
  writeFileSync(join(f.root, '.caw-tasks', '001_baseline-task.md'), 'title: Baseline task\n')
  writeFileSync(join(f.root, 'delivery.txt'), 'delivery\n')
  writeFileSync(f.queue, `${JSON.stringify([
    { delayMs: 5000, envelope: envelope(verdict()) },
  ], null, 2)}\n`)
  const before = new Set(activeSurfaceNames())
  const child = spawn(process.execPath, ['caw.mjs', 'review', '001_baseline-task.md'], {
    cwd: f.root,
    env: { ...process.env, CAW_CLAUDE: FAKE, CAW_FAKE_QUEUE: f.queue, CAW_FAKE_CALLS: f.calls },
    stdio: 'ignore',
    detached: true,
  })
  let appeared = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (activeSurfaceNames().some((name) => !before.has(name))) { appeared = true; break }
    await new Promise((done) => setTimeout(done, 20))
  }
  assert.equal(appeared, true)
  await new Promise((done) => setTimeout(done, 150))
  process.kill(-child.pid, 'SIGINT')
  const exit = await new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })))
  assert.equal([1, 130].includes(exit.code), true)
  const retained = activeSurfaceNames().filter((name) => !before.has(name))
  assert.equal(retained.length, 1)
  assert.equal(JSON.parse(readFileSync(
    join(REVIEW_SURFACE_PARENT, retained[0], 'manifest.json'), 'utf8')).state, 'interrupted')
  const runName = readdirSync(join(f.root, '.caw-logs')).find((name) => name.startsWith('run-'))
  const runManifest = JSON.parse(readFileSync(
    join(f.root, '.caw-logs', runName, 'manifest.json'), 'utf8'))
  assert.equal(runManifest.calls.length, 1)
  assert.equal(runManifest.calls[0].status, 'interrupted')
  assert.equal(runManifest.calls[0].usage_state, 'unknown')
  assert.equal(existsSync(join(f.root, '.caw-logs', runName,
    runManifest.calls[0].attempt_file)), true)
})

test('current timeout override refuses invalid input and kills an over-cap child', () => {
  const invalid = fixture()
  const invalidResult = run(invalid, ['plan', 'x'], [], { CAW_AGENT_TIMEOUT_MS: '1.5' })
  assert.equal(invalidResult.status, 1)
  assert.match(invalidResult.stderr, /must be a positive whole number/)
  assert.equal(calls(invalid).length, 0)

  const unsafe = fixture()
  const unsafeResult = run(unsafe, ['plan', 'x'], [], {
    CAW_AGENT_TIMEOUT_MS: String(Number.MAX_SAFE_INTEGER + 1),
  })
  assert.equal(unsafeResult.status, 1)
  assert.match(unsafeResult.stderr, /must be a positive whole number/)

  const slow = fixture()
  const timedOut = run(slow, ['plan', 'x'], [
    { delayMs: 250, envelope: envelope(population()) },
  ], { CAW_AGENT_TIMEOUT_MS: '20' })
  assert.equal(timedOut.status, 1)
  assert.match(timedOut.stderr, /enumerator did not finish within/)
  assert.match(timedOut.stdout, /agent timeout:/)
  const runName = readdirSync(join(slow.root, '.caw-logs')).find((name) => name.startsWith('run-'))
  const manifest = JSON.parse(readFileSync(
    join(slow.root, '.caw-logs', runName, 'manifest.json'), 'utf8'))
  assert.equal(manifest.calls.length, 1)
  assert.equal(manifest.calls[0].status, 'failure')
  assert.equal(manifest.calls[0].failure_kind, 'timeout')
  assert.equal(manifest.calls[0].usage_state, 'unknown')
})

test('current timeout override is one per-child value across every role in a command', () => {
  const f = fixture()
  const result = run(f, ['plan', 'x'], [
    { delayMs: 20, envelope: envelope(population()) },
    { delayMs: 20, envelope: envelope(plan()) },
    { delayMs: 20, envelope: envelope(planReview()) },
  ], { CAW_AGENT_TIMEOUT_MS: '200' })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout,
    /agent timeout: 200 ms from CAW_AGENT_TIMEOUT_MS \(default 30 min\)/)
  assert.equal(calls(f).length, 3)
})

// An executor that commits its own work leaves a clean tree, which reaches the same branch as an
// executor that did nothing at all. The two need opposite answers, and the message has to say
// which one happened: measured once on a Codex executor, the run reported "nothing changed" while
// the work sat in a commit the engine had not made.
test('an executor that commits its own work is named rather than filed as nothing changed', () => {
  const f = fixture({ git: true })
  mkdirSync(join(f.root, '.caw-tasks'))
  writeFileSync(join(f.root, '.caw-tasks', '001_task.md'), '---\ntitle: Task\n---\n\nDo it.\n')
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).trim()

  const result = run(f, ['build', '--no-full'], [
    { writeFiles: { 'src/output.txt': 'done\n' }, commitOwnWork: 'executor commit',
      envelope: envelope(delivery('committed it myself')) },
  ])

  assert.equal(result.status, 1)
  const out = result.stderr + result.stdout
  assert.match(out, /the executor committed its own work and left nothing to stage/)
  assert.match(out, new RegExp(`HEAD moved ${before.slice(0, 8)} -> [0-9a-f]{8}, tree clean`))
  assert.match(out, /git reset --soft [0-9a-f]{8}/)
  assert.match(out, /node caw\.mjs review 001_task\.md/)
  assert.doesNotMatch(out, /Read the spec yourself/)
  // The refusal must not undo anything: the operator decides what happens to that commit.
  assert.notEqual(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).trim(),
    before)
  assert.equal(existsSync(join(f.root, '.caw-tasks', '001_task.md')), true)
})

// `index_cmd` is the one profile field with five distinct operator-facing outcomes and no test at
// all until now. Each case asserts the line the operator reads, because that line is the whole
// interface: the run continues in four of the five, so a wrong message is the only way the
// failure reaches anyone. The plan dies at a later role in these cases — that is not what is
// under test, and the index line has already printed by then.
const indexPlan = (f, responses = []) => run(f, ['plan', 'do a thing'], responses)

test('index_cmd output goes to the enumerator and to no other role', () => {
  // The marker must reach a role ONLY as the command's OUTPUT. An earlier version of this case
  // put it in the command line, so it travelled to every role inside the profile text and the
  // case passed with the mechanism disabled. It is read out of a file for that reason.
  const marker = 'CLOSED-SET-MARKER-8fb2'
  const f = fixture({ git: true, indexCmd: 'cat index-fixture.txt' })
  writeFileSync(join(f.root, 'index-fixture.txt'), `${marker}\n`)

  const result = run(f, ['plan', 'do a thing'], [
    { envelope: envelope(population([])) },
    { envelope: envelope(plan()) },
    { envelope: envelope(planReview()) },
  ])
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /index_cmd: \d+ chars/)

  const seen = calls(f)
  const enumerator = seen.filter((c) => c.role === 'enumerator')
  assert.equal(enumerator.length, 1)
  assert.equal(enumerator[0].input.includes(marker), true, 'the enumerator was not given the index')

  // The other half is only a claim if other roles actually ran: an empty loop asserts nothing.
  const others = seen.filter((c) => c.role !== 'enumerator')
  assert.ok(others.length >= 2, `only ${others.length} non-enumerator call(s) to check`)
  for (const call of others) {
    assert.equal(call.input.includes(marker), false, `${call.role} was given the index`)
  }
})

test('index_cmd that exits non-zero enumerates without it and says so', () => {
  const f = fixture({ indexCmd: 'node -e "console.log(\\"partial\\"); process.exit(3)"' })
  const result = indexPlan(f)
  assert.match(result.stdout, /index_cmd exited 3 — enumerating without it/)
  assert.match(result.stdout, /partial/)
})

test('index_cmd that prints nothing enumerates without it and says so', () => {
  const f = fixture({ indexCmd: 'node -e "0"' })
  assert.match(indexPlan(f).stdout, /index_cmd printed nothing — enumerating without it/)
})

test('index_cmd that cannot run at all enumerates without it and says so', () => {
  const f = fixture({ indexCmd: '/nonexistent/index-command' })
  assert.match(indexPlan(f).stdout, /index_cmd (could not run|exited \d+) .*enumerating without it/)
})

// Over the cap the sets are cut, and an enumerator told a cut set is closed would report a
// population it could not have seen. The line has to say how much went.
test('index_cmd over the cap is truncated, and the run says how much was dropped', () => {
  const f = fixture({ indexCmd: 'node -e "process.stdout.write(\\"x\\".repeat(60050))"' })
  const result = indexPlan(f, [{ envelope: envelope(population([])) }])
  assert.match(result.stdout, /index_cmd printed 60050 chars, 50 of them DROPPED \(cap 60000\)/)
  assert.match(result.stdout, /The sets are cut and the enumerator is told so/)
})

test('json-v1 project index is validated, rendered, and sent only to the enumerator', () => {
  const marker = 'POST /orders/CLOSED-SET-9d2a'
  const f = fixture({
    git: true,
    indexCmd: 'cat index-fixture.json',
    indexFormat: 'json-v1',
  })
  writeFileSync(join(f.root, 'index-fixture.json'), `${JSON.stringify({
    api_version: 1,
    sets: [{
      id: 'public-routes',
      label: 'Public routes',
      source: 'scripts/project-index.mjs',
      members: ['GET /health', marker],
    }],
  })}\n`)

  const result = run(f, ['plan', 'do a thing'], [
    { envelope: envelope(population([])) },
    { envelope: envelope(plan()) },
    { envelope: envelope(planReview()) },
  ])

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /project index json-v1: 1 set\(s\)/)
  const seen = calls(f)
  assert.match(seen.find((call) => call.role === 'enumerator').input,
    /## \[public-routes\] Public routes/)
  assert.equal(seen.find((call) => call.role === 'enumerator').input.includes(marker), true)
  for (const call of seen.filter((entry) => entry.role !== 'enumerator')) {
    assert.equal(call.input.includes(marker), false)
  }
})

test('invalid json-v1 project indexes stop before provider calls', () => {
  const cases = [
    ['malformed', '{', /invalid JSON/],
    ['wrong-version', JSON.stringify({ api_version: 2, sets: [] }), /api_version must be 1/],
    ['unknown-field', JSON.stringify({ api_version: 1, sets: [], extra: true }), /unknown field/],
    ['duplicate-member', JSON.stringify({
      api_version: 1,
      sets: [{ id: 'routes', label: 'Routes', source: 'indexer', members: ['same', 'same'] }],
    }), /duplicates an earlier member/],
  ]
  for (const [name, body, message] of cases) {
    const f = fixture({ indexCmd: 'cat index-fixture.json', indexFormat: 'json-v1' })
    writeFileSync(join(f.root, 'index-fixture.json'), body)
    const result = indexPlan(f)
    assert.equal(result.status, 1, `${name}: ${result.stderr || result.stdout}`)
    assert.match(result.stderr, message, name)
    assert.match(result.stderr, /No provider call ran/, name)
    assert.equal(calls(f).length, 0, name)
  }
})

test('json-v1 project index command failures are fatal before provider calls', () => {
  const f = fixture({
    indexCmd: 'printf index-broke >&2; exit 3',
    indexFormat: 'json-v1',
  })
  const result = indexPlan(f)

  assert.equal(result.status, 1)
  assert.match(result.stderr, /project index json-v1 exited 3/)
  assert.match(result.stderr, /index-broke/)
  assert.equal(calls(f).length, 0)
})

test('unknown project index formats fail before provider calls', () => {
  const f = fixture({ indexCmd: 'node -e "0"', indexFormat: 'json-v2' })
  const result = indexPlan(f)

  assert.equal(result.status, 1)
  assert.match(result.stderr, /index_format must be text-v0 or json-v1/)
  assert.equal(calls(f).length, 0)
})

// `gate_full` had no coverage at all. The three outcomes below are the whole of its interface,
// and the second is the one with a measured cost behind it: an install whose gate used exit 1 for
// both a failure and a refusal sent a reader bisecting a range where no test had executed.
const buildOneTask = (f, extraResponses = [], args = ['build']) => {
  mkdirSync(join(f.root, '.caw-tasks'), { recursive: true })
  writeFileSync(join(f.root, '.caw-tasks', '001_task.md'), '---\ntitle: Task\n---\n\nDo it.\n')
  return run(f, args, [
    { writeFiles: { 'src/output.txt': 'done\n' }, envelope: envelope(delivery('did it')) },
    { envelope: envelope(verdict()) },
    ...extraResponses,
  ])
}

test('build wakes an executor only after the same delivery makes the gate red twice', () => {
  const gateFast = `node -e "const f=require('fs');f.appendFileSync(process.env.CAW_GATE_LOG,'gate\\n');const ok=f.readFileSync('src/output.txt','utf8').includes('fixed');process.exit(ok?0:1)"`
  const f = fixture({ git: true, gateFast })
  const gateLog = join(f.parent, 'gate-calls.log')
  mkdirSync(join(f.root, '.caw-tasks'), { recursive: true })
  writeFileSync(join(f.root, '.caw-tasks', '001_task.md'), '---\ntitle: Task\n---\n\nDo it.\n')

  const result = run(f, ['build'], [
    { writeFiles: { 'src/output.txt': 'broken\n' }, envelope: envelope(delivery('first try')) },
    { writeFiles: { 'src/output.txt': 'fixed\n' }, envelope: envelope(delivery('fixed it')) },
    { envelope: envelope(verdict()) },
  ], { CAW_GATE_LOG: gateLog })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  // The reviewer is intentionally unable to append to the harness log outside its isolated
  // surface. The two writable calls therefore prove exactly the executor boundary in question.
  assert.deepEqual(calls(f).map((call) => call.role), ['executor', 'executor'])
  assert.equal(readFileSync(gateLog, 'utf8').trim().split('\n').length, 3)
  assert.match(result.stdout, /gate red — confirming once without an executor/)
  assert.match(result.stdout, /gate reproducibly red \(executor retry 1\/2\)/)
  assert.match(result.stdout, /round 1 .*new 0,  open now 0/)
})

test('a configured gate_full runs once at the end of a build and reports green', () => {
  const f = fixture({ git: true, gateFull: 'node -e "process.exit(0)"' })
  const result = buildOneTask(f)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /· full gate: node -e "process\.exit\(0\)"/)
  assert.match(result.stdout, /\n {2}green/)
  assert.doesNotMatch(result.stdout, /no gate_full configured/)
})

test('--no-full skips a configured gate_full', () => {
  const f = fixture({ git: true, gateFull: 'node -e "process.exit(1)"' })
  const result = buildOneTask(f, [], ['build', '--no-full'])
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.doesNotMatch(result.stdout, /· full gate:/)
})

test('a red gate_full sends the reader to bisect rather than blaming the fast gate', () => {
  const f = fixture({ git: true, gateFull: 'node -e "process.exit(1)"' })
  const out = buildOneTask(f)
  const text = out.stdout + out.stderr
  assert.notEqual(out.status, 0)
  assert.match(text, /full gate is RED/)
  assert.match(text, /the fast gate\n?\s*is not what missed this/)
  assert.match(text, /git bisect start HEAD [0-9a-f]{7,}/)
})

// A refusal and a failure are different facts. Calling the refusal red is what sent one install
// bisecting a range in which nothing had executed.
test('a gate_full that refuses to start says nothing was tested, and offers no bisect', () => {
  const f = fixture({ git: true, gateFull: 'node -e "process.exit(75)"' })
  const out = buildOneTask(f)
  const text = out.stdout + out.stderr
  assert.notEqual(out.status, 0)
  assert.match(text, /full gate DID NOT RUN — it refused to start, and nothing was tested/)
  assert.match(text, /Every task is committed on its own green fast gate; none of that is in doubt/)
  assert.doesNotMatch(text, /git bisect/)
})

test('a fast gate timeout is neither red nor refused and preserves task recovery', () => {
  const f = fixture({
    git: true,
    gateFast: 'exec node -e "setTimeout(()=>{},2000)"',
    gateFastTimeout: '30',
  })
  mkdirSync(join(f.root, '.caw-tasks'), { recursive: true })
  const spec = '001_timeout.md'
  writeFileSync(join(f.root, '.caw-tasks', spec), 'title: Timeout\n')
  writeFileSync(join(f.root, 'delivery.txt'), 'hand delivery\n')

  const result = run(f, ['review', spec], [])
  const text = result.stdout + result.stderr

  assert.equal(result.status, 1)
  assert.match(text, /fast gate TIMED OUT after 30 ms and was killed/)
  assert.doesNotMatch(text, /gate red — confirming|refused to start/)
  assert.equal(calls(f).length, 0)
  assert.equal(existsSync(join(f.root, '.caw-tasks', `.round-${spec}.json`)), true)
})

test('a full gate timeout has no red verdict and offers no bisect', () => {
  const f = fixture({
    git: true,
    gateFull: 'exec node -e "setTimeout(()=>{},2000)"',
    gateFullTimeout: '30',
  })
  const result = buildOneTask(f)
  const text = result.stdout + result.stderr

  assert.equal(result.status, 1)
  assert.match(text, /full gate TIMED OUT after 30 ms and was killed/)
  assert.doesNotMatch(text, /full gate is RED|git bisect/)
})

test('invalid project gate timeouts fail before provider calls', () => {
  const f = fixture({ git: true, gateFastTimeout: '1.5' })
  const result = run(f, ['plan', 'x'], [])

  assert.equal(result.status, 1)
  assert.match(result.stderr, /gate_fast_timeout_ms must be a positive whole number/)
  assert.equal(calls(f).length, 0)
})
