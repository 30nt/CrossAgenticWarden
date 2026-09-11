import test from 'node:test'
import assert from 'node:assert/strict'

import { GateFailureAction, decideGateFailure } from '../caw.mjs'

test('the first red gate is confirmed without an executor in every mode', () => {
  for (const reviewOnly of [false, true]) {
    assert.equal(decideGateFailure({
      reviewOnly,
      confirmationRuns: 0,
      executorRetries: 0,
      maxExecutorRetries: 2,
    }), GateFailureAction.confirm)
  }
})

test('review stops after a confirmed red gate', () => {
  assert.equal(decideGateFailure({
    reviewOnly: true,
    confirmationRuns: 1,
    executorRetries: 0,
    maxExecutorRetries: 2,
  }), GateFailureAction.stopReview)
})

test('build wakes an executor only for a confirmed red gate inside its retry budget', () => {
  for (const executorRetries of [0, 1]) {
    assert.equal(decideGateFailure({
      reviewOnly: false,
      confirmationRuns: 1,
      executorRetries,
      maxExecutorRetries: 2,
    }), GateFailureAction.executor)
  }

  assert.equal(decideGateFailure({
    reviewOnly: false,
    confirmationRuns: 1,
    executorRetries: 2,
    maxExecutorRetries: 2,
  }), GateFailureAction.stopRetries)
})

test('gate failure counters and mode are validated', () => {
  const valid = {
    reviewOnly: false,
    confirmationRuns: 0,
    executorRetries: 0,
    maxExecutorRetries: 2,
  }

  for (const name of ['confirmationRuns', 'executorRetries', 'maxExecutorRetries']) {
    assert.throws(() => decideGateFailure({ ...valid, [name]: -1 }),
      new RegExp(`${name} must be a non-negative integer`))
    assert.throws(() => decideGateFailure({ ...valid, [name]: 0.5 }),
      new RegExp(`${name} must be a non-negative integer`))
  }
  assert.throws(() => decideGateFailure({ ...valid, reviewOnly: 'yes' }),
    /reviewOnly must be a boolean/)
})
