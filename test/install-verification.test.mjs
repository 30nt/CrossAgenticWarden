import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { posixFileModeSkip } from './host-capabilities.mjs'

const OWNED = ['caw.mjs', '.caw/agents', '.caw/adapters', '.caw/hooks']
const roots = []

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
const write = (root, path, body, mode = 0o644) => {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, body, { mode })
  chmodSync(target, mode)
}

function init(root) {
  git(root, 'init', '-q', '-b', 'minimal')
  git(root, 'config', 'user.name', 'CAW install fixture')
  git(root, 'config', 'user.email', 'fixture@example.invalid')
}

function sourceManifest(root, ref) {
  return git(root, 'ls-tree', '-r', ref, '--', ...OWNED).trim().split('\n').filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+\S+\s+([0-9a-f]+)\t(.+)$/)
      return `${match[1]} ${match[2]} ${match[3]}`
    }).sort()
}

function installedManifest(root) {
  return git(root, 'ls-files', '-s', '--', ...OWNED).trim().split('\n').filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+([0-9a-f]+)\s+(\d+)\t(.+)$/)
      assert.equal(match[3], '0')
      return `${match[1]} ${match[2]} ${match[4]}`
    }).sort()
}

function populateOwned(root, version) {
  write(root, 'caw.mjs', `engine ${version}\n`, 0o755)
  write(root, '.caw/agents/executor.md', `agent ${version}\n`)
  write(root, '.caw/adapters/example/adapter.mjs', `adapter ${version}\n`)
  write(root, '.caw/hooks/guard.py', `guard ${version}\n`, 0o755)
}

test('four-path verification detects mixed bytes and modes but excludes project-owned config', (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'caw-install-verification-'))
  roots.push(parent)
  const source = join(parent, 'source')
  const install = join(parent, 'install')
  mkdirSync(source)
  mkdirSync(install)
  init(source)
  populateOwned(source, 'v1')
  write(source, '.caw/CAW.md', 'upstream profile\n')
  write(source, '.caw/runtime.json', '{"upstream":true}\n')
  git(source, 'add', '-A')
  git(source, 'commit', '-q', '-m', 'v1')
  const v1 = git(source, 'rev-parse', 'HEAD').trim()

  init(install)
  for (const path of OWNED) cpSync(join(source, path), join(install, path), { recursive: true })
  write(install, '.caw/CAW.md', 'project profile\n')
  write(install, '.caw/runtime.json', '{"project":true}\n')
  git(install, 'add', '-A')
  git(install, 'commit', '-q', '-m', 'install v1')
  assert.deepEqual(installedManifest(install), sourceManifest(source, v1))

  populateOwned(source, 'v2')
  git(source, 'add', '-A')
  git(source, 'commit', '-q', '-m', 'v2')
  const v2 = git(source, 'rev-parse', 'HEAD').trim()

  cpSync(join(source, 'caw.mjs'), join(install, 'caw.mjs'))
  git(install, 'add', 'caw.mjs')
  assert.notDeepEqual(installedManifest(install), sourceManifest(source, v2),
    'one copied path cannot pass as a complete update')

  for (const path of OWNED) cpSync(join(source, path), join(install, path), { recursive: true })
  git(install, 'add', ...OWNED)
  assert.deepEqual(installedManifest(install), sourceManifest(source, v2))

  // The bytes half above runs everywhere. This half cannot: a host that discards POSIX mode
  // bits records the same mode for both trees, so the fork it stages does not exist to be seen
  // and the case asserted the comparison was broken. Announced rather than skipped, because
  // everything above it is real coverage — and announced rather than silent, because a silent
  // pass here would claim the mode half of the README’s promise had been checked.
  const modeSkip = posixFileModeSkip()
  if (modeSkip) {
    t.diagnostic(`mode-only fork not asserted: ${modeSkip}`)
  } else {
    chmodSync(join(install, '.caw/hooks/guard.py'), 0o644)
    git(install, 'add', '.caw/hooks/guard.py')
    assert.notDeepEqual(installedManifest(install), sourceManifest(source, v2),
      'a mode-only fork is visible')
  }
})
