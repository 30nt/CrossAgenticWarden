import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { posixShellSkip } from './host-capabilities.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FRAGMENTS = join(ROOT, '.caw', 'hooks', 'fragments')
const load = (name) => JSON.parse(readFileSync(join(FRAGMENTS, name), 'utf8'))

function wiring(config) {
  const result = new Map()
  for (const group of config.hooks.PreToolUse) {
    for (const hook of group.hooks) {
      const script = hook.command.match(/([a-z_]+\.py)/)?.[1]
      assert.ok(script, `missing guard script in ${hook.command}`)
      result.set(script, { matcher: group.matcher, hook })
    }
  }
  return result
}

test('Claude operator fragment covers direct edits and both named shell tools', () => {
  const map = wiring(load('claude-settings.fragment.json'))
  assert.equal(map.get('deny_tasks_edit.py').matcher, 'Edit|Write|NotebookEdit')
  assert.equal(map.get('deny_tasks_bash.py').matcher, 'Bash|PowerShell')
  assert.equal(map.get('require_caw_log.py').matcher, 'Bash|PowerShell')
  for (const [script, { hook }] of map) {
    assert.equal(hook.timeout, 10)
    assert.match(hook.command, /exit 2/)
    assert.equal(existsSync(join(ROOT, '.caw', 'hooks', script)), true)
  }
})

test('Codex operator fragment covers Bash aliases and apply_patch aliases independently', () => {
  const config = load('codex-hooks.fragment.json')
  const map = wiring(config)
  assert.equal(map.get('deny_tasks_edit.py').matcher, 'Edit|Write')
  assert.equal(map.get('deny_tasks_bash.py').matcher, 'Bash')
  assert.equal(map.get('require_caw_log.py').matcher, 'Bash')
  for (const [script, { hook }] of map) {
    assert.equal(hook.timeout, 10)
    assert.match(hook.command, /exit 2/)
    assert.match(hook.commandWindows, /exit 2/)
    assert.equal(existsSync(join(ROOT, '.caw', 'hooks', script)), true)
  }
  assert.doesNotMatch(JSON.stringify(config), /dangerously-bypass-hook-trust/)
})

// The fragments are POSIX shell text, so a shell that parses it is the capability this case
// needs — not a platform. Asking PATH for `sh` rather than naming `/bin/sh` is what lets Git
// Bash on Windows run this as real coverage, and where no such shell exists the skip names the
// missing interpreter. Written as `/bin/sh`, this case reported `undefined null !== 2` on
// Windows, which reads as a broken guard fragment and is instead an absent shell.
test('both POSIX fragments block when a named guard entry point is missing',
  { skip: posixShellSkip() }, () => {
  const root = mkdtempSync(join(tmpdir(), 'caw-operator-hook-config-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: root })
    for (const [name, env] of [
      ['claude-settings.fragment.json', { ...process.env, CLAUDE_PROJECT_DIR: root }],
      ['codex-hooks.fragment.json', process.env],
    ]) {
      for (const { hook } of wiring(load(name)).values()) {
        const result = spawnSync('sh', ['-c', hook.command], {
          cwd: root, env, encoding: 'utf8',
        })
        assert.equal(result.status, 2, `${name}: ${result.stderr}`)
        assert.match(result.stderr, /entry point is unavailable/)
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
