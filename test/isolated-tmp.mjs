// Imported first by every test file that runs the engine, so each file's process — and every
// engine it spawns — gets a temp root of its own.
//
// The engine keeps review surfaces, transports and scratch under `os.tmpdir()`, and each run
// prunes what it finds there down to the newest few. Test files run in parallel processes, so
// with one shared temp root a run in one file pruned the surface another file had just retained
// and was about to assert on: a different retention case went red on most full runs, and every
// one of them passed alone. Tests inside one file run one at a time and share this root safely.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'caw-test-'))
// `os.tmpdir()` reads TMPDIR on POSIX and TEMP/TMP on Windows; all three, so it means one thing.
process.env.TMPDIR = root
process.env.TEMP = root
process.env.TMP = root
process.on('exit', () => {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* a read-only fixture; the OS sweeps it */ }
})
