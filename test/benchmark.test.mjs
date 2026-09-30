import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mergeReviewPasses, planRelationIssue, planningLedger } from '../caw.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readCase = (name) => JSON.parse(readFileSync(join(ROOT, 'benchmark', name), 'utf8'))

test('benchmark: planning acceptance is complete and incomplete review is rejected', () => {
  const subject = readCase('planning.json')
  assert.equal(subject.version, 1)
  const ledger = planningLedger(subject.plan)
  assert.equal(ledger.tasks.length, subject.expect.tasks)
  assert.equal(ledger.requirements.length, subject.expect.requirements)
  assert.equal(ledger.cases.length, subject.expect.cases)
  assert.equal(ledger.relations.length, subject.expect.relations)
  const incomplete = ledger.relations.slice(0, -1).map((relation) => ({
    id: relation.id, state: 'covered', evidence: 'benchmark evidence',
  }))
  assert.equal(Boolean(planRelationIssue(ledger, incomplete)),
    subject.expect.incomplete_review_is_rejected)
})

test('benchmark: execution review merge is conservative on one exact baseline', () => {
  const subject = readCase('execution.json')
  assert.equal(subject.version, 1)
  const verification = {
    state: 'baseline-green', baseline: { state: 'green' }, mutations: [], failures: [],
    replay_surface: { restores: 1 },
  }
  const merged = mergeReviewPasses(subject.passes.map((verdict) => ({
    verdict, weakEvents: [], weakVerification: verification,
  })), subject.baseline_digest)
  assert.equal(merged.verdict.criteria[0].state, subject.expect.criterion_state)
  assert.equal(merged.verdict.carried[0].state, subject.expect.carried_state)
  assert.equal(merged.verdict.broken.length, subject.expect.new_findings)
  assert.equal(merged.verdict.broken[0].discovery, subject.expect.new_finding_discovery)
  assert.equal(merged.verdict.broken[0].baseline_digest, subject.baseline_digest)
})
