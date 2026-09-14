import test from 'node:test'
import assert from 'node:assert/strict'

import { SCHEMA, extractReviewCriteria, reviewCriteriaIssue } from '../caw.mjs'

const spec = `---
id: 001
title: Example
---

## Must cover
- Alpha survives a language switch
- Beta keeps the user's
  entered text unchanged

## Change
- Implement both.

## Done when
- The mounted Alpha consumer updates.
- The mounted Beta consumer preserves input.
`

const criteria = extractReviewCriteria(spec)
const rows = criteria.map(({ id }) => ({ id, state: 'met', evidence: `traced ${id}` }))
const emptyVerdict = { broken: [], uncovered: [], weak: [] }

test('extracts every review criterion with a stable engine id', () => {
  assert.deepEqual(criteria, [
    { id: 'must-cover-1', section: 'Must cover', criterion: 'Alpha survives a language switch' },
    {
      id: 'must-cover-2', section: 'Must cover',
      criterion: "Beta keeps the user's entered text unchanged",
    },
    { id: 'change-1', section: 'Change', criterion: 'Implement both.' },
    {
      id: 'done-when-1', section: 'Done when',
      criterion: 'The mounted Alpha consumer updates.',
    },
    {
      id: 'done-when-2', section: 'Done when',
      criterion: 'The mounted Beta consumer preserves input.',
    },
  ])
})

test('accepts exactly one evidenced row for every criterion', () => {
  assert.equal(reviewCriteriaIssue(spec, rows, emptyVerdict), null)
  assert.match(reviewCriteriaIssue(spec, rows.slice(1), emptyVerdict),
    /missing criterion id.*must-cover-1/)
  assert.match(reviewCriteriaIssue(spec, rows.filter(({ id }) => id !== 'change-1'), emptyVerdict),
    /missing criterion id.*change-1/)
  assert.match(reviewCriteriaIssue(spec, [...rows, rows[0]], emptyVerdict),
    /duplicate criterion id/)
  assert.match(reviewCriteriaIssue(spec, [{ ...rows[0], id: 'done-when-99' }, ...rows.slice(1)],
    emptyVerdict), /unknown criterion id/)
})

test('non-met criteria must bind to their exact blocking item', () => {
  const criterion = criteria[0].criterion
  const brokenRows = [{ ...rows[0], state: 'broken' }, ...rows.slice(1)]
  assert.match(reviewCriteriaIssue(spec, brokenRows, emptyVerdict), /no broken item/)
  assert.equal(reviewCriteriaIssue(spec, brokenRows, {
    ...emptyVerdict,
    broken: [{ evidence: `Observed failure. Criterion: ${criterion}` }],
  }), null)
  assert.match(reviewCriteriaIssue(spec, rows, {
    ...emptyVerdict,
    uncovered: [{ evidence: 'Something unrelated is absent.' }],
  }), /does not quote/)
})

test('reviewer schema requires the complete criterion ledger', () => {
  assert.ok(SCHEMA.verdict.required.includes('criteria'))
  assert.deepEqual(SCHEMA.verdict.properties.criteria.items.properties.state.enum,
    ['met', 'broken', 'uncovered', 'weak'])
})
