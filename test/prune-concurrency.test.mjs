// Every CAW process on a machine sweeps the same three temp parents on start. A sweep that assumed
// it was alone removed a sibling's directory in the moment between the sibling creating it and
// writing its manifest — for an adapter transport, a directory holding a copied credential
// mid-call. One owner running builds on several projects at once is the configuration that meets
// it. These cases put a manifest-less directory in each parent and check both sides of the grace:
// young survives, old is removed as before. For review surfaces the young case passed before the
// grace too — that sweep keeps its newest three — so there it guards; the transport and scratch
// cases are the ones that measure the fix.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

import { pruneAdapterTransports, pruneInvocationScratch, pruneReviewSurfaces } from '../caw.mjs'

const unique = () => `cawtest-${process.pid}-${randomBytes(4).toString('hex')}`
const age = (path, ms) => {
  const then = new Date(Date.now() - ms)
  utimesSync(path, then, then)
}

const sweeps = [
  ['adapter transport', join(tmpdir(), 'caw-adapter-transports'), 'transport-', pruneAdapterTransports],
  ['invocation scratch', join(tmpdir(), 'caw-invocation-scratch'), 'scratch-', pruneInvocationScratch],
  ['review surface', join(tmpdir(), 'caw-review-surfaces'), 'surface-', pruneReviewSurfaces],
]

for (const [label, parent, prefix, prune] of sweeps) {
  test(`${label}: a directory still being created survives a sibling's sweep`, (t) => {
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    const path = join(parent, `${prefix}${unique()}`)
    mkdirSync(path, { mode: 0o700 })
    t.after(() => rmSync(path, { recursive: true, force: true }))

    // No manifest yet: the creator is between mkdtemp and its first write.
    prune()
    assert.equal(existsSync(path), true, `${label} was removed inside its creation window`)
  })

  test(`${label}: an abandoned directory without a manifest is still removed`, (t) => {
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    const path = join(parent, `${prefix}${unique()}`)
    mkdirSync(path, { mode: 0o700 })
    t.after(() => rmSync(path, { recursive: true, force: true }))
    // Past the grace and past the review surfaces' own 24-hour retention, so each sweep's
    // ordinary rule applies and the grace is shown not to have turned into a leak.
    age(path, 25 * 60 * 60 * 1000)

    prune()
    assert.equal(existsSync(path), false, `an abandoned ${label} was kept`)
  })
}
