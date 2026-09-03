import test from 'node:test'
import assert from 'node:assert/strict'

import {
  addAccounting,
  deltaAccounting,
  formatAccounting,
  normalizeAccounting,
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
