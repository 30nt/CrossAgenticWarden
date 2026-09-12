import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { collectGateEvidence, retainGateEvidence } from '../caw.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'caw-gate-evidence-test-'))
  const artifacts = join(root, 'artifacts')
  const manifest = join(root, 'manifest.json')
  mkdirSync(artifacts)
  return { root, artifacts, manifest }
}

function writeManifest(path, checks) {
  writeFileSync(path, `${JSON.stringify({ version: 1, checks })}\n`)
}

const contract = {
  criteria: [{ id: 'done-when-1' }],
  acceptanceCases: [{
    id: 'ui-language-switch', evidence_kind: 'xcui-result', selector: 'settings.language',
  }],
}

test('gate evidence validates linked checks and hashes regular artifacts', (t) => {
  const f = fixture()
  t.after(() => rmSync(f.root, { recursive: true, force: true }))
  mkdirSync(join(f.artifacts, 'results'))
  writeFileSync(join(f.artifacts, 'results', 'screen.txt'), 'observable result\n')
  writeManifest(f.manifest, [{
    id: 'language-switch', criterion_ids: ['done-when-1'],
    acceptance_case_ids: ['ui-language-switch'], selector: 'settings.language',
    evidence_kind: 'xcui-result',
    state: 'passed', summary: 'mounted consumer changed language',
    artifacts: [{ id: 'screen', path: 'results/screen.txt' }],
  }])

  const evidence = collectGateEvidence(f.manifest, f.artifacts, contract)

  assert.equal(evidence.present, true)
  assert.equal(evidence.checks.length, 1)
  assert.equal(evidence.artifacts.length, 1)
  assert.equal(evidence.artifacts[0].bytes, 18)
  assert.match(evidence.artifacts[0].sha256, /^[0-9a-f]{64}$/)
})

test('gate evidence rejects traversal, symlinks, unknown links and unbound checks', (t) => {
  const f = fixture()
  t.after(() => rmSync(f.root, { recursive: true, force: true }))
  writeFileSync(join(f.root, 'outside.txt'), 'outside')
  symlinkSync(join(f.root, 'outside.txt'), join(f.artifacts, 'link.txt'))

  const base = {
    id: 'case', criterion_ids: ['done-when-1'], acceptance_case_ids: [], selector: '',
    evidence_kind: 'test-result',
    state: 'passed', summary: 'checked', artifacts: [],
  }
  writeManifest(f.manifest, [{ ...base, artifacts: [{ id: 'bad', path: '../outside.txt' }] }])
  assert.throws(() => collectGateEvidence(f.manifest, f.artifacts, contract), /path is unsafe/)

  writeManifest(f.manifest, [{ ...base, artifacts: [{ id: 'bad', path: 'link.txt' }] }])
  assert.throws(() => collectGateEvidence(f.manifest, f.artifacts, contract), /contains a symlink/)

  writeManifest(f.manifest, [{ ...base, criterion_ids: ['done-when-99'] }])
  assert.throws(() => collectGateEvidence(f.manifest, f.artifacts, contract), /unknown criterion/)

  writeManifest(f.manifest, [{ ...base, criterion_ids: [] }])
  assert.throws(() => collectGateEvidence(f.manifest, f.artifacts, contract), /not linked/)

  writeManifest(f.manifest, [{
    ...base, acceptance_case_ids: ['ui-language-switch'],
    evidence_kind: 'xcui-result', selector: 'another.selector',
  }])
  assert.throws(() => collectGateEvidence(f.manifest, f.artifacts, contract), /wrong selector/)
})

test('gate evidence enforces the per-artifact size limit', (t) => {
  const f = fixture()
  t.after(() => rmSync(f.root, { recursive: true, force: true }))
  writeFileSync(join(f.artifacts, 'large.bin'), Buffer.alloc(16 * 1024 * 1024 + 1))
  writeManifest(f.manifest, [{
    id: 'large', criterion_ids: ['done-when-1'], acceptance_case_ids: [], selector: '',
    evidence_kind: 'test-result',
    state: 'passed', summary: 'large artifact', artifacts: [{ id: 'large', path: 'large.bin' }],
  }])

  assert.throws(() => collectGateEvidence(f.manifest, f.artifacts, contract), /exceeds 16777216 bytes/)
})

test('gate evidence enforces manifest, check, artifact-count and aggregate limits', (t) => {
  const f = fixture()
  t.after(() => rmSync(f.root, { recursive: true, force: true }))

  writeFileSync(f.manifest, 'x'.repeat(1024 * 1024 + 1))
  assert.throws(() => collectGateEvidence(f.manifest, f.artifacts), /manifest exceeds/)

  const check = (id, artifacts = []) => ({
    id, criterion_ids: [], acceptance_case_ids: [], selector: '',
    evidence_kind: 'test-result', state: 'passed', summary: 'checked', artifacts,
  })
  writeManifest(f.manifest, Array.from({ length: 129 }, (_, index) => check(`check-${index}`)))
  assert.throws(() => collectGateEvidence(f.manifest, f.artifacts), /invalid|more than 128/)

  const tooMany = []
  for (let index = 0; index < 33; index++) {
    const path = `empty-${index}.bin`
    writeFileSync(join(f.artifacts, path), '')
    tooMany.push({ id: `artifact-${index}`, path })
  }
  writeManifest(f.manifest, [check('artifact-count', tooMany)])
  assert.throws(() => collectGateEvidence(f.manifest, f.artifacts), /more than 32 artifacts/)

  const aggregate = []
  for (let index = 0; index < 5; index++) {
    const path = `aggregate-${index}.bin`
    writeFileSync(join(f.artifacts, path), '')
    truncateSync(join(f.artifacts, path), 16 * 1024 * 1024)
    aggregate.push({ id: `aggregate-${index}`, path })
  }
  writeManifest(f.manifest, [check('artifact-total', aggregate)])
  assert.throws(() => collectGateEvidence(f.manifest, f.artifacts), /artifacts exceed 67108864 bytes/)
})

test('engine receipt is bound to its delivery digest and bounds retained output', () => {
  const input = {
    command: 'npm test', task: '001.md', kind: 'fast', state: 'green', commandState: 'green',
    status: 0, commandStatus: 0, durationMs: 12, timeoutMs: 1000,
    rawOutput: 'x'.repeat(1024 * 1024 + 200),
    evidence: { present: false, checks: [], artifacts: [] },
  }
  const first = retainGateEvidence({ ...input, deliveryDigest: 'a'.repeat(64) })
  const second = retainGateEvidence({ ...input, deliveryDigest: 'b'.repeat(64) })

  assert.equal(first.delivery_digest, 'a'.repeat(64))
  assert.notEqual(first.receipt_id, second.receipt_id)
  assert.equal(first.output.truncated, true)
  assert.equal(first.output.retained_bytes, 1024 * 1024)
  assert.equal(first.output.bytes, 1024 * 1024 + 200)
})
