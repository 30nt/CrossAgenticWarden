import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readProjectPolicies } from '../caw.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function fixture(script, stages = ['planning', 'review', 'gate', 'commit'], apiVersion = 1) {
  const root = mkdtempSync(join(tmpdir(), 'caw-project-policy-'))
  mkdirSync(join(root, '.caw', 'project'), { recursive: true })
  cpSync(join(ROOT, 'caw.mjs'), join(root, 'caw.mjs'))
  writeFileSync(join(root, '.caw', 'project', 'policy.mjs'), script)
  writeFileSync(join(root, '.caw', 'project', 'manifest.json'), `${JSON.stringify({
    api_version: apiVersion,
    policies: Object.fromEntries(stages.map((stage) => [stage, {
      id: `${stage}-policy`, command: ['node', '.caw/project/policy.mjs'], timeout_ms: 1000,
    }])),
  }, null, 2)}\n`)
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'CAW Test'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'caw@example.invalid'], { cwd: root })
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: root })
  return root
}

function run(root, extraEnv = {}) {
  return spawnSync(process.execPath, ['caw.mjs', 'verify-project'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...extraEnv },
  })
}

const validPolicy = `
const request = JSON.parse(await new Promise((resolve) => {
  let text = ''; process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { text += chunk });
  process.stdin.on('end', () => resolve(text));
}))
if (process.env.CAW_SECRET) process.exit(9)
const outputs = {
  planning: { issues: [], instructions: [] },
  review: { criteria: [], instructions: [] },
  gate: { action: 'continue', reason: '' },
  commit: { subject: '' },
}
process.stdout.write(JSON.stringify(outputs[request.stage]))
`

const validV2Policy = `
const request = JSON.parse(await new Promise((resolve) => {
  let text = ''; process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { text += chunk });
  process.stdin.on('end', () => resolve(text));
}))
if (request.context.phase === 'request') {
  process.stdout.write(JSON.stringify({
    issues: [], instructions: [],
    risk: {
      class: 'regulated', population_requirement: 'complete',
      require_full_gate_baseline: true,
    },
  }))
} else {
  process.stdout.write(JSON.stringify({
    issues: [], instructions: [],
    attestation: {
      state: 'complete', population_digest: request.context.population.digest,
      evidence: 'the project policy verified its closed index',
    },
  }))
}
`

test('verify-project runs every configured policy through the strict protocol', (t) => {
  const root = fixture(validPolicy)
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const result = run(root, { CAW_SECRET: 'must-not-reach-policy' })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  for (const stage of ['planning', 'review', 'gate', 'commit']) {
    assert.match(result.stdout, new RegExp(`${stage}: ${stage}-policy [0-9a-f]{12} — valid`))
  }
})

test('v2 planning policy verifies request classification and population attestation', (t) => {
  const root = fixture(validV2Policy, ['planning'], 2)
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const result = run(root)

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout,
    /planning: planning-policy [0-9a-f]{12} — valid \(request, population\)/)
})

test('v2 planning policy rejects unsupported risk and attestation fields', (t) => {
  const badRisk = fixture(validV2Policy.replace("class: 'regulated'", "class: 'Not Valid'"),
    ['planning'], 2)
  t.after(() => rmSync(badRisk, { recursive: true, force: true }))
  const riskResult = run(badRisk)
  assert.equal(riskResult.status, 1)
  assert.match(riskResult.stderr, /invalid risk class/)

  const badAttestation = fixture(validV2Policy.replace(
    "evidence: 'the project policy verified its closed index'", "evidence: ''"), ['planning'], 2)
  t.after(() => rmSync(badAttestation, { recursive: true, force: true }))
  const attestationResult = run(badAttestation)
  assert.equal(attestationResult.status, 1)
  assert.match(attestationResult.stderr, /must evidence a complete population attestation/)
})

test('v2 gate retries are restricted to evidenced flaky red results', (t) => {
  const retryGreen = fixture(`process.stdout.write(JSON.stringify({
    action: 'retry', classification: 'flaky', reason: 'allowlisted fixture'
  }))`, ['gate'], 2)
  t.after(() => rmSync(retryGreen, { recursive: true, force: true }))
  const greenResult = run(retryGreen)
  assert.equal(greenResult.status, 1)
  assert.match(greenResult.stderr, /may retry only a red fast task gate/)

  const legacyRetry = fixture(`process.stdout.write(JSON.stringify({
    action: 'retry', reason: 'legacy cannot retry'
  }))`, ['gate'], 1)
  t.after(() => rmSync(legacyRetry, { recursive: true, force: true }))
  const legacyResult = run(legacyRetry)
  assert.equal(legacyResult.status, 1)
  assert.match(legacyResult.stderr, /expected one of.*continue.*stop/)
})

test('policy digests change when any file in the project policy tree changes', (t) => {
  const root = fixture(validPolicy, ['planning'])
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const before = readProjectPolicies(root).policies.planning.digest

  writeFileSync(join(root, '.caw', 'project', 'helper.txt'), 'new policy input\n')

  const after = readProjectPolicies(root).policies.planning.digest
  assert.notEqual(after, before)
})

test('invalid manifests and policy outputs fail closed', (t) => {
  const badManifest = fixture(validPolicy, ['planning'])
  t.after(() => rmSync(badManifest, { recursive: true, force: true }))
  const manifestPath = join(badManifest, '.caw', 'project', 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.unknown = true
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`)
  const invalidManifest = run(badManifest)
  assert.equal(invalidManifest.status, 1)
  assert.match(invalidManifest.stderr, /unknown field.*unknown/)

  const badOutput = fixture(`process.stdout.write(JSON.stringify({issues: []}))`, ['planning'])
  t.after(() => rmSync(badOutput, { recursive: true, force: true }))
  const invalidOutput = run(badOutput)
  assert.equal(invalidOutput.status, 1)
  assert.match(invalidOutput.stderr, /invalid output.*instructions.*required field is missing/)
})

test('a policy that times out or changes delivery is refused', (t) => {
  const timeout = fixture(`setInterval(() => {}, 1000)`, ['planning'])
  t.after(() => rmSync(timeout, { recursive: true, force: true }))
  const timeoutManifestPath = join(timeout, '.caw', 'project', 'manifest.json')
  const timeoutManifest = JSON.parse(readFileSync(timeoutManifestPath, 'utf8'))
  timeoutManifest.policies.planning.timeout_ms = 50
  writeFileSync(timeoutManifestPath, `${JSON.stringify(timeoutManifest)}\n`)
  const timedOut = run(timeout)
  assert.equal(timedOut.status, 1)
  assert.match(timedOut.stderr, /timed out/)

  const mutation = fixture(`
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
writeFileSync(fileURLToPath(new URL('../../mutated.txt', import.meta.url)), 'changed')
process.stdout.write(JSON.stringify({issues: [], instructions: []}))
`, ['planning'])
  t.after(() => rmSync(mutation, { recursive: true, force: true }))
  const changed = run(mutation)
  assert.equal(changed.status, 1)
  assert.match(changed.stderr, /changed protected project state/)
})
