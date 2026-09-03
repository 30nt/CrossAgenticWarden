import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

import claude from '../.caw/adapters/claude/adapter.mjs'
import { symlinkSkip } from './host-capabilities.mjs'

const TEMP_ROOTS = new Set()

afterEach(() => {
  for (const root of TEMP_ROOTS) rmSync(root, { recursive: true, force: true })
  TEMP_ROOTS.clear()
})

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function sourceRepository() {
  const parent = mkdtempSync(join(tmpdir(), 'caw-review-surface-source-'))
  TEMP_ROOTS.add(parent)
  const root = join(parent, 'delivery')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, '.gitignore'), '.env\nnode_modules/\n')
  writeFileSync(join(root, 'src', 'value.txt'), 'committed\n')
  writeFileSync(join(root, 'src', 'staged.txt'), 'committed staged\n')
  writeFileSync(join(root, 'gate.mjs'), `
import { existsSync } from 'node:fs'
process.exit(existsSync('src/value.txt') && existsSync('src/new.txt') ? 0 : 1)
`)
  git(parent, 'init', '-q', '-b', 'feature/review-surface', root)
  git(root, 'config', 'user.name', 'CAW Surface Probe')
  git(root, 'config', 'user.email', 'surface@example.invalid')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'baseline')

  writeFileSync(join(root, 'src', 'value.txt'), 'delivery\n')
  writeFileSync(join(root, 'src', 'staged.txt'), 'staged delivery\n')
  git(root, 'add', 'src/staged.txt')
  writeFileSync(join(root, 'src', 'new.txt'), 'untracked delivery\n')
  writeFileSync(join(root, '.env'), 'SECRET=must-not-enter-surface\n')
  mkdirSync(join(root, 'node_modules', 'fixture-dependency'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'fixture-dependency', 'index.js'), 'dependency\n')
  return { parent, root }
}

function untrackedFiles(root) {
  return execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0').filter(Boolean)
}

function buildSurface(source, destination) {
  if (hasGitlink(source)) throw new Error('populated submodules require a probed overlay')
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', source, destination])
  git(destination, 'remote', 'remove', 'origin')

  const patch = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: source })
  if (patch.length) execFileSync('git', ['apply', '--binary', '-'], { cwd: destination, input: patch })
  for (const path of untrackedFiles(source)) {
    const target = join(destination, path)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(source, path), target, { preserveTimestamps: true })
  }

  // This spike deliberately exposes one ignored dependency root and no other ignored path.
  // The execution sandbox below makes the symlink read-only and denies the ignored secret.
  symlinkSync(join(source, 'node_modules'), join(destination, 'node_modules'), 'dir')
  const exclude = git(destination, 'rev-parse', '--git-path', 'info/exclude').trim()
  appendFileSync(join(destination, exclude), '\nnode_modules\n')
}

function hasGitlink(root) {
  return git(root, 'ls-files', '--stage').split('\n').some((line) => line.startsWith('160000 '))
}

function replayWeak(source, destination, findingId, patch) {
  buildSurface(source, destination)
  execFileSync('git', ['apply', '--binary', '-'], { cwd: destination, input: patch })
  return {
    findingId,
    patchSha256: createHash('sha256').update(patch).digest('hex'),
    gateStatus: spawnSync(process.execPath, ['gate.mjs'], { cwd: destination }).status,
  }
}

// The spike used to write a seatbelt policy of its own, which measured macOS and, worse, measured
// a policy nothing else runs. It now asks the shipped adapter to bound a plain shell exactly as it
// bounds a role, so whichever outer profile this host has is the one under test.
function boundedShell({ surface, scratchRoot, deniedReads, script }) {
  const invocation = claude.buildInvocation({
    role: 'reviewer',
    binding: { provider: 'claude', model: 'fixture', reasoning: 'high' },
    schema: { type: 'object' },
    instructions: 'spike',
    prompt: 'spike',
    executable: '/bin/bash',
    execution: {
      workingRoot: surface,
      scratchRoot,
      writeBoundary: 'isolated-review-surface',
      writeBoundaryBy: 'isolated-surface',
      deniedReadPaths: deniedReads.map((path) => realpathSync(resolve(path))),
      env: { PWD: surface },
    },
  })
  // Everything after the provider executable is the CLI's own argument list; the boundary is the
  // prefix, and the shell replaces the provider here.
  const boundary = invocation.args.slice(0, invocation.args.indexOf('/bin/bash') + 1)
  return spawnSync(invocation.executable, [...boundary, '-c', script],
    { cwd: surface, encoding: 'utf8' })
}

const outerProfileHost = () =>
  claude.describe({ role: 'architect', cliVersion: 'spike' }).guarantees.writeScope.by === 'os-boundary'

// `buildSurface` symlinks the allowlisted dependency root, so every case that builds a surface
// needs that one kernel capability before it can say anything about isolation. Where it is
// missing these skipped with a named reason instead of failing: a red here would claim the
// surface contract is broken, when what is absent is the privilege to make a link at all.
const surfaceSkip = () => symlinkSkip()
const outerProfileSkip = () =>
  surfaceSkip() || (outerProfileHost() ? false : 'this host publishes no outer profile row')

test('clone plus delivery overlay has Git truth without ignored credentials',
  { skip: surfaceSkip() }, () => {
  const source = sourceRepository()
  const surface = join(source.parent, 'surface')
  buildSurface(source.root, surface)

  assert.equal(readFileSync(join(surface, 'src', 'value.txt'), 'utf8'), 'delivery\n')
  assert.equal(readFileSync(join(surface, 'src', 'new.txt'), 'utf8'), 'untracked delivery\n')
  assert.equal(existsSync(join(surface, '.env')), false)
  assert.equal(readFileSync(join(surface, 'node_modules', 'fixture-dependency', 'index.js'), 'utf8'),
    'dependency\n')
  assert.equal(git(surface, 'remote').trim(), '')
  assert.equal(git(surface, 'rev-parse', '--is-inside-work-tree').trim(), 'true')
  assert.deepEqual(git(surface, 'status', '--porcelain').trimEnd().split('\n').sort(), [
    ' M src/staged.txt',
    ' M src/value.txt',
    '?? src/new.txt',
  ])
  assert.equal(spawnSync(process.execPath, ['gate.mjs'], { cwd: surface }).status, 0)
})

test('the outer profile permits surface writes but denies delivery writes and secret reads',
  { skip: outerProfileSkip() }, () => {
    const source = sourceRepository()
    const surface = join(source.parent, 'surface')
    buildSurface(source.root, surface)
    const scratchRoot = join(source.parent, 'provider-tmp')
    mkdirSync(scratchRoot, { recursive: true })
    const run = (script) => boundedShell({
      surface, scratchRoot, deniedReads: [join(source.root, '.env')], script,
    })
    const inside = run('printf inside > src/reviewer-mutation.txt')
    const outside = run(`printf escaped > '${join(source.root, 'src', 'escaped.txt')}'`)
    const secret = run(`cat '${join(source.root, '.env')}'`)
    const dependency = run('cat node_modules/fixture-dependency/index.js')

    assert.equal(inside.status, 0, inside.stderr)
    assert.notEqual(outside.status, 0)
    assert.notEqual(secret.status, 0)
    assert.equal(dependency.status, 0, dependency.stderr)
    assert.equal(dependency.stdout, 'dependency\n')
    assert.equal(existsSync(join(surface, 'src', 'reviewer-mutation.txt')), true)
    assert.equal(existsSync(join(source.root, 'src', 'escaped.txt')), false)
  })

test('each mutation replay begins from the same delivery overlay',
  { skip: surfaceSkip() }, () => {
  const source = sourceRepository()
  const first = join(source.parent, 'surface-one')
  buildSurface(source.root, first)
  writeFileSync(join(first, 'src', 'value.txt'), 'mutation one\n')
  const mutation = `diff --git a/src/value.txt b/src/value.txt
--- a/src/value.txt
+++ b/src/value.txt
@@ -1 +1 @@
-delivery
+mutation one
`

  const replay = join(source.parent, 'surface-two')
  buildSurface(source.root, replay)
  assert.equal(readFileSync(join(replay, 'src', 'value.txt'), 'utf8'), 'delivery\n')
  execFileSync('git', ['apply', '--binary', '-'], { cwd: replay, input: mutation })
  assert.equal(readFileSync(join(replay, 'src', 'value.txt'), 'utf8'), 'mutation one\n')
  assert.equal(spawnSync(process.execPath, ['gate.mjs'], { cwd: replay }).status, 0)

  const independent = join(source.parent, 'surface-three')
  buildSurface(source.root, independent)
  assert.equal(readFileSync(join(independent, 'src', 'value.txt'), 'utf8'), 'delivery\n')
  assert.equal(relative(source.root, independent).startsWith('..'), true)
})

test('concurrent surfaces have distinct Git state and cannot exchange mutations',
  { skip: surfaceSkip() }, () => {
  const source = sourceRepository()
  const first = join(source.parent, 'surface-concurrent-one')
  const second = join(source.parent, 'surface-concurrent-two')
  buildSurface(source.root, first)
  buildSurface(source.root, second)

  writeFileSync(join(first, 'src', 'concurrent-only.txt'), 'first\n')
  assert.equal(existsSync(join(second, 'src', 'concurrent-only.txt')), false)
  assert.notEqual(realpathSync(first), realpathSync(second))
  assert.equal(git(first, 'rev-parse', '--git-dir').trim(), '.git')
  assert.equal(git(second, 'rev-parse', '--git-dir').trim(), '.git')
})

test('weak items bind to separate fresh-surface patch and gate events',
  { skip: surfaceSkip() }, () => {
  const source = sourceRepository()
  const firstPatch = `diff --git a/src/value.txt b/src/value.txt
--- a/src/value.txt
+++ b/src/value.txt
@@ -1 +1 @@
-delivery
+weak-one
`
  const secondPatch = `diff --git a/src/staged.txt b/src/staged.txt
--- a/src/staged.txt
+++ b/src/staged.txt
@@ -1 +1 @@
-staged delivery
+weak-two
`
  const first = replayWeak(source.root, join(source.parent, 'weak-one'), 'r1.1', firstPatch)
  const second = replayWeak(source.root, join(source.parent, 'weak-two'), 'r1.2', secondPatch)

  assert.deepEqual([first.findingId, second.findingId], ['r1.1', 'r1.2'])
  assert.equal(first.gateStatus, 0)
  assert.equal(second.gateStatus, 0)
  assert.notEqual(first.patchSha256, second.patchSha256)
  assert.equal(existsSync(join(source.root, 'src', 'concurrent-only.txt')), false)
})

test('a gitlink is detected and refused before surface construction', () => {
  const source = sourceRepository()
  const head = git(source.root, 'rev-parse', 'HEAD').trim()
  git(source.root, 'update-index', '--add', '--cacheinfo', `160000,${head},deps/submodule`)

  assert.equal(hasGitlink(source.root), true)
  assert.throws(
    () => buildSurface(source.root, join(source.parent, 'surface-with-gitlink')),
    /submodules require a probed overlay/,
  )
})
