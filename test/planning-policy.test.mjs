import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PlanningAction,
  SCHEMA,
  canonicalAuthorityPaths,
  decidePlanningAction,
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
