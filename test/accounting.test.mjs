import test from 'node:test'
import assert from 'node:assert/strict'

import {
  addAccounting,
  compactRunMetrics,
  deltaAccounting,
  formatAccounting,
  normalizeAccounting,
  resolveProviderBudgets,
  zeroAccounting,
} from '../caw.mjs'

const counters = (calls, inputTokens, outputTokens) => ({
  calls,
  inputTokens,
  outputTokens,
  cachedReadTokens: 0,
  cachedWrittenTokens: 0,
  reasoningTokens: null,
})

test('provider call budgets have finite defaults and strict per-scope overrides', () => {
  const defaults = resolveProviderBudgets({})
  assert.equal(defaults.request_calls, 256)
  assert.equal(defaults.planning_calls, 16)
  assert.equal(defaults.task_calls, 16)
  assert.equal(defaults.unknown_cost_calls, 256)
  assert.deepEqual(Object.keys(defaults.role_calls).sort(),
    ['architect', 'enumerator', 'executor', 'plan-reviewer', 'reviewer'].sort())

  const configured = resolveProviderBudgets({
    budget_request_calls: '7',
    budget_planning_calls: '5',
    budget_task_calls: '3',
    budget_unknown_cost_calls: '2',
    budget_plan_reviewer_calls: '1',
  })
  assert.deepEqual({
    request: configured.request_calls,
    planning: configured.planning_calls,
    task: configured.task_calls,
    unknown: configured.unknown_cost_calls,
    reviewer: configured.role_calls['plan-reviewer'],
  }, { request: 7, planning: 5, task: 3, unknown: 2, reviewer: 1 })
  for (const invalid of ['0', '-1', '1.5', 'many']) {
    assert.throws(() => resolveProviderBudgets({ budget_request_calls: invalid }),
      /must be a positive whole number/)
  }
})

test('run metrics retain bounded decisions without provider payloads', () => {
  const metrics = compactRunMetrics({
    run_id: 'run-1', started_at: 'start', updated_at: 'end', status: 'failed',
    calls: [
      {
        role: 'executor', task: '001.md', round: 2, status: 'success',
        usage_state: 'reported', duration_ms: 120,
        tokens: { input: 100, cachedRead: 70, output: 8, reasoning: 3 },
        prompt: { bytes: 40 }, telemetry: { eventCount: 5, toolEventCount: 2, eventBytes: 90 },
      },
      {
        role: 'reviewer', task: '001.md', round: 2, status: 'failure',
        usage_state: 'estimated', duration_ms: 80,
      },
    ],
    policy_calls: [{ stage: 'gate', duration_ms: 5, output: 'must not survive' }],
    certifications: [{ state: 'limited' }],
    final_response: 'must not survive',
  })
  assert.deepEqual(metrics.provider_usage.input_tokens, { observed: 100, unknown_calls: 1 })
  assert.deepEqual(metrics.provider_usage.cached_read_tokens, { observed: 70, unknown_calls: 1 })
  assert.deepEqual(metrics.provider_usage.uncached_input_tokens, { observed: 30, unknown_calls: 1 })
  assert.deepEqual(metrics.provider_usage.prompt_bytes, { observed: 40, unknown_calls: 1 })
  assert.deepEqual(metrics.provider_usage.provider_tool_event_count,
    { observed: 2, unknown_calls: 1 })
  assert.deepEqual(metrics.provider_usage_by_scope.map((row) =>
    [row.task, row.round, row.role, row.calls]), [
    ['001.md', 2, 'executor', 1],
    ['001.md', 2, 'reviewer', 1],
  ])
  delete metrics.provider_usage
  delete metrics.provider_usage_by_scope
  assert.deepEqual(metrics, {
    version: 2,
    run_id: 'run-1', started_at: 'start', updated_at: 'end', status: 'failed',
    provider_calls: 2,
    provider_calls_by_role: { executor: 1, reviewer: 1 },
    provider_calls_by_status: { failure: 1, success: 1 },
    usage_states: { estimated: 1, reported: 1 },
    provider_duration_ms: 200,
    policy_calls: 1,
    policy_duration_ms: 5,
    certifications: { limited: 1 },
  })
})

test('accounting adds only like currencies and formats mixed lower bounds', () => {
  const priced = addAccounting(
    { priced: { USD: 2.1, EUR: 1 }, unpriced: {} },
    { priced: { USD: 2.21 }, unpriced: {} },
  )
  assert.equal(priced.priced.EUR, 1)
  assert.ok(Math.abs(priced.priced.USD - 4.31) < Number.EPSILON * 4.31)
  assert.equal(formatAccounting(priced), 'EUR 1.00 + $4.31')

  const mixed = addAccounting(priced, {
    priced: {}, unpriced: { codex: counters(2, 12000, 900) },
  })
  assert.equal(formatAccounting(mixed),
    'at least EUR 1.00 + $4.31, plus 2 unpriced Codex calls')
})

test('unknown token observations remain unknown through addition and delta', () => {
  const before = { priced: {}, unpriced: { codex: counters(1, null, 100) } }
  const after = addAccounting(before, {
    priced: {}, unpriced: { codex: counters(1, 50, 20) },
  })
  assert.equal(after.unpriced.codex.calls, 2)
  assert.equal(after.unpriced.codex.inputTokens, null)
  assert.equal(after.unpriced.codex.outputTokens, 120)

  const delta = deltaAccounting(after, before)
  assert.equal(delta.unpriced.codex.calls, 1)
  assert.equal(delta.unpriced.codex.inputTokens, null)
  assert.equal(delta.unpriced.codex.outputTokens, 20)
})

test('legacy scalar state migrates to known USD and zero is an identity', () => {
  const legacy = normalizeAccounting(3.25)
  assert.deepEqual(legacy, { priced: { USD: 3.25 }, unpriced: {}, legacy: true })
  assert.deepEqual(addAccounting(zeroAccounting(), legacy), legacy)
})
