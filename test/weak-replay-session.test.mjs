import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { restoreWeakReplaySurface, runWeakReplaySession } from '../caw.mjs'

function recordingOperations({ baselineState = 'green', throwOnMutation = null } = {}) {
  const calls = []
  const surface = { id: 'surface-1', contents: 'new' }
  let created = 0
  return {
    surface,
    calls,
    created: () => created,
    operations: {
      createSurface() {
        created += 1
        calls.push(['create'])
        return surface
      },
      prepareSurface() {
        surface.contents = 'baseline'
        calls.push(['prepare'])
        return 'baseline-commit'
      },
      restoreSurface(_surface, baseline, index) {
        assert.equal(baseline, 'baseline-commit')
        surface.contents = 'baseline'
        calls.push(['restore', index])
      },
      runBaseline() {
        calls.push(['baseline'])
        return { state: baselineState }
      },
      runMutation(item, _surface, _baseline, index) {
        assert.equal(surface.contents, 'baseline', 'the prior mutation leaked')
        calls.push(['mutation', item])
        if (index === throwOnMutation) throw new Error(`mutation ${index} failed`)
        surface.contents = `mutated-${item}`
        return { item, surface: surface.id }
      },
      finishSurface(_surface, outcome) {
        calls.push(['finish', outcome.state])
      },
    },
  }
}

test('one replay surface independently restores every mutation', () => {
  const fixture = recordingOperations()
  const result = runWeakReplaySession(['alpha', 'beta', 'gamma'], fixture.operations)

  assert.equal(fixture.created(), 1)
  assert.equal(result.state, 'complete')
  assert.equal(result.restores, 4)
  assert.deepEqual(result.mutations.map(({ surface }) => surface),
    ['surface-1', 'surface-1', 'surface-1'])
  assert.deepEqual(fixture.calls.filter(([kind]) => kind === 'restore').map(([, index]) => index),
    [0, 1, 2, 3])
  assert.equal(fixture.surface.contents, 'baseline')
  assert.deepEqual(fixture.calls.at(-1), ['finish', 'complete'])
})

test('an unavailable baseline runs no mutations and still finalizes the surface', () => {
  const fixture = recordingOperations({ baselineState: 'red' })
  const result = runWeakReplaySession(['alpha', 'beta'], fixture.operations)

  assert.equal(result.state, 'baseline-unavailable')
  assert.deepEqual(result.mutations, [])
  assert.equal(fixture.calls.some(([kind]) => kind === 'mutation'), false)
  assert.deepEqual(fixture.calls.at(-1), ['finish', 'baseline-unavailable'])
})

test('a mutation failure finalizes the reusable surface as an error', () => {
  const fixture = recordingOperations({ throwOnMutation: 1 })
  assert.throws(() => runWeakReplaySession(['alpha', 'beta'], fixture.operations),
    /mutation 1 failed/)
  assert.equal(fixture.created(), 1)
  assert.deepEqual(fixture.calls.at(-1), ['finish', 'error'])
})

test('Git restore removes tracked and untracked residue', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'caw-weak-replay-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

  git('init', '--quiet')
  git('config', 'user.name', 'CAW Test')
  git('config', 'user.email', 'caw-test@example.invalid')
  writeFileSync(join(root, 'tracked.txt'), 'baseline\n')
  git('add', 'tracked.txt')
  git('commit', '--quiet', '-m', 'baseline')
  const baseline = git('rev-parse', 'HEAD')
  writeFileSync(join(root, 'tracked.txt'), 'mutation\n')
  writeFileSync(join(root, 'residue.txt'), 'must not leak\n')

  restoreWeakReplaySurface({ workingRoot: root }, baseline)

  assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8'), 'baseline\n')
  assert.equal(existsSync(join(root, 'residue.txt')), false)
  assert.equal(git('status', '--porcelain=v1', '--untracked-files=all'), '')
})
