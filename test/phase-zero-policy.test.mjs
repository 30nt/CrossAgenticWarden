import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  cpSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

import { fileURLToPath } from 'node:url'

import { symlinkSkip } from './host-capabilities.mjs'
import { removeTree } from '../caw.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const TEMP_ROOTS = new Set()

function temporary(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  TEMP_ROOTS.add(root)
  return root
}

afterEach(() => {
  for (const root of TEMP_ROOTS) rmSync(root, { recursive: true, force: true })
  TEMP_ROOTS.clear()
})

const MiB = 1024 * 1024
const limits = {
  finalResponse: 4 * MiB,
  providerFailure: 4 * MiB,
  roundState: 8 * MiB,
  blockedPatch: 64 * MiB,
  divergedSpec: 1 * MiB,
  weakPatch: 8 * MiB,
  weakVerdict: 32 * MiB,
  reviewSurface: 2 * 1024 * MiB,
  adapterTransport: 64 * MiB,
  adapterCredentialCopy: 1 * MiB,
  localProbeAttestation: 64 * 1024,
}

function withinLimit(bytes, limit) {
  return Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= limit
}

function selectOrphans(records, { now, maxAgeMs, maxCount }) {
  const active = records.filter((record) => record.active)
  const orphans = records
    .filter((record) => !record.active && now - record.createdAt <= maxAgeMs)
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, maxCount)
  return [...active, ...orphans]
}

function boundedFailure(bytes, limit) {
  if (bytes.length <= limit) return { complete: true, bytes }
  const edge = Math.floor(limit / 2)
  return {
    complete: false,
    totalBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    first: bytes.subarray(0, edge),
    last: bytes.subarray(bytes.length - edge),
  }
}

function atomicPrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  chmodSync(dirname(path), 0o700)
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  const descriptor = openSync(temporary, 'r')
  fsyncSync(descriptor)
  closeSync(descriptor)
  renameSync(temporary, path)
}

function removeManifestSurface({ root, parent }) {
  const canonicalParent = realpathSync(parent)
  const canonicalRoot = realpathSync(root)
  if (relative(canonicalParent, canonicalRoot).startsWith('..')) {
    throw new Error('surface escapes dedicated parent')
  }
  rmSync(canonicalRoot, { recursive: true })
}

test('every retention bound accepts limit-minus-one and limit, then rejects limit-plus-one', () => {
  for (const [artifact, limit] of Object.entries(limits)) {
    assert.equal(withinLimit(limit - 1, limit), true, `${artifact}: limit-minus-one`)
    assert.equal(withinLimit(limit, limit), true, `${artifact}: exact limit`)
    assert.equal(withinLimit(limit + 1, limit), false, `${artifact}: limit-plus-one`)
  }
})

test('active task recovery survives age/count pruning while orphans satisfy both bounds', () => {
  const day = 24 * 60 * 60 * 1000
  const now = 40 * day
  const records = [
    { id: 'active-old', active: true, createdAt: 0 },
    ...Array.from({ length: 25 }, (_, index) => ({
      id: `orphan-${index}`,
      active: false,
      createdAt: now - index * day,
    })),
    { id: 'expired', active: false, createdAt: now - 31 * day },
  ]
  const kept = selectOrphans(records, { now, maxAgeMs: 30 * day, maxCount: 20 })

  assert.equal(kept.some(({ id }) => id === 'active-old'), true)
  assert.equal(kept.some(({ id }) => id === 'expired'), false)
  assert.equal(kept.filter(({ active }) => !active).length, 20)
})

test('oversized provider failure is represented by count, digest and bounded edges', () => {
  const input = Buffer.from('0123456789')
  const retained = boundedFailure(input, 6)

  assert.equal(retained.complete, false)
  assert.equal(retained.totalBytes, 10)
  assert.equal(retained.first.toString(), '012')
  assert.equal(retained.last.toString(), '789')
  assert.equal(retained.sha256, createHash('sha256').update(input).digest('hex'))
})

// Both cases below build or walk a surface whose allowlisted dependency root is a symlink, so
// the link is the capability, not the policy they assert.
test('round state writes atomically with private directory and file modes',
  { skip: symlinkSkip() }, () => {
  const root = temporary('caw-retention-round-')
  const path = join(root, '.caw-tasks', '.round-probe.json')
  atomicPrivateJson(path, { version: 1, carried: ['r1.1'] })

  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1, carried: ['r1.1'] })
  assert.equal(lstatSync(dirname(path)).mode & 0o777, 0o700)
  assert.equal(lstatSync(path).mode & 0o777, 0o600)
  assert.equal(existsSync(`${path}.tmp`), false)
})

test('surface deletion never follows an allowlisted dependency symlink',
  { skip: symlinkSkip() }, () => {
  const parent = temporary('caw-retention-surfaces-')
  const dependency = temporary('caw-retention-dependency-')
  writeFileSync(join(dependency, 'keep.txt'), 'keep\n')
  const surface = join(parent, 'surface-one')
  mkdirSync(surface)
  symlinkSync(dependency, join(surface, 'dependency'), 'dir')

  removeManifestSurface({ root: surface, parent })
  assert.equal(existsSync(surface), false)
  assert.equal(readFileSync(join(dependency, 'keep.txt'), 'utf8'), 'keep\n')
})

test('CAW-owned trees with read-only directories are removed without following symlinks',
  { skip: symlinkSkip() }, () => {
  const root = temporary('caw-read-only-tree-')
  const outside = temporary('caw-read-only-outside-')
  const nested = join(root, 'module-cache', 'dependency')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(nested, 'cached.txt'), 'cached\n')
  writeFileSync(join(outside, 'keep.txt'), 'keep\n')
  symlinkSync(outside, join(root, 'outside'), 'dir')
  chmodSync(nested, 0o555)
  chmodSync(dirname(nested), 0o555)
  chmodSync(root, 0o555)

  removeTree(root)

  assert.equal(existsSync(root), false)
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep\n')
})

test('a manifest cannot delete a surface outside its dedicated parent', () => {
  const parent = temporary('caw-retention-parent-')
  const outside = temporary('caw-retention-outside-')

  assert.throws(() => removeManifestSurface({ root: outside, parent }), /escapes dedicated parent/)
  assert.equal(existsSync(outside), true)
})

test('successful run record includes final response and excludes progress/tool events', () => {
  const finalResponse = { value: { approved: true }, model: 'fixture' }
  const progressEvents = [{ type: 'tool', input: 'secret-sized-delivery-copy' }]
  const record = { finalResponse, eventStreamRetained: false }

  assert.deepEqual(record.finalResponse, finalResponse)
  assert.equal(record.eventStreamRetained, false)
  assert.equal(JSON.stringify(record).includes(progressEvents[0].input), false)
})

test('interrupted surfaces become bounded failure artifacts and generic count pruning stays conjunctive', () => {
  const day = 24 * 60 * 60 * 1000
  const now = 40 * day
  const interrupted = { state: 'active', pidAlive: false, createdAt: now - 60 * 60 * 1000 }
  const normalized = interrupted.pidAlive ? interrupted : { ...interrupted, state: 'interrupted' }
  assert.equal(normalized.state, 'interrupted')
  assert.equal(now - normalized.createdAt < day, true)

  const attestations = Array.from({ length: 4 }, (_, index) => ({
    id: `artifact-${index}`,
    active: false,
    createdAt: now - index * day,
  }))
  const kept = selectOrphans(attestations, { now, maxAgeMs: 30 * day, maxCount: 2 })
  assert.deepEqual(kept.map(({ id }) => id), ['artifact-0', 'artifact-1'])
})

// The queue moved from `tasks/` to `.caw-tasks/`. An install that still holds specs at the old
// path must be told rather than silently read at the new one, or its queued work waits forever.
test('a legacy tasks/ holding specs refuses the run and names the migration', () => {
  const root = temporary('caw-legacy-queue-')
  cpSync(join(HERE, '..', '.caw'), join(root, '.caw'), { recursive: true })
  mkdirSync(join(root, 'tasks'))
  writeFileSync(join(root, 'tasks', '001_old.md'), '# spec\n')

  const run = spawnSync(process.execPath, [join(HERE, '..', 'caw.mjs'), 'build'],
    { cwd: root, encoding: 'utf8' })

  assert.notEqual(run.status, 0)
  const out = run.stdout + run.stderr
  assert.match(out, /tasks\/ holds 1 file\(s\) and the queue is now \.caw-tasks\//)
  assert.match(out, /git mv tasks \.caw-tasks/)
  assert.equal(existsSync(join(root, 'tasks', '001_old.md')), true, 'refusing must not move anything')
})

test('a tasks/ with no specs is the project\'s own and does not refuse', () => {
  const root = temporary('caw-own-tasks-')
  cpSync(join(HERE, '..', '.caw'), join(root, '.caw'), { recursive: true })
  mkdirSync(join(root, 'tasks'))
  writeFileSync(join(root, 'tasks', 'main.yml'), '- name: a role task\n')

  const run = spawnSync(process.execPath, [join(HERE, '..', 'caw.mjs'), 'build'],
    { cwd: root, encoding: 'utf8' })

  assert.doesNotMatch(run.stdout + run.stderr, /the queue is now/)
})
