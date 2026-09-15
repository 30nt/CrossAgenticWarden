import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PlanningAction,
  SCHEMA,
  canonicalAuthorityPaths,
  decidePlanningAction,
  planRelationIssue,
  planningLedger,
} from '../caw.mjs'

test('request issues stop planning before architect', () => {
  assert.equal(decidePlanningAction([{ issue: 'authority conflict' }]),
    PlanningAction.stopRequest)
  assert.equal(decidePlanningAction([]), PlanningAction.architect)
  assert.throws(() => decidePlanningAction(null), /requestIssues must be an array/)
})

test('enumerator output requires sourced request issues', () => {
  assert.ok(SCHEMA.population.required.includes('request_issues'))
  const issue = SCHEMA.population.properties.request_issues.items
  assert.deepEqual(issue.required, ['issue', 'request_source', 'authority_sources'])
  assert.equal(issue.properties.authority_sources.minItems, 1)
})

test('request authority is limited to the profile and its canonical docs', () => {
  const paths = canonicalAuthorityPaths(`## Domain
Text

## Canonical docs

- \`docs/product.md\` — truth
- [Stack](docs/stack.md)
- https://example.invalid/reference

## Other
- \`not-authority.md\`
`)
  assert.deepEqual([...paths], ['.caw/CAW.md', 'docs/product.md', 'docs/stack.md'])
})

const relatedPlan = () => ({
  tasks: [{
    slug: 'preserve-state',
    title: 'Preserve state',
    read: ['src/state.js'],
    change: ['Keep both states explicit.'],
    done_when: ['The empty state survives.', 'The populated state survives.'],
    gate_checks: [],
    surfaces: [{ id: 'state-storage', responsibility: 'Preserve the stored state.' }],
    state_machines: [{
      surface: 'state-storage', states: ['empty', 'populated'],
      transitions: [{ from: 'empty', event: 'store value', to: 'populated' }],
    }],
    indivisible_reason: '',
  }],
  coverage: [{
    case: 'empty and populated states',
    task: 'preserve-state',
    acceptance_criteria: ['The empty state survives.', 'The populated state survives.'],
  }],
})

test('planning ledger gives stable ids to requirements and case-to-criterion relations', () => {
  const first = planningLedger(relatedPlan())
  const reordered = relatedPlan()
  reordered.tasks[0].done_when.reverse()
  reordered.coverage[0].acceptance_criteria.reverse()
  const second = planningLedger(reordered)

  assert.equal(first.version, 1)
  assert.deepEqual(new Set(first.requirements.map(({ id }) => id)),
    new Set(second.requirements.map(({ id }) => id)))
  assert.equal(first.relations[0].id, second.relations[0].id)
  assert.equal(first.relations[0].criterion_ids.length, 2)
  assert.match(first.tasks[0].id, /^plan-task-[0-9a-f]{12}$/)
  assert.match(first.cases[0].id, /^plan-case-[0-9a-f]{12}$/)
  assert.deepEqual(first.requirements.map(({ section }) => section),
    ['read', 'change', 'done_when', 'done_when', 'surface', 'state-transition'])
})

test('plan relation review requires every known id exactly once with evidence', () => {
  const ledger = planningLedger(relatedPlan())
  const row = {
    id: ledger.relations[0].id,
    state: 'covered',
    evidence: 'both linked final-tree checks exercise the named states',
  }

  assert.equal(planRelationIssue(ledger, [row]), null)
  assert.match(planRelationIssue(ledger, []), /missing relation id/)
  assert.match(planRelationIssue(ledger, [row, row]), /duplicate relation id/)
  assert.match(planRelationIssue(ledger, [{ ...row, id: 'plan-relation-unknown' }]),
    /unknown relation id/)
  assert.match(planRelationIssue(ledger, [{ ...row, evidence: ' ' }]), /empty evidence/)
})

test('plan-reviewer schema requires the complete relation ledger', () => {
  assert.ok(SCHEMA.planReview.required.includes('relations'))
  assert.deepEqual(SCHEMA.planReview.properties.relations.items.properties.state.enum,
    ['covered', 'uncovered'])
  assert.deepEqual(SCHEMA.plan.properties.coverage.items.required,
    ['case', 'task', 'acceptance_criteria'])
  assert.deepEqual(SCHEMA.plan.properties.tasks.items.required,
    ['slug', 'title', 'read', 'change', 'done_when', 'gate_checks', 'surfaces', 'state_machines',
      'indivisible_reason'])
})
