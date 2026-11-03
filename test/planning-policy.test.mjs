import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PlanningAction,
  SCHEMA,
  canonicalAuthorityPaths,
  decidePlanningAction,
  demoteWeakFindings,
  effectiveExecutorBudgetClass,
  effectiveMutationProof,
  executorBudgetFloor,
  executorBudgetForSpec,
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

test('a link target is read relative to .caw/, where the profile is clicked from', () => {
  const paths = canonicalAuthorityPaths(`## Canonical docs

- [Handler](../docs/center/sync-handler.md) — relative to the profile
- [Rooted](/docs/rooted.md)
- [Anchored](../docs/anchored.md#section)
- [Escapes](../../outside.md)
`)
  assert.deepEqual([...paths], ['.caw/CAW.md', 'docs/center/sync-handler.md',
    'docs/rooted.md', 'docs/anchored.md'])
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
    executor_budget: 'small',
    mutation_proof: 'required',
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
      'indivisible_reason', 'executor_budget', 'mutation_proof'])
})

test('mutation proof is proposed by planning and only ever raised by the floor', () => {
  const plumbing = 'Add a mock flag.'
  assert.equal(effectiveMutationProof('none', plumbing).effective, 'none')
  assert.equal(effectiveMutationProof('required', plumbing).effective, 'required')
  assert.equal(effectiveMutationProof(null, plumbing).effective, 'required')
  assert.deepEqual(effectiveMutationProof('none', 'Change the RLS policy.'), {
    requested: 'none', floor: 'required', effective: 'required',
    reason: 'the task names database, authorization, security, credential, or migration work',
  })
  // A clause the task rules out is not work the task does.
  assert.equal(effectiveMutationProof('none', 'Add a flag. Do not touch the database.').effective,
    'none')
  assert.throws(() => effectiveMutationProof('maybe', plumbing),
    /mutation_proof must be required or none/)
})

test('the mutation proof floor reads the delivered paths and the project pattern', () => {
  const task = 'Add a mock flag.'
  assert.equal(effectiveMutationProof('none', task, {}, ['src/view.swift']).effective, 'none')
  assert.deepEqual(effectiveMutationProof('none', task, {}, ['db/migrations/001.sql']), {
    requested: 'none', floor: 'required', effective: 'required',
    reason: 'the delivery changes db/migrations/001.sql',
  })
  const f = { mutation_risk_regex: /deletePhoto|^supabase\//im }
  assert.equal(effectiveMutationProof('none', task, f, ['supabase/seed.sql']).effective, 'required')
  assert.equal(effectiveMutationProof('none', 'Rework deletePhoto.', f).effective, 'required')
  assert.equal(effectiveMutationProof('none', task, f, ['src/view.swift']).effective, 'none')
})

test('demoting weak findings keeps a row an open carried item still holds', () => {
  const verdict = {
    criteria: [
      { id: 'must-cover-1', state: 'weak', evidence: 'new doubt' },
      { id: 'must-cover-2', state: 'weak', evidence: 'still open' },
      { id: 'done-when-1', state: 'broken', evidence: 'wrong' },
    ],
    carried: [{ id: 'r1.1', state: 'open' }],
    broken: [{ where: 'a:1' }],
    uncovered: [],
    weak: [{ where: 'b:2', fix: 'tighten', evidence: 'green with the label changed' }],
    noted: ['kept'],
  }
  demoteWeakFindings(verdict, [{ id: 'r1.1', slot: 'weak', criterion_ids: ['must-cover-2'] }])
  assert.deepEqual(verdict.criteria.map((row) => row.state), ['met', 'weak', 'broken'])
  assert.deepEqual(verdict.weak, [])
  assert.equal(verdict.broken.length, 1)
  assert.equal(verdict.noted[0], 'kept')
  assert.match(verdict.noted[1], /^weak not required, noted only — b:2: tighten;/)
})

test('executor budget class is proposed by planning and raised by deterministic safety floors', () => {
  const local = relatedPlan().tasks[0]
  assert.deepEqual(effectiveExecutorBudgetClass('small', local), {
    requested: 'small', floor: 'small', effective: 'small',
    reason: 'one non-sensitive surface with fewer than four transitions',
  })

  const crossLayer = {
    ...local,
    surfaces: [
      ...local.surfaces,
      { id: 'stored-policy', responsibility: 'Persist the same decision.' },
    ],
  }
  const raised = effectiveExecutorBudgetClass('small', crossLayer)
  assert.equal(raised.requested, 'small')
  assert.equal(raised.floor, 'large')
  assert.equal(raised.effective, 'large')

  const security = effectiveExecutorBudgetClass('normal', {
    ...local, change: ['Update the RLS authorization policy.'],
  })
  assert.equal(security.effective, 'large')
  assert.deepEqual(executorBudgetFloor(`---
title: Keep the UI harness deterministic
---

## Change
- Do not change production source, schema, migration, credentials, or security policy.
- Update only the local UI-test launch helper.
`), {
    class: 'small', reason: 'one non-sensitive surface with fewer than four transitions',
  })
  assert.throws(() => effectiveExecutorBudgetClass('tiny', local),
    /executor_budget must be small, normal, or large/)
})

test('adaptive executor limits resolve from approved spec and legacy specs default to normal', () => {
  const f = {
    executor_budgets: {
      small: { tool_events: 80, event_bytes: 1048576 },
      normal: { tool_events: 160, event_bytes: 2097152 },
      large: { tool_events: 240, event_bytes: 4194304 },
    },
    executor_max_tool_events: null,
    executor_max_event_bytes: null,
  }
  const localSpec = `---\nexecutor_budget: small\n---\n\n## Surfaces\n- \`one\` — local output\n\n## State machines\n- \`one\`: states \`a\`, \`b\`\n  - \`a\` -- write --> \`b\`\n`
  assert.deepEqual(executorBudgetForSpec(f, localSpec), {
    mode: 'adaptive', class: 'small', requested: 'small', floor: 'small',
    planning_requested: null,
    reason: 'one non-sensitive surface with fewer than four transitions',
    tool_events: 80, event_bytes: 1048576,
  })

  const legacySensitiveSpec = `---\ntitle: policy\n---\n\n## Surfaces\n- \`one\` — database migration and RLS policy\n`
  const selected = executorBudgetForSpec(f, legacySensitiveSpec)
  assert.equal(selected.requested, 'normal')
  assert.equal(selected.planning_requested, null)
  assert.equal(selected.floor, 'large')
  assert.equal(selected.class, 'large')
  assert.equal(selected.tool_events, 240)
})
