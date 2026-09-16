#!/usr/bin/env node

// A deterministic stand-in for the current `claude --print` child. Tests provide a JSON queue:
// each invocation consumes one entry, records exactly what CAW transmitted, optionally changes
// fixture files as an executor would, and returns the requested envelope. It never uses a network.

import { appendFileSync, chmodSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'

if (process.argv.includes('--version')) {
  process.stdout.write('fake-claude 1.0.0\n')
  process.exit(0)
}

const queuePath = process.env.CAW_FAKE_QUEUE
const callsPath = process.env.CAW_FAKE_CALLS

// Every outer boundary this double runs under refuses a write; only the errno differs, and the
// double must not care which one it got. Seatbelt reports EPERM, bubblewrap's read-only root
// reports EROFS, and a path masked read-only inside it reports EACCES. Naming the set here is
// what stops one OS's errno from being the definition of "the boundary held".
const DENIED_BY_BOUNDARY = new Set(['EPERM', 'EROFS', 'EACCES'])
const denied = (error) => DENIED_BY_BOUNDARY.has(error?.code)

if (!queuePath || !callsPath) {
  process.stderr.write('CAW_FAKE_QUEUE and CAW_FAKE_CALLS are required\n')
  process.exit(64)
}

const input = readFileSync(0, 'utf8')
const queue = JSON.parse(readFileSync(queuePath, 'utf8'))
if (!Array.isArray(queue) || !queue.length) {
  process.stderr.write('fake provider response queue is empty\n')
  process.exit(65)
}

const role = process.env.CAW_ROLE || ''
const structured = (entry) => entry?.envelope?.structured_output ?? entry?.structured_output ?? entry
const belongsTo = (entry) => {
  if (entry?.role) return entry.role === role
  const value = structured(entry)
  if (role === 'executor') return value && 'summary' in value && 'blocked' in value
  if (role === 'reviewer') return value && 'carried' in value && 'weak' in value
  if (role === 'enumerator') return value && 'cases' in value && !('tasks' in value)
  if (role === 'architect') return value && 'tasks' in value && 'coverage' in value
  if (role === 'plan-reviewer') return value && 'unverifiable' in value && !('carried' in value)
  return true
}
const semanticRepairMatch = role === 'reviewer'
  ? input.match(/^Semantic repair (\d+) for review pass (\d+) of \d+\./)
  : null
const reviewPass = role === 'reviewer'
  ? Number(semanticRepairMatch?.[2] ||
      input.match(/(?:^|\n\n)Review pass (\d+) of \d+\./)?.[1] || 1)
  : 1
const semanticRepair = Number(semanticRepairMatch?.[1] || 0)
const matching = queue.map((entry, index) => belongsTo(entry) ? index : -1).filter((index) => index >= 0)
const exactReviewerSelection = role === 'reviewer'
  ? queue.findIndex((entry) => belongsTo(entry) &&
      entry.reviewPass === reviewPass && Number(entry.semanticRepair || 0) === semanticRepair)
  : -1
const selected = exactReviewerSelection >= 0
  ? exactReviewerSelection
  : role === 'reviewer' && reviewPass > 1
    ? (matching[reviewPass - 1] ?? matching[0] ?? -1)
    : queue.findIndex(belongsTo)
const index = selected === -1 ? 0 : selected
const next = queue[index]

if (next.probeWrites) {
  const match = input.match(/write ("(?:\\.|[^"\\])*") to ("(?:\\.|[^"\\])*") and to ("(?:\\.|[^"\\])*")/)
  if (!match) throw new Error(`could not parse probe prompt: ${input}`)
  const sentinel = JSON.parse(match[1])
  const inside = JSON.parse(match[2])
  const outside = JSON.parse(match[3])
  next.writeFiles = { ...(next.writeFiles || {}), [inside]: sentinel, [outside]: sentinel }
  next.ignoreWriteErrors = true
}
// A reviewer is confined to its isolated surface, so its append to the calls log is denied and
// swallowed above: the prompt CAW sent that role reaches no test through `CAW_FAKE_CALLS`.
// Anything a test needs to assert about it has to travel back inside the verdict, which is the
// route `probeGateArtifacts` already takes.
if (next.echoPromptMatch) {
  const value = next.envelope?.structured_output ?? next.structured_output ?? next
  const found = input.match(new RegExp(next.echoPromptMatch, 'g')) || []
  value.noted = [...(value.noted || []), `fake-prompt-echo:${JSON.stringify(found)}`]
}
if (next.probeReads) {
  const value = next.envelope?.structured_output ?? next.structured_output ?? next
  value.observed_nonce = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8')
}
try {
  // A reviewer is deliberately confined to its isolated surface and cannot update harness state
  // beside the delivery. The next writable role removes this response together with its own.
  queue.splice(0, index + 1)
  writeFileSync(queuePath, `${JSON.stringify(queue, null, 2)}\n`)
} catch (error) {
  if (!denied(error)) throw error
}
try { appendFileSync(callsPath, `${JSON.stringify({
  argv: process.argv.slice(2),
  input,
  cwd: process.cwd(),
  role,
  cawSpec: process.env.CAW_SPEC ?? null,
})}\n`) } catch (error) {
  if (!denied(error)) throw error
}

const writeResults = {}
// An executor that commits its own work is not hypothetical: one was measured doing it, and the
// engine has to tell that silence apart from an executor that did nothing. Only a double that can
// commit reaches that branch.
const commitOwnWork = (message) => {
  execFileSync('git', ['add', '-A'], { cwd: process.cwd(), stdio: 'ignore' })
  execFileSync('git', ['-c', 'user.email=fake@example.invalid', '-c', 'user.name=fake',
    'commit', '-q', '-m', message], { cwd: process.cwd(), stdio: 'ignore' })
}

for (const [path, body] of Object.entries(next.writeFiles || {})) {
  const target = resolve(process.cwd(), path)
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
    writeResults[path] = { ok: true, error: null }
  } catch (error) {
    writeResults[path] = { ok: false, error: error?.code || error?.name || 'unknown' }
    if (!next.ignoreWriteErrors) throw error
  }
}

if (next.commitOwnWork) commitOwnWork(String(next.commitOwnWork))

const canonical = next.envelope?.structured_output ?? next.structured_output
if (role === 'reviewer' && Array.isArray(canonical?.weak)) {
  for (const [index, item] of canonical.weak.entries()) {
    const fixturePatch = item.mutation?.patch
    const fixturePath = item.mutation?.capturePath
    const skipCapture = item.mutation?.skipCapture === true
    if (item.mutation) {
      delete item.mutation.patch
      delete item.mutation.capturePath
      delete item.mutation.skipCapture
    }
    if (skipCapture) continue
    try {
      execFileSync('git', ['reset', '--hard', 'caw-review-baseline'], {
        cwd: process.cwd(), input: '',
      })
      if (fixturePath) {
        const target = resolve(process.cwd(), fixturePath)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, 'captured by fake reviewer\n')
      } else if (typeof fixturePatch === 'string') {
        execFileSync('git', ['apply', '--binary', '-'], {
          cwd: process.cwd(), input: fixturePatch,
        })
      } else {
        continue
      }
      // `-f` lets one malicious fixture capture an ignored CAW-owned path without accidentally
      // adding every ignored dependency overlay to ordinary mutations.
      execFileSync('git', fixturePath
        ? ['add', '-f', '--', fixturePath]
        : ['add', '-A'], { cwd: process.cwd(), input: '' })
      execFileSync('git', ['commit', '-q', '-m', `caw-weak-${index + 1}`], {
        cwd: process.cwd(), input: '',
      })
      execFileSync('git', ['branch', '-f', `caw-weak-${index + 1}`, 'HEAD'], {
        cwd: process.cwd(), input: '',
      })
    } catch { /* malformed fixture mutation deliberately leaves no capture branch */ }
  }
  execFileSync('git', ['reset', '--hard', 'caw-review-baseline'], {
    cwd: process.cwd(), input: '',
  })
}

// Observe real artifact reads and denied mutations through the normal provider boundary.
if (next.probeGateArtifacts) {
  const files = JSON.parse(input.match(/## Read-only gate artifacts:\n(\[[^\n]*\])/)[1])
  const attempt = (action) => {
    try { action(); return null } catch (error) { return error.code }
  }
  const observations = files.map((file) => {
    const content = readFileSync(file.path)
    return {
      id: file.id,
      path: file.path,
      content: content.toString('utf8'),
      sha256: createHash('sha256').update(content).digest('hex'),
      chmodError: attempt(() => chmodSync(file.path, 0o600)),
      writeError: attempt(() => writeFileSync(file.path, 'tampered')),
      removeError: attempt(() => unlinkSync(file.path)),
    }
  })
  canonical.noted.push(`fake-gate-artifacts:${JSON.stringify({
    observations,
    privateReadErrors: (next.privateLogPaths || []).map((path) =>
      attempt(() => readFileSync(path))),
  })}`)
}

// A confined reviewer cannot update the harness call log outside its surface. Return this
// opt-in observation through the canonical `noted` field so the integration test can prove both
// halves of the boundary without granting the fake another writable path.
if (next.recordReviewProbe) {
  if (!Array.isArray(canonical?.noted)) throw new Error('recordReviewProbe requires noted[]')
  const systemIndex = process.argv.indexOf('--append-system-prompt')
  const instructions = systemIndex === -1 ? '' : process.argv[systemIndex + 1]
  canonical.noted.push(`fake-review-probe:${JSON.stringify({
    cwd: process.cwd(),
    writes: writeResults,
    instructionsSha256: createHash('sha256').update(instructions).digest('hex'),
    promptSha256: createHash('sha256').update(input).digest('hex'),
    sectionOffsets: {
      pipeline: instructions.indexOf('## Pipeline invariants'),
      capabilities: instructions.indexOf('## Capabilities'),
      language: instructions.indexOf('## Language'),
    },
    inputMatches: Object.fromEntries((next.observeInputStrings || []).map((value) =>
      [value, input.includes(value)])),
  })}`)
}

if (next.delayMs) await new Promise((done) => setTimeout(done, next.delayMs))
if (next.stderr) process.stderr.write(next.stderr)
if (next.probeTools) {
  const markerMatch = input.match(/Then output exactly ("(?:\\.|[^"\\])*")/)
  if (!markerMatch) throw new Error(`could not parse tool-contract marker: ${input}`)
  const toolsAt = process.argv.indexOf('--tools')
  const tools = next.reportedTools ??
    (toolsAt === -1 ? [] : process.argv[toolsAt + 1].split(',').filter(Boolean))
  if (next.probeShellWrite) {
    const pathMatch = input.match(/printf %s "[^"]+" > ("(?:\\.|[^"\\])*")/)
    if (!pathMatch) throw new Error(`could not parse tool-contract write path: ${input}`)
    writeFileSync(JSON.parse(pathMatch[1]), 'shell reached')
  }
  const events = [
    { type: 'system', subtype: 'init', tools },
    ...(next.probeShellToolUse ? [{
      type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
    }] : []),
    {
      type: 'result', is_error: false,
      result: JSON.parse(markerMatch[1]),
      total_cost_usd: 0.2, duration_ms: 1250,
      usage: { input_tokens: 10, output_tokens: 4 }, modelUsage: {},
    },
  ]
  writeFileSync(1, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`)
} else if (next.stdoutText !== undefined) writeFileSync(1, next.stdoutText)
else writeFileSync(1, `${JSON.stringify(next.envelope ?? next)}\n`)
process.exit(next.status ?? 0)
