// What this host can actually do, measured once per run.
//
// A gate written as `platform() === 'win32'` answers the wrong question. Windows with Developer
// Mode enabled creates symlinks and hard links exactly like a POSIX host does, so a platform gate
// reports real coverage as a permanent gap and nothing ever corrects it. The reverse is worse: a
// test that fails where the mechanism is simply absent destroys the one signal this suite has for
// telling a gap from a regression, because a skip count is evidence and a red is not.
//
// So each probe performs the operation once, in a temporary directory it removes, and caches what
// the kernel said. Each returns `false` when the host is capable — the shape `node:test` wants for
// `{ skip }` — and a named reason when it is not, so the skip line says which mechanism is missing
// rather than which operating system is running.

import {
  mkdtempSync, rmSync, symlinkSync, writeFileSync, linkSync, chmodSync, lstatSync,
  existsSync, statSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const measured = new Map()

// The probe directory is the thing under test as well as the place to test it: creating it is the
// cheapest operation here, and a host that cannot even do that has no business reporting on the
// rest. A probe that throws for that reason answers "not capable" rather than taking the run down.
function once(key, probe) {
  if (measured.has(key)) return measured.get(key)
  let root
  let answer
  try {
    root = mkdtempSync(join(tmpdir(), 'caw-host-probe-'))
    answer = probe(root)
  } catch (error) {
    answer = `${key} probe could not run on this host: ${error.code || error.message}`
  } finally {
    if (root) rmSync(root, { recursive: true, force: true })
  }
  measured.set(key, answer)
  return answer
}

export const symlinkSkip = () => once('symlink', (root) => {
  const target = join(root, 'target')
  writeFileSync(target, 'probe\n')
  try {
    symlinkSync(target, join(root, 'link'), 'file')
    return false
  } catch (error) {
    return `this host cannot create symlinks (${error.code}); on Windows that is Developer Mode off`
  }
})

export const hardLinkSkip = () => once('hard-link', (root) => {
  const target = join(root, 'target')
  writeFileSync(target, 'probe\n')
  try {
    linkSync(target, join(root, 'link'))
    return false
  } catch (error) {
    return `this host cannot create hard links (${error.code})`
  }
})

// Not "does chmod throw" — on Windows it does not, it simply does not carry the bits. The probe
// therefore asks for a mode and reads back what the filesystem kept, which is the only form that
// distinguishes an enforced mode from an accepted-and-discarded one.
export const posixFileModeSkip = () => once('posix-file-mode', (root) => {
  const path = join(root, 'moded')
  writeFileSync(path, 'probe\n')
  chmodSync(path, 0o600)
  const kept = lstatSync(path).mode & 0o777
  return kept === 0o600
    ? false
    : `this host does not carry POSIX file mode bits (asked 0o600, kept 0o${kept.toString(8)})`
})

// The operator guard fragments are POSIX shell text. Running them needs a shell that parses that
// text, which is a property of the host rather than of the fragment: Git Bash supplies one on
// Windows and a bare Windows install does not.
export const posixShellSkip = () => once('posix-shell', () => {
  const probe = spawnSync('sh', ['-c', 'command -v true >/dev/null 2>&1 && printf ok'],
    { encoding: 'utf8' })
  return probe.error || probe.stdout !== 'ok'
    ? `this host has no POSIX shell on PATH for the guard fragments (${probe.error?.code || 'no answer'})`
    : false
})

// A private-mode assertion that says out loud when it did not happen.
//
// Skipping the whole case would be the wrong trade: these cases assert a great deal besides the
// mode, and all of it runs here. But asserting nothing and staying silent is worse than a red,
// because the run then reads as if the privacy of the file had been checked. So the check either
// runs or announces itself as not run, and `node --test` prints that line either way.
export function assertPrivateMode(t, assert, path, expected, lstatSync) {
  const reason = posixFileModeSkip()
  if (reason) {
    t.diagnostic(`private mode 0o${expected.toString(8)} not asserted for ${path}: ${reason}`)
    return
  }
  assert.equal(lstatSync(path).mode & 0o777, expected)
}

// Is there any OS write-boundary helper on this host that the shipped adapters know how to drive?
//
// Asked as "does the file exist", never as "which platform is this": the two helpers are the whole
// mechanism, and a host that grows one should start running these cases without an edit here.
//
// The adapters resolve this themselves and the Claude one downgrades its declaration when the
// answer is no, so a case bound to Claude can ask the adapter and never needs this. The third-party
// fixture adapter does NOT downgrade — it keeps publishing `isolated-review-surface` with a probe —
// so a case bound to it cannot learn the answer by asking, and only a spent probe reveals it. Hence
// a probe of the host directly.
//
// It RUNS the helper rather than stat-ing it, which is the same rule every other probe here
// follows and the one this probe used to break. Presence is not capability: a default Docker
// container ships bwrap and denies the unprivileged user namespace it needs, and Ubuntu 24.04
// restricts the same namespace through AppArmor. Measured in a `node:22-bookworm-slim`
// container: bwrap present, `existsSync` therefore false-negative on the skip, and about forty
// cases went red with `Creating new namespace failed: Operation not permitted` — a red that
// claims the boundary was measured and refuted when it was never measured at all. That is the
// direction this file's own header calls the worse one.
export const outerBoundaryHelperSkip = () => once('outer-boundary-helper', () => {
  if (existsSync('/usr/bin/sandbox-exec')) {
    const probe = spawnSync('/usr/bin/sandbox-exec',
      ['-p', '(version 1)(allow default)', '/usr/bin/true'], { encoding: 'utf8' })
    if (!probe.error && probe.status === 0) return false
    return 'this host has /usr/bin/sandbox-exec but it cannot start a sandbox' +
      ` (${probe.error?.code || `exit ${probe.status}`})`
  }
  const path = (process.env.PATH || '').split(delimiter).filter(Boolean)
  for (const directory of path) {
    try {
      if (!statSync(join(directory, 'bwrap')).isFile()) continue
    } catch { continue }
    const probe = spawnSync(join(directory, 'bwrap'), ['--ro-bind', '/', '/', 'true'],
      { encoding: 'utf8' })
    if (!probe.error && probe.status === 0) return false
    const said = (probe.stderr || '').trim().split('\n')[0] ||
      probe.error?.code || `exit ${probe.status}`
    return `this host has bwrap on PATH but it cannot create a namespace: ${said}`
  }
  return 'this host has no OS write-boundary helper: neither /usr/bin/sandbox-exec nor bwrap on PATH'
})
