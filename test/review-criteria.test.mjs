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
  }), /names no Must cover/)
})

// The finding already carries the id the schema requires; the quote was a second copy of the
// same binding in prose, and on one install a reviewer could not produce it even when told the
// exact text, so a rejection never serialized while an approval always did.
test('a blocking item binds to its criterion by id, without quoting the text', () => {
  const brokenRows = [{ ...rows[0], state: 'broken' }, ...rows.slice(1)]
  assert.equal(reviewCriteriaIssue(spec, brokenRows, {
    ...emptyVerdict,
    broken: [{ criterion_ids: ['must-cover-1'], evidence: 'the language switch drops Alpha' }],
  }), null)
  // The id must be the row's own and the item must sit in the matching slot.
  assert.match(reviewCriteriaIssue(spec, brokenRows, {
    ...emptyVerdict,
    broken: [{ criterion_ids: ['must-cover-2'], evidence: 'a different property' }],
  }), /must-cover-1 is broken but no broken item names it/)
  assert.match(reviewCriteriaIssue(spec, brokenRows, {
    ...emptyVerdict,
    weak: [{ criterion_ids: ['must-cover-1'], evidence: 'wrong slot' }],
  }), /no broken item names it/)
  assert.equal(reviewCriteriaIssue(spec, rows, {
    ...emptyVerdict,
    uncovered: [{ criterion_ids: ['done-when-2'], evidence: 'nothing checks the preserved input' }],
  }), null)
  const weakRows = [{ ...rows[0], state: 'weak' }, ...rows.slice(1)]
  assert.equal(reviewCriteriaIssue(spec, weakRows, {
    ...emptyVerdict,
    carried: [{ id: 'r4.1', state: 'open', evidence: 'still reproduces' }],
  }, [], [{ id: 'r4.1', criterion_ids: ['must-cover-1'], evidence: 'earlier observation' }]), null)
})

// Which criterion an open item blocks can change between rounds: the tree moved. The ids the
// item was RAISED with are fixed, and until the disposition could carry its own, saying so
// needed the criterion text verbatim — the constraint df33fab removed for new findings, left
// standing for carried ones, while the role file forbids raising a duplicate instead. Measured:
// three consecutive rejections on a resumed task with twelve open items, $43.40, no verdict.
test('a carried entry kept open can name a criterion it was not raised against', () => {
  const weakRows = [{ ...rows[0], state: 'weak' }, ...rows.slice(1)]
  const priorOpen = [{ id: 'r1.3', criterion_ids: ['done-when-2'], evidence: 'raised elsewhere' }]

  assert.match(reviewCriteriaIssue(spec, weakRows, {
    ...emptyVerdict,
    carried: [{ id: 'r1.3', state: 'open', evidence: 'still reproduces' }],
  }, [], priorOpen), /must-cover-1 is weak but no weak item names it/)

  assert.equal(reviewCriteriaIssue(spec, weakRows, {
    ...emptyVerdict,
    carried: [{
      id: 'r1.3', state: 'open', criterion_ids: ['must-cover-1'],
      evidence: 'the switch test still passes with Alpha removed',
    }],
  }, [], priorOpen), null)

  // A closed or withdrawn entry answers for nothing, whatever it lists.
  assert.match(reviewCriteriaIssue(spec, weakRows, {
    ...emptyVerdict,
    carried: [{
      id: 'r1.3', state: 'closed', criterion_ids: ['must-cover-1'], evidence: 'fixed now',
    }],
  }, [], priorOpen), /no weak item names it/)
})

test('the carried disposition schema admits criterion_ids and nothing else new', () => {
  const carried = SCHEMA.verdict.properties.carried.items
  assert.deepEqual(Object.keys(carried.properties).sort(),
    ['criterion_ids', 'evidence', 'evidence_refs', 'id', 'state'])
  // Required, like every other property of every engine schema: this project admits no optional
  // canonical field, and an entry that needs no re-linking sends an empty array.
  assert.deepEqual([...carried.required].sort(),
    ['criterion_ids', 'evidence', 'evidence_refs', 'id', 'state'])
})

test('an open carried finding can justify a non-met criterion without duplication', () => {
  const criterion = criteria[0].criterion
  const weakRows = [{ ...rows[0], state: 'weak' }, ...rows.slice(1)]
  const priorOpen = [{ id: 'r4.1', evidence: `Observed earlier. Criterion: ${criterion}` }]
  assert.equal(reviewCriteriaIssue(spec, weakRows, {
    ...emptyVerdict,
    carried: [{ id: 'r4.1', state: 'open', evidence: 'still reproduces' }],
  }, [], priorOpen), null)
  assert.match(reviewCriteriaIssue(spec, weakRows, {
    ...emptyVerdict,
    carried: [{ id: 'r4.1', state: 'closed', evidence: 'fixed now' }],
  }, [], priorOpen), /no weak item/)
})

test('reviewer schema requires the complete criterion ledger', () => {
  assert.ok(SCHEMA.verdict.required.includes('criteria'))
  assert.deepEqual(SCHEMA.verdict.properties.criteria.items.properties.state.enum,
    ['met', 'broken', 'uncovered', 'weak'])
})
