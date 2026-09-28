import test from 'node:test'
import assert from 'node:assert/strict'

import { decideAutopilot } from '../caw.mjs'

const limits = { rounds: 3, gates: 1, resumes: 1, reauthMax: 2, reauth: null, notify: null }
const fresh = () => ({ tasks: {}, reauths: 0 })
const decide = (record, { counts = fresh(), treeDirty = true, ...override } = {}) =>
  decideAutopilot(record, counts, { ...limits, ...override }, { treeDirty })
const task = '001_x.md'

test('a stop with progress gets one more executor round, up to the per-task limit', () => {
  for (const kind of ['round-cap', 'gate-red-retries', 'review-baseline-red']) {
    const answer = decide({ kind, task })
    assert.equal(answer.action, 'run', kind)
    assert.deepEqual(answer.argv, ['round', task])
    assert.equal(answer.spend, 'rounds')
  }
  const spent = { tasks: { [task]: { rounds: 3, gates: 0, resumes: 0 } }, reauths: 0 }
  const answer = decide({ kind: 'round-cap', task }, { counts: spent })
  assert.equal(answer.action, 'stop')
  assert.match(answer.reason, /3 autopilot round\(s\) autopilot_rounds allows/)
  // Another task's rounds are its own.
  assert.equal(decide({ kind: 'round-cap', task: '002_y.md' }, { counts: spent }).action, 'run')
})

test('a gate that timed out or refused is re-run once on the same tree through review', () => {
  for (const kind of ['gate-timeout', 'gate-refused']) {
    assert.deepEqual(decide({ kind, task }).argv, ['review', task])
    const spent = { tasks: { [task]: { rounds: 0, gates: 1, resumes: 0 } }, reauths: 0 }
    assert.equal(decide({ kind, task }, { counts: spent }).action, 'stop')
  }
})

test('a role killed at its timeout resumes where that role left the task', () => {
  assert.deepEqual(decide({ kind: 'role-timeout', role: 'reviewer', task }).argv, ['review', task])
  assert.deepEqual(decide({ kind: 'role-timeout', role: 'executor', task }).argv, ['round', task])
  // An executor that died before writing anything leaves a clean tree, which only build restarts.
  assert.deepEqual(decide({ kind: 'role-timeout', role: 'executor', task }, { treeDirty: false }).argv,
    ['build'])
  assert.equal(decide({ kind: 'role-timeout', role: 'architect', task }).action, 'stop')
  const spent = { tasks: { [task]: { rounds: 0, gates: 0, resumes: 1 } }, reauths: 0 }
  assert.equal(decide({ kind: 'role-timeout', role: 'reviewer', task }, { counts: spent }).action, 'stop')
})

test('expired credentials are re-authenticated only by a configured command, a bounded number of times', () => {
  const record = { kind: 'credentials-expired', role: 'reviewer', task }
  assert.match(decide(record).reason, /no autopilot_reauth_cmd/)
  const answer = decide(record, { reauth: 'claude --print ok' })
  assert.equal(answer.action, 'run')
  assert.equal(answer.reauth, true)
  assert.deepEqual(answer.argv, ['review', task])
  assert.equal(decide(record, { reauth: 'x', counts: { tasks: {}, reauths: 2 } }).action, 'stop')
})

test('a stall, a judgement and an unrecognised stop all go to the human', () => {
  for (const kind of ['stalled', 'unchanged-twice', 'executor-blocked', 'budget-exhausted',
    'gate-evidence-refused', 'gate-changed-tree', 'gate-policy', 'advisory-review', 'decision']) {
    assert.equal(decide({ kind, task }).action, 'stop', kind)
  }
  assert.match(decide(null).reason, /names no task/)
  assert.match(decide({ kind: 'unknown', task }).reason, /without a stop record/)
})
