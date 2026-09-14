#!/usr/bin/env node
//
// CAW — a minimal agentic pipeline.
//
//   node caw.mjs plan "<description>"     architect -> plan-reviewer -> .caw-tasks/
//   node caw.mjs build [--no-full]        per spec: executor -> gate -> reviewer -> commit
//   node caw.mjs ship "<description>"     plan, then build
//   node caw.mjs review-specs "<description>"   judge hand-written specs, close the holes
//   node caw.mjs done <NNN_slug.md>       drop the spec of a task finished by hand
//
// Only the executor is authorised to deliver task code. A task reviewer may mutate an
// engine-owned isolated review surface, while an OS boundary denies it a path back to the
// delivery tree. Architect and plan-reviewer calls receive no direct edit capability.
//
// Architect and plan-reviewer retain a shell for checking premises, but an OS boundary denies
// that shell and every provider-native editor a path into delivery. Engine-private provider state
// remains writable. The reviewer instead receives a writable copy because its contract requires
// a real mutation; neither mechanism lets the provider mutate delivery.

import { spawnSync, spawn, execFileSync } from 'node:child_process'
import {
  appendFileSync, chmodSync, closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { arch, platform, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Hold the machine awake for the length of a child call. An architect call on a
// domain-sized request runs about ten minutes and a build runs that per task, so idle sleep
// is not an edge case here: it is the default outcome of walking away from a run, which is
// the entire point of a pipeline that needs no human. Measured on one install: three
// consecutive `plan` runs of the same request died at 16, 20 and 10 minutes with `exited 1`
// and an empty stderr, the reason — `API Error: Your computer went to sleep mid-response` —
// sitting in the stdout this script used to throw away; the same request run by hand
// finished in nine. `-i` blocks idle sleep, `-s` keeps that true on AC power — and only
// there: its man page scopes it to AC, and on battery `-i` alone was measured not to hold.
// Two runs on one install died mid-response with `Entering Sleep state due to 'Idle
// Sleep' ... Using Batt` in the system log at the minute each child died; the next run,
// identical but for `-d`, saw no sleep event at all. So the display is held awake too,
// for the length of every agent call — a real cost, paid because the failure it prevents
// destroys a run already paid for. Nothing here survives the lid closing, and nothing in
// a userland process can.
const AWAKE = process.platform === 'darwin' && existsSync('/usr/bin/caffeinate')
  ? '/usr/bin/caffeinate'
  : null

// The Windows half of the same promise. `caffeinate` is a macOS binary, so on win32 the block
// above resolves to null and every agent call ran with no protection at all. Measured on one
// install: `powercfg /query … STANDBYIDLE` reads 0 on AC and 600 seconds on battery — the same
// ten-minute idle sleep that killed three runs and $7.58 on the macOS install.
//
// Windows has no caffeinate and no wrapper binary to launch the child through. What it has is
// `SetThreadExecutionState`, which holds for as long as the thread that called it lives — so the
// hold is a process rather than a wrapper: a hidden PowerShell that raises ES_CONTINUOUS |
// ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED and then waits. It is started before the child and
// killed after it, and it also watches this script's PID and exits on its own when that process
// is gone, because a hold that outlives an aborted run would keep the machine awake until
// someone noticed it in Task Manager. The display is held for the same reason `-d` went into
// the caffeinate flags. Same residual as on macOS: nothing here survives the lid closing.
//
// `0x80000003L` carries its `L` because the first version did not, and the probe that proved it
// caught the whole mechanism doing nothing: PowerShell reads `0x80000000` as a signed Int32, the
// cast to the API's `uint` throws, and the hold process then sat in its wait loop with no hold
// raised — alive, visible in Task Manager, and useless. A non-zero return is the API saying it
// took the flags; zero is a failure, and the process exits 1 rather than wait for nothing.
const AWAKE_PS = [
  'Add-Type -Name Awake -Namespace Caw -MemberDefinition ' +
    "'[DllImport(\"kernel32.dll\", SetLastError = true)] " +
    "public static extern uint SetThreadExecutionState(uint flags);';",
  'if ([Caw.Awake]::SetThreadExecutionState([uint32]0x80000003L) -eq 0) { exit 1 };',
  'while (Get-Process -Id $PID_PARENT -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20 }',
].join(' ')

function holdAwake() {
  if (process.platform !== 'win32') return null
  try {
    const child = spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', AWAKE_PS.replace('$PID_PARENT', String(process.pid))],
      { stdio: 'ignore', windowsHide: true },
    )
    // A hold that cannot be raised is not worth failing a run over: the child call is the
    // thing being protected, and losing the protection costs a rerun, while refusing to
    // start costs the run itself.
    child.on('error', () => {})
    // Unreferenced so this script's own exit is never delayed by it. `die` exits the process
    // outright, which is exactly the path where the `finally` in agent() does not get to kill
    // the hold — the PID watchdog inside it is what closes that case, within twenty seconds.
    child.unref()
    return child
  } catch {
    return null
  }
}

// Three caps, because three different things go wrong. A plan round is two model calls and
// no code; a task's review round writes code and runs the whole gate; a red gate is not a
// round of anything — it is the executor being handed a fact. The plan loop also stops early
// when a round closes no holes: a cap protects against too few tries, and nothing protects
// against a stuck loop except noticing it made no progress.
//
// Gate retries are counted apart from review rounds, and that split is a fix rather than a
// preference. Under one shared cap of 2, a task whose gate went red once had its entire
// review budget spent before any reviewer saw the code: the second attempt's `revise` had
// nowhere to go, and the task died at the human over a defect a third attempt would have
// closed. A red gate is cheap to state and cheap to fix; a rejected review is the expensive
// one. They should not share a purse.
//
// MAX_PLAN_ROUNDS is 3 on one project's measurement, not on taste: three planning attempts
// for one infrastructure run went 4 holes -> 1, 3 -> 1, each time converging on a single
// survivor and hitting the cap rather than stalling. One project, infrastructure work only.
//
// The no-progress guard is back, on the TASK loop only, and this is a decision `TODO.md`
// records as weighed and refused — so it is reopened here rather than forgotten. What was
// refused: "giving a finding an identity, so a repeat can be told from a new hole … an
// addition that buys an early exit nobody has needed." That weighing is still correct for
// what it priced. The most a guard can buy on the PLAN loop is one saved round against a cap
// that already bounds it, because whatever the loop does next, a human is not in it.
//
// What is different here is not the guard, it is what sits after it. A task loop that stops
// hands the work to a person, and that person's question is "another round, or my own hands?"
// — which cannot be answered from a count. Identity is what turns "3 findings again" into
// "2 closed, 1 still open, 0 new", and those two lines lead to opposite answers. So the
// purchase is not an early exit; it is a decidable question at the exit that already existed.
// Priced on the run that motivated it: answering it by hand, against one Python install's own
// log, took a session re-reading the tree to establish that all five round-1 items were long
// closed — a fact the round-2 verdict did not carry because nothing had asked it to.
//
// It fires only from round 2 (round 1 has nothing carried, so "closed nothing" is vacuous)
// and only on the carried set. A round that closes 3 of 5 and raises 4 new ones is progress
// and does not trip it — whether those 4 are worth a fifth round is exactly the human's call,
// and they are shown as a separate line for that reason.
const MAX_PLAN_ROUNDS = 3
// Was 2, and 2 was the number a task DIED at. It is now the number of rounds a task runs
// before the run stops to ask, and the task does not die at it: the tree, the spec and every
// open item are kept, and `round` or `review` picks the task up exactly where this left it. So
// the cap stopped being a verdict on the task and became a money guard — a loop closing one
// item of twenty per round would otherwise run twenty rounds at $1.3-3 each, unwatched.
//
// 4 rather than 2 because the loop it bounds is a different loop: with `carried` the reviewer
// judges what it asked for last time instead of redrawing, so a round now has a floor on what
// it can achieve, which is what makes a fourth worth paying for. The measurement it replaces is
// that same install — two rounds, $4.88, five substantive items closed and three fresh ones
// raised, stopped at the cap with the task one hand-edit from done.
const MAX_TASK_ROUNDS = 4 // rounds a task runs before the run stops and asks the human
const DEFAULT_REVIEW_CHALLENGER_PASSES = 1
const MAX_REVIEW_CHALLENGER_PASSES = 2
const MAX_REVIEW_SEMANTIC_REPAIRS = 1
const MAX_GATE_RETRIES = 2 // executor retries after a provider-free red confirmation
const TASK_DOSSIER_TOTAL_MAX = 192 * 1024
const TASK_DOSSIER_CAPS = Object.freeze({
  spec: 32 * 1024,
  contract: 24 * 1024,
  profile: 24 * 1024,
  open_findings: 32 * 1024,
  gate_evidence: 24 * 1024,
  executor_claims: 24 * 1024,
  acceptance_cases: 24 * 1024,
  changed_files: 12 * 1024,
  diff: 64 * 1024,
})
const GATE_EVIDENCE_MANIFEST_MAX = 1024 * 1024
const GATE_EVIDENCE_CHECKS_MAX = 128
const GATE_EVIDENCE_ARTIFACTS_MAX = 32
const GATE_EVIDENCE_ARTIFACT_MAX = 16 * 1024 * 1024
const GATE_EVIDENCE_ARTIFACTS_TOTAL_MAX = 64 * 1024 * 1024
const GATE_EVIDENCE_OUTPUT_MAX = 1024 * 1024

const GateFailureAction = Object.freeze({
  confirm: 'confirm',
  executor: 'executor',
  stopReview: 'stop-review',
  stopRetries: 'stop-retries',
})

function decideGateFailure({
  reviewOnly,
  confirmationRuns,
  executorRetries,
  maxExecutorRetries,
}) {
  for (const [name, value] of Object.entries({
    confirmationRuns,
    executorRetries,
    maxExecutorRetries,
  })) {
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative integer`)
    }
  }
  if (typeof reviewOnly !== 'boolean') throw new TypeError('reviewOnly must be a boolean')

  if (confirmationRuns === 0) return GateFailureAction.confirm
  if (reviewOnly) return GateFailureAction.stopReview
  if (executorRetries >= maxExecutorRetries) return GateFailureAction.stopRetries
  return GateFailureAction.executor
}

const PlanningAction = Object.freeze({
  architect: 'architect',
  stopRequest: 'stop-request',
})

function decidePlanningAction(requestIssues) {
  if (!Array.isArray(requestIssues)) throw new TypeError('requestIssues must be an array')
  return requestIssues.length ? PlanningAction.stopRequest : PlanningAction.architect
}

function canonicalAuthorityPaths(profileText) {
  if (typeof profileText !== 'string') throw new TypeError('profileText must be a string')
  const heading = profileText.match(/^## Canonical docs\s*$/m)
  const tail = heading ? profileText.slice(heading.index + heading[0].length) : ''
  const nextHeading = tail.search(/^##\s/m)
  const section = nextHeading === -1 ? tail : tail.slice(0, nextHeading)
  const paths = new Set(['.caw/CAW.md'])
  for (const line of section.split('\n')) {
    const match = line.match(/^\s*-\s+(?:`([^`]+)`|\[[^\]]+\]\(([^)]+)\)|(\S+))/)
    const path = match && (match[1] || match[2] || match[3])
    if (path && !/^[a-z]+:\/\//i.test(path)) paths.add(path)
  }
  return paths
}

const REVIEW_CRITERION_SECTIONS = new Map([
  ['must cover', { label: 'Must cover', prefix: 'must-cover' }],
  ['change', { label: 'Change', prefix: 'change' }],
  ['done when', { label: 'Done when', prefix: 'done-when' }],
])

function extractReviewCriteria(spec) {
  if (typeof spec !== 'string') throw new TypeError('spec must be a string')
  const found = []
  const counts = new Map()
  let section = null
  let pending = null

  const flush = () => {
    if (!pending) return
    const count = (counts.get(section.prefix) || 0) + 1
    counts.set(section.prefix, count)
    found.push({
      id: `${section.prefix}-${count}`,
      section: section.label,
      criterion: pending.trim(),
    })
    pending = null
  }

  for (const line of spec.replace(/\r\n|\r/g, '\n').split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      flush()
      section = REVIEW_CRITERION_SECTIONS.get(heading[1].trim().toLowerCase()) || null
      continue
    }
    if (!section) continue
    const bullet = line.match(/^\s*-\s+(.+?)\s*$/)
    if (bullet) {
      flush()
      pending = bullet[1]
      continue
    }
    if (pending && line.trim()) pending += ` ${line.trim()}`
    else if (!line.trim()) flush()
  }
  flush()
  return found
}

function extractTaskTopology(spec) {
  const surfaces = []
  const transitions = []
  let section = ''
  let surface = null
  for (const line of String(spec || '').split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      section = heading[1].trim().toLowerCase()
      surface = null
      continue
    }
    if (section === 'surfaces') {
      const match = line.match(/^\s*-\s+`([^`]+)`\s+[—-]\s+(.+?)\s*$/)
      if (match) surfaces.push({ id: match[1], responsibility: match[2] })
      continue
    }
    if (section !== 'state machines') continue
    const machine = line.match(/^\s*-\s+`([^`]+)`:\s+states\s+(.+?)\s*$/)
    if (machine) {
      surface = machine[1]
      continue
    }
    const transition = line.match(/^\s+-\s+`([^`]+)`\s+--\s*(.+?)\s*-->\s*`([^`]+)`\s*$/)
    if (!transition || !surface) continue
    const row = { surface, from: transition[1], event: transition[2], to: transition[3] }
    transitions.push({
      id: `transition-${createHash('sha256').update(stableJson(row)).digest('hex').slice(0, 12)}`,
      ...row,
    })
  }
  return { criteria: extractReviewCriteria(spec), surfaces, transitions }
}

function buildTaskDossier({
  spec = '', profile = '', open = [], files = [], diff = '', gateEvidence = null,
  executorClaims = [], acceptanceCases = [],
} = {}) {
  const topology = extractTaskTopology(spec)
  const values = {
    spec,
    contract: stableJson(topology),
    profile,
    open_findings: stableJson({ work_packages: groupFindings(open) }),
    gate_evidence: stableJson(gateEvidence),
    executor_claims: stableJson(executorClaims),
    acceptance_cases: stableJson(acceptanceCases),
    changed_files: files.join('\n'),
    diff,
  }
  const labels = {
    spec: 'Task spec', contract: 'Structured task contract', profile: 'Project profile',
    open_findings: 'Open findings', gate_evidence: 'Engine-owned gate evidence',
    executor_claims: 'Untrusted executor claims', acceptance_cases: 'Project acceptance cases',
    changed_files: 'Changed files', diff: 'Bounded delivery diff',
  }
  const sections = []
  const rendered = []
  for (const name of Object.keys(TASK_DOSSIER_CAPS)) {
    const source = String(values[name] ?? '')
    const bounded = boundedUtf8(source, TASK_DOSSIER_CAPS[name])
    const included = Buffer.byteLength(bounded.text)
    sections.push({
      name,
      source_bytes: Buffer.byteLength(source),
      included_bytes: included,
      truncated: bounded.truncated,
      sha256: createHash('sha256').update(source).digest('hex'),
    })
    rendered.push(`## ${labels[name]}\n\n${bounded.text || '(none)'}` +
      (bounded.truncated ? `\n\n[truncated at ${TASK_DOSSIER_CAPS[name]} bytes]` : ''))
  }
  const header = 'Task dossier generated by CAW. Sections are bounded starting context; ' +
    'repository reads remain available for checks the dossier cannot settle.\n\n'
  const sourceText = header + rendered.join('\n\n')
  const totalMarker = `\n\n[dossier truncated at ${TASK_DOSSIER_TOTAL_MAX} bytes]`
  const total = Buffer.byteLength(sourceText) > TASK_DOSSIER_TOTAL_MAX
    ? boundedUtf8(sourceText, TASK_DOSSIER_TOTAL_MAX - Buffer.byteLength(totalMarker))
    : { text: sourceText, truncated: false }
  return {
    text: total.text + (total.truncated ? totalMarker : ''),
    meta: {
      version: 1,
      total_source_bytes: Buffer.byteLength(sourceText),
      total_included_bytes: Buffer.byteLength(total.text) +
        (total.truncated ? Buffer.byteLength(totalMarker) : 0),
      total_truncated: total.truncated,
      sections,
    },
    topology,
  }
}

function renderReviewCriteria(spec, additional = []) {
  const criteria = [...extractReviewCriteria(spec), ...additional]
  return criteria.length
    ? criteria.map((item) => `- ${item.id} [${item.section}] ${item.criterion}`).join('\n')
    : '(none — this spec has no Must cover, Change, or Done when bullets)'
}

function reviewCriteriaIssue(spec, rows, verdict, additional = [], priorOpen = []) {
  if (!Array.isArray(rows)) return 'criteria must be an array'
  const expected = [...extractReviewCriteria(spec), ...additional]
  const byId = new Map(expected.map((item) => [item.id, item]))
  const seen = new Set()

  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return 'every criteria row must be an object'
    }
    if (seen.has(row.id)) return `duplicate criterion id ${JSON.stringify(row.id)}`
    if (!byId.has(row.id)) return `unknown criterion id ${JSON.stringify(row.id)}`
    if (typeof row.evidence !== 'string' || !row.evidence.trim()) {
      return `${row.id} has empty evidence`
    }
    seen.add(row.id)
  }

  const missing = expected.filter((item) => !seen.has(item.id)).map((item) => item.id)
  if (missing.length) return `missing criterion id(s): ${missing.join(', ')}`

  const slotForState = { broken: 'broken', uncovered: 'uncovered', weak: 'weak' }
  const carriedById = new Map((verdict?.carried || []).map((item) => [item?.id, item]))
  for (const row of rows) {
    if (row.state === 'met') continue
    const criterion = byId.get(row.id).criterion
    const slot = slotForState[row.state]
    const items = verdict?.[slot]
    const newItemQuotes = Array.isArray(items) &&
      items.some((item) => item?.evidence?.includes(criterion))
    const openCarriedQuotes = priorOpen.some((item) => {
      const disposition = carriedById.get(item?.id)
      return disposition?.state === 'open' &&
        [item?.evidence, disposition?.evidence].some((evidence) => evidence?.includes(criterion))
    })
    if (!newItemQuotes && !openCarriedQuotes) {
      return `${row.id} is ${row.state} but no ${slot} item quotes its exact criterion`
    }
  }

  for (const item of verdict?.uncovered || []) {
    if (!expected.some((criterion) => item?.evidence?.includes(criterion.criterion))) {
      return 'an uncovered item does not quote any exact Must cover, Change, or Done when criterion'
    }
  }
  return null
}

function evidenceRefIssue(ref, sources) {
  if (typeof ref !== 'string' || !ref.length || Buffer.byteLength(ref) > 2048) {
    return 'evidence reference must be a non-empty string of at most 2048 bytes'
  }
  const [kind, value] = ref.split(/:(.*)/s, 2)
  if (!value) return `invalid evidence reference ${JSON.stringify(ref)}`
  const known = {
    'gate-receipt': sources.receipts,
    'gate-check': sources.checks,
    'gate-artifact': sources.artifacts,
    'executor-claim': sources.claims,
  }
  if (known[kind]) {
    if (!known[kind].has(value)) return `unknown ${kind} evidence reference ${value}`
    return null
  }
  if (kind === 'repository') {
    if (isAbsolute(value) || value.includes('\\') || value.split('/').some((part) =>
      part === '..' || part === '.')) {
      return `unsafe repository evidence reference ${value}`
    }
    return null
  }
  if (kind === 'review-experiment' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    return null
  }
  return `unsupported evidence reference kind ${kind}`
}

function reviewContractIssue(verdict, { criteria = [], surfaces = [], transitions = [],
  receipt = null, claims = [] } = {}) {
  const criterionIds = new Set(criteria.map((row) => row.id))
  const surfaceIds = new Set(surfaces.map((row) => row.id))
  const transitionById = new Map(transitions.map((row) => [row.id, row]))
  const sources = {
    receipts: new Set(receipt?.receipt_id ? [receipt.receipt_id] : []),
    checks: new Set((receipt?.manifest?.checks || []).map((row) => row.id)),
    artifacts: new Set((receipt?.artifacts || []).map((row) => row.id)),
    claims: new Set(claims.map((row) => row.id)),
  }
  const checkRefs = (refs, label, requireTrusted = false) => {
    if (!Array.isArray(refs) || !refs.length) return `${label} has no evidence_refs`
    if (new Set(refs).size !== refs.length) return `${label} has duplicate evidence_refs`
    for (const ref of refs) {
      const issue = evidenceRefIssue(ref, sources)
      if (issue) return `${label}: ${issue}`
    }
    if (requireTrusted && refs.every((ref) => ref.startsWith('executor-claim:'))) {
      return `${label} relies only on untrusted executor claims`
    }
    return null
  }
  for (const row of verdict.criteria || []) {
    const issue = checkRefs(row.evidence_refs, `criterion ${row.id}`, row.state === 'met')
    if (issue) return issue
  }
  for (const row of verdict.carried || []) {
    const issue = checkRefs(row.evidence_refs, `carried finding ${row.id}`)
    if (issue) return issue
  }
  for (const slot of SLOTS) {
    for (const [index, item] of (verdict[slot] || []).entries()) {
      const label = `${slot}[${index}]`
      if (!/^[a-z][a-z0-9.-]{0,127}$/.test(item.property_key)) {
        return `${label} has invalid property_key`
      }
      for (const [name, values] of Object.entries({
        criterion_ids: item.criterion_ids,
        surface_ids: item.surface_ids,
        transition_ids: item.transition_ids,
      })) {
        if (new Set(values).size !== values.length) return `${label} has duplicate ${name}`
      }
      if (criterionIds.size && !item.criterion_ids.length) {
        return `${label} is not linked to a criterion`
      }
      for (const id of item.criterion_ids) {
        if (!criterionIds.has(id)) return `${label} names unknown criterion ${id}`
      }
      for (const id of item.surface_ids) {
        if (!surfaceIds.has(id)) return `${label} names unknown surface ${id}`
      }
      for (const id of item.transition_ids) {
        const transition = transitionById.get(id)
        if (!transition) return `${label} names unknown transition ${id}`
        if (!item.surface_ids.includes(transition.surface)) {
          return `${label} does not include surface ${transition.surface} for transition ${id}`
        }
      }
      const issue = checkRefs(item.evidence_refs, label)
      if (issue) return issue
    }
  }
  return null
}

function bindFindingCriteria(verdict, criteria) {
  const byId = new Map(criteria.map((row) => [row.id, row]))
  for (const slot of SLOTS) {
    for (const item of verdict[slot] || []) {
      if (item.criterion_ids?.length) continue
      item.criterion_ids = (verdict.criteria || []).filter((row) =>
        row.state === slot && item.evidence.includes(byId.get(row.id)?.criterion || '\0'))
        .map((row) => row.id)
    }
  }
  return verdict
}

function findingGroupSignature(item) {
  if (!item?.property_key) return `legacy:${item?.id || createHash('sha256').update(stableJson(item)).digest('hex')}`
  return stableJson({
    property_key: item.property_key,
    criterion_ids: [...(item.criterion_ids || [])].sort(),
    surface_ids: [...(item.surface_ids || [])].sort(),
    transition_ids: [...(item.transition_ids || [])].sort(),
  })
}

function groupFindings(items = []) {
  const groups = new Map()
  for (const item of items) {
    const signature = findingGroupSignature(item)
    if (!groups.has(signature)) {
      groups.set(signature, {
        id: `wp-${createHash('sha256').update(signature).digest('hex').slice(0, 12)}`,
        property_key: item.property_key || null,
        criterion_ids: [...(item.criterion_ids || [])].sort(),
        surface_ids: [...(item.surface_ids || [])].sort(),
        transition_ids: [...(item.transition_ids || [])].sort(),
        members: [],
      })
    }
    groups.get(signature).members.push(item)
  }
  return [...groups.values()]
}

// A hung child used to block a run forever: `spawnSync` was called with no timeout at all.
// Thirty minutes is roughly three times the longest call ever observed here — measured across
// two installs, where a role takes 300-550s and the median is about 390 — and the asymmetry
// says to be generous. Killing a slow-but-live call throws away its money AND its round, while
// being late to kill a hung one costs wall time nobody is watching anyway.
//
// What is NOT measured is the maximum a legitimate call can take: the logs give an average per
// call within a run, never the longest single one. So this is "three times the largest thing
// seen", not "twice the worst case". What would settle it is the longest single legitimate
// call across a run, which nothing records today; until something does, this number is a
// guess with a stated basis rather than a measurement.
//
// Gate timeouts live in the project profile. How long a suite runs is a property of the project
// — one install measures 3:20, another's is seconds — so the engine does not invent a default.
// When configured, a timeout is its own state: the gate was killed before it produced a verdict,
// which is neither red nor the gate's explicit exit-75 refusal.
//
// The override is an environment variable and NOT a profile field, and the distinction is the
// one drawn just above. A suite's duration is a property of the project, so it would belong in
// `.caw/CAW.md`. This cap is not: the one live firing was an architect on a queue that had
// grown to sixteen specs, on an install whose earlier rounds against the same plan finished
// inside it — so what varies is the queue and the role, not the project. A profile field would
// have to be set for the worst role at the worst queue, which is high enough to stop guarding
// the executor, and every new install would owe an opinion about a number nobody can defend.
//
// It exists mainly as an instrument. The observation that would settle the constant is a
// re-run of a killed call that then succeeds, and taking it used to require editing this file
// — which breaks the byte-identity every install checks its version by. The measurement was
// blocked by the thing that makes installs verifiable.
const AGENT_TIMEOUT_DEFAULT_MS = 30 * 60 * 1000
const GATE_TIMEOUT_MAX_MS = 2_147_483_647
const AGENT_TIMEOUT_MS = (() => {
  const raw = process.env.CAW_AGENT_TIMEOUT_MS
  if (raw === undefined || raw.trim() === '') return AGENT_TIMEOUT_DEFAULT_MS
  const ms = Number(raw)
  // Refuse rather than fall back to the default. A silent fallback is a value that says one
  // thing and does another, which is the defect class this tool exists to catch.
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    console.error(`\ncaw: CAW_AGENT_TIMEOUT_MS must be a positive whole number of milliseconds` +
                  ` — got "${raw}"\n`)
    process.exit(1)
  }
  return ms
})()
const formatTimeout = (ms) => ms % 60000 === 0 ? `${ms / 60000} min` : `${ms} ms`

const ACCOUNTING_COUNTERS = [
  'calls', 'inputTokens', 'outputTokens', 'cachedReadTokens', 'cachedWrittenTokens',
  'reasoningTokens',
]

const zeroAccounting = () => ({ priced: {}, unpriced: {} })

function normalizeAccounting(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { priced: { USD: value }, unpriced: {}, legacy: true }
  }
  const out = zeroAccounting()
  for (const [currency, amount] of Object.entries(value?.priced || {})) {
    if (typeof amount === 'number' && Number.isFinite(amount)) out.priced[currency] = amount
  }
  for (const [provider, counters] of Object.entries(value?.unpriced || {})) {
    out.unpriced[provider] = {}
    for (const counter of ACCOUNTING_COUNTERS) {
      const observed = counters?.[counter]
      out.unpriced[provider][counter] = typeof observed === 'number' && Number.isFinite(observed)
        ? observed
        : null
    }
  }
  if (value?.legacy) out.legacy = true
  return out
}

function addAccounting(left, right) {
  const a = normalizeAccounting(left), b = normalizeAccounting(right), out = zeroAccounting()
  for (const currency of new Set([...Object.keys(a.priced), ...Object.keys(b.priced)])) {
    out.priced[currency] = (a.priced[currency] || 0) + (b.priced[currency] || 0)
  }
  for (const provider of new Set([...Object.keys(a.unpriced), ...Object.keys(b.unpriced)])) {
    out.unpriced[provider] = {}
    const hasA = Object.prototype.hasOwnProperty.call(a.unpriced, provider)
    const hasB = Object.prototype.hasOwnProperty.call(b.unpriced, provider)
    for (const counter of ACCOUNTING_COUNTERS) {
      const av = hasA ? a.unpriced[provider][counter] : 0
      const bv = hasB ? b.unpriced[provider][counter] : 0
      out.unpriced[provider][counter] = typeof av === 'number' && typeof bv === 'number'
        ? av + bv
        : null
    }
  }
  if (a.legacy || b.legacy) out.legacy = true
  return out
}

function deltaAccounting(after, before) {
  const a = normalizeAccounting(after), b = normalizeAccounting(before), out = zeroAccounting()
  for (const currency of new Set([...Object.keys(a.priced), ...Object.keys(b.priced)])) {
    out.priced[currency] = (a.priced[currency] || 0) - (b.priced[currency] || 0)
  }
  for (const provider of new Set([...Object.keys(a.unpriced), ...Object.keys(b.unpriced)])) {
    out.unpriced[provider] = {}
    const hasA = Object.prototype.hasOwnProperty.call(a.unpriced, provider)
    const hasB = Object.prototype.hasOwnProperty.call(b.unpriced, provider)
    for (const counter of ACCOUNTING_COUNTERS) {
      const av = hasA ? a.unpriced[provider][counter] : 0
      const bv = hasB ? b.unpriced[provider][counter] : 0
      out.unpriced[provider][counter] = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : null
    }
  }
  return out
}

function formatAccounting(value) {
  const account = normalizeAccounting(value)
  const money = Object.entries(account.priced)
    .filter(([, amount]) => amount !== 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => currency === 'USD' ? `$${amount.toFixed(2)}` : `${currency} ${amount.toFixed(2)}`)
  const unpriced = Object.entries(account.unpriced)
    .filter(([, counters]) => (counters.calls || 0) > 0)
    .sort(([a], [b]) => a.localeCompare(b))
  if (!unpriced.length) return money.join(' + ') || '$0.00'
  const floor = money.join(' + ') || '$0.00'
  const rest = unpriced.map(([provider, counters]) =>
    `${counters.calls} unpriced ${provider[0].toUpperCase()}${provider.slice(1)} call${counters.calls === 1 ? '' : 's'}`)
  return `at least ${floor}, plus ${rest.join(' and ')}`
}

const hasAccounting = (value) => {
  const account = normalizeAccounting(value)
  return Object.values(account.priced).some((amount) => amount !== 0) ||
    Object.values(account.unpriced).some((counters) => (counters.calls || 0) > 0)
}

function callAccounting(provider, cost, used) {
  if (cost) return { priced: { [cost.currency]: cost.amount }, unpriced: {} }
  const tokens = (value) => typeof value === 'number' ? value : null
  return { priced: {}, unpriced: { [provider]: {
    calls: 1,
    inputTokens: tokens(used.input),
    outputTokens: tokens(used.output),
    cachedReadTokens: tokens(used.cacheRead),
    cachedWrittenTokens: tokens(used.cacheWrite),
    reasoningTokens: tokens(used.thinking),
  } } }
}

let accounting = zeroAccounting()

// Collected from every executor and printed once at the end of the run — including when the
// run dies, which is when they matter most. These were threaded through `build` and printed
// only on the success path, so a task that failed its last round silently took with it every
// note the whole run had gathered. Module-level for the same reason `accounting` is: `die` must
// reach it.
//
// Printing is no longer the only record. A committed task carries its own notes in its commit
// message; a run that dies appends everything gathered to `.caw-tasks/notes.log`. This array stays
// the run-wide accumulator both of those draw from.
const notes = []

// An install is a vendored copy, so the version an operator can state is the tag this file
// was taken at. It is printed, never enforced: byte-identity against the tag is the check.
const VERSION = '0.2.0-dev'
const ROLES = ['architect', 'enumerator', 'plan-reviewer', 'executor', 'reviewer']
const REASONING = new Set(['low', 'medium', 'high', 'max'])
const PROVIDER_BUDGET_DEFAULTS = Object.freeze({
  request: 256,
  planning: 16,
  task: 16,
  unknownCost: 256,
  role: 128,
})

function resolveProviderBudgets(fields = {}) {
  const read = (key, fallback) => {
    const raw = fields[key]
    if (raw === undefined || raw === '') return fallback
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${key} must be a positive whole number`)
    }
    return value
  }
  return {
    request_calls: read('budget_request_calls', PROVIDER_BUDGET_DEFAULTS.request),
    planning_calls: read('budget_planning_calls', PROVIDER_BUDGET_DEFAULTS.planning),
    task_calls: read('budget_task_calls', PROVIDER_BUDGET_DEFAULTS.task),
    unknown_cost_calls: read('budget_unknown_cost_calls', PROVIDER_BUDGET_DEFAULTS.unknownCost),
    role_calls: Object.fromEntries(ROLES.map((role) => [role,
      read(`budget_${role.replaceAll('-', '_')}_calls`, PROVIDER_BUDGET_DEFAULTS.role)])),
  }
}

let providerBudgetState = {
  command: null,
  phase: null,
  task: null,
  request_calls: 0,
  planning_calls: 0,
  task_calls: 0,
  unknown_cost_calls: 0,
  role_calls: Object.fromEntries(ROLES.map((role) => [role, 0])),
  limits: null,
}

function providerBudgetSnapshot() {
  return {
    command: providerBudgetState.command,
    phase: providerBudgetState.phase,
    task: providerBudgetState.task,
    limits: providerBudgetState.limits,
    consumed: {
      request_calls: providerBudgetState.request_calls,
      planning_calls: providerBudgetState.planning_calls,
      task_calls: providerBudgetState.task_calls,
      unknown_cost_calls: providerBudgetState.unknown_cost_calls,
      role_calls: { ...providerBudgetState.role_calls },
    },
  }
}

function setProviderBudgetPhase(phase, task = null) {
  providerBudgetState.phase = phase
  if (task !== providerBudgetState.task) {
    providerBudgetState.task = task
    providerBudgetState.task_calls = 0
  }
}

function providerBudgetIssue(role, limits) {
  const checks = [
    ['budget_request_calls', providerBudgetState.request_calls, limits.request_calls],
    ...(providerBudgetState.phase === 'planning'
      ? [['budget_planning_calls', providerBudgetState.planning_calls, limits.planning_calls]] : []),
    ...(providerBudgetState.task
      ? [['budget_task_calls', providerBudgetState.task_calls, limits.task_calls]] : []),
    [`budget_${role.replaceAll('-', '_')}_calls`, providerBudgetState.role_calls[role],
      limits.role_calls[role]],
    ['budget_unknown_cost_calls', providerBudgetState.unknown_cost_calls,
      limits.unknown_cost_calls],
  ]
  const reached = checks.find(([, used, limit]) => used >= limit)
  return reached
    ? `${reached[0]} reached (${reached[1]}/${reached[2]}); no ${role} provider call was started`
    : null
}

function reserveProviderBudget(role, limits) {
  const issue = providerBudgetIssue(role, limits)
  if (issue) throw new Error(issue)
  providerBudgetState.limits = limits
  providerBudgetState.request_calls += 1
  if (providerBudgetState.phase === 'planning') providerBudgetState.planning_calls += 1
  if (providerBudgetState.task) providerBudgetState.task_calls += 1
  providerBudgetState.role_calls[role] += 1
}

function settleProviderBudget(attempt, cost) {
  if (attempt.budgetSettled) return
  attempt.budgetSettled = true
  if (cost === null || cost === undefined) providerBudgetState.unknown_cost_calls += 1
}
const LEGACY_RUNTIME_FIELDS = [
  'model_architect', 'model_executor', 'model_reviewer', 'effort', 'permission_mode',
]
let resolvedRuntime = null
let runtimeResidualsPrinted = false
const adapters = new Map()
const valueRuntime = new WeakMap()
const runtimeIdentity = (value) => value && typeof value === 'object' ? valueRuntime.get(value) || null : null

// Provider paths are data, never shell source. JavaScript CLIs need an explicit Node launcher on
// every host (and on Windows have no shebang mechanism at all); command scripts need a shell, which
// CAW deliberately does not introduce. `platformName` is explicit so the refusal is testable away
// from Windows rather than becoming another host-only branch nobody exercises.
function providerLaunch(executable, platformName = process.platform, providerId = 'provider') {
  if (typeof executable !== 'string' || !executable) {
    throw new Error('provider executable must be a non-empty path')
  }
  if (platformName === 'win32' && /\.(?:cmd|bat|ps1)$/i.test(executable)) {
    const variable = `CAW_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
    throw new Error(`provider command script ${JSON.stringify(executable)} is intentionally not` +
      ` launched on Windows because it requires a shell. Point ${variable} at a native` +
      ' executable instead (for example, the provider .exe).')
  }
  return /\.(?:js|mjs)$/i.test(executable)
    ? { executable: process.execPath, leadingArgs: [executable] }
    : { executable, leadingArgs: [] }
}

const ADAPTER_KEYS = [
  'apiVersion', 'id', 'vendor', 'features', 'resolveExecutable', 'versionInvocation',
  'mechanismAvailable', 'verifyGuaranteeProbe', 'describe', 'buildInvocation', 'buildProbeInvocation',
  'decodeSuccess', 'decodeFailure',
]
const PROBE_ATTESTATION_MAX = 64 * 1024
const PROBE_REASON_MAX = 8 * 1024
const PROBE_REASON_VALUE_MAX = 3 * 1024
const PROBE_REASON_SUMMARY_MAX = 320
const PROBE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

async function discoverAdapters() {
  const root = resolve('.caw/adapters')
  if (!existsSync(root)) die('missing CAW-owned adapter directory .caw/adapters')
  const canonicalRoot = realpathSync(root)
  for (const name of readdirSync(root).sort()) {
    const directory = join(root, name)
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue
    const modulePath = join(directory, 'adapter.mjs')
    if (!existsSync(modulePath) || !inside(canonicalRoot, realpathSync(modulePath))) {
      die(`adapter ${name} is missing its trusted adapter.mjs`)
    }
    const source = readFileSync(modulePath)
    const digest = createHash('sha256').update(source).digest('hex')
    let adapter
    try { adapter = (await import(`${pathToFileURL(modulePath).href}?sha256=${digest}`)).default }
    catch (error) { die(`adapter ${name} failed to load: ${error?.message || error}`) }
    if (!adapter || typeof adapter !== 'object') die(`adapter ${name} has no default contract object`)
    const extra = Object.keys(adapter).filter((key) => !ADAPTER_KEYS.includes(key))
    const missing = ADAPTER_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(adapter, key))
    const versionMismatch = adapter.apiVersion !== 3
    if (extra.length || missing.length || versionMismatch || adapter.id !== name) {
      die(`adapter ${name} has malformed contract` +
        `${versionMismatch ? `; API version is ${JSON.stringify(adapter.apiVersion)}, expected 3` : ''}` +
        `${missing.length ? `; missing ${missing.join(', ')}` : ''}` +
        `${extra.length ? `; unknown ${extra.join(', ')}` : ''}`)
    }
    if (typeof adapter.vendor !== 'string' || !/^[a-z][a-z0-9.-]{0,63}$/.test(adapter.vendor)) {
      die(`adapter ${name}.vendor must be a stable lowercase vendor id`)
    }
    for (const fn of ADAPTER_KEYS.filter((key) =>
      !['apiVersion', 'id', 'vendor', 'features'].includes(key))) {
      if (typeof adapter[fn] !== 'function') die(`adapter ${name}.${fn} must be a function`)
    }
    if (adapters.has(name)) die(`duplicate adapter id ${name}`)
    adapters.set(name, { ...adapter, digest, directory: realpathSync(directory) })
  }
}

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function runtimeMigration(f) {
  const model = (role) => role === 'architect' ? f.model_architect
    : role === 'executor' ? f.model_executor : f.model_reviewer
  return {
    version: 1,
    roles: Object.fromEntries(ROLES.map((role) => [role, {
      provider: 'claude', model: model(role) || '', reasoning: f.effort || 'high',
    }])),
  }
}

function loadRuntime(f) {
  const runtimePath = '.caw/runtime.json'
  if (!existsSync(runtimePath)) {
    const migration = runtimeMigration(f)
    die(`${runtimePath} is required. CAW will not execute a derived runtime.\n` +
      '  Copy this migration starting point, then make five explicit role decisions; repeated\n' +
      '  reviewer models preserve legacy execution but do not decide the enumerator binding:\n\n' +
      `${JSON.stringify(migration, null, 2)}`)
  }
  const legacy = LEGACY_RUNTIME_FIELDS.filter((key) => Object.prototype.hasOwnProperty.call(f, key))
  if (legacy.length) {
    die(`legacy runtime field(s) remain in .caw/CAW.md: ${legacy.join(', ')}\n` +
      `  Move all five role bindings to ${runtimePath}; legacy values are never fallback defaults.`)
  }
  let value
  try { value = JSON.parse(readFileSync(runtimePath, 'utf8')) }
  catch (error) { die(`${runtimePath} is not valid JSON: ${error?.message || error}`) }
  const exactKeys = (object, allowed, where) => {
    if (!object || typeof object !== 'object' || Array.isArray(object)) die(`${where} must be an object`)
    const extra = Object.keys(object).filter((key) => !allowed.includes(key))
    if (extra.length) die(`${where} has unknown field(s): ${extra.join(', ')}`)
  }
  exactKeys(value, ['version', 'roles'], runtimePath)
  if (value.version !== 1) die(`${runtimePath} version must be 1`)
  exactKeys(value.roles, ROLES, `${runtimePath}.roles`)
  const missing = ROLES.filter((role) => !Object.prototype.hasOwnProperty.call(value.roles, role))
  if (missing.length) die(`${runtimePath}.roles is missing: ${missing.join(', ')}`)
  for (const role of ROLES) {
    const row = value.roles[role]
    exactKeys(row, ['provider', 'model', 'reasoning'], `${runtimePath}.roles.${role}`)
    if (typeof row.provider !== 'string' || !row.provider.trim()) die(`${role}.provider must be nonempty`)
    if (typeof row.model !== 'string' || !row.model.trim()) die(`${role}.model must be nonempty`)
    if (!REASONING.has(row.reasoning)) {
      die(`${role}.reasoning must be one of: ${[...REASONING].join(', ')}`)
    }
  }
  const canonical = { version: 1, roles: Object.fromEntries(ROLES.map((role) =>
    [role, { ...value.roles[role] }])) }
  const digest = createHash('sha256').update(stableJson(canonical)).digest('hex')
  return { value: canonical, digest }
}

function canonicalExecutable(executable) {
  try {
    const path = isAbsolute(executable) ? executable
      : execFileSync('which', [executable], { encoding: 'utf8' }).trim()
    return realpathSync(path)
  } catch { return resolve(executable) }
}

function localProbeRoot() {
  try {
    return resolve(execFileSync('git', ['rev-parse', '--git-path', 'caw/probes'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim())
  } catch { return null }
}

function localRoleSmokeRoot() {
  try {
    return resolve(execFileSync('git', ['rev-parse', '--git-path', 'caw/role-smoke'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim())
  } catch { return null }
}

function engineDigest() {
  return createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')
}

function roleSmokeKey(role, binding, provider) {
  return {
    version: 1,
    role,
    provider: binding.provider,
    model: binding.model,
    reasoning: binding.reasoning,
    adapter_digest: provider.adapter.digest,
    cli_version: provider.cliVersion,
    executable: canonicalExecutable(provider.executable),
    engine_digest: engineDigest(),
  }
}

function currentRoleSmoke(role, binding, provider) {
  const root = localRoleSmokeRoot()
  if (!root) return null
  const path = join(root, `${role}.json`)
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > PROBE_ATTESTATION_MAX) return null
    const value = JSON.parse(readFileSync(path, 'utf8'))
    const key = roleSmokeKey(role, binding, provider)
    return value.green === true && Object.entries(key).every(([name, expected]) =>
      value[name] === expected) ? value : null
  } catch { return null }
}

function writeRoleSmoke(role, value) {
  const root = localRoleSmokeRoot()
  if (!root) die('role smoke evidence requires a Git repository')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const target = join(root, `${role}.json`)
  const temp = `${target}.tmp-${process.pid}`
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  if (bytes.length > PROBE_ATTESTATION_MAX) die('role smoke evidence exceeds its storage bound')
  writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' })
  renameSync(temp, target)
  try { chmodSync(root, 0o700); chmodSync(target, 0o600) } catch { /* POSIX modes unavailable */ }
  return target
}

// What an attestation is allowed to be about. `cli_version` is deliberately NOT here, and that
// is a decision rather than an omission: what the probe measures is an OS write boundary, and the
// kernel enforces that against any build of any provider. Keying evidence to the exact CLI build
// made every routine provider update refuse the whole pipeline until three paid boundary calls were spent
// re-observing a mechanism that had not changed. Measured on 2.1.228 before this was loosened:
// an unknown flag fails the call loudly, and a tool name the CLI no longer knows grants nothing
// rather than everything — so a provider update degrades noisily or safely, not silently.
// The version is still recorded and still reported when it drifts; it is the refusal that went.
// The independent Claude enumerator probe now observes its exact native tool list and an attempted
// shell command; other flag-shaped claims (configuration-source sealing and noninteraction) still
// are not kernel facts: the probe covers the kernel boundary, not the flags asserted around it,
// so a green attestation is evidence about what the OS enforced and about nothing else.
function probeKey(provider, probe, adapter, executable) {
  return {
    provider,
    probe_id: probe.id,
    adapter_digest: adapter.digest,
    os: `${platform()}-${arch()}`,
    executable: canonicalExecutable(executable),
  }
}

function readProbeFiles(root) {
  if (!root || !existsSync(root)) return []
  const out = []
  for (const name of readdirSync(root)) {
    if (!name.endsWith('.json')) continue
    const path = join(root, name)
    try {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > PROBE_ATTESTATION_MAX) continue
      const value = JSON.parse(readFileSync(path, 'utf8'))
      out.push({ value, stat, path })
    } catch { /* malformed evidence is never accepted */ }
  }
  return out
}

function currentAttestation(providerId, probe, provider) {
  const key = probeKey(providerId, probe, provider.adapter, provider.executable)
  const shipped = join(provider.adapter.directory, 'probes')
  const local = localProbeRoot()
  const candidates = [
    ...readProbeFiles(shipped).map((entry) => ({ ...entry, source: 'shipped' })),
    ...readProbeFiles(local && join(local, providerId)).map((entry) => ({ ...entry, source: 'local' })),
  ]
    .filter(({ value }) => value?.version === 1 && Object.entries(key).every(([name, expected]) =>
      value[name] === expected))
    .filter(({ value, stat, source }) => source === 'shipped'
      ? value.shipped === true
      : Date.now() - Date.parse(value.created_at || stat.mtime.toISOString()) <= PROBE_MAX_AGE_MS)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
  return candidates[0]?.value || null
}

function writeProbeAttestation(providerId, attestation) {
  const root = localProbeRoot()
  if (!root) die('probe evidence requires a Git repository')
  const directory = join(root, providerId)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  try { chmodSync(root, 0o700); chmodSync(directory, 0o700) } catch { /* POSIX modes unavailable */ }
  const body = Buffer.from(`${JSON.stringify(attestation, null, 2)}\n`)
  if (body.length > PROBE_ATTESTATION_MAX) die(`probe attestation exceeds ${PROBE_ATTESTATION_MAX} bytes`)
  // Same fields the lookup matches on, so re-probing REPLACES the evidence for a key instead of
  // leaving one file per CLI build behind it.
  const sameKey = ['provider', 'probe_id', 'adapter_digest', 'os', 'executable']
  for (const entry of readProbeFiles(directory)) {
    const created = Date.parse(entry.value?.created_at || entry.stat.mtime.toISOString())
    if (sameKey.every((key) => entry.value?.[key] === attestation[key]) ||
        Date.now() - created > PROBE_MAX_AGE_MS) unlinkSync(entry.path)
  }
  const stem = attestation.probe_id.replace(/[^\w.-]+/g, '_')
  const target = join(directory, `${stem}-${Date.now()}.json`)
  const temp = `${target}.tmp-${process.pid}`
  writeFileSync(temp, body, { mode: 0o600, flag: 'wx' })
  renameSync(temp, target)
  try { chmodSync(target, 0o600) } catch { /* POSIX modes unavailable */ }
  const files = readProbeFiles(directory).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
  // Probe ids are independent guarantees, not generations of one provider-wide value. Keep the
  // result just written and only evict older generations of the same id; otherwise adding a third
  // probe makes a successful recovery command delete evidence required by the first two.
  const retainedProbeIds = new Set([attestation.probe_id])
  for (const entry of files) {
    if (entry.path === target) continue
    const probeId = entry.value?.probe_id
    if (typeof probeId !== 'string' || !probeId || retainedProbeIds.has(probeId)) {
      unlinkSync(entry.path)
    } else {
      retainedProbeIds.add(probeId)
    }
  }
  return target
}

function boundedUtf8(value, maxBytes) {
  let text = String(value)
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false }
  let end = Math.min(text.length, maxBytes)
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > maxBytes) end -= 1
  return { text: text.slice(0, end), truncated: true }
}

function decodedProbeAnswer(decoded) {
  const value = decoded?.canonical?.value
  const keys = Object.keys(value || {}).sort().join(',')
  const writeKeys = 'inside,inside_attempted,outside,outside_attempted'
  const repositoryKeys =
    'inside,inside_attempted,observed_nonce,outside,outside_attempted,repository,repository_read_attempted'
  const toolContractKeys = 'received_marker,reported_tools,shell_tool_requested'
  if (keys === toolContractKeys) {
    if (typeof value.received_marker !== 'string' ||
        Buffer.byteLength(value.received_marker) > PROBE_REASON_VALUE_MAX ||
        typeof value.shell_tool_requested !== 'boolean' ||
        !Array.isArray(value.reported_tools) || value.reported_tools.length > 64 ||
        value.reported_tools.some((tool) => typeof tool !== 'string' || Buffer.byteLength(tool) > 128)) {
      return null
    }
    return value
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![writeKeys, repositoryKeys].includes(keys) ||
      typeof value.inside !== 'string' || typeof value.outside !== 'string' ||
      typeof value.inside_attempted !== 'boolean' ||
      typeof value.outside_attempted !== 'boolean') return null
  if (keys === repositoryKeys &&
      (typeof value.repository !== 'string' || typeof value.observed_nonce !== 'string' ||
       typeof value.repository_read_attempted !== 'boolean')) return null
  return value
}

function structuredProbeReason(answer) {
  if (Array.isArray(answer.reported_tools)) {
    const marker = boundedUtf8(answer.received_marker, PROBE_REASON_VALUE_MAX)
    return {
      kind: 'structured-probe-answer',
      answer: {
        received_marker: marker.text,
        reported_tools: answer.reported_tools,
        shell_tool_requested: answer.shell_tool_requested,
      },
      truncated: marker.truncated,
    }
  }
  const inside = boundedUtf8(answer.inside, PROBE_REASON_VALUE_MAX)
  const outside = boundedUtf8(answer.outside, PROBE_REASON_VALUE_MAX)
  const repository = typeof answer.repository === 'string'
    ? boundedUtf8(answer.repository, PROBE_REASON_VALUE_MAX) : null
  const observedNonce = typeof answer.observed_nonce === 'string'
    ? boundedUtf8(answer.observed_nonce, PROBE_REASON_VALUE_MAX) : null
  return {
    kind: 'structured-probe-answer',
    answer: {
      inside: inside.text,
      outside: outside.text,
      inside_attempted: answer.inside_attempted,
      outside_attempted: answer.outside_attempted,
      ...(repository ? {
        repository: repository.text,
        observed_nonce: observedNonce.text,
        repository_read_attempted: answer.repository_read_attempted,
      } : {}),
    },
    truncated: inside.truncated || outside.truncated || repository?.truncated === true ||
      observedNonce?.truncated === true,
  }
}

function failureProbeReason(adapter, result) {
  let decoded
  try { decoded = adapter.decodeFailure(result) } catch { return null }
  if (typeof decoded !== 'string' || !decoded.trim()) return null
  const diagnosis = boundedUtf8(decoded.trim(), PROBE_REASON_MAX)
  return { kind: 'provider-failure', diagnosis: diagnosis.text, truncated: diagnosis.truncated }
}

function missingProbeAnswerReason(invocation, resultTransport) {
  const expectedAt = resultTransport === 'file'
    ? invocation?.transport?.finalResponsePath || 'adapter file transport (path unavailable)'
    : 'provider standard output'
  const location = boundedUtf8(expectedAt, PROBE_REASON_MAX)
  return {
    kind: 'missing-structured-probe-answer',
    child_status: 0,
    expected_at: location.text,
    truncated: location.truncated,
  }
}

function probeLaunchFailureReason(result) {
  const caught = typeof result.stderr === 'string' && result.stderr.trim()
    ? result.stderr.trim()
    : result.error?.message || 'spawn returned no child status or diagnostic'
  const diagnosis = boundedUtf8(caught, PROBE_REASON_MAX)
  return { kind: 'probe-launch-failure', diagnosis: diagnosis.text, truncated: diagnosis.truncated }
}

function probeReasonSummary(reason) {
  if (!reason) return ''
  const raw = reason.kind === 'structured-probe-answer'
    ? reason.answer.reported_tools === undefined
      ? `answer: inside=${JSON.stringify(reason.answer.inside)}, outside=${JSON.stringify(reason.answer.outside)}` +
        (reason.answer.repository === undefined
          ? '' : `, repository=${JSON.stringify(reason.answer.repository)}`)
      : `answer: tools=${JSON.stringify(reason.answer.reported_tools)}, ` +
        `shell_tool_requested=${reason.answer.shell_tool_requested}`
    : reason.kind === 'provider-failure'
      ? `failure: ${reason.diagnosis}`
      : reason.kind === 'missing-structured-probe-answer'
        ? `failure: provider exited 0 but no structured probe answer was recovered from ` +
          JSON.stringify(reason.expected_at)
        : `launch failure: probe child did not start: ${reason.diagnosis}`
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  const bounded = boundedUtf8(oneLine, PROBE_REASON_SUMMARY_MAX)
  return `${bounded.text}${bounded.truncated || reason.truncated ? '…' : ''}`
}

function probeEnvironmentObservation(sourceEnv, childEnv) {
  const sourceKeys = Object.keys(sourceEnv || {}).sort()
  const childKeys = Object.keys(childEnv || {}).sort()
  const sourceSet = new Set(sourceKeys)
  const childSet = new Set(childKeys)
  const removed = sourceKeys.filter((key) => !childSet.has(key))
  const added = childKeys.filter((key) => !sourceSet.has(key))
  const changed = sourceKeys.filter((key) => childSet.has(key) && sourceEnv[key] !== childEnv[key])
  const maxNames = 128
  const maxNameBytes = 96
  const retained = (names) => names.slice(0, maxNames).map((name) =>
    boundedUtf8(name, maxNameBytes).text)
  const nameWasTruncated = [...removed, ...added, ...changed].some((name) =>
    Buffer.byteLength(name) > maxNameBytes)
  return {
    source_keys_sha256: createHash('sha256').update(sourceKeys.join('\0')).digest('hex'),
    child_keys_sha256: createHash('sha256').update(childKeys.join('\0')).digest('hex'),
    removed_keys: retained(removed),
    added_keys: retained(added),
    changed_keys: retained(changed),
    key_names_truncated: nameWasTruncated || removed.length > maxNames ||
      added.length > maxNames || changed.length > maxNames,
  }
}

const ROLE_REQUIREMENTS = {
  architect: {
    repositoryRead: 'available', directEdit: 'forbidden-delivery', shellExecution: 'available',
    externalToolAccess: 'forbidden', writeScope: 'engine-private-only',
  },
  enumerator: {
    repositoryRead: 'available', directEdit: 'forbidden-delivery',
    externalToolAccess: 'forbidden', writeScope: 'engine-private-only',
  },
  'plan-reviewer': {
    repositoryRead: 'available', directEdit: 'forbidden-delivery', shellExecution: 'available',
    externalToolAccess: 'forbidden', writeScope: 'engine-private-only',
  },
  executor: {
    repositoryRead: 'available', directEdit: 'available', shellExecution: 'available',
    externalToolAccess: 'forbidden', writeScope: 'delivery-tree',
  },
  reviewer: {
    repositoryRead: 'available', directEdit: 'forbidden-delivery', shellExecution: 'available',
    externalToolAccess: 'forbidden', writeScope: 'isolated-review-surface',
  },
}

// Actual states listed for each required state are the complete, explicit partial order. This is
// deliberately not derived from names such as "forbidden" or from a generic notion of smaller
// filesystem scope: executor and reviewer require a mutation surface, so removing it is not a
// stronger implementation of their contract. Adding a state therefore requires changing this one
// table and its closed descriptor vocabulary together.
const GUARANTEE_ORDER = {
  repositoryRead: {
    available: ['available'],
    unavailable: ['unavailable'],
  },
  directEdit: {
    available: ['available'],
    'forbidden-delivery': ['forbidden-delivery', 'forbidden'],
    forbidden: ['forbidden'],
  },
  shellExecution: {
    available: ['available'],
    forbidden: ['forbidden'],
  },
  externalToolAccess: {
    available: ['available'],
    forbidden: ['forbidden'],
  },
  writeScope: {
    none: ['none'],
    'engine-private-only': ['engine-private-only', 'none'],
    'shell-residual-delivery': ['shell-residual-delivery', 'engine-private-only', 'none'],
    'delivery-tree': ['delivery-tree'],
    'isolated-review-surface': ['isolated-review-surface'],
  },
  interaction: {
    noninteractive: ['noninteractive'],
  },
  permissionEscalation: {
    forbidden: ['forbidden'],
  },
}

const GUARANTEE_MECHANISMS = {
  repositoryRead: ['native-tool'],
  directEdit: ['native-tool', 'absent', 'isolated-surface', 'os-boundary'],
  shellExecution: ['native-tool', 'absent', 'denied-at-call'],
  externalToolAccess: ['native-tool', 'absent', 'denied-at-call'],
  writeScope: ['native-policy', 'absent', 'isolated-surface', 'os-boundary'],
  interaction: ['native-policy'],
  permissionEscalation: ['native-policy', 'absent'],
}

function roleGuaranteeMismatch(role, guarantees) {
  if (!guarantees || typeof guarantees !== 'object') return `${role} adapter returned no guarantees`
  const required = { ...ROLE_REQUIREMENTS[role], interaction: 'noninteractive', permissionEscalation: 'forbidden' }
  for (const [key, state] of Object.entries(required)) {
    const actual = guarantees[key]
    if (!actual || !GUARANTEE_ORDER[key]?.[state]?.includes(actual.state)) {
      return `${role} requires ${key}=${state}; adapter field is ${actual?.state || 'missing'}`
    }
  }
  return null
}

function validateDescriptor(role, descriptor) {
  const exact = (object, allowed, where) => {
    if (!object || typeof object !== 'object' || Array.isArray(object)) die(`${where} must be an object`)
    const extra = Object.keys(object).filter((key) => !allowed.includes(key))
    const missing = allowed.filter((key) => !Object.prototype.hasOwnProperty.call(object, key))
    if (extra.length || missing.length) die(`${where} is malformed`)
  }
  exact(descriptor, ['features', 'guarantees'], `${role} adapter descriptor`)
  exact(descriptor.features,
    ['schemaTransport', 'resultTransport', 'reportsCost', 'reportsCacheCounters', 'reportsModels',
      'modelSelection', 'reasoningLevels'],
    `${role} features`)
  if (!['inline', 'file'].includes(descriptor.features.schemaTransport)) {
    die(`${role} adapter has unsupported schema transport ${descriptor.features.schemaTransport}`)
  }
  if (!['stdout', 'file'].includes(descriptor.features.resultTransport)) {
    die(`${role} adapter has unsupported result transport ${descriptor.features.resultTransport}`)
  }
  if (descriptor.features.modelSelection !== 'explicit-id') {
    die(`${role} adapter must support explicit model ids`)
  }
  if (!Array.isArray(descriptor.features.reasoningLevels) ||
      descriptor.features.reasoningLevels.some((level) => !REASONING.has(level)) ||
      new Set(descriptor.features.reasoningLevels).size !== descriptor.features.reasoningLevels.length) {
    die(`${role} adapter has malformed reasoningLevels`)
  }
  exact(descriptor.guarantees,
    ['repositoryRead', 'directEdit', 'shellExecution', 'externalToolAccess', 'writeScope',
      'interaction', 'permissionEscalation'], `${role} guarantees`)
  for (const [key, value] of Object.entries(descriptor.guarantees)) {
    const allowed = ['state', 'by', ...(value?.probe !== undefined ? ['probe'] : [])]
    exact(value, allowed, `${role} guarantee ${key}`)
    if (typeof value.state !== 'string' || typeof value.by !== 'string') {
      die(`${role} guarantee ${key} must name state and mechanism`)
    }
    const states = new Set(Object.values(GUARANTEE_ORDER[key] || {}).flat())
    if (!states.has(value.state)) die(`${role} guarantee ${key} has unsupported state ${value.state}`)
    if (!GUARANTEE_MECHANISMS[key]?.includes(value.by)) {
      die(`${role} guarantee ${key} has unsupported mechanism ${value.by}`)
    }
    if (value.probe !== undefined && value.probe !== null) {
      const probeKeys = Object.keys(value.probe)
      const extraProbeKeys = probeKeys.filter((name) =>
        !['id', 'cliVersion', 'repositoryRead', 'expectedTools', 'shellDenied'].includes(name))
      if (extraProbeKeys.length || typeof value.probe.id !== 'string' ||
          typeof value.probe.cliVersion !== 'string' ||
          (value.probe.repositoryRead !== undefined && value.probe.repositoryRead !== true) ||
          (value.probe.expectedTools !== undefined &&
            (!Array.isArray(value.probe.expectedTools) || !value.probe.expectedTools.length ||
             value.probe.expectedTools.length > 64 ||
             value.probe.expectedTools.some((tool) => typeof tool !== 'string' || !tool ||
               Buffer.byteLength(tool) > 128) ||
             new Set(value.probe.expectedTools).size !== value.probe.expectedTools.length)) ||
          (value.probe.shellDenied !== undefined && value.probe.shellDenied !== true) ||
          (value.probe.expectedTools === undefined) !== (value.probe.shellDenied === undefined)) {
        die(`${role} guarantee ${key} probe is malformed`)
      }
    }
    if (value.by === 'os-boundary' && value.probe == null) {
      die(`${role} guarantee ${key} uses os-boundary without a versioned probe`)
    }
  }
}

const HOST_BOUNDARY_MECHANISMS = new Set(['os-boundary', 'isolated-surface'])

function requireHostMechanisms(role, descriptor, adapter) {
  const mechanisms = new Set(Object.values(descriptor.guarantees)
    .map((guarantee) => guarantee.by)
    .filter((mechanism) => HOST_BOUNDARY_MECHANISMS.has(mechanism)))
  for (const mechanism of mechanisms) {
    let available
    try {
      available = adapter.mechanismAvailable({
        mechanism, platform: platform(), arch: arch(), env: process.env,
      })
    } catch (error) {
      die(`${role} adapter could not resolve host mechanism ${mechanism}: ${error?.message || error}`)
    }
    if (typeof available !== 'boolean') {
      die(`${role} adapter mechanismAvailable must return a boolean for ${mechanism}`)
    }
    if (!available) {
      die(`${role} adapter cannot resolve host mechanism ${mechanism}; provider probe was not started`)
    }
  }
}

// Not a warning and not a refusal — a fact the run owes its reader once. Evidence outlives the
// build it was taken on by design; a log that never says so cannot answer "what was it observed
// against" months later. Collected here and printed under the runtime matrix rather than from
// inside the guarantee loop, which would put the note above the header it belongs to and repeat
// it per role.
const observedProbeDrift = new Set()
function noteProbeVersionDrift(providerId, attestation, cliVersion) {
  const observed = attestation?.cli_version
  if (!observed || observed === cliVersion) return
  observedProbeDrift.add(
    `  ${providerId}: probe evidence observed on CLI ${observed}; running ${cliVersion}`)
}

function compareGuarantees(role, descriptor, provider, missingEvidence = null) {
  const { adapter, cliVersion, executable } = provider
  validateDescriptor(role, descriptor)
  requireHostMechanisms(role, descriptor, adapter)
  if (stableJson(descriptor.features) !== stableJson(adapter.features)) {
    die(`${role} adapter descriptor features do not match its contract features`)
  }
  const guarantees = descriptor?.guarantees
  const mismatch = roleGuaranteeMismatch(role, guarantees)
  if (mismatch) die(mismatch)
  const required = { ...ROLE_REQUIREMENTS[role], interaction: 'noninteractive', permissionEscalation: 'forbidden' }
  for (const key of Object.keys(required)) {
    const actual = guarantees[key]
    if (actual.probe && actual.probe.cliVersion !== cliVersion) {
      die(`${role} guarantee ${key} has stale probe for ${actual.probe.cliVersion}; CLI is ${cliVersion}`)
    }
    if (actual.probe) {
      const attestation = currentAttestation(adapter.id, actual.probe, provider)
      const evidence = adapter.verifyGuaranteeProbe({
        role, guarantee: key, probe: actual.probe, cliVersion, executable, attestation,
      })
      if (!evidence || evidence.green !== true || evidence.id !== actual.probe.id ||
          evidence.cliVersion !== cliVersion) {
        const message = `${role} guarantee ${key} lacks current green probe evidence (${actual.probe.id}).`
        if (missingEvidence) {
          missingEvidence.push({ message, provider: adapter.id })
          continue
        }
        die(`${message}\n  Run: node caw.mjs probe ${adapter.id}`)
      }
      noteProbeVersionDrift(adapter.id, attestation, cliVersion)
    }
  }
}

function reviewIndependence(mode, authorRole, reviewerRole, recordedAuthor = undefined) {
  const participant = (role) => {
    const binding = resolvedRuntime.value.roles[role]
    const adapter = adapters.get(binding.provider)
    return {
      role,
      provider: binding.provider,
      vendor: adapter?.vendor || binding.provider,
      model: binding.model,
    }
  }
  const authorAdapter = recordedAuthor && adapters.get(recordedAuthor.provider)
  const author = recordedAuthor === undefined ? participant(authorRole) : {
    role: authorRole,
    provider: recordedAuthor?.provider || null,
    // Older records can borrow vendor identity only from the exact adapter they used.
    vendor: recordedAuthor?.vendor || (authorAdapter?.digest === recordedAuthor?.adapter_digest
      ? authorAdapter?.vendor : null) || null,
    model: recordedAuthor?.requested?.model || null,
  }
  const reviewer = participant(reviewerRole)
  const scope = authorRole === 'architect' ? 'planning' : 'task'
  if (mode === 'human-review') {
    return {
      scope, mode, author, reviewer: { kind: 'human', role: reviewerRole }, satisfied: true,
      reason: 'Automated approval is disabled; a signed human attestation is required.',
    }
  }
  const authorKnown = Boolean(author.vendor && author.model)
  const satisfied = mode === 'same-provider'
    || (mode === 'different-model' && authorKnown &&
      (author.vendor !== reviewer.vendor || author.model !== reviewer.model))
    || (mode === 'cross-vendor' && authorKnown && author.vendor !== reviewer.vendor)
  return {
    scope, mode, author, reviewer, satisfied,
    reason: satisfied ? '' : !authorKnown
      ? 'The recorded author is unknown; run a fresh executor round or use signed human review.'
      : mode === 'cross-vendor'
      ? 'Select adapters owned by different vendors.'
      : 'Select a different model or a different vendor for the reviewer.',
  }
}

function preflightRuntime(f, skipRoleSmoke = false) {
  if (!resolvedRuntime) resolvedRuntime = loadRuntime(f)
  if (!resolvedRuntime.providers) {
    resolvedRuntime.providers = new Map()
    for (const provider of new Set(ROLES.map((role) => resolvedRuntime.value.roles[role].provider))) {
      const adapter = adapters.get(provider)
      if (!adapter) die(`runtime selects untrusted or unavailable adapter ${JSON.stringify(provider)}`)
      const executable = adapter.resolveExecutable(process.env)
      const versionCall = adapter.versionInvocation(executable)
      const versionLaunch = providerLaunch(versionCall.executable, process.platform, provider)
      const probe = spawnSync(versionLaunch.executable,
        [...versionLaunch.leadingArgs, ...versionCall.args], {
        encoding: 'utf8', timeout: 5000, env: { ...process.env, ...(versionCall.env || {}) },
      })
      if (probe.error || probe.status !== 0) {
        die(`runtime provider executable is unavailable: ${executable}\n` +
          `  ${probe.error?.message || probe.stderr || `version probe exited ${probe.status}`}`)
      }
      const cliVersion = probe.stdout.trim().split('\n')[0] || 'version unreported'
      resolvedRuntime.providers.set(provider, { adapter, executable, cliVersion })
    }
    const missingEvidence = []
    for (const role of ROLES) {
      const binding = resolvedRuntime.value.roles[role]
      const provider = resolvedRuntime.providers.get(binding.provider)
      const descriptor = provider.adapter.describe({ role, cliVersion: provider.cliVersion })
      compareGuarantees(role, descriptor, provider, missingEvidence)
      if (!descriptor.features.reasoningLevels.includes(binding.reasoning)) {
        die(`${role} requests reasoning=${binding.reasoning}, but adapter ${binding.provider} ` +
          `supports ${descriptor.features.reasoningLevels.join(', ')}`)
      }
    }
    if (missingEvidence.length) {
      const providers = [...new Set(missingEvidence.map((entry) => entry.provider))]
      die('runtime lacks current green probe evidence:\n' +
        missingEvidence.map((entry) => `  - ${entry.message}`).join('\n') +
        '\n  Recovery:\n' + providers.map((provider) =>
          `  Run: node caw.mjs probe ${provider}`).join('\n'))
    }
  }
  if (f.require_role_smoke && !skipRoleSmoke) {
    const missingSmoke = ROLES.filter((role) => {
      const binding = resolvedRuntime.value.roles[role]
      return !currentRoleSmoke(role, binding, resolvedRuntime.providers.get(binding.provider))
    })
    if (missingSmoke.length) {
      die('runtime lacks role smoke evidence for the exact model/reasoning binding:\n' +
        missingSmoke.map((role) => `  - ${role}`).join('\n') +
        '\n  Recovery: node caw.mjs smoke all')
    }
  }
  const independence = [
    reviewIndependence(f.planning_independence, 'architect', 'plan-reviewer'),
    // A review-only invocation judges the saved author, resolved in runTask, not a future executor.
    ...(providerBudgetState.command === 'review' ? []
      : [reviewIndependence(f.task_independence, 'executor', 'reviewer')]),
  ]
  const independenceFailure = independence.find((entry) => !entry.satisfied)
  if (independenceFailure) {
    die(`${independenceFailure.scope} independence requires ${independenceFailure.mode}; actual pair is ` +
      `${independenceFailure.author.vendor}/${independenceFailure.author.model} -> ` +
      `${independenceFailure.reviewer.vendor}/${independenceFailure.reviewer.model}. ` +
      independenceFailure.reason)
  }
  resolvedRuntime.independence = independence
  if (!resolvedRuntime.printed) {
    say(`runtime ${resolvedRuntime.digest}`)
    for (const role of ROLES) {
      const row = resolvedRuntime.value.roles[role]
      const provider = resolvedRuntime.providers.get(row.provider)
      say(`  ${role}: ${row.provider}/${row.model} reasoning=${row.reasoning}` +
        ` adapter=${provider.adapter.digest.slice(0, 12)} CLI=${provider.cliVersion}`)
    }
    for (const line of observedProbeDrift) say(line)
    for (const entry of independence) {
      const reviewerLabel = entry.reviewer.kind === 'human'
        ? 'signed-human-attestation'
        : `${entry.reviewer.vendor}/${entry.reviewer.model}`
      say(`  ${entry.scope} independence: ${entry.mode} — ${entry.author.vendor}/${entry.author.model}` +
        ` -> ${reviewerLabel}`)
    }
    resolvedRuntime.printed = true
  }
  printRuntimeResiduals({ runtime: resolvedRuntime.value })
  return resolvedRuntime
}

// A repository-relative path here pointed at a file no install has: the manual copies six
// paths and `docs/` is not one of them, so every operator read this against their OWN tree
// and found nothing. A warning nobody can check is read as noise by the third run. The two
// lines below are the whole fact; the URL is where the reasoning behind them is kept.
const RUNTIME_RESIDUALS_DOC = 'https://github.com/30nt/CrossAgenticWarden/blob/main/SECURITY.md'

function printRuntimeResiduals({ runtime, providerId = null }) {
  if (runtimeResidualsPrinted) return
  const codexInScope = providerId === 'codex' || (!providerId &&
    ROLES.some((role) => runtime.roles[role].provider === 'codex'))
  say(`\nUNBOUNDED RUNTIME RESIDUALS — ${RUNTIME_RESIDUALS_DOC}`)
  say('  Shell-enabled roles can read outside delivery and make outbound network requests;' +
    ' externalToolAccess=forbidden does not cover shell commands.')
  if (codexInScope && process.env.CAW_CODEX_AUTH_FILE) {
    say('  CAW_CODEX_AUTH_FILE is set: a Codex child can read its private credential copy before' +
      ' reactive turn-start deletion.')
  }
  runtimeResidualsPrinted = true
}

const TASK = {
  type: 'object',
  properties: {
    slug: { type: 'string', description: 'kebab-case, 2-4 words' },
    title: { type: 'string' },
    read: { type: 'array', items: { type: 'string' } },
    change: { type: 'array', items: { type: 'string' } },
    done_when: { type: 'array', items: { type: 'string' } },
    surfaces: {
      type: 'array', minItems: 1,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'stable kebab-case surface id' },
          responsibility: { type: 'string', description: 'one independently changeable responsibility' },
        },
        required: ['id', 'responsibility'],
      },
    },
    state_machines: {
      type: 'array', minItems: 1,
      items: {
        type: 'object',
        properties: {
          surface: { type: 'string', description: 'id of exactly one surface in this task' },
          states: { type: 'array', minItems: 2, items: { type: 'string' } },
          transitions: {
            type: 'array', minItems: 1,
            items: {
              type: 'object',
              properties: {
                from: { type: 'string' }, event: { type: 'string' }, to: { type: 'string' },
              },
              required: ['from', 'event', 'to'],
            },
          },
        },
        required: ['surface', 'states', 'transitions'],
      },
    },
    indivisible_reason: {
      type: 'string',
      description: 'empty for one surface; for several surfaces, why they cannot be separate tasks',
    },
  },
  required: ['slug', 'title', 'read', 'change', 'done_when', 'surfaces', 'state_machines',
    'indivisible_reason'],
}

// One shape for every blocking slot of a task verdict. `where` and `fix` are what the executor
// needs; `evidence` is what makes the item survivable across rounds — the next reviewer judges
// whether the item is closed against what the last one actually checked, not against its prose.
// It is also what the human reads at a stop, and the reason a stop is a decision rather than a
// re-reading of the tree by hand.
const REVIEW_ITEM = {
  type: 'object',
  properties: {
    where: { type: 'string', description: 'path, and a line number or a symbol' },
    fix: { type: 'string', description: 'the concrete change to make. One item, one change.' },
    criterion_ids: {
      type: 'array', items: { type: 'string' },
      description: 'engine criterion ids whose property this finding blocks',
    },
    surface_ids: {
      type: 'array', items: { type: 'string' },
      description: 'engine surface ids involved in the same root cause',
    },
    transition_ids: {
      type: 'array', items: { type: 'string' },
      description: 'engine transition ids involved in the same root cause',
    },
    property_key: {
      type: 'string',
      description: 'stable project-independent key for the violated property; not prose similarity',
    },
    evidence: {
      type: 'string',
      description: 'what you ran, mutated or quoted to establish this — on the tree in front ' +
        'of you, naming it. Not an argument that it is probably so.',
    },
    evidence_refs: {
      type: 'array', items: { type: 'string' },
      description: 'stable receipt, check, artifact, claim, repository, or experiment references',
    },
  },
  required: ['where', 'fix', 'criterion_ids', 'surface_ids', 'transition_ids', 'property_key',
    'evidence', 'evidence_refs'],
}

// A block must NAME what cannot be done: the refusal prints it as the reason and a human acts on
// it. But both `blocked` fields are `required`, so a model that finished has to put SOMETHING
// there — and the first live firing of this path on any install was an executor writing `none`
// after completing its task, which stopped the run and cost the round again. The schema
// descriptions now say the empty string is the value; this is the guard behind them, because a
// description holds with some probability and a check holds.
//
// An explicit set rather than a length rule. A terse real block — "spec contradicts itself" —
// must survive, and any threshold that kills a placeholder is close enough to kill that too.
// The list is a defence against one observed shape, not a claim to have enumerated them all.
const NO_BLOCK = new Set([
  'none', 'no', 'nothing', 'n/a', 'na', 'null', 'nil', 'not applicable',
  'nothing blocked', 'nothing blocked me', 'nothing to report', 'nothing blocked this',
  'ok', 'done', 'completed', 'complete', 'success',
])
const blocked = (s) => {
  const t = (s || '').trim().toLowerCase().replace(/[.!]+$/, '').replace(/\s+/g, ' ')
  return t && !/^[-\u2013\u2014]+$/.test(t) && !NO_BLOCK.has(t) ? s : ''
}

function closeSchema(schema) {
  if (Array.isArray(schema)) return schema.map(closeSchema)
  if (!schema || typeof schema !== 'object') return schema
  const out = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties') {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, closeSchema(child)]))
    } else if (key === 'items') out.items = closeSchema(value)
    else out[key] = closeSchema(value)
  }
  if (schema.type === 'object') out.additionalProperties = false
  return out
}

const POPULATION_SOURCE_SCHEMA = {
  description: 'an engine-resolvable address. No bare symbols or free-form sources.',
  anyOf: [
    {
      type: 'object',
      description: 'a canonical current-tree file plus an exact excerpt occurrence',
      properties: {
        kind: { type: 'string', enum: ['repository'] },
        path: { type: 'string' },
        occurrence: { type: 'number' },
        excerpt: { type: 'string' },
      },
      required: ['kind', 'path', 'occurrence', 'excerpt'],
    },
    {
      type: 'object',
      description: 'an exact excerpt and one-based occurrence in the human request',
      properties: {
        kind: { type: 'string', enum: ['request'] },
        occurrence: { type: 'number' },
        excerpt: { type: 'string' },
      },
      required: ['kind', 'occurrence', 'excerpt'],
    },
    {
      type: 'object',
      description: 'an exact excerpt occurrence in the engine index block named by its digest',
      properties: {
        kind: { type: 'string', enum: ['index'] },
        index_sha256: { type: 'string' },
        occurrence: { type: 'number' },
        excerpt: { type: 'string' },
      },
      required: ['kind', 'index_sha256', 'occurrence', 'excerpt'],
    },
  ],
}

const SCHEMA = closeSchema({
  plan: {
    type: 'object',
    properties: {
      tasks: { type: 'array', items: TASK },
      coverage: {
        type: 'array',
        description: 'the population this request implies — one row per case that must be handled, ' +
          'each mapped to the task that handles it. Completeness is this mapping, not a judgement.',
        items: {
          type: 'object',
          properties: {
            case: { type: 'string', description: 'a case, state, input or surface the request implies' },
            task: { type: 'string', description: 'slug of the task that handles it' },
            acceptance_criteria: {
              type: 'array', minItems: 1,
              items: { type: 'string' },
              description: 'one or more exact done_when strings from that task which make this ' +
                'case checkable on the final tree',
            },
          },
          required: ['case', 'task', 'acceptance_criteria'],
        },
      },
      blocked: {
        type: 'string',
        description: 'THE EMPTY STRING when you are returning tasks. Fill it only to name a ' +
          'question that stops you planning at all. Do not write "none" or any other ' +
          'placeholder: anything here stops the run.',
      },
      // Filled on a revision only — see the revision block in plan(). A plan that closes a hole
      // by moving a case between tasks cannot be read as a diff unless it says what moved.
      resplit: {
        type: 'array', items: { type: 'string' },
        description: 'empty on the first round. On a revision: one line per case that MOVED ' +
          'between tasks or per task whose boundary changed — what moved, from which task to ' +
          'which, and which hole required it. Closing a hole by rewriting a task nobody ' +
          'complained about goes here too.',
      },
    },
    required: ['tasks', 'coverage', 'blocked', 'resplit'],
  },

  // Typed slots and nothing else, on purpose. A free-text field is where "replace 24 with 25"
  // goes; with no such field, a finding that is not a hole has nowhere to land. There is no
  // verdict property either — the script derives the verdict from the slots, so the reviewer
  // can neither approve a plan with a hole nor reject one without naming one.
  planReview: {
    type: 'object',
    properties: {
      relations: {
        type: 'array',
        description: 'exactly one disposition for every engine-assigned relation id',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'the engine-assigned relation id' },
            state: { type: 'string', enum: ['covered', 'uncovered'] },
            evidence: {
              type: 'string',
              description: 'why the linked acceptance criteria do or do not establish this case',
            },
          },
          required: ['id', 'state', 'evidence'],
        },
      },
      uncovered: {
        type: 'array', items: { type: 'string' },
        description: 'a case the request implies that no task handles',
      },
      unverifiable: {
        type: 'array', items: { type: 'string' },
        description: "a task whose done_when cannot be checked, or that contradicts its own change list",
      },
      misordered: {
        type: 'array', items: { type: 'string' },
        description: 'a task that needs something a later task produces',
      },
      out_of_scope: {
        type: 'array', items: { type: 'string' },
        description: 'a task doing work the request did not ask for',
      },
      undecidable: {
        type: 'array', items: { type: 'string' },
        description: 'a question the request itself does not settle and the plan is guessing at. ' +
          'This goes to the human, not to another round. List every one you can see: the run ' +
          'ends on the first anyway, so a question left out costs the human a whole run to find.',
      },
    },
    required: ['relations', 'uncovered', 'unverifiable', 'misordered', 'out_of_scope', 'undecidable'],
  },

  // A source is an address the engine can resolve, not a model's assertion that it looked
  // somewhere. Each tagged branch is a closed object because strict provider schemas require all
  // declared properties to be required. The resolver below remains the instrument that can return
  // a falsifying result for every class: schema validity alone cannot establish that the named
  // bytes exist and match. A bare symbol deliberately has no class because existence of a name
  // would not establish which bytes the case came from.
  population: {
    type: 'object',
    properties: {
      cases: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            case: {
              type: 'string',
              description: 'one case, state, input, call site or surface the request implies, ' +
                'stated so another agent can tell whether a task handles it',
            },
            source: POPULATION_SOURCE_SCHEMA,
          },
          required: ['case', 'source'],
        },
      },
      request_issues: {
        type: 'array',
        description: 'every request/profile/canonical-doc conflict or product question the ' +
          'request assumes settled but project authority does not settle. Empty when the ' +
          'request is ready for an architect.',
        items: {
          type: 'object',
          properties: {
            issue: { type: 'string' },
            request_source: POPULATION_SOURCE_SCHEMA,
            authority_sources: {
              type: 'array', minItems: 1, items: POPULATION_SOURCE_SCHEMA,
              description: 'exact profile or canonical-document excerpts that conflict with, ' +
                'or fail to settle, the request premise',
            },
          },
          required: ['issue', 'request_source', 'authority_sources'],
        },
      },
    },
    required: ['cases', 'request_issues'],
  },

  // Typed slots, for the reason stated over `planReview` and against the measurement that the
  // task side did not have them. `fixes: string[]` was the whole verdict, so every observation
  // a reviewer made had exactly one place to land and blocking was that place. Measured on
  // one Python install: of eight items across two rounds, one was "rename this
  // test, the assertion is correct and has teeth" — the reviewer's own words — and it blocked
  // a round like the four defects beside it. A slot that does not block is what that item was
  // missing, and `noted` is the same channel `executor.md` already gives the executor for the
  // same kind of sighting.
  //
  // `carried` is the other half and it is the convergence half. The reviewer used to be handed
  // the spec, the diff and nothing else, so round 2 was a fresh reading of the whole tree
  // rather than a judgement of what round 1 asked for — the identical defect the plan loop was
  // measured on and fixed by handing the architect its own plan back (4 -> 5 -> 5 became
  // 6 -> 3 -> 1; see the revision block in `plan()`). On that same install it shows as three
  // round-2 items naming test code that no round-1 fix had touched: visible in round 1, drawn
  // in round 2. A reviewer that redraws each round does not converge, and adding rounds to a
  // sampler buys more samples rather than an approval.
  //
  // `evidence` is required on every blocking item, at every round, and that is `reviewer.md`'s
  // "Re-run every claim" turned from a habit into a field. It is also the whole of the ratchet:
  // a later round cannot block on a re-reading it cannot demonstrate, and no round counter is
  // needed to say so.
  verdict: {
    type: 'object',
    properties: {
      criteria: {
        type: 'array',
        description: 'the atomic review census: exactly one row for every engine-listed Must ' +
          'cover, Change, and Done when criterion. Missing, duplicate, or unknown ids invalidate ' +
          'the response.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'the engine-assigned criterion id' },
            state: {
              type: 'string', enum: ['met', 'broken', 'uncovered', 'weak'],
              description: 'met only when the shipped consumer and meaningful verification ' +
                'establish the criterion; otherwise name the blocking slot that carries it',
            },
            evidence: {
              type: 'string',
              description: 'what was traced, read, or experimentally checked for this criterion',
            },
            evidence_refs: {
              type: 'array', items: { type: 'string' },
              description: 'stable references for the evidence used in this disposition',
            },
          },
          required: ['id', 'state', 'evidence', 'evidence_refs'],
        },
      },
      // Empty on round 1 — there is nothing to carry. From round 2 on it must hold one entry
      // per item this task still has open, and the loop refuses a verdict that skips any.
      carried: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'the id the item was given when it was raised, e.g. r1.2' },
            state: {
              type: 'string', enum: ['closed', 'open', 'withdrawn'],
              description: 'closed — the tree now satisfies it. open — it does not. withdrawn ' +
                '— it was wrong when raised, and you are retracting it.',
            },
            evidence: {
              type: 'string',
              description: 'what you ran or read to decide THIS state, on the tree in front of ' +
                'you. Closing your own item is a claim like any other; "addressed" is not one.',
            },
            evidence_refs: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'state', 'evidence', 'evidence_refs'],
        },
      },
      broken: {
        type: 'array', items: REVIEW_ITEM,
        description: 'the delivery does not do what it says, or does it wrongly',
      },
      uncovered: {
        type: 'array', items: REVIEW_ITEM,
        description: "a line of the spec's `## Must cover`, `## Change`, or `## Done when` that the tree does " +
          'not meet. Quote the line in `evidence`.',
      },
      weak: {
        type: 'array', items: {
          type: 'object',
          properties: {
            ...REVIEW_ITEM.properties,
            mutation: {
              type: 'object',
              properties: {
                breaks: {
                  type: 'string',
                  description: 'the asserted property this mutation breaks while the gate stays green',
                },
              },
              required: ['breaks'],
            },
          },
          required: [...REVIEW_ITEM.required, 'mutation'],
        },
        description: 'a test that is green for the wrong reason — a deleted check, a matcher ' +
          'widened until it always matches, a probe that matches its own fixture. `evidence` ' +
          'names the experiment, and `mutation.breaks` names the property it defeats. Make each ' +
          'mutation as a numbered capture in the isolated surface; the engine derives its diff, ' +
          'replays it on a fresh surface and accepts it only when the gate remains green. A ' +
          'weakness you did not demonstrate is a `noted`, not a `weak`.',
      },
      noted: {
        type: 'array', items: { type: 'string' },
        description: 'true, checkable, and none of the three above: a name that misleads, a ' +
          'neighbouring smell, something worth knowing. This slot does NOT block and nothing ' +
          'acts on it — it is printed to the human once and rides along in the commit. Put ' +
          'here everything you would otherwise be tempted to block on "while we are here".',
      },
    },
    required: ['criteria', 'carried', 'broken', 'uncovered', 'weak', 'noted'],
  },
  delivery: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      notes: { type: 'array', items: { type: 'string' } },
      claims: {
        type: 'array',
        description: 'untrusted executor-reported checks. The engine retains them as navigation ' +
          'hints and never upgrades them into gate evidence.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            criterion_ids: { type: 'array', items: { type: 'string' } },
            acceptance_case_ids: { type: 'array', items: { type: 'string' } },
            command: { type: 'string' },
            selector: { type: 'string' },
            result: { type: 'string', enum: ['passed', 'failed', 'not-run'] },
            summary: { type: 'string' },
            artifact_refs: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'criterion_ids', 'acceptance_case_ids', 'command', 'selector',
            'result', 'summary', 'artifact_refs'],
        },
      },
      blocked: {
        type: 'string',
        description: 'THE EMPTY STRING when you did the task. Fill it only to name what ' +
          'makes the task impossible as specified. Do not write "none" or any other ' +
          'placeholder: anything here stops the run.',
      },
    },
    required: ['summary', 'notes', 'claims', 'blocked'],
  },
})

const PROJECT_POLICY_OUTPUT_SCHEMAS = Object.freeze({
  planning: closeSchema({
    type: 'object',
    properties: {
      issues: { type: 'array', items: { type: 'string' } },
      instructions: { type: 'array', items: { type: 'string' } },
    },
    required: ['issues', 'instructions'],
  }),
  review: closeSchema({
    type: 'object',
    properties: {
      criteria: {
        type: 'array', items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            section: { type: 'string' },
            criterion: { type: 'string' },
          },
          required: ['id', 'section', 'criterion'],
        },
      },
      instructions: { type: 'array', items: { type: 'string' } },
    },
    required: ['criteria', 'instructions'],
  }),
  gate: closeSchema({
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['continue', 'stop'] },
      reason: { type: 'string' },
    },
    required: ['action', 'reason'],
  }),
  commit: closeSchema({
    type: 'object',
    properties: { subject: { type: 'string' } },
    required: ['subject'],
  }),
})

const PROJECT_POLICY_V2_PLANNING_REQUEST_SCHEMA = closeSchema({
  type: 'object',
  properties: {
    issues: { type: 'array', items: { type: 'string' } },
    instructions: { type: 'array', items: { type: 'string' } },
    risk: {
      type: 'object',
      properties: {
        class: { type: 'string' },
        population_requirement: { type: 'string', enum: ['none', 'sample', 'complete'] },
        require_full_gate_baseline: { type: 'boolean' },
      },
      required: ['class', 'population_requirement', 'require_full_gate_baseline'],
    },
  },
  required: ['issues', 'instructions', 'risk'],
})

const PROJECT_POLICY_V2_PLANNING_POPULATION_SCHEMA = closeSchema({
  type: 'object',
  properties: {
    issues: { type: 'array', items: { type: 'string' } },
    instructions: { type: 'array', items: { type: 'string' } },
    attestation: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['none', 'sample', 'complete'] },
        population_digest: { type: 'string' },
        evidence: { type: 'string' },
      },
      required: ['state', 'population_digest', 'evidence'],
    },
  },
  required: ['issues', 'instructions', 'attestation'],
})

const PROJECT_POLICY_V2_GATE_SCHEMA = closeSchema({
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['continue', 'stop', 'retry'] },
    reason: { type: 'string' },
    classification: {
      type: 'string', enum: ['defect', 'flaky', 'infrastructure', 'unknown'],
    },
    baseline_inputs_digest: { type: 'string' },
  },
  required: ['action', 'reason'],
})

const PROJECT_POLICY_V3_ACCEPTANCE_SCHEMA = closeSchema({
  type: 'object',
  properties: {
    cases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          criterion_ids: { type: 'array', minItems: 1, items: { type: 'string' } },
          surface_id: { type: 'string' },
          transition_id: { type: 'string' },
          production_consumer: { type: 'string' },
          scenario: { type: 'string' },
          observable: { type: 'string' },
          mutation: { type: 'string' },
          evidence_kind: { type: 'string' },
          selector: { type: 'string' },
        },
        required: ['id', 'criterion_ids', 'surface_id', 'transition_id', 'production_consumer',
          'scenario', 'observable', 'mutation', 'evidence_kind', 'selector'],
      },
    },
  },
  required: ['cases'],
})

const GATE_EVIDENCE_MANIFEST_SCHEMA = closeSchema({
  type: 'object',
  properties: {
    version: { type: 'number', enum: [1] },
    checks: {
      type: 'array', maxItems: GATE_EVIDENCE_CHECKS_MAX,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          criterion_ids: { type: 'array', items: { type: 'string' } },
          acceptance_case_ids: { type: 'array', items: { type: 'string' } },
          selector: { type: 'string' },
          evidence_kind: { type: 'string' },
          state: { type: 'string', enum: ['passed', 'failed', 'skipped'] },
          summary: { type: 'string' },
          artifacts: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, path: { type: 'string' } },
              required: ['id', 'path'],
            },
          },
        },
        required: ['id', 'criterion_ids', 'acceptance_case_ids', 'selector', 'evidence_kind', 'state',
          'summary', 'artifacts'],
      },
    },
  },
  required: ['version', 'checks'],
})

// ---------------------------------------------------------------- infrastructure

// A run that dies has no commit to carry its notes, so they go to a file as well as the
// terminal. `.log`, not `.md`, and that extension is doing real work: `build` treats every
// `.caw-tasks/*.md` as a spec to execute, so a notes file named `.md` would be run as a task —
// and a project that ties its gate to the same glob would measure it as one.
// The queue's directory. `.caw-` rather than a bare `.caw-tasks/`, which is a name a target
// repository is entitled to own — an Ansible role requires one. The guards must spell this
// the same way; they carry it as `QUEUE` in `.caw/hooks/deny_tasks_bash.py`.
const QUEUE_DIR = '.caw-tasks'
const NOTES_LOG = join(QUEUE_DIR, 'notes.log')

// Where a run's own output goes — the guard in `.caw/hooks/require_caw_log.py` refuses a
// pipeline run whose command line does not name it — and, since `blocked` learned to keep a
// task's work, where that patch goes too.
const LOG_DIR = '.caw-logs'

// Provider-neutral execution demand used by task review. Phase 2 moves its enforcement into the
// adapter contract; until then the incumbent transport consumes the same shape directly.
const REVIEW_WRITE_BOUNDARY = 'isolated-review-surface'
const REVIEW_PATCH_MAX = 8 * 1024 * 1024
const REVIEW_VERDICT_PATCH_MAX = 32 * 1024 * 1024
const FINAL_VALUE_MAX = 4 * 1024 * 1024
const ENGINE_DIAGNOSTIC_MAX = 16 * 1024
// Weak verification is evidence, not task state. Keep enough events to explain a normal run,
// but make a pathological queue bounded and say how much evidence was not retained.
const WEAK_VERIFICATION_EVENTS_RETAINED = 32
const ROUND_STATE_MAX = 8 * 1024 * 1024
const BLOCKED_PATCH_MAX = 64 * 1024 * 1024
const DIVERGED_SPEC_MAX = 1024 * 1024
const REVIEW_SURFACE_MAX = 2 * 1024 * 1024 * 1024
const REVIEW_SURFACE_PARENT = join(tmpdir(), 'caw-review-surfaces')
const WEAK_CONTROL_TIMEOUT_DEFAULT_MS = 5000
const ADAPTER_TRANSPORT_MAX = 64 * 1024 * 1024
const ADAPTER_TRANSPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000
const ADAPTER_TRANSPORT_MAX_COUNT = 3
const ADAPTER_TRANSPORT_PARENT = join(tmpdir(), 'caw-adapter-transports')
const INVOCATION_SCRATCH_PARENT = join(tmpdir(), 'caw-invocation-scratch')
const ACTIVE_REVIEW_SURFACES = new Map()
const ACTIVE_INVOCATION_SCRATCH = new Set()
const PROJECT_POLICY_MANIFEST = join('.caw', 'project', 'manifest.json')
const PROJECT_POLICY_STAGES = ['planning', 'review', 'gate', 'commit', 'acceptance']
const PROJECT_POLICY_OUTPUT_MAX = 256 * 1024
const PROJECT_POLICY_INPUT_MAX = 1024 * 1024
const PROJECT_POLICY_FILES_MAX = 2 * 1024 * 1024
const PROJECT_POLICY_TIMEOUT_DEFAULT_MS = 5000
const PROJECT_POLICY_TIMEOUT_MAX_MS = 60000
const PROJECT_GATE_RETRIES_MAX = 2
const PROJECT_POLICY_SCRATCH_PARENT = join(tmpdir(), 'caw-project-policies')
const GATE_EVIDENCE_SCRATCH_PARENT = join(tmpdir(), 'caw-gate-evidence')
const POPULATION_CACHE_VERSION = 1
const POPULATION_CACHE_MAX = 20
const POPULATION_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const POPULATION_CACHE_FILE_MAX = 8 * 1024 * 1024
const TASK_AUDIT_MAX = 16 * 1024 * 1024
let projectPolicySet = null
let activePopulationCertification = null
let runRecord = null

function gitPrivatePath(...parts) {
  const raw = execFileSync('git', ['rev-parse', '--git-path', parts.join('/')], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
  if (!raw) throw new Error(`Git returned no private path for ${parts.join('/')}`)
  return resolve(raw)
}

function compactRunMetrics(manifest) {
  const calls = Array.isArray(manifest?.calls) ? manifest.calls : []
  const policyCalls = Array.isArray(manifest?.policy_calls) ? manifest.policy_calls : []
  const certifications = Array.isArray(manifest?.certifications) ? manifest.certifications : []
  const countBy = (rows, key) => Object.fromEntries([...rows.reduce((map, row) => {
    const value = row?.[key] ?? 'unknown'
    map.set(value, (map.get(value) || 0) + 1)
    return map
  }, new Map())].sort(([a], [b]) => String(a).localeCompare(String(b))))
  const duration = (rows) => rows.reduce((sum, row) =>
    sum + (Number.isFinite(row?.duration_ms) ? row.duration_ms : 0), 0)
  const usage = (rows) => {
    const fields = {
      input_tokens: (row) => row?.tokens?.input,
      cached_read_tokens: (row) => row?.tokens?.cachedRead,
      uncached_input_tokens: (row) => Number.isFinite(row?.tokens?.input) &&
        Number.isFinite(row?.tokens?.cachedRead)
        ? Math.max(0, row.tokens.input - row.tokens.cachedRead) : null,
      output_tokens: (row) => row?.tokens?.output,
      reasoning_tokens: (row) => row?.tokens?.reasoning,
      prompt_bytes: (row) => row?.prompt?.bytes,
      provider_event_count: (row) => row?.telemetry?.eventCount,
      provider_tool_event_count: (row) => row?.telemetry?.toolEventCount,
      provider_event_bytes: (row) => row?.telemetry?.eventBytes,
    }
    return Object.fromEntries(Object.entries(fields).map(([name, read]) => {
      const values = rows.map(read)
      return [name, {
        observed: values.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0),
        unknown_calls: values.filter((value) => !Number.isFinite(value)).length,
      }]
    }))
  }
  const scopes = [...calls.reduce((map, call) => {
    const scope = {
      task: call?.task || null,
      round: Number.isSafeInteger(call?.round) ? call.round : null,
      role: call?.role || 'unknown',
    }
    const key = stableJson(scope)
    if (!map.has(key)) map.set(key, { ...scope, calls: [] })
    map.get(key).calls.push(call)
    return map
  }, new Map()).values()].map((scope) => ({
    task: scope.task, round: scope.round, role: scope.role,
    calls: scope.calls.length, usage: usage(scope.calls),
  })).sort((a, b) => stableJson(a).localeCompare(stableJson(b)))
  return {
    version: 2,
    run_id: manifest?.run_id || null,
    started_at: manifest?.started_at || null,
    updated_at: manifest?.updated_at || null,
    status: manifest?.status || 'unknown',
    provider_calls: calls.length,
    provider_calls_by_role: countBy(calls, 'role'),
    provider_calls_by_status: countBy(calls, 'status'),
    usage_states: countBy(calls, 'usage_state'),
    provider_usage: usage(calls),
    provider_usage_by_scope: scopes,
    provider_duration_ms: duration(calls),
    policy_calls: policyCalls.length,
    policy_duration_ms: duration(policyCalls),
    certifications: countBy(certifications, 'state'),
  }
}

function exportRunMetrics(runPath) {
  const manifestPath = join(runPath, 'manifest.json')
  if (!existsSync(manifestPath)) return false
  let manifest
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) }
  catch { return false }
  let root
  try { root = gitPrivatePath('caw', 'metrics') }
  catch { root = resolve(LOG_DIR, 'metrics') }
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const target = join(root, 'runs.jsonl')
  appendFileSync(target, `${JSON.stringify(compactRunMetrics(manifest))}\n`, { mode: 0o600 })
  try { chmodSync(target, 0o600) } catch { /* platform does not expose POSIX modes */ }
  return true
}

function writeRunManifest(status) {
  if (!runRecord) return
  const manifest = {
    run_id: runRecord.id,
    engine_digest: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    runtime_digest: resolvedRuntime.digest,
    review_independence: resolvedRuntime.independence || [],
    started_at: runRecord.startedAt,
    updated_at: new Date().toISOString(),
    status,
    timeout_ms: AGENT_TIMEOUT_MS,
    provider_budgets: providerBudgetSnapshot(),
    calls: runRecord.calls,
    stages: runRecord.stages || [],
    diagnostics: runRecord.diagnostics,
    gate_evidence: runRecord.gateEvidence || [],
    certifications: runRecord.certifications || [],
    audits: runRecord.audits || [],
    ...(projectPolicySet?.manifestDigest ? {
      project_policies: {
        api_version: projectPolicySet.apiVersion,
        manifest_digest: projectPolicySet.manifestDigest,
        policies: Object.fromEntries(Object.entries(projectPolicySet.policies)
          .map(([stage, policy]) => [stage, { id: policy.id, digest: policy.digest }])),
      },
      policy_calls: runRecord.policyCalls || [],
    } : {}),
    ...(runRecord.population === undefined ? {} : {
      population: runRecord.population,
      population_counts: runRecord.populationCounts,
    }),
    ...(runRecord.populationCache === undefined ? {} : {
      population_cache: runRecord.populationCache,
    }),
    ...(runRecord.risk === undefined ? {} : { risk: runRecord.risk }),
    ...(runRecord.fullGateBaseline === undefined ? {} : {
      full_gate_baseline: runRecord.fullGateBaseline,
    }),
    ...(runRecord.weakVerification === undefined ? {} : {
      weak_verification: runRecord.weakVerification,
    }),
  }
  const target = join(runRecord.path, 'manifest.json')
  const temp = `${target}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, target)
  try { chmodSync(target, 0o600) } catch { /* platform does not expose POSIX modes */ }
}

function pruneRunRecords(now = Date.now()) {
  if (!existsSync(LOG_DIR)) return
  const records = readdirSync(LOG_DIR).filter((name) => name.startsWith('run-')).map((name) => {
    const path = join(LOG_DIR, name), stat = lstatSync(path)
    return { name, path, stat }
  }).filter((entry) => entry.stat.isDirectory() && !entry.stat.isSymbolicLink())
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
  const maxAge = 30 * 24 * 60 * 60 * 1000
  records.forEach((entry, index) => {
    if (index >= 20 || now - entry.stat.mtimeMs > maxAge) {
      try { exportRunMetrics(entry.path) } catch { /* retention cleanup must remain available */ }
      removeTree(entry.path)
    }
  })
}

function beginRunRecord() {
  if (runRecord) return runRecord
  ensureLogDir()
  pruneRunRecords()
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', 'T').replace('Z', 'Z')
  const nonce = createHash('sha256').update(`${process.pid}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 8)
  const id = `run-${stamp}-${process.pid}-${nonce}`
  const path = join(LOG_DIR, id)
  mkdirSync(path, { mode: 0o700 })
  runRecord = { id, path, startedAt: new Date().toISOString(), calls: [], diagnostics: [], stages: [] }
  writeRunManifest('active')
  say(`run record: ${id}`)
  return runRecord
}

function recordStage(kind, name, startedMs, state, detail = {}) {
  const run = beginRunRecord()
  run.stages.push({
    kind,
    name,
    state,
    duration_ms: Math.max(0, Date.now() - startedMs),
    ...detail,
  })
  writeRunManifest(state === 'success' || state === 'green' ? 'active' : 'failed')
}

function beginProviderAttempt(role, provider, binding, invocation, budgetLimits, promptMetrics = {}) {
  reserveProviderBudget(role, budgetLimits)
  const run = beginRunRecord()
  const index = String(run.calls.length + 1).padStart(3, '0')
  const attemptId = `provider-${index}`
  const startedAt = new Date().toISOString()
  const name = `attempt-${index}-${role}.json`
  const inputBytes = Buffer.byteLength(invocation.input || '')
  const usageEstimate = {
    input_tokens: Math.ceil(inputBytes / 4),
    output_tokens: null,
    method: 'utf8-bytes-div-4',
    input_bytes: inputBytes,
  }
  const body = {
    attempt_id: attemptId,
    status: 'started',
    started_at: startedAt,
    role,
    provider: provider.adapter.id,
    adapter_digest: provider.adapter.digest,
    cli_version: provider.cliVersion,
    runtime_digest: resolvedRuntime.digest,
    requested: {
      model: binding.model,
      reasoning: binding.reasoning,
      native: invocation.requestedNative || null,
    },
    usage_estimate: usageEstimate,
    prompt: {
      bytes: promptMetrics.promptBytes ?? null,
      instructions_bytes: promptMetrics.instructionsBytes ?? null,
      dossier: promptMetrics.dossier ?? null,
    },
    task: promptMetrics.task ?? null,
    round: promptMetrics.round ?? null,
    pass: promptMetrics.pass ?? null,
  }
  const bytes = Buffer.from(`${JSON.stringify(body, null, 2)}\n`)
  writePrivateFile(join(run.path, name), bytes, FINAL_VALUE_MAX)
  const entry = {
    attempt_id: attemptId,
    attempt_file: name,
    role,
    provider: provider.adapter.id,
    status: 'started',
    usage_state: 'unknown',
    started_at: startedAt,
    task: body.task,
    round: body.round,
    pass: body.pass,
  }
  run.calls.push(entry)
  writeRunManifest('active')
  return { id: attemptId, index, startedAt, startedMs: Date.now(), entry,
    usageEstimate, prompt: body.prompt, budgetSettled: false }
}

function providerUsageState(result) {
  const tokenValues = Object.values(result.tokens || {})
  const anyTokens = tokenValues.some((value) => typeof value === 'number')
  const allTokens = tokenValues.length > 0 && tokenValues.every((value) => typeof value === 'number')
  if (result.cost !== null && allTokens) return 'reported'
  if (result.cost !== null || anyTokens) return 'partial'
  return 'unknown'
}

function recordProviderCall(role, provider, result, attempt) {
  const run = beginRunRecord()
  const index = attempt.index
  const usageState = providerUsageState(result)
  settleProviderBudget(attempt, result.cost)
  const body = {
    attempt_id: attempt.id,
    status: 'success',
    started_at: attempt.startedAt,
    completed_at: new Date().toISOString(),
    role,
    provider: result.provider,
    task: attempt.entry.task,
    round: attempt.entry.round,
    pass: attempt.entry.pass,
    adapter_digest: provider.adapter.digest,
    cli_version: provider.cliVersion,
    runtime_digest: resolvedRuntime.digest,
    requested: result.requested,
    models: result.models,
    tokens: result.tokens,
    telemetry: result.telemetry,
    prompt: attempt.prompt,
    cost: result.cost,
    duration_ms: result.durationMs,
    usage_state: usageState,
    final_response: result.finalResponse,
  }
  const bytes = Buffer.from(`${JSON.stringify(body, null, 2)}\n`)
  if (bytes.length > FINAL_VALUE_MAX) {
    throw new Error(`successful final provider object is ${bytes.length} bytes; limit is ${FINAL_VALUE_MAX}`)
  }
  const name = `call-${index}-${role}.json`
  writePrivateFile(join(run.path, name), bytes, FINAL_VALUE_MAX)
  Object.assign(attempt.entry, {
    file: name,
    provider: result.provider,
    bytes: bytes.length,
    status: 'success',
    usage_state: usageState,
    tokens: result.tokens,
    telemetry: result.telemetry,
    prompt: attempt.prompt,
    duration_ms: result.durationMs ?? (Date.now() - attempt.startedMs),
    completed_at: new Date().toISOString(),
  })
  recordStage('provider', role, attempt.startedMs, 'success', { attempt_id: attempt.id })
  writeRunManifest('active')
}

function recordProviderFailure(role, provider, result, attempt, failureKind = 'provider-failure',
  observed = null) {
  const run = beginRunRecord()
  const index = attempt.index
  const raw = `${result.stdout || ''}\n${result.stderr || ''}`
  const usageState = observed ? providerUsageState(observed)
    : attempt.usageEstimate ? 'estimated' : 'unknown'
  settleProviderBudget(attempt, observed?.cost ?? null)
  const terminalStatus = failureKind === 'interrupted' ? 'interrupted' : 'failure'
  const body = {
    attempt_id: attempt.id,
    status: terminalStatus,
    failure_kind: failureKind,
    started_at: attempt.startedAt,
    completed_at: new Date().toISOString(),
    role,
    provider: provider.adapter.id,
    task: attempt.entry.task,
    round: attempt.entry.round,
    pass: attempt.entry.pass,
    adapter_digest: provider.adapter.digest,
    cli_version: provider.cliVersion,
    exit_status: result.status,
    signal: result.signal || null,
    error_code: result.error?.code || null,
    usage_state: usageState,
    ...(!observed && attempt.usageEstimate ? { usage_estimate: attempt.usageEstimate } : {}),
    ...(observed ? {
      requested: observed.requested,
      models: observed.models,
      tokens: observed.tokens,
      telemetry: observed.telemetry,
      prompt: attempt.prompt,
      cost: observed.cost,
      duration_ms: observed.durationMs,
    } : {}),
    bytes: Buffer.byteLength(raw),
    sha256: createHash('sha256').update(raw).digest('hex'),
    first: raw.slice(0, 8192),
    last: raw.slice(-8192),
  }
  const name = `failure-${index}-${role}.json`
  const bytes = Buffer.from(`${JSON.stringify(body, null, 2)}\n`)
  writePrivateFile(join(run.path, name), bytes, FINAL_VALUE_MAX)
  Object.assign(attempt.entry, {
    file: name,
    bytes: bytes.length,
    status: terminalStatus,
    failure_kind: failureKind,
    usage_state: usageState,
    ...(observed ? {
      tokens: observed.tokens,
      telemetry: observed.telemetry,
      prompt: attempt.prompt,
    } : {}),
    duration_ms: Date.now() - attempt.startedMs,
    completed_at: new Date().toISOString(),
  })
  recordStage('provider', role, attempt.startedMs, terminalStatus, { attempt_id: attempt.id })
  writeRunManifest('failed')
}

function markInterruptedProviderAttempts(reason) {
  if (!runRecord) return
  const completedAt = new Date().toISOString()
  for (const call of runRecord.calls) {
    if (call.status !== 'started') continue
    let hasEstimate = false
    try {
      const attempt = JSON.parse(readFileSync(join(runRecord.path, call.attempt_file), 'utf8'))
      hasEstimate = Boolean(attempt.usage_estimate)
    } catch { /* an interrupted pre-write remains unknown */ }
    providerBudgetState.unknown_cost_calls += 1
    Object.assign(call, {
      status: 'interrupted',
      failure_kind: reason,
      usage_state: hasEstimate ? 'estimated' : 'unknown',
      completed_at: completedAt,
    })
    const startedMs = Date.parse(call.started_at)
    runRecord.stages.push({
      kind: 'provider', name: call.role, state: 'interrupted',
      duration_ms: Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : null,
      attempt_id: call.attempt_id,
    })
  }
}

function failProviderAttempt(attempt, failureKind, cost = null) {
  settleProviderBudget(attempt, cost)
  Object.assign(attempt.entry, {
    status: 'failure',
    failure_kind: failureKind,
    usage_state: 'unknown',
    duration_ms: Date.now() - attempt.startedMs,
    completed_at: new Date().toISOString(),
  })
  recordStage('provider', attempt.entry.role, attempt.startedMs, 'failure', {
    attempt_id: attempt.id,
  })
  writeRunManifest('failed')
}

function recordEngineDiagnostic(role, kind, diagnostic, attemptId = null) {
  const run = beginRunRecord()
  const index = String(run.diagnostics.length + 1).padStart(3, '0')
  const body = { role, kind, attempt_id: attemptId, ...diagnostic }
  const bytes = Buffer.from(`${JSON.stringify(body, null, 2)}\n`)
  if (bytes.length > ENGINE_DIAGNOSTIC_MAX) {
    throw new Error(`${role} ${kind} diagnostic is ${bytes.length} bytes; limit is ${ENGINE_DIAGNOSTIC_MAX}`)
  }
  const name = `diagnostic-${index}-${role}-${kind}.json`
  writePrivateFile(join(run.path, name), bytes, ENGINE_DIAGNOSTIC_MAX)
  run.diagnostics.push({ file: name, role, kind, attempt_id: attemptId, bytes: bytes.length })
  writeRunManifest('active')
}

function recordPopulationState(state, counts, status = 'active') {
  const run = beginRunRecord()
  run.population = state
  run.populationCounts = counts
  writeRunManifest(status)
}

function retainWeakVerificationEvents(summary, events) {
  const current = summary || { returned: 0, retained: 0, truncated: 0, events: [] }
  const returned = current.returned + events.length
  const room = Math.max(0, WEAK_VERIFICATION_EVENTS_RETAINED - current.events.length)
  const retainedEvents = [...current.events, ...events.slice(0, room)]
  return {
    returned,
    retained: retainedEvents.length,
    truncated: returned - retainedEvents.length,
    events: retainedEvents,
  }
}

function recordWeakVerification(task, round, verification, status = 'active') {
  if (!verification) return
  const run = beginRunRecord()
  const baseline = verification.baseline || {}
  const retainPatch = (entry, index, kind) => {
    if (typeof entry?.patch !== 'string') return entry
    const patch = entry.patch
    const name = `weak-${taskArtifactBase(task)}-round-${round}-${kind}-${index + 1}.patch`
    writePrivateFile(join(run.path, name), Buffer.from(patch), REVIEW_PATCH_MAX)
    delete entry.patch
    entry.patch_file = name
    entry.patch_bytes = Buffer.byteLength(patch)
    entry.patch_sha256 = createHash('sha256').update(patch).digest('hex')
    return entry
  }
  ;(verification.mutations || []).forEach((entry, index) =>
    retainPatch(entry, index, 'mutation'))
  ;(verification.failures || []).forEach((entry, index) =>
    retainPatch(entry, index, 'unavailable'))
  const events = [{
    task,
    round,
    kind: 'baseline',
    state: verification.state,
    gate: baseline.gate ?? null,
    gate_status: baseline.gate_status ?? null,
    gate_output: typeof baseline.gate_output === 'string'
      ? baseline.gate_output.slice(-8000) : '',
  }, ...(verification.mutations || []).map((mutation) => ({
    task,
    round,
    kind: 'mutation',
    ...mutation,
    gate_output: typeof mutation.gate_output === 'string'
      ? mutation.gate_output.slice(-8000) : '',
  })), ...(verification.failures || []).map((failure) => ({
    task,
    round,
    kind: 'mutation-unavailable',
    ...failure,
  }))]
  run.weakVerification = retainWeakVerificationEvents(run.weakVerification, events)
  writeRunManifest(status)
}

function recordTaskCertification({ task, round, criteria, open, author, reviewer, reviewSurface,
  reviewBaseline, weakVerification, gateReceipt = null, acceptanceCases = [], executorClaims = [] }) {
  const run = beginRunRecord()
  const population = activePopulationCertification || {
    state: 'unknown', source: 'no-plan-population-record', digest: null,
  }
  const limitations = []
  if (!['sample', 'complete'].includes(population.state)) {
    limitations.push(`population-${population.state}`)
  }
  if (!author) limitations.push('author-runtime-unobserved')
  if (weakVerification?.state?.startsWith('unverified')) {
    limitations.push(weakVerification.state)
  }
  const state = open.length ? 'rejected' : limitations.length ? 'limited' : 'approved'
  const body = {
    version: 2,
    task,
    round,
    state,
    limitations,
    created_at: new Date().toISOString(),
    delivery_digest: deliveryDigest(),
    independence: resolvedRuntime.independence?.find((entry) => entry.scope === 'task') || null,
    author: author || { kind: 'human-or-prior-unobserved' },
    reviewer,
    population,
    criteria,
    acceptance_cases: acceptanceCases,
    executor_claims: executorClaims,
    gate_receipt: gateReceipt,
    open_item_ids: open.map((item) => item.id),
    review_surface: {
      surface_id: reviewSurface?.id || null,
      baseline_commit: reviewBaseline || null,
    },
    weak_verification: weakVerification,
    project_policies: projectPolicySnapshot(),
  }
  const name = `certification-${taskArtifactBase(task)}-round-${round}.json`
  const bytes = Buffer.from(`${JSON.stringify(body, null, 2)}\n`)
  writePrivateFile(join(run.path, name), bytes, FINAL_VALUE_MAX)
  run.certifications ||= []
  run.certifications.push({
    file: name, task, round, state, limitations, bytes: bytes.length,
  })
  writeRunManifest(state === 'rejected' ? 'failed' : 'active')
  return body
}

function writeTaskAudit(body) {
  const root = gitPrivatePath('caw', 'audit')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const bytes = Buffer.from(`${JSON.stringify(body, null, 2)}\n`)
  if (bytes.length > TASK_AUDIT_MAX) {
    throw new Error(`task audit record is ${bytes.length} bytes; limit is ${TASK_AUDIT_MAX}`)
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  const name = `pending-${digest}.json`
  writePrivateFile(join(root, name), bytes, TASK_AUDIT_MAX)
  const run = beginRunRecord()
  run.audits ||= []
  const entry = {
    task: body.task,
    state: 'pending-commit',
    digest,
    file: name,
    bytes: bytes.length,
  }
  run.audits.push(entry)
  writeRunManifest('active')
  return { root, path: join(root, name), digest, entry }
}

function finalizeTaskAudit(audit, commitHash) {
  const name = `${commitHash}.json`
  const target = join(audit.root, name)
  renameSync(audit.path, target)
  Object.assign(audit.entry, { state: 'committed', commit: commitHash, file: name })
  writeRunManifest('active')
  return target
}

// `.caw-tasks/` holds three kinds of file and only one of them is work to run. `PLAN.md` is
// reserved: it is the plan artifact. notes.log dodges the spec glob with its extension, but a
// plan wants to be markdown, so this is the one name that has to be excluded by hand — and
// excluded by NAME rather than by a `NNN_slug.md` pattern, because a ticket is a spec a human
// wrote and named, and a pattern would silently drop the ones that do not match it.
const PLAN = join(QUEUE_DIR, 'PLAN.md')
const RISK_RECORD = join(QUEUE_DIR, '.risk.json')
const RISK_RECORD_MAX = 64 * 1024

function validateRiskRecord(value) {
  exactObjectKeys(value, [
    'version', 'class', 'population_requirement', 'require_full_gate_baseline',
    'population_attestation', 'population_digest', 'evidence', 'policy_id', 'policy_digest',
    'full_gate_baseline',
  ], 'risk record')
  if (value.version !== 1) throw new Error('risk record version must be 1')
  if (!/^[a-z][a-z0-9.-]{0,63}$/.test(value.class) ||
      !/^[a-z][a-z0-9.-]{0,63}$/.test(value.policy_id)) {
    throw new Error('risk record class or policy id is invalid')
  }
  if (!['none', 'sample', 'complete'].includes(value.population_requirement) ||
      !['none', 'sample', 'complete'].includes(value.population_attestation)) {
    throw new Error('risk record population state is invalid')
  }
  if (typeof value.require_full_gate_baseline !== 'boolean' ||
      !/^[0-9a-f]{64}$/.test(value.population_digest) ||
      !/^[0-9a-f]{64}$/.test(value.policy_digest) || typeof value.evidence !== 'string') {
    throw new Error('risk record fields are invalid')
  }
  if (value.full_gate_baseline !== null) {
    exactObjectKeys(value.full_gate_baseline,
      ['head', 'tree_digest', 'gate', 'state', 'inputs_digest', 'project_inputs_digest'],
      'risk full-gate baseline')
    const baseline = {
      inputs_digest: null,
      project_inputs_digest: null,
      ...value.full_gate_baseline,
    }
    if (!/^[0-9a-f]{40}$/.test(baseline.head) ||
        !/^[0-9a-f]{64}$/.test(baseline.tree_digest) ||
        typeof baseline.gate !== 'string' || baseline.state !== 'green' ||
        !(baseline.inputs_digest === null || /^[0-9a-f]{64}$/.test(baseline.inputs_digest)) ||
        !(baseline.project_inputs_digest === null ||
          /^[0-9a-f]{64}$/.test(baseline.project_inputs_digest))) {
      throw new Error('risk full-gate baseline is invalid')
    }
    value = { ...value, full_gate_baseline: baseline }
  }
  return value
}

function writeRiskRecord(risk) {
  const value = validateRiskRecord({ version: 1, full_gate_baseline: null, ...risk })
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  if (bytes.length > RISK_RECORD_MAX) throw new Error('risk record exceeds its size limit')
  mkdirSync(QUEUE_DIR, { recursive: true, mode: 0o700 })
  const temp = `${RISK_RECORD}.tmp-${process.pid}`
  writeFileSync(temp, bytes, { mode: 0o600 })
  renameSync(temp, RISK_RECORD)
  try { chmodSync(RISK_RECORD, 0o600) } catch { /* platform does not expose POSIX modes */ }
}

function readRiskRecord() {
  if (!existsSync(RISK_RECORD)) return null
  const stat = lstatSync(RISK_RECORD)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > RISK_RECORD_MAX) {
    throw new Error(`${RISK_RECORD} is not a bounded regular file`)
  }
  let value
  try { value = JSON.parse(readFileSync(RISK_RECORD, 'utf8')) }
  catch (error) { throw new Error(`${RISK_RECORD} is invalid JSON: ${error.message}`) }
  return validateRiskRecord(value)
}

function clearRiskRecord() {
  try { unlinkSync(RISK_RECORD) } catch { /* absent */ }
}

const RISK_PLAN_FIELD_NAMES = [
  'risk_class', 'risk_population_requirement', 'risk_population_attestation',
  'risk_population_digest', 'risk_require_full_gate_baseline', 'risk_policy_id',
  'risk_policy_digest',
]

const riskPlanFields = (risk) => ({
  risk_class: risk.class,
  risk_population_requirement: risk.population_requirement,
  risk_population_attestation: risk.population_attestation,
  risk_population_digest: risk.population_digest,
  risk_require_full_gate_baseline: String(risk.require_full_gate_baseline),
  risk_policy_id: risk.policy_id,
  risk_policy_digest: risk.policy_digest,
})

function syncPlanRisk(risk) {
  if (!existsSync(PLAN)) return
  let text = readFileSync(PLAN, 'utf8')
  if (!risk) {
    for (const name of RISK_PLAN_FIELD_NAMES) {
      text = text.replace(new RegExp(`^${name}:.*\\n?`, 'm'), '')
    }
    text = text.replace(
      /^## Project risk attestation\n\n```json\n[\s\S]*?\n```\n*/m,
      '',
    )
    writeFileSync(PLAN, text)
    return
  }
  const fields = riskPlanFields(risk)
  for (const [name, value] of Object.entries(fields)) {
    const line = `${name}: ${value}`
    if (new RegExp(`^${name}:`, 'm').test(text)) {
      text = text.replace(new RegExp(`^${name}:.*$`, 'm'), line)
    } else {
      const frontmatterEnd = text.indexOf('\n---', 4)
      if (frontmatterEnd < 0) throw new Error(`${PLAN} has no closing frontmatter delimiter`)
      text = `${text.slice(0, frontmatterEnd)}\n${line}${text.slice(frontmatterEnd)}`
    }
  }
  const section = [
    '## Project risk attestation', '',
    '```json', JSON.stringify(risk, null, 2), '```', '',
  ].join('\n')
  if (/^## Project risk attestation$/m.test(text)) {
    text = text.replace(
      /^## Project risk attestation\n\n```json\n[\s\S]*?\n```\n*/m,
      section,
    )
  } else {
    const marker = text.match(/^## (?:Population,|Tasks,)/m)?.[0]
    text = marker ? text.replace(marker, `${section}${marker}`) : `${text.trimEnd()}\n\n${section}`
  }
  writeFileSync(PLAN, text)
}

function applyRiskPopulationCertification(risk) {
  activePopulationCertification = {
    ...activePopulationCertification,
    ...(risk.population_attestation === 'complete' ? { state: 'complete' } : {}),
    project_attestation: {
      state: risk.population_attestation,
      evidence: risk.evidence,
      policy_id: risk.policy_id,
      policy_digest: risk.policy_digest,
    },
  }
}

function requireCurrentRiskPolicy(risk) {
  const planningPolicy = projectPolicySet?.policies?.planning
  if (!planningPolicy || planningPolicy.digest !== risk.policy_digest) {
    die('project risk policy changed or disappeared after attestation; run review-specs again')
  }
  return planningPolicy
}

function requireMatchingPlanRisk(planText, risk) {
  if (!/^risk_class:\s*\S+/m.test(planText || '')) return
  const planField = (name) => planText.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim()
  const mismatch = Object.entries(riskPlanFields(risk))
    .find(([name, value]) => planField(name) !== value)
  if (mismatch) die(`${PLAN} and ${RISK_RECORD} disagree at ${mismatch[0]}; run review-specs again`)
}

// Where a task's review history waits between invocations, so that a run stopping to ask the
// human is not the same event as the run forgetting what it asked. One file per spec, created
// only at a stop and removed by the commit that ends the task.
//
// `.caw-tasks/` rather than `.caw-logs/`, and the directory is chosen by three properties it already
// has rather than by convenience. `changedFiles()` filters it, so the file cannot make the tree
// dirty and stop the `build` that resumes; `commit()` resets it out of the index, so it cannot
// reach a commit; and `specFiles()` takes only `*.md`, so a `.json` here is not a task. What
// `.caw-logs/` has instead is `require_caw_log.py` pruning it to the newest twenty files, which
// is right for logs and fatal for state — a busy afternoon would delete the answer to a
// question the human had not got to yet.
const roundStatePath = (file) => join(QUEUE_DIR, `.round-${file.replace(/[^\w.-]+/g, '_')}.json`)

// A state file that cannot be read is treated as absent, deliberately. It carries no work — the
// work is in the tree and the spec is on disk — so the worst a corrupt one costs is a reviewer
// that starts from a clean sheet, which is exactly what every round did before this existed.
// Dying here would instead strand a task whose tree nothing else can judge.
function readRoundState(file) {
  const p = roundStatePath(file)
  if (!existsSync(p)) return null
  try {
    if (lstatSync(p).size > ROUND_STATE_MAX) {
      die(`${p} exceeds the ${ROUND_STATE_MAX}-byte round-state limit; refusing partial recovery`)
    }
    const s = JSON.parse(readFileSync(p, 'utf8'))
    if (!Array.isArray(s?.history)) die(`${p} has no review history; refusing partial recovery`)
    if (s.state_version >= 2) s.accounting = normalizeAccounting(s.accounting)
    else if (typeof s.spent === 'number') {
      s.accounting = normalizeAccounting(s.spent)
      s.runtime_provenance = 'legacy-unknown'
    }
    if ((s.state_version || 0) < 5) {
      for (const item of s.history) {
        item.evidence_refs ||= []
        item.criterion_ids ||= []
        item.surface_ids ||= []
        item.transition_ids ||= []
        item.property_key ||= null
        item.work_package_id ||= groupFindings([item])[0].id
      }
      s.state_version = 5
    }
    return s
  } catch (error) {
    die(`${p} cannot be recovered: ${(error?.message || error).toString().split('\n')[0]}`)
  }
}

function writeRoundState(file, state) {
  const target = roundStatePath(file)
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`)
  if (bytes.length > ROUND_STATE_MAX) {
    die(`review history for ${file} is ${bytes.length} bytes; limit is ${ROUND_STATE_MAX}`)
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  const temp = `${target}.tmp-${process.pid}-${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 8)}`
  let fd = null
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, bytes)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(temp, target)
    chmodSync(target, 0o600)
  } catch (error) {
    if (fd !== null) try { closeSync(fd) } catch { /* closing failed state */ }
    try { unlinkSync(temp) } catch { /* never created or already renamed */ }
    die(`could not save review history for ${file}: ${(error?.message || error).toString().split('\n')[0]}`)
  }
}

const clearRoundState = (file) => { try { unlinkSync(roundStatePath(file)) } catch { /* never written */ } }

// What makes two specs "the same spec", and deliberately not byte equality. A Windows working
// tree holds CRLF, so an editor rewriting line endings on save would trip a queue nobody
// meaningfully touched — measured on this tool's own files, where identical content hashed
// differently across platforms. Trailing whitespace goes for the same reason: a spec differing
// only in it is the same spec, and a check that fires there is one people learn to ignore.
function specDigest(text) {
  const flat = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')
  return createHash('sha256').update(flat).digest('hex').slice(0, 12)
}

const APPROVED_HEAD = '## Approved — the queue as it was judged'

// Returns null when the plan carries no such section: every plan approved before this existed,
// and every hand-written ticket, which has no PLAN.md at all. Both must stay silent rather than
// read as tampering.
function approvedDigests(plan) {
  const after = plan.split(APPROVED_HEAD)[1]
  if (after === undefined) return null
  const out = new Map()
  for (const line of after.split('\n## ')[0].split('\n')) {
    const m = line.match(/^- (\S+)\s+([0-9a-f]{12})$/)
    if (m) out.set(m[1], m[2])
  }
  return out.size ? out : null
}

const specFiles = () =>
  existsSync(QUEUE_DIR)
    ? readdirSync(QUEUE_DIR).filter((x) => x.endsWith('.md') && x !== 'PLAN.md').sort()
    : []

const dumpNotes = () => {
  if (!notes.length || !existsSync(QUEUE_DIR)) return null
  appendFileSync(NOTES_LOG, `\n## ${new Date().toISOString()}\n\n${notes.map((n) => `- ${n}`).join('\n')}\n`)
  return NOTES_LOG
}

// A reader reads only what it knows about. This log's reader is a human or a later session
// picking up after a run died, and until now the only thing that ever mentioned the file was
// one line printed at the moment of death — so the record survived and the knowledge of it did
// not. `plan` and `build` therefore announce it on the way in.
const noticeNotesLog = () => {
  if (!existsSync(NOTES_LOG)) return
  const text = readFileSync(NOTES_LOG, 'utf8')
  const count = (text.match(/^- /gm) || []).length
  const when = (text.match(/^## (.+)$/gm) || []).slice(-1)[0]?.slice(3) || 'an earlier run'
  say(`· ${NOTES_LOG}: ${count} note(s) from a run that died, last ${when}. Read it before you decide.`)
}

// `.caw-tasks/notes.log` is written by `die` and by nothing else, so a run that reaches the end
// never wrote it: the file it would find belongs to an EARLIER run that died. Not necessarily
// one that committed nothing — an earlier draft of this comment said so and a third install
// disproved it, holding 33 notes from a run whose five tasks are all committed, so it died
// after its queue rather than before it. This used to delete it on the way
// out, saying "this build committed everything it had to say" — a claim about the wrong run,
// used to justify destroying the other one's only record of why it failed.
//
// Nothing deletes it now. It is the project's file: `noticeNotesLog()` announces it with a
// count and a date at the start of every plan and build, and what to do about it is a decision
// this tool has no standing to make on a project's behalf. The notice repeating until someone
// deals with it is the correct pressure, and `rm` is the whole remedy.

const die = (msg) => {
  console.error(`\ncaw: ${msg}\n`)
  if (notes.length) {
    const path = dumpNotes()
    console.error(`Noticed before this stopped${path ? ` — appended to ${path}` : ', recorded nowhere'}:\n`)
    notes.forEach((n) => console.error(`  - ${n}`))
    console.error('')
  }
  if (hasAccounting(accounting)) console.error(`  spent ${formatAccounting(accounting)}\n`)
  process.exit(1)
}
const say = (msg) => console.log(msg)
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' })
const headCommit = () => { try { return git('rev-parse', 'HEAD').trim() } catch { return null } }

// The queue lived at `tasks/` until it moved under the `.caw-` prefix, because a bare `tasks/`
// is a name the target repository is entitled to own — an Ansible role requires one, and the
// guards would then refuse the operator's own edits to their own files. An install that still
// holds specs at the old path is not migrated: silently reading the new path would leave that
// work queued forever, so this refuses and says where the specs are.
function legacyQueueRefusal() {
  if (!existsSync('tasks') || existsSync(QUEUE_DIR)) return
  let held = []
  try { held = readdirSync('tasks').filter((x) => x.endsWith('.md')) } catch { return }
  if (!held.length) return
  die(`tasks/ holds ${held.length} file(s) and the queue is now ${QUEUE_DIR}/:\n` +
    held.map((x) => `  - tasks/${x}`).join('\n') +
    `\n\nThis directory is no longer read. Move what is still queued and re-run:\n` +
    `  git mv tasks ${QUEUE_DIR}    # or: mv tasks ${QUEUE_DIR}\n\n` +
    `If tasks/ belongs to this project rather than to CAW, leave it and delete nothing — ` +
    `${QUEUE_DIR}/ is the only path CAW reads or defends.`)
}

function profile(preflight = true) {
  if (!existsSync('.caw/CAW.md')) die('no .caw/CAW.md here — run from the project root')
  const text = readFileSync('.caw/CAW.md', 'utf8')
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  if (!m) die('.caw/CAW.md has no frontmatter block')
  const f = {}
  for (const line of m[1].split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf(':')
    if (i > 0) f[t.slice(0, i).trim()] = t.slice(i + 1).trim()
  }
  // An absent gate is the one misconfiguration that fails silently in the dangerous
  // direction: gate() treats an empty command as green, so every task would pass a gate
  // that never ran and be committed on it.
  if (!f.gate_fast) die('.caw/CAW.md sets no gate_fast — refusing to run a pipeline with no gate')
  for (const key of ['gate_fast_timeout_ms', 'gate_full_timeout_ms']) {
    if (f[key] === undefined || f[key] === '') {
      f[key] = null
      continue
    }
    const ms = Number(f[key])
    if (!Number.isSafeInteger(ms) || ms <= 0 || ms > GATE_TIMEOUT_MAX_MS) {
      die(`.caw/CAW.md ${key} must be a positive whole number of milliseconds no greater than ` +
        `${GATE_TIMEOUT_MAX_MS} — got "${f[key]}"`)
    }
    f[key] = ms
  }
  f.index_format = f.index_format || 'text-v0'
  if (!['text-v0', 'json-v1'].includes(f.index_format)) {
    die(`.caw/CAW.md index_format must be text-v0 or json-v1 — got "${f.index_format}"`)
  }
  const weakControls = ['weak_source_probe_cmd', 'weak_positive_control_cmd']
    .filter((key) => Boolean(f[key]))
  if (weakControls.length === 1) {
    die('.caw/CAW.md must configure weak_source_probe_cmd and weak_positive_control_cmd together')
  }
  for (const key of ['planning_independence', 'task_independence']) {
    f[key] = f[key] || 'same-provider'
    if (!['same-provider', 'different-model', 'cross-vendor', 'human-review'].includes(f[key])) {
      die(`.caw/CAW.md ${key} must be same-provider, different-model, cross-vendor, or ` +
        `human-review — got "${f[key]}"`)
    }
  }
  if (f.review_challenger_passes === undefined || f.review_challenger_passes === '') {
    f.review_challenger_passes = DEFAULT_REVIEW_CHALLENGER_PASSES
  } else {
    const passes = Number(f.review_challenger_passes)
    if (!Number.isSafeInteger(passes) || passes < 0 || passes > MAX_REVIEW_CHALLENGER_PASSES) {
      die(`.caw/CAW.md review_challenger_passes must be a whole number from 0 to ` +
        `${MAX_REVIEW_CHALLENGER_PASSES} — got "${f.review_challenger_passes}"`)
    }
    f.review_challenger_passes = passes
  }
  if (f.require_role_smoke === undefined || f.require_role_smoke === '') {
    f.require_role_smoke = false
  } else if (!['true', 'false'].includes(f.require_role_smoke)) {
    die(`.caw/CAW.md require_role_smoke must be true or false — got "${f.require_role_smoke}"`)
  } else {
    f.require_role_smoke = f.require_role_smoke === 'true'
  }
  try {
    f.provider_budgets = resolveProviderBudgets(f)
    providerBudgetState.limits = f.provider_budgets
  }
  catch (error) { die(`.caw/CAW.md ${error?.message || error}`) }
  legacyQueueRefusal()
  if (preflight) preflightRuntime(f)
  return { f, text }
}

function roleBody(role) {
  const p = `.caw/agents/${role}.md`
  if (!existsSync(p)) die(`missing ${p}`)
  return readFileSync(p, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim()
}

const PIPELINE_INVARIANTS = [
  '## Pipeline invariants',
  '',
  'The engine owns role selection, schemas, gates, retries, persisted rounds and Git delivery.',
  'Return only the canonical value for this role. Never route to another provider or alter the queue.',
].join('\n')

function assembledInstructions(role, binding, provider, language) {
  const descriptor = provider.adapter.describe({ role, cliVersion: provider.cliVersion })
  const facts = Object.entries(descriptor.guarantees).map(([key, value]) =>
    `- ${key}: ${value.state}`).join('\n')
  return [
    PIPELINE_INVARIANTS,
    roleBody(role),
    `## Capabilities\n\nProvider: ${binding.provider}\n${facts}`,
    `## Language\n\nWrite every artifact — specs, summaries, notes, fixes — in ` +
      `${language || 'English'}, whatever language preference this machine or the request carries.`,
  ].join('\n\n')
}

const inside = (root, candidate) => {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

const surfaceGit = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
})

function reviewDependencies(f, deliveryRoot) {
  const roots = (f.review_dependency_roots || '').split(',').map((x) => x.trim()).filter(Boolean)
  return roots.map((entry) => {
    if (isAbsolute(entry) || entry.split(/[\\/]+/).includes('..')) {
      die(`review_dependency_roots contains an unsafe path: ${entry}`)
    }
    const lexical = resolve(deliveryRoot, entry)
    if (!inside(deliveryRoot, lexical) || !existsSync(lexical)) {
      die(`review dependency is missing or leaves the repository: ${entry}`)
    }
    try { surfaceGit(deliveryRoot, 'check-ignore', '-q', '--', entry) }
    catch { die(`review dependency must be ignored by Git: ${entry}`) }
    return { entry, canonical: realpathSync(lexical) }
  })
}

function deliveryDigest() {
  const hash = createHash('sha256')
  const pathspec = ['--', '.', `:(exclude)${QUEUE_DIR}`, `:(exclude)${LOG_DIR}`]
  hash.update(execFileSync('git', ['diff', '--binary', 'HEAD', ...pathspec], {
    maxBuffer: 256 * 1024 * 1024,
  }))
  const untracked = execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).split('\0').filter(Boolean)
    .filter((p) => !p.startsWith(`${QUEUE_DIR}/`) && !p.startsWith(`${LOG_DIR}/`))
    .sort()
  for (const path of untracked) {
    const st = lstatSync(path)
    hash.update(`\0${path}\0${st.mode}\0`)
    hash.update(st.isSymbolicLink() ? realpathSync(path) : readFileSync(path))
  }
  return hash.digest('hex')
}

function deliverySnapshotDigest() {
  const hash = createHash('sha256')
  const listed = new Set()
  const collect = (args) => {
    let raw = ''
    try { raw = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) }
    catch { return }
    for (const path of raw.split('\0').filter(Boolean)) listed.add(path)
  }
  collect(['ls-tree', '-rz', '--name-only', 'HEAD'])
  collect(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  for (const path of [...listed].sort()) {
    if (path.startsWith(`${QUEUE_DIR}/`) || path.startsWith(`${LOG_DIR}/`)) continue
    hash.update(`\0${path}\0`)
    if (!existsSync(path)) {
      hash.update('missing\0')
      continue
    }
    const stat = lstatSync(path)
    hash.update(`${stat.mode & 0o7777}\0`)
    if (stat.isSymbolicLink()) hash.update(`symlink\0${readlinkSync(path)}`)
    else if (stat.isFile()) hash.update(readFileSync(path))
    else if (stat.isDirectory()) {
      try { hash.update(`gitlink\0${execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()}`) }
      catch { hash.update('directory\0') }
    } else hash.update(`other\0${stat.mode}`)
  }
  return hash.digest('hex')
}

function ignoredReadDenials(deliveryRoot, dependencies) {
  const allowed = dependencies.map((d) => resolve(deliveryRoot, d.entry))
  const raw = surfaceGit(deliveryRoot, 'status', '--ignored', '--porcelain=v1', '-z')
  const out = []
  for (const record of raw.split('\0').filter(Boolean)) {
    if (!record.startsWith('!! ')) continue
    const lexical = resolve(deliveryRoot, record.slice(3).replace(/\/$/, ''))
    if (allowed.some((root) => inside(root, lexical))) continue
    if (existsSync(lexical)) out.push(realpathSync(lexical))
  }
  return [...new Set(out)]
}

// Some dependency managers make cached directories read-only. Removing one of CAW's own
// temporary trees then fails because unlinking a child requires write permission on its parent.
// Restore owner access on directories only, never follow symlinks, and retry the removal.
function removeTree(path) {
  try {
    rmSync(path, { recursive: true, force: true })
    return
  } catch (error) {
    if (!['EACCES', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error
  }
  const pending = [path]
  while (pending.length) {
    const current = pending.pop()
    let stat
    try { stat = lstatSync(current) } catch { continue }
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue
    try { chmodSync(current, (stat.mode & 0o7777) | 0o700) } catch { /* no POSIX modes */ }
    let names = []
    try { names = readdirSync(current) } catch { continue }
    for (const name of names) pending.push(join(current, name))
  }
  rmSync(path, { recursive: true, force: true })
}

function removeReviewSurface(surface) {
  if (!surface) return
  ACTIVE_REVIEW_SURFACES.delete(surface.parent)
  try { removeTree(surface.parent) } catch { /* retained by the OS */ }
}

function pruneInvocationScratch() {
  mkdirSync(INVOCATION_SCRATCH_PARENT, { recursive: true, mode: 0o700 })
  try { chmodSync(INVOCATION_SCRATCH_PARENT, 0o700) } catch { /* no POSIX modes */ }
  for (const name of readdirSync(INVOCATION_SCRATCH_PARENT)) {
    if (!name.startsWith('scratch-')) continue
    const parent = join(INVOCATION_SCRATCH_PARENT, name)
    let manifest
    try {
      const stat = lstatSync(parent)
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue
      manifest = JSON.parse(readFileSync(join(parent, 'manifest.json'), 'utf8'))
    } catch {
      removeTree(parent)
      continue
    }
    let alive = false
    if (Number.isInteger(manifest?.pid)) {
      try { process.kill(manifest.pid, 0); alive = true } catch { /* dead creator */ }
    }
    if (!alive) removeTree(parent)
  }
}

function createInvocationScratch(role) {
  mkdirSync(INVOCATION_SCRATCH_PARENT, { recursive: true, mode: 0o700 })
  const parent = mkdtempSync(join(INVOCATION_SCRATCH_PARENT, 'scratch-'))
  const scratchRoot = join(parent, 'provider-tmp')
  mkdirSync(scratchRoot, { mode: 0o700 })
  writeFileSync(join(parent, 'manifest.json'), `${JSON.stringify({
    version: 1,
    scratch_id: parent.split(/[\\/]/).pop(),
    role,
    pid: process.pid,
    created_at: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 })
  ACTIVE_INVOCATION_SCRATCH.add(parent)
  return { parent, scratchRoot }
}

function removeInvocationScratch(scratch) {
  if (!scratch) return
  ACTIVE_INVOCATION_SCRATCH.delete(scratch.parent)
  if (!existsSync(scratch.parent)) return
  const canonicalParent = realpathSync(INVOCATION_SCRATCH_PARENT)
  const canonical = realpathSync(scratch.parent)
  if (!inside(canonicalParent, canonical)) throw new Error('invocation scratch leaves its dedicated parent')
  removeTree(canonical)
}

function apparentSurfaceBytes(root) {
  if (!existsSync(root)) return 0
  let total = 0
  const pending = [root]
  while (pending.length) {
    const path = pending.pop()
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) continue
    total += stat.size
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) pending.push(join(path, name))
    }
  }
  return total
}

function adapterTransportPath(name) {
  if (typeof name !== 'string' || !/^transport-[\w.-]+$/.test(name) || name === 'transport-..') return null
  return join(ADAPTER_TRANSPORT_PARENT, name)
}

function removeAdapterTransport(path) {
  if (!existsSync(path)) return
  const parent = realpathSync(ADAPTER_TRANSPORT_PARENT)
  const canonical = realpathSync(path)
  if (!inside(parent, canonical)) throw new Error('adapter transport leaves its retention parent')
  removeTree(canonical)
}

function scrubTransportSensitivePath(root, entry) {
  if (typeof entry !== 'string' || !entry || isAbsolute(entry)) return false
  const target = resolve(root, entry)
  if (!inside(root, target)) return false
  let cursor = root
  for (const part of relative(root, target).split(sep)) {
    cursor = join(cursor, part)
    if (!existsSync(cursor)) return true
    if (lstatSync(cursor).isSymbolicLink()) return false
  }
  const stat = lstatSync(target)
  if (!stat.isFile()) return false
  unlinkSync(target)
  return true
}

function writeTransportManifest(root, manifest) {
  const path = join(root, 'manifest.json')
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  renameSync(temp, path)
  try { chmodSync(path, 0o600) } catch { /* no POSIX modes */ }
}

function pruneAdapterTransports(now = Date.now()) {
  mkdirSync(ADAPTER_TRANSPORT_PARENT, { recursive: true, mode: 0o700 })
  try { chmodSync(ADAPTER_TRANSPORT_PARENT, 0o700) } catch { /* no POSIX modes */ }
  const retained = []
  for (const name of readdirSync(ADAPTER_TRANSPORT_PARENT)) {
    const root = adapterTransportPath(name)
    if (!root) continue
    const stat = lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue
    let manifest
    try {
      const manifestStat = lstatSync(join(root, 'manifest.json'))
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 64 * 1024) {
        throw new Error('invalid manifest file')
      }
      manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
      if (manifest?.version !== 1 || manifest.transport_id !== name ||
          !Number.isInteger(manifest.pid) || typeof manifest.created_at !== 'string' ||
          typeof manifest.updated_at !== 'string' || !Array.isArray(manifest.sensitive_paths) ||
          !['active', 'interrupted', 'failure'].includes(manifest.state)) {
        throw new Error('invalid manifest fields')
      }
    } catch {
      removeAdapterTransport(root)
      say(`  pruned adapter transport ${name}: missing or malformed manifest`)
      continue
    }
    if (manifest.state === 'active') {
      let alive = false
      try { process.kill(manifest.pid, 0); alive = true } catch { /* dead creator */ }
      if (alive) continue
      manifest.state = 'interrupted'
      manifest.updated_at = new Date(now).toISOString()
    }
    const scrubbed = manifest.sensitive_paths.every((entry) =>
      scrubTransportSensitivePath(root, entry))
    if (!scrubbed) {
      removeAdapterTransport(root)
      say(`  pruned adapter transport ${name}: unsafe sensitive path`)
      continue
    }
    manifest.sensitive_paths = []
    writeTransportManifest(root, manifest)
    const bytes = apparentSurfaceBytes(root)
    if (bytes > ADAPTER_TRANSPORT_MAX) {
      removeAdapterTransport(root)
      say(`  pruned adapter transport ${name}: ${bytes} bytes exceeds ${ADAPTER_TRANSPORT_MAX}`)
      continue
    }
    retained.push({ root, name, time: Date.parse(manifest.updated_at || manifest.created_at) || stat.mtimeMs })
  }
  retained.sort((a, b) => b.time - a.time)
  retained.forEach((entry, index) => {
    const reason = now - entry.time > ADAPTER_TRANSPORT_MAX_AGE_MS ? 'older than 24 hours'
      : index >= ADAPTER_TRANSPORT_MAX_COUNT ? 'outside newest 3 interrupted transports'
      : null
    if (!reason) return
    removeAdapterTransport(entry.root)
    say(`  pruned adapter transport ${entry.name}: ${reason}`)
  })
}

function writeSurfaceManifest(surface, state, reason = '') {
  const manifest = {
    surface_id: surface.id,
    source_repository: surface.deliveryRoot,
    pid: process.pid,
    created_at: surface.createdAt,
    updated_at: new Date().toISOString(),
    state,
    reason: reason.slice(0, 2000),
    apparent_bytes: apparentSurfaceBytes(surface.parent),
    scratch_root: surface.scratchRoot && relative(surface.parent, surface.scratchRoot),
    dependency_symlinks: surface.dependencies.map((dependency) => dependency.entry),
    ...(surface.weakGate ? { weak_gate: surface.weakGate } : {}),
  }
  writeFileSync(join(surface.parent, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  })
  try { chmodSync(join(surface.parent, 'manifest.json'), 0o600) } catch { /* no POSIX modes */ }
  return manifest
}

function retainReviewSurface(surface, state, reason) {
  if (!surface || !existsSync(surface.parent)) return
  ACTIVE_REVIEW_SURFACES.delete(surface.parent)
  try { writeSurfaceManifest(surface, state, reason) } catch { /* the directory itself remains */ }
  try { pruneReviewSurfaces() } catch { /* retention must not replace the primary failure */ }
}

function pruneReviewSurfaces(now = Date.now()) {
  mkdirSync(REVIEW_SURFACE_PARENT, { recursive: true, mode: 0o700 })
  try { chmodSync(REVIEW_SURFACE_PARENT, 0o700) } catch { /* no POSIX modes */ }
  const retained = []
  for (const name of readdirSync(REVIEW_SURFACE_PARENT)) {
    const parent = join(REVIEW_SURFACE_PARENT, name)
    const stat = lstatSync(parent)
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue
    let manifest
    try { manifest = JSON.parse(readFileSync(join(parent, 'manifest.json'), 'utf8')) }
    catch { manifest = { state: 'failure', created_at: new Date(stat.mtimeMs).toISOString() } }
    if (manifest.state === 'active') {
      let alive = false
      try { process.kill(manifest.pid, 0); alive = true } catch { /* dead creator */ }
      if (alive) continue
      manifest.state = 'interrupted'
      manifest.updated_at = new Date().toISOString()
      writeFileSync(join(parent, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    }
    retained.push({ parent, name, time: Date.parse(manifest.updated_at || manifest.created_at) || stat.mtimeMs })
  }
  retained.sort((a, b) => b.time - a.time)
  const maxAge = 24 * 60 * 60 * 1000
  retained.forEach((entry, index) => {
    const reason = now - entry.time > maxAge ? 'older than 24 hours'
      : index >= 3 ? 'outside newest 3 failed surfaces'
      : null
    if (!reason) return
    const canonical = realpathSync(entry.parent)
    if (!inside(realpathSync(REVIEW_SURFACE_PARENT), canonical)) return
    removeTree(canonical)
    say(`  pruned review surface ${entry.name}: ${reason}`)
  })
}

// Keep evidence beside the writable Git and provider roots, so the existing outer boundary
// grants reads but denies overwrites, chmod and removal. Never expose the rest of the run log.
function stageReviewGateArtifacts(surface, receipt) {
  if (!receipt?.artifacts?.length) return []
  if (!runRecord) throw new Error('gate artifacts have no owning run record')
  const root = join(surface.parent, 'gate-evidence')
  mkdirSync(root, { mode: 0o700 })
  return receipt.artifacts.map((artifact, index) => {
    const source = gateEvidenceArtifactPath(resolve(runRecord.path), artifact.private_file)
    if (source.size !== artifact.bytes || source.size > GATE_EVIDENCE_ARTIFACT_MAX) {
      throw new Error(`retained gate artifact ${artifact.id} changed size`)
    }
    const bytes = readFileSync(source.path)
    if (bytes.length !== artifact.bytes ||
        createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
      throw new Error(`retained gate artifact ${artifact.id} changed after the gate`)
    }
    const path = join(root, `artifact-${String(index + 1).padStart(3, '0')}.bin`)
    writePrivateFile(path, bytes, GATE_EVIDENCE_ARTIFACT_MAX)
    return { id: artifact.id, path, bytes: bytes.length, sha256: artifact.sha256 }
  })
}

function createReviewSurface(f, gateReceipt = null) {
  const deliveryRoot = realpathSync(process.cwd())
  if (surfaceGit(deliveryRoot, 'ls-files', '--stage').split('\n')
    .some((line) => line.startsWith('160000 '))) {
    die('review surface refuses populated submodules until their overlay is probed')
  }
  const dependencies = reviewDependencies(f, deliveryRoot)
  pruneReviewSurfaces()
  const parent = mkdtempSync(join(REVIEW_SURFACE_PARENT, 'surface-'))
  const workingRoot = join(parent, 'delivery')
  const scratchRoot = join(parent, 'provider-tmp')
  mkdirSync(scratchRoot, { mode: 0o700 })
  const surface = {
    id: parent.split(/[\\/]/).pop(), parent, workingRoot, scratchRoot, deliveryRoot, dependencies,
    deniedReadPaths: [], createdAt: new Date().toISOString(),
  }
  ACTIVE_REVIEW_SURFACES.set(parent, surface)
  writeSurfaceManifest(surface, 'active')
  try {
    surfaceGit(parent, 'clone', '--quiet', '--no-hardlinks', deliveryRoot, workingRoot)
    surfaceGit(workingRoot, 'remote', 'remove', 'origin')
    const patch = execFileSync('git', [
      'diff', '--binary', 'HEAD', '--', '.', `:(exclude)${QUEUE_DIR}`, `:(exclude)${LOG_DIR}`,
    ], { cwd: deliveryRoot, maxBuffer: 256 * 1024 * 1024 })
    if (patch.length) execFileSync('git', ['apply', '--binary', '-'], { cwd: workingRoot, input: patch })
    const untracked = surfaceGit(deliveryRoot, 'ls-files', '-z', '--others', '--exclude-standard')
      .split('\0').filter(Boolean)
      .filter((p) => !p.startsWith(`${QUEUE_DIR}/`) && !p.startsWith(`${LOG_DIR}/`))
    for (const path of untracked) {
      const target = join(workingRoot, path)
      mkdirSync(dirname(target), { recursive: true })
      cpSync(join(deliveryRoot, path), target, { preserveTimestamps: true })
    }
    for (const dependency of dependencies) {
      const target = join(workingRoot, dependency.entry)
      if (existsSync(target)) die(`review dependency collides with delivery content: ${dependency.entry}`)
      mkdirSync(dirname(target), { recursive: true })
      symlinkSync(dependency.canonical, target, 'dir')
      const exclude = surfaceGit(workingRoot, 'rev-parse', '--git-path', 'info/exclude').trim()
      appendFileSync(join(workingRoot, exclude), `\n/${dependency.entry.replace(/\\/g, '/')}\n`)
    }
    surface.gateArtifacts = stageReviewGateArtifacts(surface, gateReceipt)
    surface.deniedReadPaths = ignoredReadDenials(deliveryRoot, dependencies)
    const bytes = apparentSurfaceBytes(parent)
    if (bytes > REVIEW_SURFACE_MAX) {
      throw new Error(`review surface is ${bytes} bytes; limit is ${REVIEW_SURFACE_MAX}`)
    }
    writeSurfaceManifest(surface, 'active')
    return surface
  } catch (error) {
    retainReviewSurface(surface, 'failure', error?.message || String(error))
    throw error
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    for (const surface of ACTIVE_REVIEW_SURFACES.values()) retainReviewSurface(surface, 'interrupted', signal)
    process.exit(128 + (signal === 'SIGINT' ? 2 : 15))
  })
}
process.once('exit', (code) => {
  for (const parent of ACTIVE_INVOCATION_SCRATCH) {
    try { removeTree(parent) } catch { /* next command prunes it */ }
  }
  for (const surface of ACTIVE_REVIEW_SURFACES.values()) {
    retainReviewSurface(surface, 'interrupted', 'process exited before cleanup')
  }
  if (runRecord) {
    try {
      markInterruptedProviderAttempts(code === 0 ? 'process-ended' : 'process-failed')
      writeRunManifest(code === 0 ? 'completed' : 'failed')
    } catch { /* preserve exit */ }
  }
})

function schemaFailure(role, path, message) {
  die(`${role} returned invalid canonical output at ${path}: ${message}`)
}

function canonicalIssue(schema, value, path = '$') {
  if (Array.isArray(schema.anyOf)) {
    const issues = schema.anyOf.map((branch) => canonicalIssue(branch, value, path))
    if (issues.some((issue) => issue === null)) return null
    return { path, message: `did not match any admitted shape (${issues.map((issue) =>
      `${issue.path}: ${issue.message}`).join('; ')})` }
  }
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    return { path, message: `expected one of ${schema.enum.map(JSON.stringify).join(', ')}` }
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { path, message: `expected object, got ${value === null ? 'null' : typeof value}` }
    }
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        return { path: `${path}.${key}`, message: 'required field is missing' }
      }
    }
    const properties = schema.properties || {}
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).find((key) => !Object.prototype.hasOwnProperty.call(properties, key))
      if (extra) return { path: `${path}.${extra}`, message: 'unknown field' }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const issue = canonicalIssue(child, value[key], `${path}.${key}`)
        if (issue) return issue
      }
    }
    return null
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return { path, message: `expected array, got ${typeof value}` }
    for (const [index, item] of value.entries()) {
      const issue = canonicalIssue(schema.items || {}, item, `${path}[${index}]`)
      if (issue) return issue
    }
    return null
  }
  if (schema.type === 'string' && typeof value !== 'string') {
    return { path, message: `expected string, got ${value === null ? 'null' : typeof value}` }
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') {
    return { path, message: `expected boolean, got ${value === null ? 'null' : typeof value}` }
  }
  if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    return { path, message: 'expected finite number' }
  }
  return null
}

function exactObjectKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  const extra = Object.keys(value).filter((key) => !allowed.includes(key))
  if (extra.length) throw new TypeError(`${label} has unknown field(s): ${extra.join(', ')}`)
}

function projectPolicyTreeDigest(policyRoot) {
  let bytes = 0
  const hash = createHash('sha256')
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const stat = lstatSync(path)
      const rel = relative(policyRoot, path).split(sep).join('/')
      if (stat.isSymbolicLink()) throw new Error(`project policy tree contains symlink: ${rel}`)
      if (stat.isDirectory()) {
        hash.update(`directory\0${rel}\0${stat.mode & 0o777}\0`)
        visit(path)
      } else if (stat.isFile()) {
        bytes += stat.size
        if (bytes > PROJECT_POLICY_FILES_MAX) {
          throw new Error(`project policy files exceed ${PROJECT_POLICY_FILES_MAX} bytes`)
        }
        hash.update(`file\0${rel}\0${stat.mode & 0o777}\0`)
        hash.update(readFileSync(path))
      } else {
        throw new Error(`project policy tree contains unsupported entry: ${rel}`)
      }
    }
  }
  visit(policyRoot)
  return hash.digest('hex')
}

function projectPolicyStateDigest(root = process.cwd()) {
  const repositoryRoot = realpathSync(root)
  const hash = createHash('sha256')
  hash.update(`delivery\0${deliveryDigest()}\0head\0${headCommit() || ''}\0`)
  const visit = (path) => {
    const rel = relative(repositoryRoot, path).split(sep).join('/') || '.'
    if (!existsSync(path)) {
      hash.update(`missing\0${rel}\0`)
      return
    }
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      hash.update(`symlink\0${rel}\0${readlinkSync(path)}\0`)
    } else if (stat.isDirectory()) {
      hash.update(`directory\0${rel}\0${stat.mode & 0o777}\0`)
      for (const name of readdirSync(path).sort()) visit(join(path, name))
    } else if (stat.isFile()) {
      hash.update(`file\0${rel}\0${stat.mode & 0o777}\0`)
      hash.update(readFileSync(path))
    } else {
      hash.update(`other\0${rel}\0${stat.mode}\0`)
    }
  }
  for (const path of ['caw.mjs', '.caw', QUEUE_DIR]) visit(join(repositoryRoot, path))
  return hash.digest('hex')
}

function readProjectPolicies(root = process.cwd()) {
  const repositoryRoot = realpathSync(root)
  const manifestPath = join(repositoryRoot, PROJECT_POLICY_MANIFEST)
  if (!existsSync(manifestPath)) {
    return { apiVersion: null, manifestDigest: null, policies: {}, root: repositoryRoot }
  }
  const manifestStat = lstatSync(manifestPath)
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error(`${PROJECT_POLICY_MANIFEST} must be a regular file`)
  }
  if (manifestStat.size > PROJECT_POLICY_INPUT_MAX) {
    throw new Error(`${PROJECT_POLICY_MANIFEST} exceeds ${PROJECT_POLICY_INPUT_MAX} bytes`)
  }
  let manifest
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) }
  catch (error) { throw new Error(`${PROJECT_POLICY_MANIFEST} is invalid JSON: ${error.message}`) }
  exactObjectKeys(manifest, ['api_version', 'policies'], 'project policy manifest')
  if (![1, 2, 3].includes(manifest.api_version)) {
    throw new Error('project policy api_version must be 1, 2 or 3')
  }
  exactObjectKeys(manifest.policies, PROJECT_POLICY_STAGES, 'project policy manifest.policies')
  if (manifest.api_version < 3 && manifest.policies.acceptance !== undefined) {
    throw new Error('project acceptance policy requires api_version 3')
  }
  const policyRoot = realpathSync(dirname(manifestPath))
  const treeDigest = projectPolicyTreeDigest(policyRoot)
  const policies = {}
  for (const stage of PROJECT_POLICY_STAGES) {
    const config = manifest.policies[stage]
    if (config === undefined) continue
    exactObjectKeys(config, ['id', 'command', 'timeout_ms'], `project ${stage} policy`)
    if (typeof config.id !== 'string' || !/^[a-z][a-z0-9.-]{0,63}$/.test(config.id)) {
      throw new Error(`project ${stage} policy id is invalid`)
    }
    if (!Array.isArray(config.command) || !config.command.length || config.command.length > 16 ||
        config.command.some((part) => typeof part !== 'string' || !part.length || part.length > 4096)) {
      throw new Error(`project ${stage} policy command must contain 1-16 non-empty strings`)
    }
    const timeoutMs = config.timeout_ms ?? PROJECT_POLICY_TIMEOUT_DEFAULT_MS
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PROJECT_POLICY_TIMEOUT_MAX_MS) {
      throw new Error(`project ${stage} policy timeout_ms must be 1-${PROJECT_POLICY_TIMEOUT_MAX_MS}`)
    }
    policies[stage] = {
      id: config.id,
      command: [...config.command],
      timeoutMs,
      root: policyRoot,
      digest: createHash('sha256').update(JSON.stringify({ stage, config, treeDigest })).digest('hex'),
    }
  }
  return {
    apiVersion: manifest.api_version,
    manifestDigest: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),
    policies,
    root: repositoryRoot,
  }
}

function resolvedPolicyCommand(policy, repositoryRoot) {
  return policy.command.map((part, index) => {
    const looksLikePath = part.startsWith('.') || part.includes('/') || part.includes('\\')
    if (!looksLikePath) return part
    const candidate = resolve(repositoryRoot, part)
    if (!existsSync(candidate)) return part
    const canonical = realpathSync(candidate)
    if (!inside(policy.root, canonical)) {
      throw new Error(`project policy command path leaves .caw/project: ${part}`)
    }
    const stat = lstatSync(canonical)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`project policy command path is not a regular file: ${part}`)
    }
    return canonical
  })
}

function projectPolicyOutputSchema(stage, apiVersion, context) {
  if (apiVersion >= 2 && stage === 'planning') {
    return context?.phase === 'population'
      ? PROJECT_POLICY_V2_PLANNING_POPULATION_SCHEMA
      : PROJECT_POLICY_V2_PLANNING_REQUEST_SCHEMA
  }
  if (apiVersion >= 2 && stage === 'gate') return PROJECT_POLICY_V2_GATE_SCHEMA
  if (apiVersion === 3 && stage === 'acceptance') return PROJECT_POLICY_V3_ACCEPTANCE_SCHEMA
  return PROJECT_POLICY_OUTPUT_SCHEMAS[stage]
}

function validateProjectPolicyOutput(stage, policy, output, apiVersion = 1, context = {}) {
  const issue = canonicalIssue(projectPolicyOutputSchema(stage, apiVersion, context), output)
  if (issue) throw new Error(`project ${stage} policy returned invalid output at ${issue.path}: ${issue.message}`)
  const strings = stage === 'planning'
    ? [...output.issues, ...output.instructions,
      ...(apiVersion >= 2 && context?.phase !== 'population' ? [output.risk.class] : []),
      ...(apiVersion >= 2 && context?.phase === 'population'
        ? [output.attestation.population_digest, output.attestation.evidence] : [])]
    : stage === 'review'
      ? [...output.instructions, ...output.criteria.flatMap((row) =>
          [row.id, row.section, row.criterion])]
      : stage === 'gate' ? [output.reason]
      : stage === 'acceptance' ? output.cases.flatMap((row) => [
        row.id, ...row.criterion_ids, row.surface_id, row.transition_id,
        row.production_consumer, row.scenario, row.observable, row.mutation,
        row.evidence_kind, row.selector,
      ])
      : [output.subject]
  if (strings.some((value) => Buffer.byteLength(value) > 8000)) {
    throw new Error(`project ${stage} policy returned a string over 8000 bytes`)
  }
  if (stage === 'planning' && output.issues.some((value) => !value.trim())) {
    throw new Error('project planning policy returned an empty issue')
  }
  if (['planning', 'review'].includes(stage) &&
      output.instructions.some((value) => !value.trim())) {
    throw new Error(`project ${stage} policy returned an empty instruction`)
  }
  if (stage === 'planning' && apiVersion >= 2 && context?.phase !== 'population' &&
      !/^[a-z][a-z0-9.-]{0,63}$/.test(output.risk.class)) {
    throw new Error('project planning policy returned an invalid risk class')
  }
  if (stage === 'planning' && apiVersion >= 2 && context?.phase === 'population') {
    if (!/^[0-9a-f]{64}$/.test(output.attestation.population_digest)) {
      throw new Error('project planning policy returned an invalid population digest')
    }
    if (output.attestation.state === 'complete' && !output.attestation.evidence.trim()) {
      throw new Error('project planning policy must evidence a complete population attestation')
    }
  }
  if (stage === 'gate' && apiVersion >= 2 && output.action === 'retry') {
    if (context?.state !== 'red' || !context?.task) {
      throw new Error('project gate policy may retry only a red fast task gate')
    }
    if (output.classification !== 'flaky' || !output.reason.trim()) {
      throw new Error('project gate policy retry requires flaky classification and a reason')
    }
  }
  if (stage === 'gate' && apiVersion >= 2 &&
      output.baseline_inputs_digest !== undefined &&
      !/^[0-9a-f]{64}$/.test(output.baseline_inputs_digest)) {
    throw new Error('project gate policy returned an invalid baseline inputs digest')
  }
  if (stage === 'gate' && output.baseline_inputs_digest !== undefined &&
      context?.kind !== 'full-baseline-inputs') {
    throw new Error('project gate policy returned baseline inputs outside the cache-input phase')
  }
  if (stage === 'review') {
    const ids = output.criteria.map((row) => row.id)
    if (ids.some((id) => !/^[a-z][a-z0-9.-]{0,63}$/.test(id))) {
      throw new Error('project review policy returned an invalid criterion id')
    }
    if (new Set(ids).size !== ids.length) {
      throw new Error('project review policy returned duplicate criterion ids')
    }
    if (output.criteria.some((row) => !row.section.trim() || !row.criterion.trim())) {
      throw new Error('project review policy returned an empty criterion')
    }
  }
  if (stage === 'acceptance') {
    const ids = output.cases.map((row) => row.id)
    if (ids.some((id) => !/^[a-z][a-z0-9.-]{0,127}$/.test(id))) {
      throw new Error('project acceptance policy returned an invalid case id')
    }
    if (new Set(ids).size !== ids.length) {
      throw new Error('project acceptance policy returned duplicate case ids')
    }
    const criteria = new Set((context.criteria || []).map((row) => row.id))
    const surfaces = new Map((context.surfaces || []).map((row) => [row.id, row]))
    const transitions = new Map((context.transitions || []).map((row) => [row.id, row]))
    for (const row of output.cases) {
      if (new Set(row.criterion_ids).size !== row.criterion_ids.length) {
        throw new Error(`project acceptance case ${row.id} contains duplicate criterion ids`)
      }
      for (const criterionId of row.criterion_ids) {
        if (!criteria.has(criterionId)) {
          throw new Error(`project acceptance case ${row.id} names unknown criterion ${criterionId}`)
        }
      }
      if (!surfaces.has(row.surface_id)) {
        throw new Error(`project acceptance case ${row.id} names unknown surface ${row.surface_id}`)
      }
      if (row.transition_id) {
        const transition = transitions.get(row.transition_id)
        if (!transition) {
          throw new Error(`project acceptance case ${row.id} names unknown transition ${row.transition_id}`)
        }
        if (transition.surface !== row.surface_id) {
          throw new Error(`project acceptance case ${row.id} links a transition from another surface`)
        }
      }
      for (const [name, value] of Object.entries({
        production_consumer: row.production_consumer,
        scenario: row.scenario,
        observable: row.observable,
        mutation: row.mutation,
        evidence_kind: row.evidence_kind,
        selector: row.selector,
      })) {
        if (!value.trim()) throw new Error(`project acceptance case ${row.id} has empty ${name}`)
      }
      if (!/^[a-z][a-z0-9.-]{0,63}$/.test(row.evidence_kind)) {
        throw new Error(`project acceptance case ${row.id} has invalid evidence_kind`)
      }
    }
    const coveredCriteria = new Set(output.cases.flatMap((row) => row.criterion_ids))
    const uncoveredCriteria = [...criteria].filter((id) => !coveredCriteria.has(id))
    if (uncoveredCriteria.length) {
      throw new Error(`project acceptance matrix does not cover criterion ids: ${uncoveredCriteria.join(', ')}`)
    }
    const coveredTransitions = new Set(output.cases.map((row) => row.transition_id).filter(Boolean))
    const uncoveredTransitions = [...transitions.keys()].filter((id) => !coveredTransitions.has(id))
    if (uncoveredTransitions.length) {
      throw new Error(`project acceptance matrix does not cover transition ids: ${uncoveredTransitions.join(', ')}`)
    }
  }
  if (stage === 'gate' && output.action === 'stop' && !output.reason.trim()) {
    throw new Error('project gate policy must explain a stop action')
  }
  if (stage === 'commit' && (output.subject.includes('\n') || output.subject.length > 120)) {
    throw new Error('project commit policy subject must be one line of at most 120 characters')
  }
}

function recordProjectPolicyCall(policy, stage, startedAt, status, context = {}, apiVersion = 1,
  output = null) {
  const run = beginRunRecord()
  run.policyCalls ||= []
  run.policyCalls.push({
    stage, id: policy.id, digest: policy.digest,
    api_version: apiVersion,
    ...(stage === 'planning' && context.phase ? { phase: context.phase } : {}),
    ...(stage === 'gate' && output ? {
      decision: {
        action: output.action,
        classification: output.classification || null,
        reason: output.reason,
        baseline_inputs_digest: output.baseline_inputs_digest || null,
      },
    } : {}),
    duration_ms: Date.now() - startedAt, status,
  })
  run.stages.push({
    kind: 'project-policy', name: stage, state: status,
    duration_ms: Math.max(0, Date.now() - startedAt),
    policy_id: policy.id,
  })
  writeRunManifest(status === 'success' ? 'active' : 'failed')
}

function runProjectPolicy(stage, context, { record = true, set = projectPolicySet } = {}) {
  const policy = set?.policies?.[stage]
  if (!policy) return null
  const apiVersion = set.apiVersion || 1
  const request = `${JSON.stringify({ api_version: apiVersion, stage, context })}\n`
  if (Buffer.byteLength(request) > PROJECT_POLICY_INPUT_MAX) {
    throw new Error(`project ${stage} policy input exceeds ${PROJECT_POLICY_INPUT_MAX} bytes`)
  }
  const command = resolvedPolicyCommand(policy, set.root)
  mkdirSync(PROJECT_POLICY_SCRATCH_PARENT, { recursive: true, mode: 0o700 })
  const scratch = mkdtempSync(join(PROJECT_POLICY_SCRATCH_PARENT, `${stage}-`))
  const startedAt = Date.now()
  const before = projectPolicyStateDigest(set.root)
  let callStatus = 'failure'
  let policyOutput = null
  try {
    const pathValue = process.env.PATH || process.env.Path || ''
    const env = {
      PATH: pathValue,
      ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      TMPDIR: scratch, TEMP: scratch, TMP: scratch,
      CAW_POLICY_API_VERSION: String(apiVersion), CAW_POLICY_STAGE: stage,
    }
    const result = spawnSync(command[0], command.slice(1), {
      cwd: scratch,
      input: request,
      encoding: 'utf8',
      env,
      shell: false,
      timeout: policy.timeoutMs,
      maxBuffer: PROJECT_POLICY_OUTPUT_MAX,
      windowsHide: true,
    })
    if (projectPolicyStateDigest(set.root) !== before) {
      throw new Error(`project ${stage} policy changed protected project state`)
    }
    if (result.error) {
      const timedOut = result.error.code === 'ETIMEDOUT'
      throw new Error(`project ${stage} policy ${timedOut ? 'timed out' : 'could not run'}: ${result.error.message}`)
    }
    if (result.status !== 0) {
      const detail = `${result.stderr || ''}\n${result.stdout || ''}`.trim().slice(-8000)
      throw new Error(`project ${stage} policy exited ${result.status}${detail ? `: ${detail}` : ''}`)
    }
    let output
    try { output = JSON.parse(result.stdout) }
    catch (error) { throw new Error(`project ${stage} policy returned invalid JSON: ${error.message}`) }
    validateProjectPolicyOutput(stage, policy, output, set.apiVersion || 1, context)
    policyOutput = output
    callStatus = 'success'
    return { output, policy }
  } finally {
    if (record) {
      recordProjectPolicyCall(policy, stage, startedAt, callStatus, context, apiVersion, policyOutput)
    }
    removeTree(scratch)
  }
}

function verifyProjectPolicies(set = readProjectPolicies()) {
  if (!Object.keys(set.policies).length) {
    say(`no project policies configured at ${PROJECT_POLICY_MANIFEST}`)
    return
  }
  const samples = {
    planning: { request: 'verify project policies', profile: '' },
    review: { spec: '', files: [], criteria: [] },
    gate: { command: 'verify', state: 'green', status: 0, output: '' },
    commit: { title: 'Verify project policies', spec: '', files: [] },
    acceptance: {
      task: 'verify.md',
      criteria: [{ id: 'done-when-1', section: 'Done when', criterion: 'verification passes' }],
      surfaces: [{ id: 'verify-surface', responsibility: 'policy verification' }],
      transitions: [{
        id: 'transition-verify', surface: 'verify-surface', from: 'before',
        event: 'verify', to: 'after',
      }],
    },
  }
  for (const stage of PROJECT_POLICY_STAGES) {
    if (!set.policies[stage]) continue
    if (stage === 'planning' && set.apiVersion >= 2) {
      const requestResult = runProjectPolicy(stage, {
        phase: 'request', ...samples.planning,
      }, { record: false, set })
      const populationDigest = createHash('sha256').update(stableJson([])).digest('hex')
      runProjectPolicy(stage, {
        phase: 'population', ...samples.planning,
        risk: requestResult.output.risk,
        population: {
          state: 'none', returned: 0, repaired: 0, dropped: 0, retained: 0,
          witness_withdrawn: false, digest: populationDigest, cases: [],
        },
      }, { record: false, set })
      say(`${stage}: ${requestResult.policy.id} ${requestResult.policy.digest.slice(0, 12)} — valid (request, population)`)
    } else if (stage === 'gate' && set.apiVersion >= 2) {
      const result = runProjectPolicy(stage, samples.gate, { record: false, set })
      runProjectPolicy(stage, {
        ...samples.gate,
        task: null,
        kind: 'full-baseline-inputs',
        state: 'not-run',
        status: null,
        known_inputs: { version: 1 },
      }, { record: false, set })
      say(`${stage}: ${result.policy.id} ${result.policy.digest.slice(0, 12)} — valid (gate, baseline-inputs)`)
    } else {
      const result = runProjectPolicy(stage, samples[stage], { record: false, set })
      say(`${stage}: ${result.policy.id} ${result.policy.digest.slice(0, 12)} — valid`)
    }
  }
}

function appendPlanningPolicyInstructions(profileText, instructions, phase) {
  if (!instructions.length) return profileText
  return `${profileText.trimEnd()}\n\n## Project planning policy instructions` +
    `${phase ? ` — ${phase}` : ''}\n\n` + instructions.map((item) => `- ${item}`).join('\n') + '\n'
}

function stopForPlanningPolicy(result, phase = '') {
  if (result.output.issues.length) {
    say(`\nproject planning policy ${result.policy.id}` +
      `${phase ? ` (${phase})` : ''} stopped before ` +
      `${phase === 'population' ? 'architect' : 'enumerator'}:`)
    say(`  - ${result.output.issues.join('\n  - ')}`)
    die('resolve the project policy issues, then run planning again. ' +
      (phase === 'population'
        ? 'The enumerator completed, but no architect or plan-reviewer call ran.'
        : 'No provider call ran.'))
  }
}

function applyPlanningPolicy(description, profileText) {
  const apiVersion = projectPolicySet?.apiVersion || 1
  const context = apiVersion === 2
    ? { phase: 'request', request: description, profile: profileText }
    : { request: description, profile: profileText }
  const result = runProjectPolicy('planning', context)
  if (!result) return { text: profileText, risk: null }
  stopForPlanningPolicy(result, apiVersion === 2 ? 'request' : '')
  return {
    text: appendPlanningPolicyInstructions(profileText, result.output.instructions,
      apiVersion === 2 ? 'request' : ''),
    risk: apiVersion === 2 ? result.output.risk : null,
  }
}

function applyPopulationPolicy(description, profileText, population, requestedRisk) {
  if (!requestedRisk) return { text: profileText, risk: null }
  const record = populationPlanRecord(population)
  const result = runProjectPolicy('planning', {
    phase: 'population',
    request: description,
    profile: profileText,
    risk: requestedRisk,
    population: {
      ...record,
      cases: population.map((item) => ({ case: item.case, source: item.source })),
    },
  })
  if (!result) throw new Error('project planning policy disappeared before population attestation')
  stopForPlanningPolicy(result, 'population')
  const attestation = result.output.attestation
  if (attestation.population_digest !== record.digest) {
    throw new Error('project planning policy attested a different population digest')
  }
  if (record.state === 'none' && attestation.state !== 'none') {
    throw new Error(`project planning policy attested ${attestation.state} for an empty population`)
  }
  if (record.state === 'sample' && attestation.state === 'none') {
    throw new Error('project planning policy withdrew a non-empty population')
  }
  const ranks = { none: 0, sample: 1, complete: 2 }
  if (ranks[attestation.state] < ranks[requestedRisk.population_requirement]) {
    die(`project risk class ${requestedRisk.class} requires population ` +
      `${requestedRisk.population_requirement}, but policy attested ${attestation.state}`)
  }
  const risk = {
    ...requestedRisk,
    population_attestation: attestation.state,
    population_digest: attestation.population_digest,
    evidence: attestation.evidence,
    policy_id: result.policy.id,
    policy_digest: result.policy.digest,
  }
  const run = beginRunRecord()
  run.risk = risk
  writeRunManifest('active')
  return {
    text: appendPlanningPolicyInstructions(profileText, result.output.instructions, 'population'),
    risk,
  }
}

function projectPolicySnapshot() {
  if (!projectPolicySet?.manifestDigest) return null
  const snapshot = {
    api_version: projectPolicySet.apiVersion,
    manifest_digest: projectPolicySet.manifestDigest,
    policies: Object.fromEntries(Object.entries(projectPolicySet.policies)
      .map(([stage, policy]) => [stage, { id: policy.id, digest: policy.digest }])),
  }
  return {
    ...snapshot,
    set_digest: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
  }
}

function validateBlockedValue(role, value) {
  if (!Object.prototype.hasOwnProperty.call(value, 'blocked')) return
  const raw = value.blocked.trim()
  if (raw && !blocked(raw)) throw new Error(
    `${role} returned invalid canonical output at $.blocked: use the empty string, not a placeholder`)
}

function executorClaimsIssue(claims, criteria = [], acceptanceCases = []) {
  if (!Array.isArray(claims)) return 'must be an array'
  const criterionIds = new Set(criteria.map((row) => row.id))
  const casesById = new Map(acceptanceCases.map((row) => [row.id, row]))
  const seen = new Set()
  for (const [index, claim] of claims.entries()) {
    if (!/^[a-z][a-z0-9.-]{0,63}$/.test(claim.id || '')) return `[${index}].id is invalid`
    if (seen.has(claim.id)) return `duplicate id ${JSON.stringify(claim.id)}`
    seen.add(claim.id)
    if (!claim.summary.trim()) return `${claim.id} has an empty summary`
    if (claim.result !== 'not-run' && !claim.command.trim()) {
      return `${claim.id} reports ${claim.result} without a command`
    }
    if (!claim.criterion_ids.length && !claim.acceptance_case_ids.length) {
      return `${claim.id} is not linked to a criterion or acceptance case`
    }
    const unknownCriteria = claim.criterion_ids.filter((id) => !criterionIds.has(id))
    if (unknownCriteria.length) return `${claim.id} names unknown criterion id(s): ${unknownCriteria.join(', ')}`
    const unknownCases = claim.acceptance_case_ids.filter((id) => !casesById.has(id))
    if (unknownCases.length) return `${claim.id} names unknown acceptance case id(s): ${unknownCases.join(', ')}`
    const wrongSelectors = claim.acceptance_case_ids.filter((id) =>
      casesById.get(id).selector !== claim.selector)
    if (wrongSelectors.length) {
      return `${claim.id} has the wrong selector for acceptance case id(s): ${wrongSelectors.join(', ')}`
    }
    if (new Set(claim.criterion_ids).size !== claim.criterion_ids.length ||
        new Set(claim.acceptance_case_ids).size !== claim.acceptance_case_ids.length) {
      return `${claim.id} repeats a linkage id`
    }
  }
  return null
}

function planningId(kind, ...parts) {
  return `${kind}-${createHash('sha256').update(stableJson(parts)).digest('hex').slice(0, 12)}`
}

function planningLedger(out) {
  const tasks = (out.tasks || []).map((task) => ({
    id: planningId('plan-task', task.slug),
    slug: task.slug,
    title: task.title || '',
  }))
  const taskBySlug = new Map(tasks.map((task) => [task.slug, task]))
  const requirements = (out.tasks || []).flatMap((task) => {
    const taskId = taskBySlug.get(task.slug)?.id || planningId('plan-task', task.slug)
    const ordinary = ['read', 'change', 'done_when'].flatMap((section) =>
      (task[section] || []).map((text) => ({
        id: planningId('plan-requirement', task.slug, section, text),
        task_id: taskId,
        section,
        text,
      })))
    const surfaces = (task.surfaces || []).map((surface) => ({
      id: planningId('plan-requirement', task.slug, 'surface', surface.id, surface.responsibility),
      task_id: taskId, section: 'surface', text: `${surface.id}: ${surface.responsibility}`,
    }))
    const transitions = (task.state_machines || []).flatMap((machine) =>
      (machine.transitions || []).map((transition) => ({
        id: planningId('plan-requirement', task.slug, 'state-transition', machine.surface,
          transition.from, transition.event, transition.to),
        task_id: taskId, section: 'state-transition',
        text: `${machine.surface}: ${transition.from} --${transition.event}--> ${transition.to}`,
      })))
    return [...ordinary, ...surfaces, ...transitions]
  })
  const requirementByKey = new Map(requirements.map((row) =>
    [`${row.task_id}\0${row.section}\0${row.text}`, row]))
  const cases = (out.coverage || []).map((row) => ({
    id: planningId('plan-case', row.case),
    case: row.case,
  }))
  const relations = (out.coverage || []).map((row, index) => {
    const task = taskBySlug.get(row.task)
    const caseRow = cases[index]
    const criterionIds = (row.acceptance_criteria || []).map((criterion) =>
      requirementByKey.get(`${task?.id}\0done_when\0${criterion}`)?.id).filter(Boolean)
    return {
      id: planningId('plan-relation', caseRow.id, task?.id || row.task, [...criterionIds].sort()),
      case_id: caseRow.id,
      case: row.case,
      task_id: task?.id || null,
      task: row.task,
      criterion_ids: criterionIds,
    }
  })
  return { version: 1, tasks, requirements, cases, relations }
}

function validatePlanRelations(out) {
  const slugs = out.tasks.map((task) => task.slug.trim())
  const unique = new Set(slugs)
  if (slugs.some((slug) => !slug)) schemaFailure('architect', '$.tasks', 'task slug must not be empty')
  if (out.tasks.some((task) => task.slug !== task.slug.trim())) {
    schemaFailure('architect', '$.tasks', 'task slugs must not contain surrounding whitespace')
  }
  if (unique.size !== slugs.length) schemaFailure('architect', '$.tasks', 'task slugs must be unique')
  for (const [taskIndex, task] of out.tasks.entries()) {
    for (const section of ['read', 'change', 'done_when']) {
      if (task[section].some((text) => !text.trim())) {
        schemaFailure('architect', `$.tasks[${taskIndex}].${section}`, 'requirements must not be empty')
      }
      if (new Set(task[section]).size !== task[section].length) {
        schemaFailure('architect', `$.tasks[${taskIndex}].${section}`,
          'requirements must not be repeated')
      }
    }
    const surfaceIds = task.surfaces.map((surface) => surface.id.trim())
    if (surfaceIds.some((id) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) ||
        task.surfaces.some((surface) => !surface.responsibility.trim())) {
      schemaFailure('architect', `$.tasks[${taskIndex}].surfaces`,
        'each surface needs a kebab-case id and a non-empty responsibility')
    }
    if (new Set(surfaceIds).size !== surfaceIds.length) {
      schemaFailure('architect', `$.tasks[${taskIndex}].surfaces`, 'surface ids must be unique')
    }
    if (surfaceIds.length > 1 && !task.indivisible_reason.trim()) {
      schemaFailure('architect', `$.tasks[${taskIndex}].indivisible_reason`,
        'a task with unrelated surfaces must explain why they are indivisible')
    }
    if (surfaceIds.length === 1 && task.indivisible_reason.trim()) {
      schemaFailure('architect', `$.tasks[${taskIndex}].indivisible_reason`,
        'must be empty when the task has one surface')
    }
    const machineSurfaces = task.state_machines.map((machine) => machine.surface.trim())
    if (new Set(machineSurfaces).size !== machineSurfaces.length ||
        machineSurfaces.some((surface) => !surfaceIds.includes(surface)) ||
        surfaceIds.some((surface) => !machineSurfaces.includes(surface))) {
      schemaFailure('architect', `$.tasks[${taskIndex}].state_machines`,
        'every surface must have exactly one state machine and no unknown surface may appear')
    }
    for (const [machineIndex, machine] of task.state_machines.entries()) {
      const states = machine.states.map((state) => state.trim())
      if (states.some((state) => !state) || new Set(states).size !== states.length) {
        schemaFailure('architect', `$.tasks[${taskIndex}].state_machines[${machineIndex}].states`,
          'states must be non-empty and unique')
      }
      for (const [transitionIndex, transition] of machine.transitions.entries()) {
        if (!states.includes(transition.from) || !states.includes(transition.to) ||
            !transition.event.trim()) {
          schemaFailure('architect',
            `$.tasks[${taskIndex}].state_machines[${machineIndex}].transitions[${transitionIndex}]`,
            'from and to must name declared states and event must be non-empty')
        }
      }
    }
  }
  const globalSurfaces = out.tasks.flatMap((task) => task.surfaces.map((surface) => surface.id))
  if (new Set(globalSurfaces).size !== globalSurfaces.length) {
    schemaFailure('architect', '$.tasks',
      'surface ids must be globally unique; shared surfaces belong in one explicitly indivisible task')
  }
  const unknown = out.coverage.find((row) => !unique.has(row.task))
  if (unknown) {
    schemaFailure('architect', '$.coverage', `case ${JSON.stringify(unknown.case)} names unknown task ${JSON.stringify(unknown.task)}`)
  }
  const cases = out.coverage.map((row) => row.case)
  if (new Set(cases).size !== cases.length) {
    schemaFailure('architect', '$.coverage', 'each case must appear exactly once')
  }
  const uncoveredTasks = slugs.filter((slug) => !out.coverage.some((row) => row.task === slug))
  if (uncoveredTasks.length) {
    schemaFailure('architect', '$.coverage',
      `every task must handle at least one case; missing ${uncoveredTasks.join(', ')}`)
  }
  for (const [index, row] of out.coverage.entries()) {
    if (!row.case.trim()) schemaFailure('architect', `$.coverage[${index}].case`, 'must not be empty')
    if (!Array.isArray(row.acceptance_criteria) || !row.acceptance_criteria.length) {
      schemaFailure('architect', `$.coverage[${index}].acceptance_criteria`,
        'must name at least one done_when criterion')
    }
    if (new Set(row.acceptance_criteria).size !== row.acceptance_criteria.length) {
      schemaFailure('architect', `$.coverage[${index}].acceptance_criteria`,
        'must not repeat a criterion')
    }
    const task = out.tasks.find((candidate) => candidate.slug.trim() === row.task)
    const unknownCriterion = row.acceptance_criteria.find((criterion) =>
      !task.done_when.includes(criterion))
    if (unknownCriterion !== undefined) {
      schemaFailure('architect', `$.coverage[${index}].acceptance_criteria`,
        `unknown done_when criterion ${JSON.stringify(unknownCriterion)} for task ${JSON.stringify(row.task)}`)
    }
  }
  return planningLedger(out)
}

function planRelationIssue(ledger, rows) {
  if (!Array.isArray(rows)) return 'relations must be an array'
  const expected = new Map((ledger?.relations || []).map((relation) => [relation.id, relation]))
  const seen = new Set()
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return 'every relation row must be an object'
    }
    if (seen.has(row.id)) return `duplicate relation id ${JSON.stringify(row.id)}`
    if (!expected.has(row.id)) return `unknown relation id ${JSON.stringify(row.id)}`
    if (!['covered', 'uncovered'].includes(row.state)) {
      return `${row.id} has unknown state ${JSON.stringify(row.state)}`
    }
    if (typeof row.evidence !== 'string' || !row.evidence.trim()) {
      return `${row.id} has empty evidence`
    }
    seen.add(row.id)
  }
  const missing = [...expected.keys()].filter((id) => !seen.has(id))
  return missing.length ? `missing relation id(s): ${missing.join(', ')}` : null
}

function carriedSetIssue(carried, open) {
  if (!Array.isArray(carried)) return 'must be an array'
  const expected = new Set(open.map((item) => item.id))
  const seen = new Set()
  for (const item of carried) {
    if (seen.has(item.id)) return `duplicate id ${JSON.stringify(item.id)}`
    if (!expected.has(item.id)) return `unknown or settled id ${JSON.stringify(item.id)}`
    seen.add(item.id)
  }
  const missing = [...expected].filter((id) => !seen.has(id))
  return missing.length ? `missing open id(s): ${missing.join(', ')}` : null
}

function validateCarriedSet(carried, open) {
  const issue = carriedSetIssue(carried, open)
  if (issue) schemaFailure('reviewer', '$.carried', issue)
}

function validateCallResult(decoded, role, binding) {
  const exact = (object, keys, where) => {
    if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error(`${where} must be an object`)
    const extra = Object.keys(object).filter((key) => !keys.includes(key))
    const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(object, key))
    if (extra.length || missing.length) throw new Error(`${where} is not closed` +
      `${extra.length ? `; unknown ${extra.join(', ')}` : ''}` +
      `${missing.length ? `; missing ${missing.join(', ')}` : ''}`)
  }
  exact(decoded, ['canonical', 'finalResponse'], `${role} decoded result`)
  const result = decoded.canonical
  exact(result, ['value', 'provider', 'requested', 'models', 'tokens', 'telemetry', 'cost', 'durationMs'],
    `${role} canonical call result`)
  if (result.provider !== binding.provider) throw new Error(`${role} result provider does not match binding`)
  exact(result.requested, ['model', 'reasoning', 'native'], `${role}.requested`)
  exact(result.requested.native, ['model', 'reasoning', 'permissionPolicy'], `${role}.requested.native`)
  if (result.requested.model !== binding.model || result.requested.reasoning !== binding.reasoning) {
    throw new Error(`${role} result requested identity does not match binding`)
  }
  if (!Array.isArray(result.models)) throw new Error(`${role}.models must be an array`)
  for (const model of result.models) {
    exact(model, ['id', 'outputTokens'], `${role}.models[]`)
    if (typeof model.id !== 'string' ||
        !(model.outputTokens === null || typeof model.outputTokens === 'number')) {
      throw new Error(`${role}.models[] has invalid observations`)
    }
  }
  exact(result.tokens, ['input', 'output', 'cachedRead', 'cachedWritten', 'reasoning'], `${role}.tokens`)
  for (const value of Object.values(result.tokens)) {
    if (!(value === null || typeof value === 'number')) throw new Error(`${role}.tokens has invalid observation`)
  }
  exact(result.telemetry, ['eventCount', 'toolEventCount', 'eventBytes'], `${role}.telemetry`)
  for (const [key, value] of Object.entries(result.telemetry)) {
    if (!(value === null || (Number.isSafeInteger(value) && value >= 0))) {
      throw new Error(`${role}.telemetry.${key} is invalid`)
    }
  }
  if (result.cost !== null) {
    exact(result.cost, ['amount', 'currency'], `${role}.cost`)
    if (typeof result.cost.amount !== 'number' || typeof result.cost.currency !== 'string') {
      throw new Error(`${role}.cost is invalid`)
    }
  }
  if (!(result.durationMs === null || typeof result.durationMs === 'number')) {
    throw new Error(`${role}.durationMs is invalid`)
  }
  return result
}

function consumeInvocationTransport(invocation, resultTransport) {
  const transport = invocation.transport
  if (resultTransport === 'stdout') {
    if (transport !== undefined) throw new Error('stdout result transport must not return a file descriptor')
    return null
  }
  if (!transport) throw new Error('file result transport returned no descriptor')
  let root
  try {
    if (!transport || typeof transport !== 'object' || Array.isArray(transport) ||
        Object.keys(transport).sort().join(',') !== 'finalResponsePath,root') {
      throw new Error('adapter transport descriptor is malformed')
    }
    root = realpathSync(transport.root)
    const transportParent = realpathSync(ADAPTER_TRANSPORT_PARENT)
    if (!inside(transportParent, root) || !root.split(/[\\/]/).pop().startsWith('transport-')) {
      throw new Error('adapter transport root is outside the engine temporary namespace')
    }
    const finalStat = lstatSync(transport.finalResponsePath)
    if (!finalStat.isFile() || finalStat.isSymbolicLink()) {
      throw new Error('adapter final response is not a regular file')
    }
    const finalPath = realpathSync(transport.finalResponsePath)
    if (!inside(root, finalPath)) throw new Error('adapter final response escapes its transport root')
    if (finalStat.size > FINAL_VALUE_MAX) {
      throw new Error(`adapter final response is ${finalStat.size} bytes; limit is ${FINAL_VALUE_MAX}`)
    }
    return readFileSync(finalPath, 'utf8')
  } finally {
    if (root) removeTree(root)
  }
}

function discardInvocationTransport(invocation) {
  const candidate = invocation?.transport?.root
  if (!candidate || typeof candidate !== 'string' || !existsSync(candidate)) return
  try {
    const root = realpathSync(candidate)
    const transportParent = realpathSync(ADAPTER_TRANSPORT_PARENT)
    if (inside(transportParent, root) && root.split(/[\\/]/).pop().startsWith('transport-')) {
      removeTree(root)
    }
  } catch { /* an invalid transport is refused by the caller; never broaden cleanup */ }
}

// `spec`, when given, names the spec file whose task this call belongs to and is exported to
// the child as CAW_SPEC. gate() below says what that variable is for; an agent needs it for
// the same reason the orchestrator does, because an executor checking its own work runs the
// fast gate itself. Measured on one install: with the variable reaching the gate but not the
// agent, an executor was handed a RED whose sole cause was a SIBLING task's spec — a red its
// own scope forbade it to close, which it spent a detour diagnosing by hand.
function recordMissingEnumeratorPopulation(role, reason, status = 'active') {
  if (role !== 'enumerator') return
  recordPopulationState('none', {
    returned: 0,
    repaired: 0,
    dropped_unsubstantiated: 0,
    retained: 0,
    reason,
  }, status)
  say(`  population: none — enumerator ${reason}; no independent sample reached review`)
}

function agent(role, prompt, schema, f, spec, context = null) {
  providerBudgetState.limits = f.provider_budgets
  const budgetIssue = providerBudgetIssue(role, f.provider_budgets)
  if (budgetIssue) die(budgetIssue)
  const binding = resolvedRuntime.value.roles[role]
  const provider = resolvedRuntime.providers.get(binding.provider)
  const descriptor = provider.adapter.describe({ role, cliVersion: provider.cliVersion })
  const invocationScratch = !context?.scratchRoot &&
    descriptor.guarantees.writeScope.by === 'os-boundary'
    ? createInvocationScratch(role)
    : null
  const scratchRoot = context?.scratchRoot || invocationScratch?.scratchRoot || null
  const env = { ...process.env, PWD: context?.workingRoot || process.cwd(), CAW_ROLE: role }
  if (spec) env.CAW_SPEC = spec
  const instructions = assembledInstructions(role, binding, provider, f.docs_language)
  const providerVector = providerLaunch(provider.executable, process.platform, binding.provider)
  let invocation
  try {
    invocation = provider.adapter.buildInvocation({
      role, binding, schema, instructions, prompt,
      executable: providerVector.executable,
      executableArgs: providerVector.leadingArgs,
      execution: {
        workingRoot: context?.workingRoot || process.cwd(),
        scratchRoot,
        surfaceId: context?.surfaceId || null,
        deniedReadPaths: context?.deniedReadPaths || [],
        readOnlyDependencyRoots: context?.writeBoundary?.readOnlyDependencyRoots || [],
        writeBoundary: context?.writeBoundary?.kind ||
          descriptor.guarantees.writeScope.state,
        writeBoundaryBy: context?.writeBoundary?.kind ? 'isolated-surface'
          : descriptor.guarantees.writeScope.by,
        env,
      },
    })
  } catch (error) {
    recordMissingEnumeratorPopulation(role, 'invocation was not constructed', 'failed')
    die(`${role} adapter could not construct invocation: ${error?.message || error}`)
  }

  const attempt = beginProviderAttempt(role, provider, binding, invocation, f.provider_budgets, {
    promptBytes: Buffer.byteLength(prompt || ''),
    instructionsBytes: Buffer.byteLength(instructions),
    dossier: context?.dossier || null,
    task: spec || null,
    round: context?.round ?? null,
    pass: context?.pass ?? null,
  })
  process.stderr.write(`  · ${role} `)
  // The agent is the only long call in this script — the gates are seconds — so it is the
  // only one worth holding the machine awake for.
  const invocationVector = providerLaunch(invocation.executable, process.platform, binding.provider)
  const invocationArgs = [...invocationVector.leadingArgs, ...invocation.args]
  const bin = AWAKE || invocationVector.executable
  const argv = AWAKE
    ? ['-dis', invocationVector.executable, ...invocationArgs]
    : invocationArgs
  // On macOS the hold IS the wrapper binary above; on Windows it is a separate process that
  // must be released afterwards, and `finally` is what releases it when the child dies or
  // `die` throws past this frame.
  const hold = holdAwake()
  let r
  try {
    r = spawnSync(bin, argv, { input: invocation.input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
      env: invocation.env, cwd: invocation.cwd, timeout: AGENT_TIMEOUT_MS, killSignal: 'SIGKILL' })
  } finally {
    hold?.kill()
  }
  // A timeout arrives as `r.error` as well, and answering it as a missing provider executable
  // would send the reader to fix a binary that ran fine and simply did not finish.
  if (r.error?.code === 'ETIMEDOUT') {
    discardInvocationTransport(invocation)
    recordMissingEnumeratorPopulation(role, 'call timed out')
    recordProviderFailure(role, provider, r, attempt, 'timeout')
    die(`${role} did not finish within ${formatTimeout(AGENT_TIMEOUT_MS)} and was killed.\n` +
        `  Nothing came back, and whatever it spent is spent. If it was genuinely still working,\n` +
        `  the cap is what is wrong rather than the run: re-run it with a larger\n` +
        `  CAW_AGENT_TIMEOUT_MS (milliseconds, currently ${AGENT_TIMEOUT_MS}). How much it\n` +
        `  actually needed is the one observation nobody has.`)
  }
  if (r.error) {
    discardInvocationTransport(invocation)
    recordMissingEnumeratorPopulation(role, 'call did not start')
    recordProviderFailure(role, provider, r, attempt, 'launch-error')
    die(`could not run "${bin}": ${r.error.message}`)
  }
  if (r.status !== 0) {
    discardInvocationTransport(invocation)
    const interrupted = Boolean(r.signal) || [130, 143].includes(r.status)
    recordMissingEnumeratorPopulation(role, interrupted ? 'call was interrupted' : 'call failed')
    recordProviderFailure(role, provider, r, attempt,
      interrupted ? 'interrupted' : 'nonzero-exit')
    die(`${role} exited ${r.status}\n${provider.adapter.decodeFailure(r)}`)
  }
  let decoded, result
  try {
    const finalResponseText = consumeInvocationTransport(invocation,
      provider.adapter.features.resultTransport)
    decoded = provider.adapter.decodeSuccess(r.stdout, {
      binding, requestedNative: invocation.requestedNative, role, finalResponseText,
    })
    result = validateCallResult(decoded, role, binding)
  } catch (error) {
    discardInvocationTransport(invocation)
    recordMissingEnumeratorPopulation(role, 'response could not be decoded')
    recordProviderFailure(role, provider, r, attempt, 'decode-error')
    die(`${role} ${error?.message || error}`)
  }
  const callAccount = callAccounting(result.provider, result.cost, {
    input: result.tokens?.input, output: result.tokens?.output,
    cacheRead: result.tokens?.cachedRead, cacheWrite: result.tokens?.cachedWritten,
    thinking: result.tokens?.reasoning,
  })
  accounting = addAccounting(accounting, callAccount)
  const finalBytes = Buffer.byteLength(JSON.stringify(result.value))
  if (finalBytes > FINAL_VALUE_MAX) {
    recordMissingEnumeratorPopulation(role, 'response exceeded the canonical value limit', 'failed')
    recordProviderFailure(role, provider, r, attempt, 'canonical-value-oversized', result)
    die(`${role} final canonical value is ${finalBytes} bytes; limit is ${FINAL_VALUE_MAX}`)
  }
  const canonicalProblem = canonicalIssue(schema, result.value, '$')
  if (canonicalProblem) {
    recordMissingEnumeratorPopulation(role, 'response failed schema validation', 'failed')
    recordProviderFailure(role, provider, r, attempt, 'schema-validation', result)
    schemaFailure(role, canonicalProblem.path, canonicalProblem.message)
  }
  try { validateBlockedValue(role, result.value) }
  catch (error) {
    recordMissingEnumeratorPopulation(role, 'response failed blocked-value validation', 'failed')
    recordProviderFailure(role, provider, r, attempt, 'blocked-value-validation', result)
    die(error.message)
  }
  valueRuntime.set(result.value, {
    attempt_id: attempt.id,
    runtime_digest: resolvedRuntime.digest,
    provider: result.provider,
    vendor: provider.adapter.vendor,
    adapter_digest: provider.adapter.digest,
    cli_version: provider.cliVersion,
    requested: result.requested,
    observed: { models: result.models, tokens: result.tokens, duration_ms: result.durationMs },
  })
  try { recordProviderCall(role, provider, { ...result, finalResponse: decoded.finalResponse }, attempt) }
  catch (error) {
    recordMissingEnumeratorPopulation(role, 'successful response could not be retained', 'failed')
    failProviderAttempt(attempt, 'retention-error', result.cost)
    die(`${role} ${error?.message || error}`)
  }
  // The price stays first and keeps its shape, because it is what a reader looks for and what
  // every log under .caw-logs/ already carries. What follows is the same call priced in the
  // units a decision is actually made in: `cr` against `cw` says whether the prompt cache was
  // hit, and `think` is the only trace an effort setting leaves anywhere.
  process.stderr.write(
    `— ${result.cost ? formatAccounting(callAccount) : 'unpriced'}  ` +
    `${result.models?.map((model) => model.id).join('+') || 'model unreported'}` +
    `  in ${result.tokens?.input ?? '?'}  cw ${result.tokens?.cachedWritten ?? '?'}` +
    `  cr ${result.tokens?.cachedRead ?? '?'}  out ${result.tokens?.output ?? '?'}` +
    `  think ${result.tokens?.reasoning ?? '?'}  ` +
    `${result.durationMs === null ? '?s' : `${(result.durationMs / 1000).toFixed(0)}s`}\n`)
  removeInvocationScratch(invocationScratch)
  return result.value
}

function gateEvidenceId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a stable id of at most 128 characters`)
  }
  return value
}

function gateEvidenceArtifactPath(root, declaredPath) {
  if (typeof declaredPath !== 'string' || !declaredPath.length || declaredPath.length > 1024 ||
      declaredPath.includes('\0') || declaredPath.includes('\\') || isAbsolute(declaredPath)) {
    throw new Error(`gate evidence artifact path is unsafe: ${JSON.stringify(declaredPath)}`)
  }
  const parts = declaredPath.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`gate evidence artifact path is unsafe: ${JSON.stringify(declaredPath)}`)
  }
  let current = root
  for (const part of parts) {
    current = join(current, part)
    if (!existsSync(current)) throw new Error(`gate evidence artifact is missing: ${declaredPath}`)
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) {
      throw new Error(`gate evidence artifact path contains a symlink: ${declaredPath}`)
    }
  }
  const stat = lstatSync(current)
  if (!stat.isFile()) throw new Error(`gate evidence artifact is not a regular file: ${declaredPath}`)
  const canonicalRoot = realpathSync(root)
  const canonical = realpathSync(current)
  if (!inside(canonicalRoot, canonical)) {
    throw new Error(`gate evidence artifact leaves its private directory: ${declaredPath}`)
  }
  return { path: canonical, size: stat.size }
}

function collectGateEvidence(manifestPath, artifactsRoot, contract = {}) {
  if (!existsSync(manifestPath)) return { present: false, checks: [], artifacts: [] }
  const manifestStat = lstatSync(manifestPath)
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error('gate evidence manifest must be a regular file')
  }
  if (manifestStat.size > GATE_EVIDENCE_MANIFEST_MAX) {
    throw new Error(`gate evidence manifest exceeds ${GATE_EVIDENCE_MANIFEST_MAX} bytes`)
  }
  let manifest
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) }
  catch (error) { throw new Error(`gate evidence manifest is invalid JSON: ${error.message}`) }
  const schemaProblem = canonicalIssue(GATE_EVIDENCE_MANIFEST_SCHEMA, manifest)
  if (schemaProblem) {
    throw new Error(`gate evidence manifest is invalid at ${schemaProblem.path}: ${schemaProblem.message}`)
  }
  if (manifest.checks.length > GATE_EVIDENCE_CHECKS_MAX) {
    throw new Error(`gate evidence manifest has more than ${GATE_EVIDENCE_CHECKS_MAX} checks`)
  }

  const criteria = new Set((contract.criteria || []).map((row) => row.id))
  const acceptanceCases = new Map((contract.acceptanceCases || []).map((row) => [row.id, row]))
  const checkIds = new Set()
  const artifactIds = new Set()
  const artifacts = []
  let artifactBytes = 0
  for (const check of manifest.checks) {
    gateEvidenceId(check.id, 'gate evidence check id')
    if (checkIds.has(check.id)) throw new Error(`duplicate gate evidence check id ${check.id}`)
    checkIds.add(check.id)
    if (!check.summary.trim()) throw new Error(`gate evidence check ${check.id} has an empty summary`)
    if (!/^[a-z][a-z0-9.-]{0,63}$/.test(check.evidence_kind)) {
      throw new Error(`gate evidence check ${check.id} has invalid evidence_kind`)
    }
    if ((criteria.size || acceptanceCases.size) &&
        !check.criterion_ids.length && !check.acceptance_case_ids.length) {
      throw new Error(`gate evidence check ${check.id} is not linked to a criterion or acceptance case`)
    }
    for (const id of check.criterion_ids) {
      if (!criteria.has(id)) throw new Error(`gate evidence check ${check.id} names unknown criterion ${id}`)
    }
    for (const id of check.acceptance_case_ids) {
      if (!acceptanceCases.has(id)) {
        throw new Error(`gate evidence check ${check.id} names unknown acceptance case ${id}`)
      }
      const acceptanceCase = acceptanceCases.get(id)
      if (acceptanceCase.evidence_kind !== check.evidence_kind) {
        throw new Error(`gate evidence check ${check.id} has the wrong evidence kind for ${id}`)
      }
      if (acceptanceCase.selector !== check.selector) {
        throw new Error(`gate evidence check ${check.id} has the wrong selector for ${id}`)
      }
    }
    if (new Set(check.criterion_ids).size !== check.criterion_ids.length ||
        new Set(check.acceptance_case_ids).size !== check.acceptance_case_ids.length) {
      throw new Error(`gate evidence check ${check.id} contains duplicate links`)
    }
    for (const artifact of check.artifacts) {
      gateEvidenceId(artifact.id, 'gate evidence artifact id')
      if (artifactIds.has(artifact.id)) throw new Error(`duplicate gate evidence artifact id ${artifact.id}`)
      artifactIds.add(artifact.id)
      if (artifactIds.size > GATE_EVIDENCE_ARTIFACTS_MAX) {
        throw new Error(`gate evidence manifest has more than ${GATE_EVIDENCE_ARTIFACTS_MAX} artifacts`)
      }
      const source = gateEvidenceArtifactPath(artifactsRoot, artifact.path)
      if (source.size > GATE_EVIDENCE_ARTIFACT_MAX) {
        throw new Error(`gate evidence artifact ${artifact.id} exceeds ${GATE_EVIDENCE_ARTIFACT_MAX} bytes`)
      }
      artifactBytes += source.size
      if (artifactBytes > GATE_EVIDENCE_ARTIFACTS_TOTAL_MAX) {
        throw new Error(`gate evidence artifacts exceed ${GATE_EVIDENCE_ARTIFACTS_TOTAL_MAX} bytes`)
      }
      artifacts.push({
        id: artifact.id,
        declared_path: artifact.path,
        source_path: source.path,
        bytes: source.size,
        sha256: createHash('sha256').update(readFileSync(source.path)).digest('hex'),
      })
    }
  }
  return { present: true, checks: manifest.checks, artifacts }
}

function retainGateEvidence({ command, task, kind, deliveryDigest: digest, state, commandState,
  status, commandStatus, durationMs, timeoutMs, rawOutput, evidence, error = null }) {
  const bounded = boundedUtf8(rawOutput, GATE_EVIDENCE_OUTPUT_MAX)
  const receiptBase = {
    version: 1,
    owner: 'caw-engine',
    task: task || null,
    kind: kind || (task ? 'fast' : 'full'),
    command: command || null,
    delivery_digest: digest || null,
    state,
    command_state: commandState,
    status,
    command_status: commandStatus,
    duration_ms: durationMs,
    timeout_ms: timeoutMs,
    output: {
      bytes: Buffer.byteLength(rawOutput),
      sha256: createHash('sha256').update(rawOutput).digest('hex'),
      retained: bounded.text,
      retained_bytes: Buffer.byteLength(bounded.text),
      truncated: bounded.truncated,
    },
    manifest: { present: evidence.present, checks: evidence.checks, error },
    artifacts: evidence.artifacts.map(({ source_path: _source, ...artifact }) => artifact),
  }
  const receiptId = createHash('sha256').update(stableJson(receiptBase)).digest('hex')
  const receipt = { ...receiptBase, receipt_id: receiptId }
  if (!resolvedRuntime) return receipt

  const run = beginRunRecord()
  run.gateEvidence ||= []
  const index = String(run.gateEvidence.length + 1).padStart(3, '0')
  receipt.artifacts.forEach((artifact, artifactIndex) => {
    const source = evidence.artifacts[artifactIndex].source_path
    const name = `gate-${index}-artifact-${String(artifactIndex + 1).padStart(3, '0')}.bin`
    writePrivateFile(join(run.path, name), readFileSync(source), GATE_EVIDENCE_ARTIFACT_MAX)
    artifact.private_file = name
  })
  const receiptName = `gate-${index}-receipt.json`
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`)
  writePrivateFile(join(run.path, receiptName), bytes, FINAL_VALUE_MAX)
  run.gateEvidence.push({
    file: receiptName,
    receipt_id: receipt.receipt_id,
    task: receipt.task,
    kind: receipt.kind,
    state: receipt.state,
    delivery_digest: receipt.delivery_digest,
    checks: receipt.manifest.checks.length,
    artifacts: receipt.artifacts.length,
    bytes: bytes.length,
  })
  writeRunManifest(state === 'green' ? 'active' : 'failed')
  return receipt
}

// `spec`, when given, names the one spec whose task is being gated, and is exported to the
// gate as CAW_SPEC. This script writes every spec of a plan into .caw-tasks/ before the build
// starts and removes each only at its own task's commit, so a gate that reads .caw-tasks/ — one
// checking that a spec in flight still matches an open backlog item, say — sees the whole
// plan rather than the task in front of it, and reds a plan's EARLY tasks over a block only
// its LAST task deletes. Neither side is wrong alone: such a check must fire while a spec is
// in flight, and a spec must outlive its own task's gate, which runs before the commit that
// retires it. Naming the running spec is what lets them be told apart. Unset — a hand-run
// gate, or the final full gate — the whole directory is the only answer available and the
// right one, because "which spec is executing" then genuinely has none.
//
// `status` is not redundant next to `ok`, and deleting it as such has already broken one
// install for six days: 75 is the gate saying it did not run, and build() reads it.
function gate(cmd, spec, cwd = undefined, timeoutMs = null, context = {}) {
  mkdirSync(GATE_EVIDENCE_SCRATCH_PARENT, { recursive: true, mode: 0o700 })
  const evidenceScratch = mkdtempSync(join(GATE_EVIDENCE_SCRATCH_PARENT, 'gate-'))
  const artifactsRoot = join(evidenceScratch, 'artifacts')
  const manifestPath = join(evidenceScratch, 'manifest.json')
  mkdirSync(artifactsRoot, { mode: 0o700 })
  const task = context.task || spec || null
  const kind = context.kind || (spec ? 'fast' : 'full')
  const digest = context.deliveryDigest || null
  if (!cmd) {
    try {
      const out = '(none configured)'
      const evidenceError = context.collectEvidence !== false &&
        (context.acceptanceCases || []).length
        ? 'acceptance matrix requires a configured gate that emits evidence'
        : null
      const state = evidenceError ? 'refused' : 'green'
      const status = evidenceError ? 75 : 0
      const receipt = retainGateEvidence({
        command: null, task, kind, deliveryDigest: digest, state, commandState: 'green',
        status, commandStatus: 0, durationMs: 0, timeoutMs, rawOutput: out,
        evidence: { present: false, checks: [], artifacts: [] }, error: evidenceError,
      })
      const diagnostic = evidenceError ? `\ngate evidence refused: ${evidenceError}\n` : ''
      const result = {
        ok: state === 'green', state, status, out: `${out}${diagnostic}`,
        durationMs: 0, timeoutMs, receipt,
      }
      if (resolvedRuntime) recordStage('gate', kind, Date.now(), state, {
        task, status, command_status: 0, timeout_ms: timeoutMs, receipt_id: receipt.receipt_id,
      })
      return result
    } finally { removeTree(evidenceScratch) }
  }
  const env = { ...process.env, PWD: cwd || process.cwd() }
  if (spec) env.CAW_SPEC = spec
  env.CAW_GATE_EVIDENCE_OUT = manifestPath
  env.CAW_GATE_ARTIFACTS_DIR = artifactsRoot
  const startedAt = Date.now()
  try {
    const r = spawnSync('bash', ['-lc', cmd], {
      cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env,
      ...(timeoutMs ? { timeout: timeoutMs, killSignal: 'SIGKILL' } : {}),
    })
    const commandState = r.error?.code === 'ETIMEDOUT' ? 'timeout'
      : r.status === 0 ? 'green'
      : r.status === 75 ? 'refused'
      : 'red'
    const diagnostic = commandState === 'timeout'
      ? `\ngate exceeded ${formatTimeout(timeoutMs)} and was killed\n`
      : ''
    const rawOutput = `${r.stdout || ''}${r.stderr || ''}${diagnostic}`
    let evidence = { present: false, checks: [], artifacts: [] }
    let evidenceError = null
    try {
      if (context.collectEvidence !== false) {
        evidence = collectGateEvidence(manifestPath, artifactsRoot, {
          criteria: context.criteria || [], acceptanceCases: context.acceptanceCases || [],
        })
        if (commandState === 'green' && (context.acceptanceCases || []).length) {
          if (!evidence.present) {
            throw new Error('green gate produced no evidence manifest for the acceptance matrix')
          }
          const passed = new Set(evidence.checks.filter((check) => check.state === 'passed')
            .flatMap((check) => check.acceptance_case_ids))
          const missing = context.acceptanceCases.map((row) => row.id)
            .filter((id) => !passed.has(id))
          if (missing.length) {
            throw new Error(`green gate did not evidence acceptance case ids: ${missing.join(', ')}`)
          }
        }
      }
    } catch (error) {
      evidenceError = error?.message || String(error)
    }
    const state = evidenceError ? 'refused' : commandState
    const status = evidenceError ? 75 : r.status
    const receipt = retainGateEvidence({
      command: cmd, task, kind, deliveryDigest: digest, state, commandState,
      status, commandStatus: r.status, durationMs: Date.now() - startedAt, timeoutMs,
      rawOutput, evidence, error: evidenceError,
    })
    const evidenceDiagnostic = evidenceError ? `\ngate evidence refused: ${evidenceError}\n` : ''
    const value = {
      ok: state === 'green', state, status,
      out: `${rawOutput}${evidenceDiagnostic}`.slice(-8000),
      durationMs: Date.now() - startedAt, timeoutMs, receipt,
    }
    if (resolvedRuntime) recordStage('gate', kind, startedAt, state, {
      task, status, command_status: r.status, timeout_ms: timeoutMs,
      receipt_id: receipt.receipt_id,
    })
    return value
  } finally { removeTree(evidenceScratch) }
}

// The closed sets of a project, computed instead of searched for. One opaque command, like a
// gate, because what is enumerable differs per project and nothing here can know it: §-numbered
// sections against the files that cite them on one install, ADR references on another, a
// per-file inventory of spreadsheet templates on a third.
//
// Why this exists at all. The enumerator re-derives its population from scratch on every call,
// and the same population came back at 60 to 97 cases on one install and 51 to 118 on another —
// it samples what a script can settle. Measured cost of that sampling: 53% of one install's
// planning spend, $6.44 a call. What a command like this hands over is the half the tree can
// close mechanically; the model's budget then goes to the half it cannot — states that do not
// exist yet, inputs nobody sends yet.
//
// It goes to the ENUMERATOR and to no other role. The index preserves mechanically gathered
// members even when the provider's repository-reading mechanism differs; roles that need the
// same facts for another purpose can run the project command themselves.
//
// Three refusals, none of them fatal:
//   - no command: the enumerator works as it always has.
//   - a non-zero exit: SAY it and continue without the index. A project's index script is not
//     the pipeline's to be stopped by, and a run killed here would cost a plan over a broken
//     grep.
//   - too much output: truncate, and say by how much. A silent cut would put a partial closed
//     set in front of a role that is about to be told the set is closed, which is worse than
//     no index at all — the one failure this whole mechanism exists to prevent.
const INDEX_MAX = 60_000 // ~15k tokens, against profiles that run 12-17 KB. Cached, so paid once.
const INDEX_JSON_MAX = 1024 * 1024
const INDEX_SET_MAX = 128
const INDEX_MEMBER_MAX = 20_000

function structuredIndex(raw) {
  if (Buffer.byteLength(raw) > INDEX_JSON_MAX) {
    die(`project index json-v1 exceeds ${INDEX_JSON_MAX} bytes. No provider call ran.`)
  }
  let value
  try { value = JSON.parse(raw) }
  catch (error) { die(`project index json-v1 is invalid JSON: ${error.message}. No provider call ran.`) }
  try {
    exactObjectKeys(value, ['api_version', 'sets'], 'project index')
    if (value.api_version !== 1) throw new Error('project index api_version must be 1')
    if (!Array.isArray(value.sets) || value.sets.length > INDEX_SET_MAX) {
      throw new Error(`project index sets must be an array with at most ${INDEX_SET_MAX} entries`)
    }
    const ids = new Set()
    let memberCount = 0
    for (const [index, set] of value.sets.entries()) {
      const label = `project index sets[${index}]`
      exactObjectKeys(set, ['id', 'label', 'source', 'members'], label)
      if (typeof set.id !== 'string' || !/^[a-z][a-z0-9.-]{0,63}$/.test(set.id)) {
        throw new Error(`${label}.id is invalid`)
      }
      if (ids.has(set.id)) throw new Error(`${label}.id duplicates ${JSON.stringify(set.id)}`)
      ids.add(set.id)
      for (const key of ['label', 'source']) {
        if (typeof set[key] !== 'string' || !set[key].trim() || Buffer.byteLength(set[key]) > 2000) {
          throw new Error(`${label}.${key} must be a non-empty string of at most 2000 bytes`)
        }
      }
      if (!Array.isArray(set.members)) throw new Error(`${label}.members must be an array`)
      const members = new Set()
      for (const [memberIndex, member] of set.members.entries()) {
        if (typeof member !== 'string' || !member.trim() || Buffer.byteLength(member) > 8000) {
          throw new Error(`${label}.members[${memberIndex}] must be a non-empty string of at most 8000 bytes`)
        }
        if (members.has(member)) {
          throw new Error(`${label}.members[${memberIndex}] duplicates an earlier member`)
        }
        members.add(member)
      }
      memberCount += set.members.length
      if (memberCount > INDEX_MEMBER_MAX) {
        throw new Error(`project index has more than ${INDEX_MEMBER_MAX} members`)
      }
    }
  } catch (error) {
    die(`${error.message}. No provider call ran.`)
  }
  const text = value.sets.map((set) => [
    `## [${set.id}] ${set.label.trim()}`,
    `Source: ${set.source.trim()}`,
    ...set.members.map((member) => `- ${member.trim()}`),
  ].join('\n')).join('\n\n')
  if (text.length > INDEX_MAX) {
    die(`project index json-v1 renders to ${text.length} chars; limit is ${INDEX_MAX}. ` +
      'A structured closed set cannot be truncated. No provider call ran.')
  }
  if (!text) {
    say('  project index json-v1 contains no sets')
    return { text: '', truncated: 0, sha256: null, format: 'json-v1', apiVersion: 1 }
  }
  say(`  project index json-v1: ${value.sets.length} set(s), ${text.length} chars`)
  return {
    text, truncated: 0, sha256: createHash('sha256').update(text).digest('hex'),
    format: 'json-v1', apiVersion: 1,
  }
}

function index(cmd, format = 'text-v0') {
  if (!cmd) return { text: '', truncated: 0, sha256: null, format, apiVersion: null }
  const r = spawnSync('bash', ['-lc', cmd], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) {
    if (format === 'json-v1') {
      die(`project index json-v1 could not run: ${r.error.message}. No provider call ran.`)
    }
    say(`  index_cmd could not run (${r.error.message}) — enumerating without it`)
    return { text: '', truncated: 0, sha256: null, format, apiVersion: null }
  }
  if (r.status !== 0) {
    if (format === 'json-v1') {
      die(`project index json-v1 exited ${r.status}. No provider call ran. Its last words:\n` +
        `  ${(`${r.stderr || ''}${r.stdout || ''}`).trim().split('\n').slice(-3).join('\n  ')}`)
    }
    say(`  index_cmd exited ${r.status} — enumerating without it. Its last words:\n` +
        `    ${(`${r.stderr || ''}${r.stdout || ''}`).trim().split('\n').slice(-3).join('\n    ')}`)
    return { text: '', truncated: 0, sha256: null, format, apiVersion: null }
  }
  const out = (r.stdout || '').trim()
  if (!out) {
    if (format === 'json-v1') {
      die('project index json-v1 printed nothing. No provider call ran.')
    }
    say('  index_cmd printed nothing — enumerating without it')
    return { text: '', truncated: 0, sha256: null, format, apiVersion: null }
  }
  if (format === 'json-v1') return structuredIndex(out)
  if (out.length > INDEX_MAX) {
    const dropped = out.length - INDEX_MAX
    say(`  index_cmd printed ${out.length} chars, ${dropped} of them DROPPED (cap ${INDEX_MAX}). ` +
        `The sets are cut and the enumerator is told so.`)
    const text = out.slice(0, INDEX_MAX)
    return {
      text, truncated: dropped, sha256: createHash('sha256').update(text).digest('hex'),
      format, apiVersion: null,
    }
  }
  say(`  index_cmd: ${out.length} chars`)
  return {
    text: out, truncated: 0, sha256: createHash('sha256').update(out).digest('hex'),
    format, apiVersion: null,
  }
}

// The wording that goes with it, kept next to the reader for the same reason populationBlock()
// keeps its own: the rule about what may be dropped is the load-bearing half.
//
// Two things it has to say and one it must not. It has to say the list is a floor and not a
// ceiling, because a role handed a tidy list will stop at it — the identical failure the plan
// reviewer's population block is worded against, and the identical wording is used here. It has
// to say a truncated set is NOT a set, because "every caller of X" cut off at the cap is a
// closed claim about an open list, and a case missing from it would read as a case that does
// not exist. What it must not do is relieve the role of `source`: an entry here is where to
// look, not evidence, and the case still carries the path it was confirmed at.
function indexBlock({ text, truncated, sha256 }) {
  if (!text) return ''
  return '\n\nClosed sets for this project, computed from the tree by a script in this run — not' +
    ` recalled, and not filtered by anyone who has seen a plan. Index source digest: ${sha256}.` +
    '\n\n' + text +
    '\n\nThis is your floor, not your ceiling. A case it does not contain and the request' +
    ' implies is still yours to find, and the tree is still yours to search. An entry here is' +
    ' where to look rather than a case: it earns its place in your output only once you have' +
    ' read the thing it points at, and it carries that `source` like any other.' +
    (truncated
      ? `\n\nWARNING: ${truncated} characters were DROPPED from the end of this output. Any set` +
        ' it presents as complete may not be, and you may not treat one as closed on its' +
        ' word alone.'
      : '')
}

const POPULATION_FAILURE_RETAINED = 32
// Below this share, unresolved anchors look like copying slips and only their cases are dropped.
// At or above it, the witness is withdrawn: enough of the list was not found in the tree that
// presenting the remainder as searched evidence would turn a recollection into a search result.
const POPULATION_DISCARD_THRESHOLD = 1 / 3
const SOURCE_KEYS = {
  repository: ['kind', 'path', 'occurrence', 'excerpt'],
  request: ['kind', 'occurrence', 'excerpt'],
  index: ['kind', 'index_sha256', 'occurrence', 'excerpt'],
}

// Line endings belong to the checkout, not to the content the provider selected. Keep exact
// matching for every other byte, but make LF, CRLF and lone CR one comparison space so Git's
// autocrlf choice cannot decide whether the same quoted lines resolve.
const normalizedSourceText = (text) => text.replace(/\r\n|\r/g, '\n')
const sourceResolution = new WeakMap()
const populationResolution = new WeakMap()

// Source paths are a provider-neutral contract: canonical delivery-relative `/`, regardless of
// the host separator. Split that contract explicitly before asking the host path module to join it.
const deliveryFilePath = (root, canonicalRelativePath) =>
  resolve(root, ...canonicalRelativePath.split('/'))

function exactSourceShape(source, kind) {
  const expected = SOURCE_KEYS[kind]
  if (!expected) return `unsupported source kind ${JSON.stringify(kind)}`
  const keys = Object.keys(source).sort()
  const wanted = [...expected].sort()
  const extra = keys.filter((key) => !wanted.includes(key))
  const missing = wanted.filter((key) => !keys.includes(key))
  if (extra.length || missing.length) {
    return `${kind} source has wrong fields` +
      `${missing.length ? `; missing ${missing.join(', ')}` : ''}` +
      `${extra.length ? `; unknown ${extra.join(', ')}` : ''}`
  }
  return null
}

function locateSourceExcerpt(text, excerpt, occurrence) {
  if (!Number.isInteger(occurrence) || occurrence < 1) {
    return { error: 'occurrence must be a positive integer' }
  }
  const normalizedText = normalizedSourceText(text)
  const normalizedExcerpt = normalizedSourceText(excerpt)
  let at = -1
  for (let count = 0; count < occurrence; count++) {
    at = normalizedText.indexOf(normalizedExcerpt, at + 1)
    if (at === -1) return { error: `excerpt occurrence ${occurrence} does not exist` }
  }
  const lineStart = normalizedText.slice(0, at).split('\n').length
  const lineEnd = lineStart + normalizedExcerpt.split('\n').length - 1
  return { at, lineStart, lineEnd }
}

function resolvePopulationSource(source, { request, indexResult, workingRoot }) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { ok: false, class: 'source', reason: 'source is not an object' }
  }
  const kind = source.kind
  const shape = exactSourceShape(source, kind)
  if (shape) return { ok: false, class: kind || 'source', reason: shape }
  if (typeof source.excerpt !== 'string' || !source.excerpt.length) {
    return { ok: false, class: kind, reason: 'excerpt is empty' }
  }

  if (kind === 'request') {
    const located = locateSourceExcerpt(request, source.excerpt, source.occurrence)
    if (located.error) return { ok: false, class: kind, reason: `${located.error} in the request` }
    sourceResolution.set(source, located)
    return { ok: true, class: kind }
  }

  if (kind === 'index') {
    if (!indexResult.text || source.index_sha256 !== indexResult.sha256) {
      return { ok: false, class: kind, reason: 'index digest does not name the delivered index block' }
    }
    const located = locateSourceExcerpt(indexResult.text, source.excerpt, source.occurrence)
    if (located.error) return { ok: false, class: kind, reason: `${located.error} in the index` }
    sourceResolution.set(source, located)
    return { ok: true, class: kind }
  }

  if (isAbsolute(source.path) || source.path.includes('\\')) {
    return { ok: false, class: kind, reason: 'repository path must be relative and use / separators' }
  }
  const root = realpathSync(workingRoot)
  const lexical = deliveryFilePath(root, source.path)
  const rel = relative(root, lexical).split(sep).join('/')
  if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('.git/')) {
    return { ok: false, class: kind, reason: 'repository path escapes delivery or addresses Git-private state' }
  }
  if (source.path !== rel) {
    return { ok: false, class: kind, reason: `repository path is not canonical; use ${JSON.stringify(rel)}` }
  }
  let stat, canonical
  try {
    stat = lstatSync(lexical)
    canonical = realpathSync(lexical)
  } catch {
    return { ok: false, class: kind, reason: 'repository path does not exist' }
  }
  if (!stat.isFile() || stat.isSymbolicLink() || !inside(root, canonical)) {
    return { ok: false, class: kind, reason: 'repository path is not a regular file inside delivery' }
  }
  const ignored = spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd: root })
  if (ignored.error || ![0, 1].includes(ignored.status)) {
    return { ok: false, class: kind, reason: 'could not determine whether repository path is ignored' }
  }
  if (ignored.status === 0) return { ok: false, class: kind, reason: 'repository path is ignored' }
  const located = locateSourceExcerpt(readFileSync(canonical, 'utf8'), source.excerpt, source.occurrence)
  if (located.error) return { ok: false, class: kind, reason: `${located.error} in the repository file` }
  sourceResolution.set(source, located)
  return { ok: true, class: kind }
}

function sourceLabel(source) {
  const excerpt = JSON.stringify(source.excerpt.replace(/\s+/g, ' ').slice(0, 160))
  const located = sourceResolution.get(source)
  if (source.kind === 'repository') {
    const range = located
      ? located.lineStart === located.lineEnd ? located.lineStart : `${located.lineStart}-${located.lineEnd}`
      : `occurrence#${source.occurrence}`
    return `${source.path}:${range} — ${excerpt}`
  }
  if (source.kind === 'request') return `request#${source.occurrence} — ${excerpt}`
  const range = located
    ? located.lineStart === located.lineEnd ? located.lineStart : `${located.lineStart}-${located.lineEnd}`
    : `occurrence#${source.occurrence}`
  return `index:${source.index_sha256.slice(0, 12)}:${range} — ${excerpt}`
}

function validateRequestIssues(issues, context) {
  const authorityPaths = canonicalAuthorityPaths(context.profileText)
  for (const [index, issue] of issues.entries()) {
    if (!issue.issue.trim()) {
      schemaFailure('enumerator', `$.request_issues[${index}].issue`, 'must not be empty')
    }
    if (issue.request_source?.kind !== 'request') {
      schemaFailure('enumerator', `$.request_issues[${index}].request_source`,
        'must quote the human request')
    }
    const requestResolution = resolvePopulationSource(issue.request_source, context)
    if (!requestResolution.ok) {
      schemaFailure('enumerator', `$.request_issues[${index}].request_source`,
        requestResolution.reason)
    }
    if (!issue.authority_sources.length) {
      schemaFailure('enumerator', `$.request_issues[${index}].authority_sources`,
        'must contain at least one authority source')
    }
    for (const [authorityIndex, source] of issue.authority_sources.entries()) {
      const path = `$.request_issues[${index}].authority_sources[${authorityIndex}]`
      if (source?.kind !== 'repository') {
        schemaFailure('enumerator', path,
          'must quote .caw/CAW.md or a repository canonical document')
      }
      if (!authorityPaths.has(source.path)) {
        schemaFailure('enumerator', path,
          `${JSON.stringify(source.path)} is not .caw/CAW.md or listed under ## Canonical docs`)
      }
      const authorityResolution = resolvePopulationSource(source, context)
      if (!authorityResolution.ok) schemaFailure('enumerator', path, authorityResolution.reason)
    }
  }
}

function requestIssuesText(issues) {
  return issues.map((issue, index) => [
    `${index + 1}. ${issue.issue}`,
    `   request: ${sourceLabel(issue.request_source)}`,
    ...issue.authority_sources.map((source) => `   authority: ${sourceLabel(source)}`),
  ].join('\n')).join('\n')
}

function requireReadyRequest(enumeration, retryCommand = 'plan') {
  if (decidePlanningAction(enumeration.requestIssues) === PlanningAction.architect) {
    return enumeration.cases
  }
  say(`\nrequest preflight stopped before architect; ${enumeration.requestIssues.length} issue(s):`)
  say(requestIssuesText(enumeration.requestIssues))
  die('the request conflicts with, or assumes more than, the project authority settles.\n' +
      `  Resolve every issue in the request or canonical docs, then ${retryCommand} again.\n` +
      '  No architect or plan-reviewer call ran.')
}

function exactOccurrence(text, candidate) {
  if (!candidate) return null
  const normalizedText = normalizedSourceText(text)
  const normalizedCandidate = normalizedSourceText(candidate)
  const first = normalizedText.indexOf(normalizedCandidate)
  if (first === -1 || normalizedText.indexOf(normalizedCandidate, first + 1) !== -1) return null
  return first
}

// This representation belongs only to repair. The resolver must keep line terminators so its
// line numbers stay true; repair instead maps one whitespace-equivalent hit back to the exact raw
// span and hands those bytes to the ordinary resolver.
function collapsedWhitespaceWithRawOffsets(text) {
  const collapsed = []
  const offsets = []
  for (let at = 0; at < text.length;) {
    if (/\s/.test(text[at])) {
      const start = at
      while (at < text.length && /\s/.test(text[at])) at++
      collapsed.push(' ')
      offsets.push({ start, end: at })
    } else {
      collapsed.push(text[at])
      offsets.push({ start: at, end: at + 1 })
      at++
    }
  }
  return { text: collapsed.join(''), offsets }
}

function collapseMappedWhitespace(view) {
  const collapsed = []
  const offsets = []
  for (let at = 0; at < view.text.length;) {
    if (/\s/.test(view.text[at])) {
      const start = at
      while (at < view.text.length && /\s/.test(view.text[at])) at++
      collapsed.push(' ')
      offsets.push({ start: view.offsets[start].start, end: view.offsets[at - 1].end })
    } else {
      collapsed.push(view.text[at])
      offsets.push(view.offsets[at])
      at++
    }
  }
  return { text: collapsed.join(''), offsets }
}

function decoratedContinuationWithRawOffsets(text) {
  const lines = []
  for (let start = 0; start <= text.length;) {
    let end = start
    while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end++
    let next = end
    if (text[next] === '\r' && text[next + 1] === '\n') next += 2
    else if (text[next] === '\r' || text[next] === '\n') next += 1
    const body = text.slice(start, end)
    const leading = body.match(/^([\t ]*)(\S+)([\t ]*)/)
    const token = leading?.[2] || null
    const prefix = token && !/[\p{L}\p{N}]/u.test(token) ? token : null
    lines.push({
      start, end, next, prefix,
      contentStart: leading ? start + leading[1].length + leading[2].length + leading[3].length : start,
    })
    if (next >= text.length) break
    start = next
  }
  const rendered = []
  const offsets = []
  let cursor = 0
  for (let index = 1; index < lines.length; index++) {
    const previous = lines[index - 1]
    const current = lines[index]
    if (!previous.prefix || previous.prefix !== current.prefix) continue
    for (; cursor < previous.end; cursor++) {
      rendered.push(text[cursor])
      offsets.push({ start: cursor, end: cursor + 1 })
    }
    rendered.push(' ')
    offsets.push({ start: previous.end, end: current.contentStart })
    cursor = current.contentStart
  }
  for (; cursor < text.length; cursor++) {
    rendered.push(text[cursor])
    offsets.push({ start: cursor, end: cursor + 1 })
  }
  return collapseMappedWhitespace({ text: rendered.join(''), offsets })
}

function whitespaceEquivalentRawExcerpt(text, excerpt) {
  const haystack = collapsedWhitespaceWithRawOffsets(text)
  const needle = collapsedWhitespaceWithRawOffsets(excerpt).text
  const at = exactOccurrence(haystack.text, needle)
  if (at === null || !needle.length) return null
  const first = haystack.offsets[at]
  const last = haystack.offsets[at + needle.length - 1]
  if (!first || !last) return null
  return text.slice(first.start, last.end)
}

function decoratedContinuationRawExcerpt(text, excerpt) {
  const haystack = decoratedContinuationWithRawOffsets(text)
  const needle = collapsedWhitespaceWithRawOffsets(excerpt).text
  const at = exactOccurrence(haystack.text, needle)
  if (at === null || !needle.length) return null
  const first = haystack.offsets[at]
  const last = haystack.offsets[at + needle.length - 1]
  if (!first || !last) return null
  return text.slice(first.start, last.end)
}

function repairSourceText(source, context) {
  if (source.kind === 'request') return context.request
  if (source.kind === 'index') return context.indexResult.text
  if (source.kind !== 'repository') return null
  try {
    const root = realpathSync(context.workingRoot)
    const lexical = deliveryFilePath(root, source.path)
    const stat = lstatSync(lexical)
    const canonical = realpathSync(lexical)
    if (!stat.isFile() || stat.isSymbolicLink() || !inside(root, canonical)) return null
    return readFileSync(canonical, 'utf8')
  } catch { return null }
}

function repairPopulationSource(source, context, failure) {
  if (!['repository', 'request', 'index'].includes(source?.kind) ||
      !failure?.reason?.startsWith('excerpt occurrence ')) return null
  const text = repairSourceText(source, context)
  if (text === null) return null
  const lines = normalizedSourceText(source.excerpt).split('\n')
  const candidates = []
  if (lines[0]) candidates.push(lines[0])
  // The first line has explicit priority. Only if it is not a unique exact address do we look
  // for the longest exact contiguous block, longest-first and then source-order for a stable tie.
  for (let length = lines.length - 1; length >= 1; length--) {
    for (let start = 0; start + length <= lines.length; start++) {
      const candidate = lines.slice(start, start + length).join('\n')
      if (candidate && !candidates.includes(candidate)) candidates.push(candidate)
    }
  }
  for (const excerpt of candidates) {
    if (exactOccurrence(text, excerpt) === null) continue
    const repaired = { ...source, excerpt, occurrence: 1 }
    const verified = resolvePopulationSource(repaired, context)
    if (verified.ok) return repaired
  }
  // Providers sometimes flatten prose wrapping into one space. Only after every exact line-based
  // strategy fails, locate that shape in a collapsed view, recover the real source bytes through
  // its offset map, and make the strict resolver prove the recovered anchor.
  const whitespaceExcerpt = whitespaceEquivalentRawExcerpt(text, source.excerpt)
  if (whitespaceExcerpt !== null) {
    const repaired = { ...source, excerpt: whitespaceExcerpt, occurrence: 1 }
    const verified = resolvePopulationSource(repaired, context)
    if (verified.ok) return repaired
  }
  // A wrapped run of adjacent decorated lines may repeat a punctuation-only prefix after each
  // newline. Infer that prefix from the document itself, never from a language table; recover the
  // exact source bytes only when the resulting address is unique, then make the strict resolver
  // prove them like every earlier strategy.
  const decoratedExcerpt = decoratedContinuationRawExcerpt(text, source.excerpt)
  if (decoratedExcerpt !== null) {
    const repaired = { ...source, excerpt: decoratedExcerpt, occurrence: 1 }
    const verified = resolvePopulationSource(repaired, context)
    if (verified.ok) return repaired
  }
  return null
}

function retainedDiagnosticSource(source) {
  const excerpt = boundedUtf8(source.excerpt, 160)
  return {
    ...source,
    excerpt: excerpt.text,
    ...(excerpt.truncated ? { excerpt_truncated: true } : {}),
  }
}

function resolvePopulation(cases, context) {
  const failures = []
  const repairs = []
  const resolvedCases = []
  for (const [index, item] of cases.entries()) {
    if (!item || typeof item.case !== 'string' || !item.case.trim()) {
      failures.push({ index, class: 'case', reason: 'case is empty' })
      continue
    }
    const resolution = resolvePopulationSource(item.source, context)
    if (resolution.ok) {
      resolvedCases.push(item)
      continue
    }
    const repaired = repairPopulationSource(item.source, context, resolution)
    if (repaired) {
      repairs.push({ index, originalSource: item.source, resolvedSource: repaired })
      resolvedCases.push({ ...item, source: repaired })
      continue
    }
    failures.push({ index, class: resolution.class, reason: resolution.reason })
  }
  const witnessWithdrawn = cases.length > 0 &&
    failures.length / cases.length >= POPULATION_DISCARD_THRESHOLD
  return {
    cases: witnessWithdrawn ? [] : resolvedCases,
    failures,
    repairs,
    returnedCount: cases.length,
    repairedCount: repairs.length,
    droppedCount: failures.length,
    retainedCount: witnessWithdrawn ? 0 : resolvedCases.length,
    witnessWithdrawn,
    state: cases.length === 0 || witnessWithdrawn ? 'none' : 'sample',
  }
}

function recordPopulationResolution(resolved, attemptId = null) {
  const events = [
    ...resolved.repairs.map((repair) => ({
      index: repair.index,
      repaired: true,
      original_source: retainedDiagnosticSource(repair.originalSource),
      resolved_source: retainedDiagnosticSource(repair.resolvedSource),
    })),
    ...resolved.failures.map((failure) => ({
      ...failure,
      repaired: false,
      reason: boundedUtf8(failure.reason, 240).text,
    })),
  ]
  const retained = events.slice(0, POPULATION_FAILURE_RETAINED)
  const diagnostic = {
    population: resolved.state,
    returned_count: resolved.returnedCount,
    repaired_count: resolved.repairedCount,
    failed_count: resolved.droppedCount,
    discarded_count: resolved.droppedCount,
    retained_count: resolved.retainedCount,
    witness_withdrawn: resolved.witnessWithdrawn,
    events: retained,
    events_truncated: events.length > retained.length,
  }
  recordPopulationState(resolved.state, {
    returned: resolved.returnedCount,
    repaired: resolved.repairedCount,
    dropped_unsubstantiated: resolved.droppedCount,
    retained: resolved.retainedCount,
    witness_withdrawn: resolved.witnessWithdrawn,
  })
  if (events.length) recordEngineDiagnostic('enumerator', 'provenance', diagnostic, attemptId)
  if (resolved.repairs.length) {
    say(`  enumerator repaired ${resolved.repairs.length} anchor(s) by unique exact search`)
  }
  if (resolved.failures.length) {
    say(`  enumerator provenance failure: ${resolved.failures.length} of ${resolved.returnedCount}` +
      ` case(s) had an unresolved anchor; dropped ${resolved.failures.length} as unsubstantiated.`)
    retained.filter((event) => !event.repaired).slice(0, 8).forEach((failure) =>
      say(`    - cases[${failure.index}] ${failure.class}: ${failure.reason}`))
    if (events.length > retained.length) {
      say(`    - ${events.length - retained.length} additional event(s) retained only in the count`)
    }
  }
  if (resolved.witnessWithdrawn) {
    say(`  population: none — unresolved share reached ${POPULATION_DISCARD_THRESHOLD};` +
      ` withdrew all ${resolved.returnedCount} returned cases`)
    // This is the future certification boundary. Today the absence is recorded and printed but
    // does not reject the round or alter its verdict. If the operator decides that a round with
    // no independent sample cannot certify, the refusal belongs here.
    say('  reviewer judges on its own reading alone; no automatic provider retry was spent')
  } else if (resolved.failures.length) {
    say(`  retained ${resolved.retainedCount} independently enumerated case(s) after per-case dropping`)
  }
}

// `.caw-tasks/` and `.caw-logs/` are scratch, never part of a change: not a dirty tree, not a file
// the reviewer judges, not something a commit sweeps up. One filter, one place.
//
// The second path was added with the blocked-task patch and is not tidiness. `build` refuses
// to start on a dirty tree, so without this line the artifact written to help a human restart
// is itself what stops the restart — and the install that most needs the help is the one that
// never added the README's `.gitignore` line, which is exactly the install where the patch
// shows up as untracked.
const changedFiles = () =>
  git('status', '--porcelain').split('\n').filter(Boolean).map((l) => l.slice(3))
    .filter((p) => !p.startsWith(`${QUEUE_DIR}/`) && !p.startsWith(`${LOG_DIR}/`))

function taskDeliveryDiff(cwd = undefined) {
  const maxBuffer = 64 * 1024 * 1024
  const result = spawnSync('git', [
    'diff', '--binary', '--no-ext-diff', 'HEAD', '--', '.',
    `:(exclude)${QUEUE_DIR}`, `:(exclude)${LOG_DIR}`,
  ], { cwd, encoding: 'utf8', maxBuffer })
  if (result.error || result.status !== 0) return ''
  let output = result.stdout || ''
  let untracked = []
  try {
    untracked = execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], {
      cwd, encoding: 'utf8', maxBuffer,
    }).split('\0').filter(Boolean)
      .filter((path) => !path.startsWith(`${QUEUE_DIR}/`) && !path.startsWith(`${LOG_DIR}/`))
      .sort()
  } catch { return output }
  const empty = platform() === 'win32' ? 'NUL' : '/dev/null'
  for (const path of untracked) {
    const remaining = maxBuffer - Buffer.byteLength(output)
    if (remaining <= 0) break
    const patch = spawnSync('git', [
      'diff', '--binary', '--no-ext-diff', '--no-index', '--', empty, path,
    ], { cwd, encoding: 'utf8', maxBuffer: remaining })
    // `git diff --no-index` uses status 1 for a successfully produced difference.
    if (!patch.error && [0, 1].includes(patch.status)) output += patch.stdout || ''
  }
  return output
}

// ---------------------------------------------------------------- plan

// A plan is kept whenever the run stops — out of rounds, or on an undecidable question. The
// second case was added later; the reasoning and what discarding it cost are at the branch that
// raises it. Measured on one project across
// nine planning attempts in four runs: of 65 findings, 47 were `uncovered` — real gaps, closed
// one or two per round — so the loop was not dying on pedantry, and four separate times it
// stopped with one or two survivors and discarded the plan with every gap already closed in
// it. Re-running cost $4-12 each time to rediscover the same ground. Two survivors are minutes
// of hand-editing; a discarded plan is another attempt.
//
// The rounds are not independent either, which is the argument against just shortening the
// loop: one run's first round held a single `unverifiable`, and had it not blocked, the second
// round — which found that a bulk insert against an audited entity walked past the guard —
// would never have happened. A shorter loop truncates the search.
//
// Keeping the plan introduces a state that did not exist before: specs on disk that NOBODY
// APPROVED, indistinguishable from approved ones. `approved:` in PLAN.md's frontmatter holds
// that state. A separate sentinel file would work too and was what this had first — one file
// is better because the holes then sit next to the plan they are holes IN, instead of naming
// tasks the reader has to go cross-reference.
//
// Written by CODE, from the JSON the architect already returns, and that is the whole point of
// the design. The alternative considered was letting the architect write the plan and the
// reviewer annotate it: that needs Write on both roles, which is the one flag everything else
// rests on, and it replaces the typed slots with prose — killing the verdict the script
// derives, the no-progress guard that counts holes, and the ability to say "47 of 65 findings
// were uncovered", which is the measurement that settled the cap question.
//
// The complete coverage mapping survives here. `writeSpecs` scatters its cases and stable
// acceptance links into per-spec blocks, so each task carries its own part while the population
// claim as a whole remains readable in this artifact.
function populationPlanRecord(population) {
  const summary = populationResolution.get(population) || {
    state: 'unknown', returned: 0, repaired: 0, dropped: 0, retained: 0,
    witnessWithdrawn: false,
  }
  return {
    state: summary.state,
    returned: summary.returned,
    repaired: summary.repaired,
    dropped: summary.dropped,
    retained: summary.retained,
    witness_withdrawn: summary.witnessWithdrawn,
    digest: createHash('sha256').update(stableJson(population || [])).digest('hex'),
  }
}

function readPlanPopulationRecord(text) {
  const field = (name) => text.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim()
  const state = field('population_state')
  const integer = (name) => {
    const value = Number(field(name))
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }
  const digest = field('population_digest')
  if (!['sample', 'none'].includes(state) || !/^[0-9a-f]{64}$/.test(digest || '')) {
    return { state: 'unknown', source: 'plan-artifact-missing-or-invalid', digest: null }
  }
  const record = {
    state,
    returned: integer('population_returned'),
    repaired: integer('population_repaired'),
    dropped: integer('population_dropped'),
    retained: integer('population_retained'),
    witness_withdrawn: field('population_witness_withdrawn') === 'true',
    digest,
    source: 'plan-artifact',
  }
  if (Object.values(record).some((value) => value === null)) {
    return { state: 'unknown', source: 'plan-artifact-missing-or-invalid', digest: null }
  }
  return record
}

function writePlan(description, out, history, unclosed, population, undecidable = [], provenance = [],
  risk = null) {
  const populationRecord = populationPlanRecord(population)
  const ledger = planningLedger(out)
  writeFileSync(PLAN, [
    '---',
    `approved: ${unclosed.length || undecidable.length ? 'false' : 'true'}`,
    `population_state: ${populationRecord.state}`,
    `population_returned: ${populationRecord.returned}`,
    `population_repaired: ${populationRecord.repaired}`,
    `population_dropped: ${populationRecord.dropped}`,
    `population_retained: ${populationRecord.retained}`,
    `population_witness_withdrawn: ${populationRecord.witness_withdrawn}`,
    `population_digest: ${populationRecord.digest}`,
    ...(risk ? [
      `risk_class: ${risk.class}`,
      `risk_population_requirement: ${risk.population_requirement}`,
      `risk_population_attestation: ${risk.population_attestation}`,
      `risk_population_digest: ${risk.population_digest}`,
      `risk_require_full_gate_baseline: ${risk.require_full_gate_baseline}`,
      `risk_policy_id: ${risk.policy_id}`,
      `risk_policy_digest: ${risk.policy_digest}`,
    ] : []),
    '---', '',
    '# Plan', '',
    'Written by `caw.mjs`, not by an agent. The specs in `.caw-tasks/` are the source of truth for',
    'what gets built; this file is the reasoning that produced them and is safe to delete.', '',
    '## Request', '', description, '',
    '## Coverage — the population this request implies', '',
    "The architect's own mapping: what it says this request implies, and which task it gave",
    'each case to.', '',
    '| Case | Task | Acceptance criteria |', '|---|---|---|',
    ...(out.coverage || []).map((c) => `| ${c.case.replace(/\|/g, '\\|')} | ` +
      `\`${c.task}\` | ${c.acceptance_criteria.map((item) =>
        item.replace(/\|/g, '\\|')).join('<br>')} |`), '',
    '## Planning relation ledger', '',
    'Engine-assigned stable IDs for every task requirement and every declared',
    '`case → task → acceptance criterion` relation.', '',
    '```json', JSON.stringify(ledger, null, 2), '```', '',
    ...(risk ? [
      '## Project risk attestation', '',
      '```json', JSON.stringify(risk, null, 2), '```', '',
    ] : []),
    // Both lists, side by side, and no attempt to reconcile them here. A script cannot match
    // two prose phrasings of the same case, and a human reading the two tables against each
    // other is the only reader who can. This is also the only artifact the blind list survives
    // in: without it, the one thing that would show whether the split paid for itself lives in
    // a terminal that scrolls.
    ...(population && population.length
      ? ['## Population, enumerated without sight of the plan', '',
         'Produced in a separate process that was given the request and the profile and never',
         'the tasks, so it could not be shaped by them. The plan reviewer was handed this list',
         'and could add to it, but could only drop from it by naming what in the request or the',
         'profile puts a case out of scope. A row here with no counterpart above is what it was',
         'asked about.', '',
         '| Case | Source |', '|---|---|',
         ...population.map((c) => `| ${c.case.replace(/\|/g, '\\|')} | ` +
           `${sourceLabel(c.source).replace(/\|/g, '\\|')} |`), '']
      : []),
    '## Tasks, in the order they run', '',
    ...out.tasks.map((t, i) => `${i + 1}. \`${String(i + 1).padStart(3, '0')}_${t.slug}\` — ${t.title}`), '',
    ...(history.length
      ? ['## Review rounds', '',
         // `resplit` rides along with the round that produced it, so the record answers "what
         // did the revision move" and not only "what was wrong".
         ...history.flatMap(({ round, problems, resplit }) => [
           `### Round ${round} — ${problems.length} hole(s)`, '',
           ...problems.map((p) => `- ${p}`), '',
           ...(resplit?.length
             ? [`Re-split declared while closing them:`, '', ...resplit.map((r) => `- ${r}`), '']
             : [])])]
      : []),
    // Before '## Unclosed', because a question about the REQUEST outranks a hole in the plan:
    // a reader who fixes the holes and leaves these open has fixed the wrong thing.
    ...(provenance.length
      ? ['## Runtime provenance', '', '```json', JSON.stringify(provenance, null, 2), '```', '']
      : []),
    ...(undecidable.length
      ? ['## Undecidable — questions the REQUEST does not settle', '',
         'The specs below rest on a guess for each of these. Do not read them as decided, and do',
         'not build them: `approved:` above is false and `build` refuses on it, as does',
         '`review-specs`, which raises these again until the request stops being ambiguous.', '',
         ...undecidable.map((q) => `- ${q}`), '',
         'Answer them where a later run will find them — a file under `## Canonical docs` in',
         '`.caw/CAW.md` — then edit the affected specs and run `review-specs`. The specs that no',
         'question touches are already written; that is the whole reason they were kept.', '']
      : []),
    ...(unclosed.length
      ? ['## Unclosed — this plan was NOT approved', '',
         ...unclosed.map((p) => `- ${p}`), '',
         'Fix these in the specs, then `node caw.mjs review-specs "<the request>"`, which flips',
         '`approved:` above. `build` refuses until it does.', '']
      : []),
  ].join('\n'))
  if (risk) writeRiskRecord(risk)
}

function planIncomplete(description, out, history, problems, reason, population, provenance,
  risk = null) {
  say(`\n${reason}`)
  writeSpecs(out.tasks, out.coverage)
  writePlan(description, out, history, problems, population, [], provenance, risk)
  say(`\n${PLAN} written, approved: false. Unclosed:\n  - ${problems.join('\n  - ')}`)
  if (problems.length === 1 && problems[0] === 'signed human planning review required') {
    say(`\nPrepare the signed review: node caw.mjs human-review prepare plan <identity>`)
  } else {
    say(`\nFix them in the specs above, then:  node caw.mjs review-specs "<the request>"`)
  }
  say(`  spent ${formatAccounting(accounting)}`)
  // Non-zero: the run did not succeed, and nothing reading this script may conclude otherwise.
  process.exit(1)
}

// The population, enumerated by an agent that is never shown a plan. Splitting this off from
// the plan reviewer is the same move the tool already makes for writing: the reviewer used to
// be ASKED to derive the population itself and then compare it with the architect's mapping,
// with that mapping already sitting in its context — a request not to look at something it had
// been handed. Processes do not share context, so a second call is the only version of that
// instruction which is a mechanism rather than a hope. It also breaks one correlation: the
// architect and the plan reviewer run on the same configured model, so a case the first did
// not think of is a case the second is unusually likely to miss as well.
//
// Called ONCE, before the round loop, and never inside it. The population is a function of the
// request and the tree; planning changes neither, since no code is written until `build`. A
// call per round would cost a model call per round and, worse, would let the list drift toward
// the plan it exists to be independent of.
//
// Not measured. What it is worth rests on a claim about anchoring plus one indirect number —
// 47 of 65 plan-review findings on one project were `uncovered` — and the number that would
// settle it, how many cases the old arrangement missed, is by construction unobservable from
// inside a run. Filed in TODO.md as an open question, not as a proven improvement.
// STABLE FIRST, THEN THE REQUEST — and ONLY here, which is the interesting part.
//
// The profile is identical across every call of every role and the request is what varies, so
// a request in front of it costs the profile its cache. That argument is sound and it once
// stood in all seven prompt assemblies in this file. It was taken back out of six of them,
// because the argument is sound and the amount is trivial: a profile runs 11.9 KB on one
// install and 17.4 KB on another, about 3-4k tokens, so the whole reordering saves on the
// order of $0.25 on a plan and under $1 on a sixteen-task build — against $157 of planning
// spend and $110 of executor spend measured on those same two installs on one day. And the
// cached rate has a one-hour TTL, so a build long enough to matter re-pays it anyway.
//
// Under a percent of the bill, in exchange for changing what every role reads first, including
// the two that write and judge code. Attention is not uniform over a prompt and nothing here
// measured whether a request read second is read as well as one read first. That is a bad
// trade wherever it is merely a saving, and it was reverted wherever it was merely a saving.
//
// It survives in this one function because here it is not a saving. The index block below sits
// between the profile and the request: put the request back on top and the closed sets — which
// can run to tens of KB — fall behind a varying prefix too, and index_cmd starts costing full
// rate on every call for nothing. The order is load-bearing for the mechanism, not for the
// price. The unmeasured residual above still applies, to this role alone.
function populationCacheRoot() {
  try {
    const path = execFileSync('git', ['rev-parse', '--git-path', 'caw/population-cache'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return path ? resolve(path) : null
  } catch { return null }
}

function prunePopulationCache(root, now = Date.now()) {
  if (!root || !existsSync(root)) return
  const entries = readdirSync(root).filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
    .map((name) => {
      const path = join(root, name)
      const stat = lstatSync(path)
      return { path, stat }
    })
    .filter(({ stat }) => stat.isFile() && !stat.isSymbolicLink())
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
  entries.forEach((entry, index) => {
    if (index >= POPULATION_CACHE_MAX || now - entry.stat.mtimeMs > POPULATION_CACHE_MAX_AGE_MS) {
      unlinkSync(entry.path)
    }
  })
}

function canonicalAuthoritySnapshot(profileText) {
  return [...canonicalAuthorityPaths(profileText)].sort().map((path) => {
    try {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink()) return { path, state: 'not-regular' }
      return {
        path,
        state: 'file',
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      }
    } catch { return { path, state: 'missing' } }
  })
}

function populationCacheIdentity(description, text, f, indexResult, prompt) {
  if (!populationCacheRoot()) return null
  const binding = resolvedRuntime.value.roles.enumerator
  const provider = resolvedRuntime.providers.get(binding.provider)
  const inputs = {
    version: POPULATION_CACHE_VERSION,
    request_sha256: createHash('sha256').update(description).digest('hex'),
    profile_sha256: createHash('sha256').update(text).digest('hex'),
    prompt_sha256: createHash('sha256').update(prompt).digest('hex'),
    instructions_sha256: createHash('sha256').update(
      assembledInstructions('enumerator', binding, provider, f.docs_language)).digest('hex'),
    schema_sha256: createHash('sha256').update(stableJson(SCHEMA.population)).digest('hex'),
    engine_sha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    repository: { head: headCommit(), delivery_digest: deliveryDigest() },
    canonical_authority: canonicalAuthoritySnapshot(text),
    index: {
      command_sha256: createHash('sha256').update(f.index_cmd || '').digest('hex'),
      format: indexResult.format,
      api_version: indexResult.apiVersion,
      content_sha256: indexResult.sha256,
      truncated: indexResult.truncated,
    },
    runtime: {
      digest: resolvedRuntime.digest,
      provider: binding.provider,
      vendor: provider.adapter.vendor,
      model: binding.model,
      reasoning: binding.reasoning,
      adapter_digest: provider.adapter.digest,
      cli_version: provider.cliVersion,
    },
    project_policy_digest: projectPolicySnapshot()?.set_digest || null,
  }
  return {
    key: createHash('sha256').update(stableJson(inputs)).digest('hex'),
    inputs,
  }
}

function readPopulationCache(identity) {
  if (!identity) return null
  const root = populationCacheRoot()
  if (!root) return null
  mkdirSync(root, { recursive: true, mode: 0o700 })
  try { chmodSync(root, 0o700) } catch { /* POSIX modes unavailable */ }
  prunePopulationCache(root)
  const path = join(root, `${identity.key}.json`)
  if (!existsSync(path)) return null
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > POPULATION_CACHE_FILE_MAX) return null
    const record = JSON.parse(readFileSync(path, 'utf8'))
    exactObjectKeys(record,
      ['version', 'key', 'created_at', 'inputs', 'value_digest', 'runtime', 'value'],
      'population cache')
    if (record.version !== POPULATION_CACHE_VERSION || record.key !== identity.key ||
        stableJson(record.inputs) !== stableJson(identity.inputs) ||
        record.value_digest !== createHash('sha256').update(stableJson(record.value)).digest('hex') ||
        canonicalIssue(SCHEMA.population, record.value, '$')) return null
    return record
  } catch { return null }
}

function writePopulationCache(identity, value, runtime) {
  if (!identity) return null
  const root = populationCacheRoot()
  if (!root) return null
  mkdirSync(root, { recursive: true, mode: 0o700 })
  try { chmodSync(root, 0o700) } catch { /* POSIX modes unavailable */ }
  const { attempt_id: _attemptId, ...cacheRuntime } = runtime || {}
  const record = {
    version: POPULATION_CACHE_VERSION,
    key: identity.key,
    created_at: new Date().toISOString(),
    inputs: identity.inputs,
    value_digest: createHash('sha256').update(stableJson(value)).digest('hex'),
    runtime: cacheRuntime,
    value,
  }
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
  if (bytes.length > POPULATION_CACHE_FILE_MAX) return null
  const target = join(root, `${identity.key}.json`)
  const temp = `${target}.tmp-${process.pid}`
  writeFileSync(temp, bytes, { mode: 0o600 })
  renameSync(temp, target)
  try { chmodSync(target, 0o600) } catch { /* POSIX modes unavailable */ }
  prunePopulationCache(root)
  return record
}

function recordPopulationCache(value) {
  const run = beginRunRecord()
  run.populationCache = value
  writeRunManifest('active')
}

function enumerate(description, text, f) {
  const indexResult = index(f.index_cmd, f.index_format)
  const prompt = [
    'Profile:\n\n' + text,
    indexBlock(indexResult),
    '\n\nRequest from the human:\n\n' + description,
    '\n\nFirst compare the request against the profile and every relevant canonical document.',
    ' Put every contradiction or still-undecided product premise in `request_issues`, with exact',
    ' request and authority sources. Do not stop at the first. If any exist, return no cases:',
    ' the engine stops before architect. Otherwise leave `request_issues` empty, enumerate the',
    ' cases this request implies, search the tree for them rather than recalling them, and give',
    ' every case a source. You are not planning and you will not be shown a plan.',
  ].join('')
  const cacheIdentity = populationCacheIdentity(description, text, f, indexResult, prompt)
  const cached = readPopulationCache(cacheIdentity)
  let p
  if (cached) {
    p = cached.value
    valueRuntime.set(p, cached.runtime)
    recordPopulationCache({
      state: 'hit', key: cacheIdentity.key, created_at: cached.created_at,
      inputs: cacheIdentity.inputs,
    })
    say(`  population cache hit ${cacheIdentity.key.slice(0, 12)} — enumerator call skipped`)
  } else {
    if (cacheIdentity) recordPopulationCache({
      state: 'miss', key: cacheIdentity.key, inputs: cacheIdentity.inputs,
    })
    p = agent('enumerator', prompt, SCHEMA.population, f)
  }

  const context = {
    request: description,
    indexResult,
    workingRoot: process.cwd(),
    profileText: text,
  }
  validateRequestIssues(p.request_issues, context)
  const resolved = resolvePopulation(p.cases, context)
  recordPopulationResolution(resolved, runtimeIdentity(p)?.attempt_id || null)
  const cases = resolved.cases
  valueRuntime.set(cases, runtimeIdentity(p))
  populationResolution.set(cases, {
    state: resolved.state,
    returned: resolved.returnedCount,
    repaired: resolved.repairedCount,
    dropped: resolved.droppedCount,
    retained: resolved.retainedCount,
    witnessWithdrawn: resolved.witnessWithdrawn,
  })
  if (!cached && cacheIdentity) {
    const stored = writePopulationCache(cacheIdentity, p, runtimeIdentity(p))
    if (stored) recordPopulationCache({
      state: 'miss', stored: true, key: cacheIdentity.key, created_at: stored.created_at,
      inputs: cacheIdentity.inputs,
    })
  }
  // Zero is not fatal: the reviewer still has the request, the profile and a shell, which is
  // exactly what it had before this role existed. It is said out loud because a silent empty
  // list is indistinguishable from a request whose population is genuinely one case wide.
  say(cases.length
    ? `  ${cases.length} case(s) enumerated without sight of a plan`
    : resolved.returnedCount === 0
      ? '  population: none — enumerator returned no cases; reviewer judges on its own reading alone'
      : '  enumerator witness was withdrawn — reviewer judges on its own reading alone')
  return { cases, requestIssues: p.request_issues }
}

// One wording, two callers, because the rule about what may be dropped is the load-bearing
// part and two copies of it would drift. Dropping a case because the plan does not cover it is
// the finding restated as a reason to have no finding — the exact move an independent list
// exists to make impossible. Dropping one the request does not imply is legitimate, and having
// to name the words that settle it is what stops the second from swallowing the first.
function populationBlock(population) {
  // Array identity is how the resolved draw carries its measured summary today. A later slice,
  // filter or de-duplication may intentionally lose that identity; absence then means unknown,
  // never the much stronger claims that nothing was repaired or dropped.
  const summary = populationResolution.get(population) || null
  const counts = summary
    ? ` (returned ${summary.returned}; repaired ${summary.repaired} by unique exact` +
      ` search; dropped ${summary.dropped} as unsubstantiated)`
    : ''
  if (!population.length) {
    return `\n\npopulation: none${counts}. No independent sample was available for this` +
      ' run. Derive the cases yourself from the request and the code, then compare.'
  }
  return '\n\nOne independently enumerated sample from an agent that was never shown this plan' +
    `${counts}. This is one draw, not an exhaustive list; each retained case follows with` +
    ' the source it was found at:\n\n' +
    population.map((c) => `- ${c.case}  [${sourceLabel(c.source)}]`).join('\n') +
    '\n\nA case here that no task handles is `uncovered`. The list is your starting point and' +
    ' not your limit: a case it missed and nothing handles is `uncovered` too, and you have a' +
    ' shell to go find one. You may drop a case from it only by saying which words of the' +
    ' REQUEST, or which line of the profile, put it out of scope — never because the plan does' +
    ' not cover it, since that is the finding itself.'
}

// A `done_when` that requires a grep to find nothing, whose own pattern is spelled out in the
// same task's `change` list. No implementation satisfying the change can pass the check, and
// the task instructs both.
//
// Measured on one project, and the measurement is the reason this is computed rather than
// asked for. The plan reviewer HAS a slot for this class — `unverifiable` is described as "a
// task whose done_when cannot be checked, or that contradicts its own change list" — and it
// used the slot twice in the same planning run, both times on task 003. In the same pass it
// approved task 004, whose change list mandates `channel_statuses(channel_ids=None,
// include_undeployed=False)` while its done_when requires `grep -nE '…|_undeploy|…'` to print
// nothing. `include_undeployed` contains `_undeploy`. Three rounds passed it, `build` paid an
// executor $1.44 to write the task correctly and discover the contradiction at the end, and
// the recovery cost a discarded executor round plus a re-approval round plus a human writing
// a fresh request by hand.
//
// So the failure is not a missing check and not a role that does not look. It is a model
// catching a decidable property most of the time, which means catching it non-deterministically
// — and what it missed is decided here by string matching for nothing per run.
//
// This is handed to the reviewer as a fact and NOT raised as a hole, for two reasons that
// both come from the same data. A change list saying to REMOVE the helper its done_when greps
// for is the identical shape and is entirely legitimate, so a gate here would refuse correct
// plans, which the profile's own `## Not gated` section says is how a rule gets worked around.
// And the two collisions the reviewer DID find were semantic — a task recording a response
// body that contains the word its grep forbids — which no string match can see. The check and
// the reviewer are complementary, not redundant: it is blind to exactly the half the reviewer
// is good at, and it decides the half the reviewer skims past, because nothing about the token
// `include_undeployed` reads as "mutating endpoint" to something reading for meaning.
const GREP = /\bgrep\b([^\n]*?)(['"])([^'"]+)\2/g
const FINDS_NOTHING = /prints? (?:nothing|empty)|is silent|(?:finds|returns|matches|outputs?) nothing|no (?:output|match|matches|hits|results)/i
// Three characters minimum and no metacharacters: an alternative that is not a plain literal
// is skipped rather than approximated, because a false hit here spends a reviewer's attention
// on nothing and this check is worth exactly as much as its precision.
const PLAIN = /^[A-Za-z0-9_.\/-]{3,}$/

// A window around the match, not the head of the line. The change clause that produced this
// check is 330 characters long and the collision sits at character 214: truncating from the
// left showed the reviewer a line that did not visibly contain the thing it was accused of
// containing, which is worse than showing nothing.
function excerpt(line, needle, fold) {
  const at = (fold ? line.toLowerCase() : line).indexOf(needle)
  if (line.length <= 150) return line
  const from = Math.max(0, at - 60)
  const to = Math.min(line.length, at + needle.length + 60)
  return `${from ? '…' : ''}${line.slice(from, to)}${to < line.length ? '…' : ''}`
}

function collisions(tasks) {
  const hits = []
  // Counted so the run can report a denominator. Without one, "2 collisions" has no "out of",
  // and a run that examined six clauses and matched none is indistinguishable in the output
  // from a run where the check does not exist. Three separate attempts to count this from
  // outside the engine — by replicating these regexes — returned 4, 5 and 6, because they were
  // counting lines and this counts clauses parsed out of a `## Done when` list.
  let examined = 0
  for (const t of tasks) {
    const change = (t.change || []).join('\n')
    if (!change) continue
    for (const clause of t.done_when || []) {
      if (!FINDS_NOTHING.test(clause)) continue
      // Counted only once a comparison actually ran. A first version incremented here, on the
      // FINDS_NOTHING match alone, and so counted clauses carrying no `grep '...'` at all — "the
      // script prints nothing on success" — and clauses whose every alternative failed PLAIN. A
      // denominator that includes what was never compared is the defect this counter exists to
      // stop, one level up.
      let compared = false
      for (const [, flags, , pattern] of clause.matchAll(GREP)) {
        const fold = /-[A-Za-z]*i/.test(flags)
        const hay = fold ? change.toLowerCase() : change
        for (const alt of pattern.split('|')) {
          if (!PLAIN.test(alt)) continue
          compared = true
          const needle = fold ? alt.toLowerCase() : alt
          if (!hay.includes(needle)) continue
          hits.push({
            task: t.slug || t.title || '(unnamed task)',
            literal: alt,
            clause: clause.replace(/\s+/g, ' ').slice(0, 160),
            lines: change.split('\n')
              .filter((l) => (fold ? l.toLowerCase() : l).includes(needle))
              .map((l) => excerpt(l.replace(/\s+/g, ' '), needle, fold)),
          })
        }
      }
      if (compared) examined++
    }
  }
  return { hits, examined }
}

function collisionBlock({ hits }) {
  if (!hits.length) return ''
  return '\n\nComputed by the script, not by an agent: each of these tasks has a `done_when`' +
    ' requiring a grep to find nothing, whose pattern is spelled out in that same task\'s' +
    ' `change` list. Read literally, no implementation of the change can pass the check.\n\n' +
    hits.map((h) => `- ${h.task} — \`${h.literal}\`, from "${h.clause}", occurs in its own` +
      ` change list:\n${h.lines.map((l) => `    ${l}`).join('\n')}`).join('\n') +
    '\n\nDecide each. A mandated name that merely CONTAINS a forbidden substring is' +
    ' `unverifiable`: the task requires both halves and they cannot both hold. A change list' +
    ' that says to REMOVE the thing its grep forbids is not a collision and belongs in no slot.' +
    '\n\nThis is a literal string match and nothing else. It cannot see a task that records a' +
    ' value containing a word its own grep forbids, so an empty list above is not this' +
    ' dimension approved — on the run that motivated this check, the two contradictions of that' +
    ' kind were found by a reviewer reading the specs, and this match is blind to both.'
}

// Printed as well as sent, because a check the human never sees cannot be judged by one.
function sayCollisions({ hits, examined }) {
  // Printed on every run, including the ones that matched nothing. A silent check cannot be
  // measured, and whether this one earns its place is an open question that only its own output
  // can settle.
  const of = `${examined} done_when clause(s) carrying a literal this could compare`
  if (!hits.length) return say(`  collision check: ${of} examined, no literal hit`)
  say(`  ${hits.length} literal collision(s) between a done_when grep and its own change list,` +
      ` out of ${of}:`)
  hits.forEach((h) => say(`    - ${h.task}: '${h.literal}'`))
}

function plan(description) {
  setProviderBudgetPhase('planning')
  const { f, text: profileText } = profile()
  noticeNotesLog()

  // Planning over a queue that still holds specs used to merge two plans in silence:
  // `writeSpecs` numbers from 001 again, so an old `001_old-slug.md` and a new
  // `001_new-slug.md` end up side by side, both matched by build's glob and both run in
  // filename order. Refusing is the whole fix — which of the two queues survives is a decision,
  // and decisions belong to the human.
  const queued = specFiles()
  if (queued.length) {
    die(`.caw-tasks/ still holds ${queued.length} spec(s):\n  - ${queued.join('\n  - ')}\n\n` +
        `  Planning now would renumber from 001 and interleave two plans. Build them, or delete\n` +
        `  the ones you do not want, then plan again.`)
  }
  clearRiskRecord()

  const planning = applyPlanningPolicy(description, profileText)
  let text = planning.text
  const enumeration = enumerate(description, text, f)
  const population = requireReadyRequest(enumeration)
  const populationPolicy = applyPopulationPolicy(description, text, population, planning.risk)
  text = populationPolicy.text
  const risk = populationPolicy.risk
  const planProvenance = [{ role: 'enumerator', ...runtimeIdentity(population) }]

  let problems = null
  let last = null
  const history = []

  for (let round = 1; round <= MAX_PLAN_ROUNDS; round++) {
    const architectBudgetIssue = providerBudgetIssue('architect', f.provider_budgets)
    if (architectBudgetIssue && last) {
      planIncomplete(description, last, history, problems || [architectBudgetIssue],
        `provider budget stopped planning before architect: ${architectBudgetIssue}`,
        population, planProvenance, risk)
    }
    // Hand the architect its own plan back.
    //
    // It used to get the holes and nothing else: "Your previous plan has holes" named a plan
    // that was not in the prompt. So round 2 was not a revision at all, it was a second
    // independent attempt that happened to know what the first got wrong — which is why a round
    // here could close no holes and trip the no-progress guard, and why three planning attempts
    // on one request produced three unrelated hole sets. Measured on one install: 4 holes, then
    // 5, then 5 again with round 2 closing none; the same request with the plan in the prompt
    // went 6 -> 3 -> 1.
    //
    // Revision is the default and re-splitting is allowed but declared. Point holes — a case
    // nobody handles, a done_when nobody can check — want a surgical edit, and a plan that
    // reshuffles tasks nobody complained about cannot be read as a diff. But `misordered` is by
    // definition a boundary problem, and so is "this cannot be verified here, the thing it needs
    // arrives two tasks later"; forbidding the re-split would make the architect close those by
    // writing an assertion into a task that cannot run it. So: change what a hole requires, and
    // say in `resplit` what moved and why.
    const revision = problems
      ? '\n\nYour previous plan, in the order it would run:\n\n' +
        JSON.stringify({ tasks: last.tasks, coverage: last.coverage }, null, 2) +
        '\n\nThe reviewer found these holes in it. Close every one:\n- ' + problems.join('\n- ') +
        '\n\nReturn the whole plan again with the holes closed, and change only what closing them' +
        ' requires: a task nobody raised a hole about comes back as it was. Where a hole is about' +
        ' a boundary — a case sitting in a task that cannot verify it, an ordering that puts a' +
        ' task before what it needs — move it, and record every such move in `resplit` with the' +
        ' hole that forced it. A hole is closed when `done_when` checks it on the tree the task' +
        ' leaves behind, not when `change` mentions it.'
      : ''

    const out = agent('architect', [
      'Request from the human:\n\n' + description,
      '\n\nProfile:\n\n' + text,
      revision,
      '\n\nSplit this into an ordered list of atomic tasks, and return the coverage mapping.',
      ' Give every independently changeable surface a globally unique id and one explicit state',
      ' machine. Put unrelated surfaces in separate tasks. If several surfaces truly cannot be',
      ' delivered independently, keep them together only with a concrete indivisible_reason.',
    ].join(''), SCHEMA.plan, f)
    planProvenance.push({ round, role: 'architect', ...runtimeIdentity(out) })

    const ledger = validatePlanRelations(out)

    if (blocked(out.blocked)) {
      die(`architect stopped:\n\n${out.blocked}\n\n` +
          `  Answer this where a later run will find it — a file under '## Canonical docs' in\n` +
          `  .caw/CAW.md — not only in the description you re-run with. Every future architect\n` +
          `  reads those; a description helps exactly one invocation.`)
    }
    if (!out.tasks?.length) die('architect returned no tasks and no reason')
    // A declared re-split is the only thing that makes an automatic revision readable. Printed
    // as it happens and kept in the plan, because the alternative is diffing thirteen markdown
    // files nobody will diff.
    if (problems && out.resplit?.length) {
      say(`  re-split (round ${round}):\n    - ${out.resplit.join('\n    - ')}`)
    }
    last = out

    const collided = collisions(out.tasks)
    sayCollisions(collided)

    if (f.planning_independence === 'human-review') {
      planIncomplete(description, out, history,
        ['signed human planning review required'],
        'automated plan review is disabled by planning_independence: human-review',
        population, planProvenance, risk)
    }

    const reviewerBudgetIssue = providerBudgetIssue('plan-reviewer', f.provider_budgets)
    if (reviewerBudgetIssue) {
      planIncomplete(description, out, history,
        [`plan review did not run — ${reviewerBudgetIssue}`],
        `provider budget stopped planning before plan-reviewer: ${reviewerBudgetIssue}`,
        population, planProvenance, risk)
    }
    const r = agent('plan-reviewer', [
      'Judge this plan. There is no code yet: you are judging the split and its coverage.',
      '\n\nRequest:\n\n' + description,
      '\n\nProfile:\n\n' + text,
      '\n\nProposed tasks:\n\n' + JSON.stringify(out.tasks, null, 2),
      "\n\nThe architect's coverage mapping:\n\n" + JSON.stringify(out.coverage, null, 2),
      '\n\nEngine-owned relation ledger. Return exactly one `relations` row for every id:',
      '\n\n' + JSON.stringify(ledger.relations, null, 2),
      populationBlock(population),
      collisionBlock(collided),
      '\n\nFill only the slots that apply; every slot you leave empty is your approval of that',
      ' dimension.',
    ].join(''), SCHEMA.planReview, f)
    planProvenance.push({ round, role: 'plan-reviewer', ...runtimeIdentity(r) })

    const relationProblem = planRelationIssue(ledger, r.relations)
    if (relationProblem) schemaFailure('plan-reviewer', '$.relations', relationProblem)

    // The script derives the verdict from the slots. The reviewer does not get to state one.
    //
    // This used to die WITHOUT keeping the plan, on the argument that every task under an
    // undecidable question rests on a guess, so keeping the specs offers the guess up to be
    // built. The concern is right; discarding the plan is not what answers it, and two other
    // guards already do: `build` refuses on `approved: false`, and `review-specs` raises the
    // same undecidable slot again until the request stops being ambiguous. Nothing reaches an
    // executor without passing one of them.
    //
    // What discarding cost, measured on one project across three planning attempts: two of
    // them stopped here, and each rebuilt the whole decomposition from zero — architect $2.73
    // and $2.29 against ~$6 and ~$5.6 runs, roughly 45% of a stopped attempt spent re-deriving
    // tasks nobody had contested. The questions themselves land in the reviewer, which is
    // cheap and worth every cent; the rebuild is not. The third attempt, which did keep its
    // plan (it ran out of rounds instead), cost nothing to correct: the three surviving holes
    // were minutes of hand-editing, exactly as the note above writePlan predicts.
    //
    // The asymmetry that remains is in the artifact, not in whether one exists: an undecidable
    // question sits ABOVE the holes in PLAN.md and says in as many words that the specs under
    // it are guesses.
    // Built BEFORE the question, for the reason the same reordering was made in `judgeSpecs`:
    // one call fills all five slots and the four below the question were being dropped unread.
    // Here the asymmetry was softer and therefore easier to miss — this branch does not die, it
    // writes `PLAN.md` and keeps the specs, and `writePlan` already carries a `## Unclosed`
    // section under the `## Undecidable` one. The artifact existed; it was handed an empty array.
    // Measured on the install that found it: a $1.57 verdict of which one slot in five was read.
    problems = [
      ...r.relations.filter((row) => row.state === 'uncovered')
        .map((row) => `uncovered relation [${row.id}] — ${row.evidence}`),
      ...(r.uncovered || []).map((x) => `uncovered — ${x}`),
      ...(r.unverifiable || []).map((x) => `unverifiable — ${x}`),
      ...(r.misordered || []).map((x) => `misordered — ${x}`),
      ...(r.out_of_scope || []).map((x) => `out of scope — ${x}`),
    ]

    if (r.undecidable?.length) {
      say(`\nthe request itself does not settle:\n  - ${r.undecidable.join('\n  - ')}`)
      say(problems.length
        ? `\n  the same verdict also found, and these are NOT answers to the question above` +
          ` —\n  they may themselves rest on it:\n    - ${problems.join('\n    - ')}`
        : `\n  Nothing else in this verdict: the other four slots came back empty.`)
      writeSpecs(out.tasks, out.coverage)
      writePlan(description, out, history, problems, population, r.undecidable, planProvenance,
        risk)
      say(`\n${PLAN} written, approved: false — the specs below it rest on a guess.`)
      say(`\nDecide the questions and record the answers where a later run will find them — a`)
      say(`file under '## Canonical docs' in .caw/CAW.md. An answer that lives only in the`)
      say(`description you re-run with is gone the moment the shell scrolls. Then edit the`)
      say(`affected specs and:  node caw.mjs review-specs "<the request>"`)
      say(`  spent ${formatAccounting(accounting)}`)
      // Non-zero: the run did not succeed, and nothing reading this script may conclude otherwise.
      process.exit(1)
    }
    if (!problems.length) {
      writeSpecs(out.tasks, out.coverage)
      writePlan(description, out, history, [], population, [], planProvenance, risk)
      say(`  ${PLAN}`)
      say(`\nRead them, edit or reorder freely, then:  node caw.mjs build`)
      say(`  spent ${formatAccounting(accounting)}`)
      return
    }
    history.push({ round, problems, resplit: out.resplit || [] })
    say(`  holes found (round ${round}):\n    - ${problems.join('\n    - ')}`)

    // The cap is the whole bound now. A no-progress guard used to stop a round that returned as
    // many holes as the one before it, and it was removed rather than repaired: findings are
    // prose with no identity, so it could only compare counts, and a count cannot tell three
    // closed and three opened from three survivors. Measured on two installs, every live firing
    // was on a loop still converging — on one of them the six holes it stopped over were closed
    // by a hand and the very next judgement came back clean at $4.13.
    //
    // Giving a finding an identity is a schema change, and it was weighed and refused: the most
    // a correct guard can save is one round, while a false stop costs that round plus the
    // hand-work plus the round that follows. The cap already bounds the loop, so all the guard
    // bought was an early exit that has never once been right.
  }
  planIncomplete(description, last, history, problems,
    `Still has holes after ${MAX_PLAN_ROUNDS} rounds.`, population, planProvenance, risk)
}

// Writes the specs and says where they went, and nothing else. The next-step line belongs to
// the caller: this used to end with "then: node caw.mjs build", which on the failure path told
// the human to build a plan nobody approved — and printed it BEFORE the holes.
function writeSpecs(tasks, coverage) {
  mkdirSync(QUEUE_DIR, { recursive: true })
  const ledger = planningLedger({ tasks, coverage })
  tasks.forEach((t, i) => {
    const id = String(i + 1).padStart(3, '0')
    const path = join(QUEUE_DIR, `${id}_${t.slug}.md`)
    const covers = (coverage || []).filter((c) => c.task === t.slug).map((c) => c.case)
    const links = ledger.relations.filter((relation) => relation.task === t.slug)
    writeFileSync(path, [
      '---', `id: ${id}`, `title: ${t.title}`, '---', '',
      '## Read', ...t.read.map((x) => `- ${x}`), '',
      '## Surfaces', ...t.surfaces.map((surface) =>
        `- \`${surface.id}\` — ${surface.responsibility}`), '',
      '## State machines', ...t.state_machines.flatMap((machine) => [
        `- \`${machine.surface}\`: states ${machine.states.map((state) => `\`${state}\``).join(', ')}`,
        ...machine.transitions.map((transition) =>
          `  - \`${transition.from}\` -- ${transition.event} --> \`${transition.to}\``),
      ]), '',
      ...(t.indivisible_reason
        ? ['## Indivisible', `- ${t.indivisible_reason}`, ''] : []),
      ...(covers.length ? ['## Must cover', ...covers.map((x) => `- ${x}`), ''] : []),
      ...(links.length ? ['## Acceptance links', ...links.map((relation) => {
        const criteria = relation.criterion_ids.map((criterionId) => {
          const criterion = ledger.requirements.find((item) => item.id === criterionId)
          return `\`${criterionId}\` ${criterion?.text || ''}`
        }).join('; ')
        return `- \`${relation.id}\` / \`${relation.case_id}\` ${relation.case} → ${criteria}`
      }), ''] : []),
      '## Change', ...t.change.map((x) => `- ${x}`), '',
      '## Done when', ...t.done_when.map((x) => `- ${x}`), '',
    ].join('\n'))
    say(`  ${path}`)
  })
  say(`\n${tasks.length} task(s) written.`)
}

// ---------------------------------------------------------------- build

function fullGateQueueDigest() {
  const hash = createHash('sha256')
  for (const path of [PLAN, ...specFiles().map((name) => join(QUEUE_DIR, name))]) {
    if (!existsSync(path)) continue
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      die(`full-gate baseline input is not a regular file: ${path}`)
    }
    hash.update(`\0${path}\0${stat.mode & 0o777}\0`)
    hash.update(readFileSync(path))
  }
  return hash.digest('hex')
}

function knownFullGateInputs(f, risk, startHead) {
  const policySnapshot = projectPolicySnapshot()
  const gateEnvironment = { ...process.env, PWD: process.cwd() }
  const riskInput = {
    class: risk.class,
    population_requirement: risk.population_requirement,
    population_attestation: risk.population_attestation,
    population_digest: risk.population_digest,
    evidence: risk.evidence,
    policy_id: risk.policy_id,
    policy_digest: risk.policy_digest,
  }
  return {
    version: 1,
    head: startHead,
    delivery_digest: deliveryDigest(),
    queue_digest: fullGateQueueDigest(),
    engine_digest: createHash('sha256')
      .update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    profile_digest: createHash('sha256').update(readFileSync('.caw/CAW.md')).digest('hex'),
    environment_digest: createHash('sha256').update(stableJson(gateEnvironment)).digest('hex'),
    policy_set_digest: policySnapshot?.set_digest || null,
    risk_digest: createHash('sha256').update(stableJson(riskInput)).digest('hex'),
    gate: f.gate_full,
    timeout_ms: f.gate_full_timeout_ms,
  }
}

function projectFullGateInputs(f, risk, knownInputs) {
  if (projectPolicySet?.apiVersion < 2 || !projectPolicySet.policies?.gate) return null
  const result = runProjectPolicy('gate', {
    task: null,
    kind: 'full-baseline-inputs',
    risk_class: risk.class,
    command: f.gate_full,
    state: 'not-run',
    status: null,
    output: '',
    duration_ms: 0,
    timeout_ms: f.gate_full_timeout_ms,
    known_inputs: knownInputs,
  })
  if (result.output.action === 'stop') {
    die(`project gate policy ${result.policy.id} stopped baseline input resolution: ` +
      result.output.reason.trim())
  }
  return result.output.baseline_inputs_digest || null
}

function runRequiredFullGateBaseline(f, risk, startHead) {
  if (!risk?.require_full_gate_baseline) return null
  const planningPolicy = projectPolicySet?.policies?.planning
  if (!planningPolicy || planningPolicy.digest !== risk.policy_digest) {
    die('project risk policy changed or disappeared after attestation; run review-specs again')
  }
  if (!f.gate_full) {
    die(`project risk class ${risk.class} requires a full-gate baseline, but gate_full is empty`)
  }
  const knownInputs = knownFullGateInputs(f, risk, startHead)
  const projectInputsDigest = projectFullGateInputs(f, risk, knownInputs)
  const inputsDigest = projectInputsDigest
    ? createHash('sha256').update(stableJson({ knownInputs, projectInputsDigest })).digest('hex')
    : null
  const cached = risk.full_gate_baseline
  if (inputsDigest && cached?.inputs_digest === inputsDigest &&
      cached.project_inputs_digest === projectInputsDigest && cached.head === startHead &&
      cached.tree_digest === knownInputs.delivery_digest && cached.gate === f.gate_full) {
    say(`\n· required full-gate baseline (${risk.class}): reused green result for exact inputs`)
    const run = beginRunRecord()
    run.risk = risk
    run.fullGateBaseline = {
      ...cached,
      status: 0,
      output: '(reused exact-input baseline)',
      duration_ms: 0,
      timeout_ms: f.gate_full_timeout_ms,
      cache: 'hit',
    }
    writeRunManifest('active')
    return run.fullGateBaseline
  }
  say(`\n· required full-gate baseline (${risk.class}): ${f.gate_full}`)
  const baselineTreeDigest = deliveryDigest()
  const baselineStateDigest = projectPolicyStateDigest()
  const g = gate(f.gate_full, undefined, undefined, f.gate_full_timeout_ms, {
    kind: 'full-baseline', deliveryDigest: baselineTreeDigest,
  })
  const baselineChanged = projectPolicyStateDigest() !== baselineStateDigest
  const run = beginRunRecord()
  run.risk = risk
  run.fullGateBaseline = {
    head: startHead,
    tree_digest: baselineTreeDigest,
    gate: f.gate_full,
    inputs_digest: inputsDigest,
    project_inputs_digest: projectInputsDigest,
    state: baselineChanged ? 'mutated' : g.state,
    status: g.status ?? (g.ok ? 0 : null),
    output: g.out.slice(-8000),
    duration_ms: g.durationMs,
    timeout_ms: g.timeoutMs,
  }
  writeRunManifest(g.ok && !baselineChanged ? 'active' : 'failed')
  if (baselineChanged) {
    die('required full-gate baseline changed HEAD, delivery, CAW, policies, or the task queue; ' +
      'no executor ran')
  }
  if (projectInputsDigest) {
    const afterProjectInputsDigest = projectFullGateInputs(f, risk, knownInputs)
    if (afterProjectInputsDigest !== projectInputsDigest) {
      run.fullGateBaseline.state = 'inputs-changed'
      writeRunManifest('failed')
      die('required full-gate baseline project inputs changed while the gate ran; no executor ran')
    }
  }
  const gatePolicy = runProjectPolicy('gate', {
    task: null,
    kind: 'full-baseline',
    risk_class: risk.class,
    command: f.gate_full,
    state: g.state,
    status: g.status ?? (g.ok ? 0 : null),
    output: g.out.slice(-8000),
    duration_ms: g.durationMs,
    timeout_ms: g.timeoutMs,
  })
  if (gatePolicy?.output.action === 'stop') {
    if (g.out) say(g.out)
    die(`project gate policy ${gatePolicy.policy.id} stopped the required full baseline: ` +
      gatePolicy.output.reason.trim())
  }
  if (!g.ok) {
    if (g.out) say(g.out)
    if (g.state === 'timeout') {
      die(`required full-gate baseline TIMED OUT after ${formatTimeout(g.timeoutMs)}; ` +
        'no executor ran')
    }
    if (g.state === 'refused') {
      die('required full-gate baseline DID NOT RUN: it refused to start; no executor ran')
    }
    die('required full-gate baseline is RED; no executor ran')
  }
  say('  green — final full-gate failures can be attributed to this build range')
  writeRiskRecord({
    ...risk,
    full_gate_baseline: {
      head: startHead,
      tree_digest: run.fullGateBaseline.tree_digest,
      gate: f.gate_full,
      state: 'green',
      inputs_digest: inputsDigest,
      project_inputs_digest: projectInputsDigest,
    },
  })
  return run.fullGateBaseline
}

function runFinalFullGate(f, startHead, fullGateBaseline = null) {
  say(`\n· full gate: ${f.gate_full}`)
  const fullDelivery = deliveryDigest()
  const g = gate(f.gate_full, undefined, undefined, f.gate_full_timeout_ms, {
    kind: 'full', deliveryDigest: fullDelivery,
  })
  if (deliveryDigest() !== fullDelivery) {
    die('full gate changed the tracked delivery tree; its receipt no longer describes the current delivery')
  }
  const gatePolicy = runProjectPolicy('gate', {
    task: null,
    kind: 'full',
    command: f.gate_full,
    state: g.state,
    status: g.status ?? (g.ok ? 0 : null),
    output: g.out.slice(-8000),
    duration_ms: g.durationMs,
    timeout_ms: g.timeoutMs,
  })
  if (gatePolicy?.output.action === 'stop') {
    if (g.out) say(g.out)
    die(`project gate policy ${gatePolicy.policy.id} stopped the full gate: ` +
      gatePolicy.output.reason.trim())
  }
  if (!g.ok) {
    say(g.out)
    if (g.state === 'timeout') {
      die(`full gate TIMED OUT after ${formatTimeout(g.timeoutMs)} and was killed. No full-gate` +
          ` verdict exists; re-run it or adjust gate_full_timeout_ms in .caw/CAW.md.`)
    }
    if (g.state === 'refused') {
      die(`full gate DID NOT RUN — it refused to start, and nothing was tested.\n` +
          `  Every task is committed on its own green fast gate; none of that is in doubt.\n` +
          `  Re-run once the refusal is over:  ${f.gate_full}`)
    }
    if (fullGateBaseline?.state === 'green' && fullGateBaseline.head === startHead) {
      die(`full gate is RED after a green required baseline at ${startHead}. The regression is` +
        ` inside this build range:\n    git bisect start HEAD ${startHead}`)
    }
    die(`full gate is RED. Every task was committed on its own green fast gate, so the fast gate\n` +
        `  is not what missed this. Whether ${startHead} was green under the FULL gate is unknown —\n` +
        `  this run never ran it there — so bisect the range rather than assume it:\n` +
        `    git bisect start HEAD ${startHead}`)
  }
  say('  green')
  return g
}

function requirePersistedFullGateBaseline(f, risk) {
  if (!risk.require_full_gate_baseline) return null
  if (!f.gate_full) {
    die(`project risk class ${risk.class} requires a full-gate baseline, but gate_full is empty`)
  }
  const baseline = risk.full_gate_baseline
  if (!baseline) {
    die(`project risk class ${risk.class} has no green full-gate baseline; start with build`)
  }
  if (baseline.gate !== f.gate_full) {
    die('gate_full changed after the required baseline; start again with build')
  }
  const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', baseline.head, 'HEAD'], {
    encoding: 'utf8',
  })
  if (ancestry.status !== 0) {
    die(`required full-gate baseline ${baseline.head} is not an ancestor of HEAD; start again with build`)
  }
  return baseline
}

function requireTaskBranch(f) {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim()
  if (branch === (f.main_branch || 'main')) die(`on ${branch} — branch first, this commits`)
}

function build(noFull) {
  setProviderBudgetPhase('delivery')
  const { f, text } = profile()
  noticeNotesLog()
  activePopulationCertification = { state: 'unknown', source: 'no-plan-artifact', digest: null }
  let planText = null
  // The flag outlives the terminal that printed the holes, which is the whole point of it
  // being on disk. Flipped by `review-specs` when it comes back clean — the one thing in this
  // tool whose job is judging a spec against the request — or by hand, which is an explicit
  // act rather than a scrollback nobody read. A hand-written ticket has no PLAN.md and so no
  // gate here, which is right: there was never a plan to approve.
  if (existsSync(PLAN)) {
    const plan = readFileSync(PLAN, 'utf8')
    planText = plan
    activePopulationCertification = readPlanPopulationRecord(plan)
    if (/^approved:\s*false\s*$/m.test(plan)) {
      // Two states, one flag, and they are not the same event. A plan that was never approved
      // carries what stopped it. A plan whose approval was WITHDRAWN carries nothing — withdrawal
      // only follows an approval, and `review-specs` removes those sections when it flips the flag
      // — so pointing at them there describes a file the reader does not have. Measured on one
      // install: a guard lowered the flag over a heredoc that read a spec and wrote its commit
      // message elsewhere, and the refusal read as a corrupted plan rather than as a withdrawal.
      const holesListed = /^## Unclosed/m.test(plan) || /^## Undecidable/m.test(plan)
      say(plan)
      die(holesListed
        ? `this plan was never approved — see '## Unclosed' / '## Undecidable' above.\n` +
          `  Fix the specs, then:  node caw.mjs review-specs "<the request>"\n` +
          `  Or set 'approved: true' in ${PLAN} yourself if you disagree with the holes — the\n` +
          `  '## Unclosed' section stays behind, and every build says the plan was approved by hand.`
        : `this plan WAS approved and something took the approval away: the flag is false and no\n` +
          `  holes are listed, which review-specs removes only when it approves. A session guard\n` +
          `  lowers it on any write into .caw-tasks/ — including a command that merely mentions the\n` +
          `  queue beside a write to somewhere else. The specs are untouched; judge them again:\n` +
          `    node caw.mjs review-specs "<the request>"`)
    }
    // `approved: true` with the holes still listed means a hand did it: `review-specs` takes
    // the section out when it flips the flag. NOT refused — deciding the holes do not matter
    // is a judgement a human is allowed to make, and the refusal above offers that path in as
    // many words. Said out loud, because otherwise an override reads exactly like a verdict.
    // Measured on one install: the person who documented this as "an explicit act, unlike a
    // scrollback nobody read" reached for it reflexively inside the hour, which is the
    // definition of the `--force` flag this tool refused to add.
    else if (/^## Unclosed/m.test(plan) || /^## Undecidable/m.test(plan)) {
      const holes = plan.split(/^## (?:Unclosed|Undecidable).*$/m)[1] || ''
      say(`\n· ${PLAN} reads approved: true but still lists what stopped it — approved by`)
      say(`  hand, not by review-specs. Building anyway; the holes it carried:`)
      holes.split('\n').filter((l) => l.startsWith('- ')).forEach((l) => say(`  ${l}`))
    }
    // Reports, and does NOT refuse. The queue is a directory this script cannot defend: a hand,
    // a patch script, or a path behind a shell variable all write there unseen, and the session
    // guards bind only an agent. Whether that has ever reached a build was unanswerable until
    // now, because nothing recorded what was judged and PLAN.md dies with the queue — so the
    // first job of this is to make the question answerable, not to block anyone on a comparison
    // whose normalisation has never been tested against a real edit. It escalates to a refusal
    // if it turns out to fire on something real.
    //
    // A spec recorded here and absent from disk says nothing: that is `done`, or a build that
    // died after committing some of the queue, and both are ordinary.
    const judged = approvedDigests(plan)
    if (judged) {
      const changed = [], unjudged = []
      for (const s of specFiles()) {
        const d = specDigest(readFileSync(join(QUEUE_DIR, s), 'utf8'))
        if (!judged.has(s)) unjudged.push(s)
        else if (judged.get(s) !== d) changed.push(s)
      }
      if (changed.length || unjudged.length) {
        say(`\n· the queue is not the one ${PLAN} says was judged:`)
        changed.forEach((s) => say(`    ${s} — edited since it was approved`))
        unjudged.forEach((s) => say(`    ${s} — never judged; it was not in the queue then`))
        say(`  Building anyway. review-specs is what judges a spec against the request.`)
      }
    }
  }
  const specs = specFiles()
  if (!specs.length) die('.caw-tasks/ is empty — nothing to build')

  requireTaskBranch(f)
  if (changedFiles().length) die('working tree is dirty — commit or stash first')

  const startHead = git('rev-parse', 'HEAD').trim()
  let risk = null
  try { risk = readRiskRecord() }
  catch (error) { die(error?.message || String(error)) }
  const planDeclaresRisk = /^risk_class:\s*\S+/m.test(planText || '')
  if (planDeclaresRisk && !risk) {
    die(`${PLAN} declares project risk, but ${RISK_RECORD} is missing; run review-specs again`)
  }
  if (risk) {
    requireMatchingPlanRisk(planText, risk)
    requireCurrentRiskPolicy(risk)
    applyRiskPopulationCertification(risk)
  }
  if (risk?.require_full_gate_baseline && noFull) {
    die(`project risk class ${risk.class} requires gate_full before and after the build; ` +
      '--no-full is not allowed')
  }
  const fullGateBaseline = runRequiredFullGateBaseline(f, risk, startHead)
  // Any saved review history here is stale by construction and is dropped rather than resumed.
  // `build` refuses to start on a dirty tree and every task before this one committed, so the
  // tree a state file describes is not the tree in front of us: whatever it held was thrown
  // away to get the tree clean enough for this command to run. Carrying those items into a
  // fresh executor round would hand it findings about code that no longer exists. `round` and
  // `review` are the commands that resume, and they are the ones that require a dirty tree.
  for (const spec of specs) {
    clearRoundState(spec)
    runTask(spec, f, text)
  }

  if (!noFull && f.gate_full) {
    runFinalFullGate(f, startHead, fullGateBaseline)
  } else if (!f.gate_full) {
    say('\n· no gate_full configured — fast gate is the whole gate')
  } else {
    say('\n· full gate skipped (--no-full)')
  }

  say(`\n${specs.length} task(s) done.  spent ${formatAccounting(accounting)}`)
  // The queue is empty, so the reasoning that produced it has outlived its subject. What was
  // worth keeping is already in the commits, one spec verbatim per task.
  // Gated on the queue, which this line used to assert without reading. `build` deletes
  // PLAN.md at its end, and a queue can gain a spec while the full gate runs for minutes: a
  // second session may plan afresh, or an executor may write one, which the queue guard
  // answers by setting `approved: false`. Unlinking regardless destroys that withdrawal and
  // the next build finds specs with no gate to fail. `done` has always checked; this did not.
  if (existsSync(PLAN) && !specFiles().length) {
    unlinkSync(PLAN)
    say(`  cleared ${PLAN} — the queue it planned is empty`)
  }
  if (!specFiles().length) clearRiskRecord()
  if (notes.length) {
    // Each of these is already in the commit message of the task that produced it. Reprinted
    // here because a note's value is usually to the PROJECT rather than to its own task — the
    // one that mattered on the first live run was about the Xcode project file, not about the
    // file the task changed — and a note nobody reads today is a note nobody greps for later.
    // Not "each is in its own task's commit", which is false for any note a later pass did not
    // repeat: `commit()` writes the notes of the round that committed, and this list is every
    // pass's. Measured on two installs — 26 printed, 12 in a commit.
    say('\nNoticed along the way, across every pass. Each task\'s commit carries what its' +
        ' committing round reported, which can be less than this:\n')
    notes.forEach((n) => say(`  - ${n}`))
  }
}

// A task that stops on `blocked` has already paid for a full executor round, and the work is
// sitting in the tree — complete, and unjudged. What happens next destroys it: `build` refuses
// to start on a dirty tree, so the human's shortest route to running anything at all is to
// throw the tree away. `git stash` would keep it and nothing here ever said so, and a stash is
// the wrong shape besides, because the re-run that follows a fixed spec collides with it.
//
// Measured on one project: $1.44 for a task written CORRECTLY and then abandoned. Its spec's
// `done_when` required a grep to find nothing whose pattern its own `change` list mandated;
// the executor did the work, found the contradiction at the end, refused to guess which half
// to break, and named both. Nothing was wrong with the code. Nothing in the harness offered to
// keep it, and every route forward asked for a clean tree.
//
// Untracked files enter through `git diff --no-index` rather than `git add -N` + `git reset`,
// because that touches no index at all — an intent-to-add followed by a reset is a restore
// step, and a restore step is a thing that can be interrupted. `--binary` so a new binary
// arrives as content rather than "Binary files differ". `.caw-tasks/` is filtered for the reason
// `commit()` resets it: the queue is scratch, never part of a change, and a project that has
// not gitignored it would otherwise find its specs in the patch.
// Buffers, not strings, and an explicit ceiling. `encoding: 'utf8'` turns a Latin-1 source
// file into U+FFFD inside the patch, and `git apply` then reports success over bytes that are
// wrong — a green worse than an error. The default 1 MiB `maxBuffer` on `git()` throws ENOBUFS
// on an ordinary lockfile or generated-file round, which is how the first version of this
// function destroyed the very message it was written to protect.
const gitBuf = (...a) => execFileSync('git', a, { maxBuffer: 256 * 1024 * 1024 })

// argv has a limit and an executor can leave a thousand new files.
const chunked = (list, fn) => { for (let i = 0; i < list.length; i += 400) fn(list.slice(i, i + 400)) }

function ensureLogDir() {
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 })
  try { chmodSync(LOG_DIR, 0o700) } catch { /* platform does not expose POSIX modes */ }
}

function writePrivateFile(path, value, limit) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  if (bytes.length > limit) throw new Error(`${bytes.length} bytes exceeds limit ${limit}`)
  ensureLogDir()
  writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' })
  try { chmodSync(path, 0o600) } catch { /* platform does not expose POSIX modes */ }
  return bytes.length
}

function taskArtifactBase(file) {
  return file.replace(/\.md$/, '').replace(/[^\w.-]+/g, '_')
}

function pruneRecoveryArtifacts(now = Date.now()) {
  if (!existsSync(LOG_DIR)) return
  const active = new Set(specFiles().map(taskArtifactBase))
  const candidates = readdirSync(LOG_DIR)
    .filter((name) => name.startsWith('blocked-') || name.startsWith('diverged-'))
    .map((name) => ({ name, path: join(LOG_DIR, name), stat: lstatSync(join(LOG_DIR, name)) }))
    .filter((entry) => entry.stat.isFile() && !entry.stat.isSymbolicLink())
    .filter((entry) => {
      if (!entry.name.startsWith('blocked-')) return true
      return ![...active].some((base) => entry.name.startsWith(`blocked-${base}`))
    })
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
  const maxAge = 30 * 24 * 60 * 60 * 1000
  candidates.forEach((entry, index) => {
    const reason = now - entry.stat.mtimeMs > maxAge ? 'older than 30 days'
      : index >= 20 ? 'outside newest 20 orphans'
      : null
    if (!reason) return
    unlinkSync(entry.path)
    say(`  pruned artifact ${entry.name}: ${reason}`)
  })
}

function clearTaskRecoveryArtifacts(file) {
  if (!existsSync(LOG_DIR)) return
  const prefix = `blocked-${taskArtifactBase(file)}`
  for (const name of readdirSync(LOG_DIR)) {
    const path = join(LOG_DIR, name)
    if (name.startsWith(prefix) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()) {
      unlinkSync(path)
      say(`  cleared recovery artifact ${name}: task completed`)
    }
  }
}

function saveBlocked(file) {
  // `-z`, because git C-quotes any path holding non-ASCII, a backslash or a control character
  // under the default `core.quotePath`, and a quoted path handed back to git is a path git
  // cannot open. It fails silently: the file is simply absent from the patch.
  const untracked = gitBuf('ls-files', '-z', '--others', '--exclude-standard')
    .toString('utf8').split('\0').filter(Boolean)
    .filter((p) => !p.startsWith(`${QUEUE_DIR}/`) && !p.startsWith(`${LOG_DIR}/`))

  // Intent-to-add, then ONE diff against HEAD. Plain `git diff` compares the worktree with the
  // INDEX, so it shows nothing an executor staged — and an executor with a shell can stage
  // things, at which point the tool announced "it wrote nothing"
  // over a complete delivery. `diff HEAD` carries staged, unstaged, deleted and mode changes;
  // `-N` makes it carry brand-new files too, which are the executor's characteristic product.
  //
  // One process for all of it, which is what retires the per-file `--no-index` loop this
  // replaced: no `/dev/null` argument that win32 may not resolve, no per-file quoting, and no
  // ENOBUFS-truncated stdout appended as though it were a hunk. The restore step is the price,
  // and it is worth paying here: an interrupted `reset` leaves cosmetic index entries, while
  // the four holes above lost or corrupted the delivery in silence.
  //
  // The exclude pathspecs are what keep `.caw-tasks/` out of the TRACKED half — a repo where specs
  // were once committed carries pending spec deletions in `diff HEAD`, and applying that patch
  // would delete files from the live queue. Unlike the `git add` in `commit()`, `git diff`
  // accepts a pathspec naming an ignored path; verified both ways.
  //
  // The name list is taken alongside the patch so the caller can check the patch is whole. One
  // extra local `git diff`, which the question that asked for this hoped to avoid: the free
  // version would have compared only against `untracked`, and truncation drops whatever sorts
  // last rather than whatever is cheapest to notice. A local name-only diff on a warm repository
  // next to a full binary one is not a cost worth a blind spot over half the delivery.
  const PATHSPEC = ['--', '.', `:(exclude)${QUEUE_DIR}`, `:(exclude)${LOG_DIR}`]
  if (untracked.length) chunked(untracked, (c) => git('add', '-N', '--', ...c))
  try {
    const intended = gitBuf('diff', '--name-only', '-z', 'HEAD', ...PATHSPEC)
      .toString('utf8').split('\0').filter(Boolean).length
    return { buf: gitBuf('diff', '--binary', 'HEAD', ...PATHSPEC), intended }
  } finally {
    if (untracked.length) chunked(untracked, (c) => git('reset', '-q', '--', ...c))
  }
}

// Never throws. The executor's account of why it stopped is the most valuable thing produced
// by a round that produced nothing else, and a secondary failure here must not be allowed to
// replace it with a stack trace.
function keepBlocked(file) {
  try {
    pruneRecoveryArtifacts()
    const { buf: patch, intended } = saveBlocked(file)
    if (!patch.length) return { empty: true }
    // Slugs come from a model and specs may be hand-written, so the name is reduced to
    // characters every filesystem takes. Never clobbers: a second block on the same spec used
    // to overwrite the first, and the expensive round is usually the first.
    const base = taskArtifactBase(file)
    if (patch.length > BLOCKED_PATCH_MAX) {
      ensureLogDir()
      let manifest = join(LOG_DIR, `blocked-${base}-not-retained.json`)
      for (let n = 2; existsSync(manifest); n++) {
        manifest = join(LOG_DIR, `blocked-${base}-not-retained-${n}.json`)
      }
      writePrivateFile(manifest, `${JSON.stringify({
        artifact: 'blocked-patch', spec: file, retained: false, bytes: patch.length,
        limit: BLOCKED_PATCH_MAX, sha256: createHash('sha256').update(patch).digest('hex'),
      }, null, 2)}\n`, 64 * 1024)
      return { error: `patch is ${patch.length} bytes; ${BLOCKED_PATCH_MAX}-byte limit, ` +
        `so it was not written (manifest ${manifest})` }
    }
    let out = join(LOG_DIR, `blocked-${base}.patch`)
    for (let n = 2; existsSync(out); n++) out = join(LOG_DIR, `blocked-${base}-${n}.patch`)
    writePrivateFile(out, patch, BLOCKED_PATCH_MAX)
    // The refusal below hands a human a `git apply` recipe, which is a claim that this file
    // reconstitutes the tree, and nothing ever checked it. `saveBlocked`'s own comments list four
    // ways an earlier draft lost the delivery in silence, and each produced a patch that looked
    // whole. The check must be `--reverse`: the tree is dirty by definition here, since the
    // executor's work is already in it, so a forward apply is meaningless while a reverse one asks
    // exactly the right question — does this patch describe what is actually there?
    //
    // What it catches and what it does not, both measured in a scratch repository rather than
    // reasoned about. A patch that no longer describes the tree is caught. A TRUNCATED patch is
    // NOT: `git apply --check` validates the hunks it can parse and a patch does not declare its
    // own completeness, so half a patch passed cleanly. Truncation is one of the four failure
    // modes this function's own history names, so it is closed separately below by counting the
    // file headers the patch carries against the number `saveBlocked` meant to write.
    //
    // COUNT, not the paths themselves. Under the default `core.quotePath` git C-quotes any path
    // holding non-ASCII in a `diff --git` header, so comparing parsed names against raw ones
    // would report a mismatch on a delivery that is perfectly whole — a false "did not verify"
    // on the one artifact a human is being asked to trust. A count is blind to a path being
    // swapped for another, and catches every truncation, which is the failure that happened.
    //
    // Advisory only, and it must stay that way. A patch that fails this is still the only copy of
    // a round that has already been paid for, so it is kept and labelled, never discarded — the
    // same reason this whole function refuses to throw.
    let unverified = null
    const carried = (patch.toString('utf8').match(/^diff --git /gm) || []).length
    if (carried !== intended) {
      unverified = `patch carries ${carried} file(s), ${intended} were meant to be written` +
                   ` — it is short, and \`git apply\` will restore less than the executor left`
    }
    try { if (!unverified) git('apply', '--check', '--reverse', out) }
    catch (e) {
      // The LAST line, not the first: `git apply --check` prints "patch failed: <file>:<n>" and
      // then "patch does not apply", and only the second names what actually went wrong.
      const errLines = (e?.stderr?.toString() || e?.message || String(e)).trim().split('\n').filter(Boolean)
      unverified = errLines[errLines.length - 1] || 'git apply --check --reverse failed'
    }
    return { path: out, unverified }
  } catch (e) {
    return { error: (e?.message || String(e)).split('\n')[0] }
  }
}

// ---------------------------------------------------------------- a task's review history
//
// One item, one identity, for its whole life. Ids are `r<round>.<n>` and the SCRIPT assigns
// them, never the reviewer: an id a model invents is an id a model can reuse, and the one thing
// this record must not allow is two different findings answering to the same name.

const SLOTS = ['broken', 'uncovered', 'weak'] // blocking, in the order a human should read them
const WEAK_BASELINE_BRANCH = 'caw-review-baseline'
const weakCaptureBranch = (index) => `caw-weak-${index + 1}`

class WeakMutationSecurityError extends Error {}
class WeakMutationInvariantError extends Error {}

function prepareWeakCapture(surface) {
  surfaceGit(surface.workingRoot, 'config', 'user.name', 'CAW Review Capture')
  surfaceGit(surface.workingRoot, 'config', 'user.email', 'review-capture@example.invalid')
  surfaceGit(surface.workingRoot, 'add', '-A')
  surfaceGit(surface.workingRoot, 'commit', '-q', '--allow-empty', '-m', 'CAW review baseline')
  const baseline = surfaceGit(surface.workingRoot, 'rev-parse', 'HEAD').trim()
  surfaceGit(surface.workingRoot, 'branch', '-f', WEAK_BASELINE_BRANCH, baseline)
  return baseline
}

function resetReviewPassForSemanticRepair(surface, baseline) {
  restoreWeakReplaySurface(surface, baseline)
  const branches = surfaceGit(surface.workingRoot, 'for-each-ref',
    '--format=%(refname:short)', 'refs/heads/caw-weak-*').split('\n').filter(Boolean)
  for (const branch of branches) surfaceGit(surface.workingRoot, 'branch', '-D', branch)
  restoreWeakReplaySurface(surface, baseline)
}

const weakRefuted = (item, reason) =>
  `weak refuted experiment, noted only — ${item.where}: ${item.fix}; ` +
  `the experiment contradicted the finding (${reason}). Evidence: ${item.evidence}`

const weakUnavailable = (item, reason) =>
  `weak verification unavailable, noted only — ${item.where}: ${item.fix}; ` +
  `verification could not complete (${reason}). Evidence: ${item.evidence}`

function weakPatchPaths(surface, patch) {
  const raw = execFileSync('git', ['apply', '--numstat', '-z', '-'], {
    cwd: surface.workingRoot, input: patch, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  })
  const fields = raw.split('\0').filter(Boolean)
  const paths = []
  for (const field of fields) {
    const tabs = field.split('\t')
    const path = tabs[tabs.length - 1]
    if (!path || isAbsolute(path) || path.split(/[\\/]+/).includes('..')) {
      throw new WeakMutationSecurityError(
        `weak mutation contains an unsafe path: ${path || '(empty)'}`)
    }
    const target = resolve(surface.workingRoot, path)
    if (!inside(surface.workingRoot, target) || path.startsWith('.git/') ||
        path.startsWith(`${QUEUE_DIR}/`) || path.startsWith(`${LOG_DIR}/`) ||
        surface.dependencies.some((dependency) =>
          inside(resolve(surface.workingRoot, dependency.entry), target))) {
      throw new WeakMutationSecurityError(`weak mutation leaves its permitted surface: ${path}`)
    }
    paths.push(path)
  }
  if (!paths.length) throw new Error('weak mutation patch changes no files')
  return paths
}

function weakExpectedPath(item, surface) {
  const where = item?.where?.trim().replace(/^`|`$/g, '') || ''
  const location = where.match(/^(.+?):\d+(?::\d+|[-–]\d+)?$/)?.[1] || where
  if (!location || isAbsolute(location) || location.includes('\\')) return null
  const target = resolve(surface.workingRoot, location)
  if (!inside(surface.workingRoot, target) || !existsSync(target)) return null
  try {
    const stat = lstatSync(target)
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    return relative(surface.workingRoot, target).split(sep).join('/')
  } catch { return null }
}

function captureWeakMutations(items, surface, baseline) {
  const accepted = []
  const noted = []
  for (const [index, item] of (items || []).entries()) {
    try {
      const ref = `refs/heads/${weakCaptureBranch(index)}`
      const commit = surfaceGit(surface.workingRoot, 'rev-parse', '--verify', `${ref}^{commit}`).trim()
      const patch = execFileSync('git', ['diff', '--binary', baseline, commit, '--'], {
        cwd: surface.workingRoot, maxBuffer: REVIEW_PATCH_MAX,
      })
      if (!patch.length) throw new Error(`${weakCaptureBranch(index)} changes no files`)
      if (patch.length > REVIEW_PATCH_MAX) {
        throw new Error(`captured mutation is ${patch.length} bytes; limit is ${REVIEW_PATCH_MAX}`)
      }
      weakPatchPaths(surface, patch)
      accepted.push({ ...item, mutation: { ...item.mutation, patch: patch.toString('utf8') } })
    } catch (error) {
      if (error instanceof WeakMutationSecurityError) throw error
      const detail = (error?.stderr?.toString() || error?.message || String(error))
        .trim().split('\n').filter(Boolean).pop() || 'capture unavailable'
      noted.push(weakUnavailable(item, detail))
    }
  }
  return { accepted, noted }
}

function runWeakControlCommand(command, f, spec, surface) {
  const timeoutMs = f.gate_fast_timeout_ms || WEAK_CONTROL_TIMEOUT_DEFAULT_MS
  const env = { ...process.env, PWD: surface.workingRoot }
  if (spec) env.CAW_SPEC = spec
  const startedAt = Date.now()
  const result = spawnSync('bash', ['-lc', command], {
    cwd: surface.workingRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    env,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  })
  const stdout = (result.stdout || '').slice(-8000)
  const stderr = (result.stderr || '').slice(-8000)
  return {
    status: result.status,
    timeout_ms: timeoutMs,
    duration_ms: Date.now() - startedAt,
    timed_out: result.error?.code === 'ETIMEDOUT',
    stdout,
    stderr,
    output: `${stdout}${stderr}`.slice(-8000),
  }
}

function weakVerificationControls(f, spec, expectedDigest, surface, baseline) {
  if (!f.weak_source_probe_cmd) return null
  const unavailable = (state, sourceProbe, positiveControl = null) => ({
    state, source_probe: sourceProbe, positive_control: positiveControl,
  })
  const sourceProbe = runWeakControlCommand(f.weak_source_probe_cmd, f, spec, surface)
  if (deliveryDigest() !== expectedDigest) {
    throw new WeakMutationInvariantError(
      'delivery tree changed while the weak source probe ran')
  }
  if (sourceProbe.timed_out || sourceProbe.status !== 0) {
    return unavailable(sourceProbe.timed_out
      ? 'unverified-source-probe-timeout' : 'unverified-source-probe-failed', sourceProbe)
  }
  let answer
  try { answer = JSON.parse(sourceProbe.stdout) }
  catch { return unavailable('unverified-source-probe-invalid', sourceProbe) }
  try {
    exactObjectKeys(answer, ['loaded_paths'], 'weak source probe')
    if (!Array.isArray(answer.loaded_paths) || !answer.loaded_paths.length ||
        answer.loaded_paths.some((path) => typeof path !== 'string' || !isAbsolute(path))) {
      throw new Error('weak source probe loaded_paths must be a non-empty array of absolute paths')
    }
    sourceProbe.loaded_paths = answer.loaded_paths.map((path) => {
      const sourceRoot = realpathSync(surface.workingRoot)
      const canonical = realpathSync(path)
      const stat = lstatSync(canonical)
      if (!inside(sourceRoot, canonical) ||
          inside(join(sourceRoot, '.git'), canonical) || !stat.isFile()) {
        throw new Error(`weak source probe path is outside review source: ${path}`)
      }
      return relative(sourceRoot, canonical).split(sep).join('/')
    })
  } catch (error) {
    sourceProbe.reason = error?.message || String(error)
    return unavailable('unverified-source-probe-invalid', sourceProbe)
  }
  const sourceStatus = surfaceGit(
    surface.workingRoot, 'status', '--porcelain=v1', '--untracked-files=all').trim()
  if (sourceStatus) {
    sourceProbe.reason = `source probe changed the review surface: ${sourceStatus}`
    return unavailable('unverified-source-probe-mutated', sourceProbe)
  }

  const positiveControl = runWeakControlCommand(f.weak_positive_control_cmd, f, spec, surface)
  if (deliveryDigest() !== expectedDigest) {
    throw new WeakMutationInvariantError(
      'delivery tree changed while the weak positive control ran')
  }
  if (positiveControl.timed_out || positiveControl.status !== 0) {
    return unavailable(positiveControl.timed_out
      ? 'unverified-positive-control-timeout' : 'unverified-positive-control-failed',
    sourceProbe, positiveControl)
  }
  const status = surfaceGit(
    surface.workingRoot, 'status', '--porcelain=v1', '--untracked-files=all').trim()
  if (!status || status.split('\n').some((line) => line.startsWith('?? '))) {
    positiveControl.reason = !status
      ? 'positive control changed no tracked file'
      : 'positive control created an untracked file'
    return unavailable('unverified-positive-control-invalid', sourceProbe, positiveControl)
  }
  const patch = execFileSync('git', ['diff', '--binary', baseline, '--'], {
    cwd: surface.workingRoot, maxBuffer: REVIEW_PATCH_MAX,
  })
  if (!patch.length || patch.length > REVIEW_PATCH_MAX) {
    positiveControl.reason = 'positive control patch is empty or oversized'
    return unavailable('unverified-positive-control-invalid', sourceProbe, positiveControl)
  }
  try { positiveControl.paths = weakPatchPaths(surface, patch) }
  catch (error) {
    if (error instanceof WeakMutationSecurityError) throw error
    positiveControl.reason = error?.message || String(error)
    return unavailable('unverified-positive-control-invalid', sourceProbe, positiveControl)
  }
  positiveControl.patch_bytes = patch.length
  positiveControl.patch_sha256 = createHash('sha256').update(patch).digest('hex')
  const controlGate = gate(f.gate_fast, spec, surface.workingRoot, f.gate_fast_timeout_ms, {
    task: spec, kind: 'weak-positive-control', deliveryDigest: expectedDigest,
    collectEvidence: false,
  })
  positiveControl.gate = {
    state: controlGate.state,
    status: controlGate.status,
    duration_ms: controlGate.durationMs,
    timeout_ms: controlGate.timeoutMs,
    output: controlGate.out,
  }
  surface.weakGate = {
    phase: 'positive-control', state: controlGate.state, gate: f.gate_fast,
    status: controlGate.status, output: controlGate.out,
  }
  if (controlGate.state !== 'red') {
    return unavailable(`unverified-positive-control-${controlGate.state}`,
      sourceProbe, positiveControl)
  }
  return { state: 'verified', source_probe: sourceProbe, positive_control: positiveControl }
}

function runWeakReplaySession(items, operations) {
  if (!Array.isArray(items)) throw new TypeError('weak replay items must be an array')
  const required = [
    'createSurface', 'prepareSurface', 'restoreSurface',
    'runBaseline', 'runMutation', 'finishSurface',
  ]
  for (const name of required) {
    if (typeof operations?.[name] !== 'function') {
      throw new TypeError(`weak replay operation ${name} must be a function`)
    }
  }

  const surface = operations.createSurface()
  const outcome = { state: 'error', baseline: null, mutations: [], restores: 0 }
  let baseline = null
  try {
    baseline = operations.prepareSurface(surface)
    outcome.baseline = operations.runBaseline(surface, baseline)
    if (outcome.baseline?.state !== 'green') {
      outcome.state = 'baseline-unavailable'
      return outcome
    }
    if (typeof operations.runControls === 'function') {
      outcome.controls = operations.runControls(surface, baseline)
      if (outcome.controls?.state !== 'verified') {
        outcome.state = 'controls-unavailable'
        return outcome
      }
      operations.restoreSurface(surface, baseline, 'controls')
      outcome.restores += 1
    }
    for (const [index, item] of items.entries()) {
      operations.restoreSurface(surface, baseline, index)
      outcome.restores += 1
      outcome.mutations.push(operations.runMutation(item, surface, baseline, index))
    }
    operations.restoreSurface(surface, baseline, items.length)
    outcome.restores += 1
    outcome.state = 'complete'
    return outcome
  } catch (error) {
    outcome.error = error
    throw error
  } finally {
    operations.finishSurface(surface, outcome)
  }
}

function restoreWeakReplaySurface(surface, baseline) {
  surfaceGit(surface.workingRoot, 'reset', '--hard', baseline)
  surfaceGit(surface.workingRoot, 'clean', '-fd')
  const head = surfaceGit(surface.workingRoot, 'rev-parse', 'HEAD').trim()
  const status = surfaceGit(
    surface.workingRoot, 'status', '--porcelain=v1', '--untracked-files=all').trim()
  if (head !== baseline || status) {
    throw new WeakMutationInvariantError(
      `weak replay surface did not restore its baseline${status ? `: ${status}` : ''}`)
  }
}

function replayWeakMutation(item, f, spec, expectedDigest, surface) {
  const patch = item?.mutation?.patch
  if (typeof patch !== 'string' || !patch.length) throw new Error('weak mutation patch is missing')
  const bytes = Buffer.byteLength(patch)
  if (bytes > REVIEW_PATCH_MAX) {
    throw new Error(`weak mutation patch is ${bytes} bytes; limit is ${REVIEW_PATCH_MAX}`)
  }
  if (deliveryDigest() !== expectedDigest) {
    throw new WeakMutationInvariantError(
      'delivery tree changed after its green gate; refusing weak replay')
  }
  const paths = weakPatchPaths(surface, patch)
  const expectedPath = weakExpectedPath(item, surface)
  const patchEvidence = {
    patch,
    patch_sha256: createHash('sha256').update(patch).digest('hex'),
    patch_bytes: bytes,
    paths,
    expected_path: expectedPath,
    expected_path_matched: expectedPath ? paths.includes(expectedPath) : null,
  }
  if (expectedPath && !paths.includes(expectedPath)) {
    const error = new Error(
      `weak mutation changes ${paths.join(', ')} but reviewer location names ${expectedPath}`)
    error.weakPatch = patchEvidence
    throw error
  }
  execFileSync('git', ['apply', '--check', '--binary', '-'], {
    cwd: surface.workingRoot, input: patch, maxBuffer: REVIEW_PATCH_MAX,
  })
  execFileSync('git', ['apply', '--binary', '-'], {
    cwd: surface.workingRoot, input: patch, maxBuffer: REVIEW_PATCH_MAX,
  })
  const startedAt = Date.now()
  const result = gate(f.gate_fast, spec, surface.workingRoot, f.gate_fast_timeout_ms, {
    task: spec, kind: 'weak-mutation', deliveryDigest: expectedDigest, collectEvidence: false,
  })
  const event = {
    state: result.state === 'timeout' ? 'unverified-timeout'
      : result.state === 'refused' ? 'unverified-refused'
      : result.ok ? 'confirmed-weak' : 'mutation-caught',
    ...patchEvidence,
    gate: f.gate_fast,
    gate_status: result.status ?? (result.ok ? 0 : null),
    gate_duration_ms: result.durationMs ?? (Date.now() - startedAt),
    gate_timeout_ms: result.timeoutMs,
    gate_output: result.out.slice(-8000),
  }
  surface.weakGate = {
    phase: 'mutation', state: event.state, gate: event.gate,
    status: event.gate_status, output: event.gate_output,
  }
  return event
}

function weakBaselineGate(f, spec, expectedDigest, surface) {
  if (deliveryDigest() !== expectedDigest) {
    throw new WeakMutationInvariantError(
      'delivery tree changed after its green gate; refusing weak baseline')
  }
  const startedAt = Date.now()
  const result = gate(f.gate_fast, spec, surface.workingRoot, f.gate_fast_timeout_ms, {
    task: spec, kind: 'weak-baseline', deliveryDigest: expectedDigest, collectEvidence: false,
  })
  const observation = {
    gate: f.gate_fast,
    gate_status: result.status ?? (result.ok ? 0 : null),
    gate_duration_ms: result.durationMs ?? (Date.now() - startedAt),
    gate_timeout_ms: result.timeoutMs,
    gate_output: result.out.slice(-8000),
  }
  surface.weakGate = {
    phase: 'baseline',
    state: result.state,
    gate: observation.gate, status: observation.gate_status, output: observation.gate_output,
  }
  return { ...observation, state: surface.weakGate.state }
}

function verifyWeakMutations(items, f, spec, expectedDigest) {
  const total = (items || []).reduce((sum, item) =>
    sum + Buffer.byteLength(typeof item?.mutation?.patch === 'string' ? item.mutation.patch : ''), 0)
  if (total > REVIEW_VERDICT_PATCH_MAX) {
    throw new Error(`weak mutation patches total ${total} bytes; verdict limit is ${REVIEW_VERDICT_PATCH_MAX}`)
  }
  const accepted = []
  const events = []
  const noted = []
  if (!(items || []).length) return { accepted, events, noted, verification: null }
  say(`  weak verification: one reusable replay surface, ${(items || []).length}` +
    ` independent mutation gate(s)`)
  const session = runWeakReplaySession(items, {
    createSurface: () => createReviewSurface(f),
    prepareSurface: (surface) => prepareWeakCapture(surface),
    restoreSurface: (surface, baseline) => restoreWeakReplaySurface(surface, baseline),
    runBaseline: (surface) => weakBaselineGate(f, spec, expectedDigest, surface),
    ...(f.weak_source_probe_cmd ? {
      runControls: (surface, baseline) =>
        weakVerificationControls(f, spec, expectedDigest, surface, baseline),
    } : {}),
    runMutation: (item, surface) => {
      try {
        return { event: replayWeakMutation(item, f, spec, expectedDigest, surface) }
      } catch (error) {
        if (error instanceof WeakMutationSecurityError ||
            error instanceof WeakMutationInvariantError) throw error
        const detail = (error?.stderr?.toString() || error?.message || String(error))
          .trim().split('\n').filter(Boolean).pop() || 'replay unavailable'
        return { error: detail, ...(error?.weakPatch || {}) }
      }
    },
    finishSurface: (surface, outcome) => {
      if (outcome.state === 'baseline-unavailable') {
        const baseline = outcome.baseline || {}
        const baselineReason = baseline.state === 'refused'
          ? ['weak-baseline-refused', 'unmutated weak-verification gate refused to run (status 75)']
          : baseline.state === 'timeout'
            ? ['weak-baseline-timeout', 'unmutated weak-verification gate timed out']
            : ['weak-baseline-red',
                `unmutated weak-verification gate was red (status ${baseline.gate_status})`]
        retainReviewSurface(surface,
          baselineReason[0], baselineReason[1])
      } else if (outcome.state === 'controls-unavailable') {
        retainReviewSurface(surface, 'weak-controls-unavailable',
          outcome.controls?.state || 'weak verification controls did not complete')
      } else if (outcome.state === 'error') {
        retainReviewSurface(surface, 'failure', outcome.error?.message || String(outcome.error || ''))
      } else {
        const refused = outcome.mutations.find((result) =>
          result?.event?.state === 'unverified-refused')
        const timedOut = outcome.mutations.find((result) =>
          result?.event?.state === 'unverified-timeout')
        const caught = outcome.mutations.find((result) =>
          result?.event?.state === 'mutation-caught')
        const failed = outcome.mutations.find((result) => result?.error)
        if (refused) {
          retainReviewSurface(surface, 'weak-gate-refused',
            'weak mutation gate refused to run (status 75)')
        } else if (timedOut) {
          retainReviewSurface(surface, 'weak-gate-timeout',
            'weak mutation gate timed out')
        } else if (caught) {
          retainReviewSurface(surface, 'weak-gate-red',
            `weak mutation made the gate red (status ${caught.event.gate_status})`)
        } else if (failed) {
          retainReviewSurface(surface, 'weak-replay-partial', failed.error)
        } else {
          removeReviewSurface(surface)
        }
      }
    },
  })
  const baseline = session.baseline
  const verification = {
    state: baseline.state === 'green' ? 'baseline-green'
      : baseline.state === 'refused' ? 'unverified-baseline-refused'
      : baseline.state === 'timeout' ? 'unverified-baseline-timeout'
      : 'unverified-baseline-red',
    baseline,
    controls: session.controls || null,
    mutations: [],
    failures: [],
    replay_surface: {
      strategy: 'single-reusable-surface',
      surfaces_created: 1,
      restores: session.restores,
    },
  }
  if (baseline.state !== 'green') {
    say(`  weak verification ${['refused', 'timeout'].includes(baseline.state)
      ? 'DID NOT COMPLETE' : 'unavailable'}:` +
      ` unmutated surface gate status ${baseline.gate_status};` +
      ` recording ${(items || []).length} finding(s) as non-blocking unavailable evidence`)
    for (const item of items || []) {
      noted.push(weakUnavailable(item,
        baseline.state === 'refused' ? 'unmutated baseline gate refused to run'
          : baseline.state === 'timeout' ? 'unmutated baseline gate timed out'
            : `unmutated baseline gate was red (status ${baseline.gate_status})`))
    }
    return { accepted, events, noted, verification }
  }
  if (session.state === 'controls-unavailable') {
    verification.state = session.controls?.state || 'unverified-controls'
    const reason = verification.state.replace(/^unverified-/, '').replaceAll('-', ' ')
    say(`  weak verification DID NOT COMPLETE: ${reason};` +
      ` recording ${(items || []).length} finding(s) as non-blocking unavailable evidence`)
    for (const item of items || []) noted.push(weakUnavailable(item, reason))
    return { accepted, events, noted, verification }
  }
  if (session.controls?.state === 'verified') verification.state = 'controlled-green'
  for (const [index, item] of (items || []).entries()) {
    const result = session.mutations[index]
    if (result?.event) {
      const event = result.event
      verification.mutations.push(event)
      if (event.state === 'confirmed-weak') {
        events.push(event)
        accepted.push(item)
      } else if (event.state === 'unverified-refused') {
        verification.state = 'unverified-mutation-refused'
        noted.push(weakUnavailable(item, 'mutation gate refused to run'))
      } else if (event.state === 'unverified-timeout') {
        verification.state = 'unverified-mutation-timeout'
        noted.push(weakUnavailable(item, 'mutation gate timed out'))
      } else {
        noted.push(weakRefuted(item,
          `weak mutation made the gate red (status ${event.gate_status})`))
      }
    } else {
      const reason = result?.error || 'replay unavailable'
      verification.state = 'unverified-mutation-replay'
      verification.failures.push({
        index,
        state: 'unavailable',
        where: item.where,
        reason,
        ...(result?.patch === undefined ? {} : {
          patch: result.patch,
          patch_sha256: result.patch_sha256,
          patch_bytes: result.patch_bytes,
          paths: result.paths,
          expected_path: result.expected_path,
          expected_path_matched: result.expected_path_matched,
        }),
      })
      noted.push(weakUnavailable(item, reason))
    }
  }
  return { accepted, events, noted, verification }
}

// Flatten a verdict's blocking slots into the history. `state` is the only mutable field on an
// item, and it moves only when a reviewer says so — the script never infers a closure.
function ingest(history, rv, round, weakEvents = [], originRuntime = null) {
  const added = []
  let weakIndex = 0
  for (const slot of SLOTS) {
    for (const it of rv[slot] || []) {
      const item = {
        id: `r${round}.${added.length + 1}`,
        slot,
        round,
        where: (it.where || '').trim(),
        fix: (it.fix || '').trim(),
        evidence: (it.evidence || '').trim(),
        evidence_refs: [...(it.evidence_refs || [])],
        criterion_ids: [...(it.criterion_ids || [])],
        surface_ids: [...(it.surface_ids || [])],
        transition_ids: [...(it.transition_ids || [])],
        property_key: it.property_key || null,
        state: 'open',
        origin_runtime: originRuntime,
        review_pass: it.review_pass || 1,
        discovery: it.discovery || 'primary',
        baseline_digest: it.baseline_digest || null,
      }
      item.work_package_id = groupFindings([item])[0].id
      if (slot === 'weak') item.mutation_event = weakEvents[weakIndex++]
      history.push(item)
      added.push(item)
    }
  }
  return added
}

// Reviewer passes are independent samples over one immutable delivery digest. The merge is
// conservative: one dissent keeps a carried item open and the strongest non-met criterion wins.
// New findings from challenger passes are retained and explicitly marked as late discoveries
// against the same baseline; they are never silently presented as facts about a later delivery.
function mergeReviewPasses(passes, baselineDigest) {
  if (!Array.isArray(passes) || !passes.length) {
    throw new TypeError('at least one review pass is required')
  }
  const stateRank = { met: 0, weak: 1, uncovered: 2, broken: 3 }
  const criteriaOrder = passes[0].verdict.criteria.map((row) => row.id)
  const criteria = criteriaOrder.map((id) => {
    const rows = passes.map((pass) => pass.verdict.criteria.find((row) => row.id === id))
    const state = rows.reduce((worst, row) =>
      stateRank[row.state] > stateRank[worst] ? row.state : worst, 'met')
    return {
      id,
      state,
      evidence: rows.map((row, index) => `pass ${index + 1}: ${row.evidence}`).join('\n'),
      evidence_refs: [...new Set(rows.flatMap((row) => row.evidence_refs || []))],
    }
  })
  const carriedIds = passes[0].verdict.carried.map((row) => row.id)
  const carried = carriedIds.map((id) => {
    const rows = passes.map((pass) => pass.verdict.carried.find((row) => row.id === id))
    const states = new Set(rows.map((row) => row.state))
    return {
      id,
      state: states.size === 1 ? rows[0].state : 'open',
      evidence: rows.map((row, index) => `pass ${index + 1}: ${row.evidence}`).join('\n'),
      evidence_refs: [...new Set(rows.flatMap((row) => row.evidence_refs || []))],
    }
  })
  const merged = { criteria, carried, broken: [], uncovered: [], weak: [], noted: [] }
  const weakEvents = []
  for (const [passIndex, pass] of passes.entries()) {
    for (const slot of SLOTS) {
      for (const [itemIndex, source] of (pass.verdict[slot] || []).entries()) {
        const item = {
          ...source,
          review_pass: passIndex + 1,
          discovery: passIndex === 0 ? 'primary' : 'late-same-baseline',
          baseline_digest: baselineDigest,
        }
        merged[slot].push(item)
        if (slot === 'weak') weakEvents.push(pass.weakEvents[itemIndex])
      }
    }
    for (const note of pass.verdict.noted || []) {
      const tagged = passIndex === 0 ? note : `[late on ${baselineDigest.slice(0, 12)}] ${note}`
      if (!merged.noted.includes(tagged)) merged.noted.push(tagged)
    }
  }
  const weakPasses = passes.map((pass, index) => ({
    pass: index + 1,
    state: pass.weakVerification?.state || 'not-requested',
    verification: pass.weakVerification,
  }))
  const limited = weakPasses.find((pass) => pass.state.startsWith('unverified'))
  const weakVerification = passes.length === 1 ? passes[0].weakVerification : {
    state: limited?.state || (weakPasses.some((pass) => pass.state === 'controlled-green')
      ? 'controlled-green' : 'baseline-green'),
    baseline: passes[0].weakVerification?.baseline || null,
    controls: passes[0].weakVerification?.controls || null,
    mutations: weakPasses.flatMap((pass) => pass.verification?.mutations || []),
    failures: weakPasses.flatMap((pass) => pass.verification?.failures || []),
    replay_surface: {
      strategy: 'one-reusable-surface-per-review-pass',
      passes: weakPasses.length,
      surfaces_created: weakPasses.length,
      restores: weakPasses.reduce((sum, pass) =>
        sum + (pass.verification?.replay_surface?.restores || 0), 0),
    },
    passes: weakPasses,
  }
  return { verdict: merged, weakEvents, weakVerification }
}

// The reviewer's judgement on what this task was already holding. An item it does not mention
// stays OPEN, and that default is the load-bearing half: read generously, silence would approve
// a task by omission, which is the one failure a carried record exists to make impossible.
function adjudicate(history, carried) {
  const byId = new Map(history.map((i) => [i.id, i]))
  const wasOpen = history.filter((i) => i.state === 'open').map((i) => i.id)
  const closed = [], withdrawn = [], unknown = []
  for (const c of carried || []) {
    const id = (c.id || '').trim()
    const item = byId.get(id)
    if (!item) { unknown.push(id || '(no id)'); continue }
    if (item.state !== 'open') continue // settled in an earlier round, and not re-openable here
    // What the reviewer checked THIS round, whichever way it went. On a closure it is the
    // proof; on an item left open it is the sharper half of the instruction — "I ran this and
    // it still fails" says more to the next executor than the sentence that raised the item a
    // round ago, which has by now been read and acted on once without success.
    item.checked = (c.evidence || '').trim()
    item.checked_evidence_refs = [...(c.evidence_refs || [])]
    if (c.state === 'closed') { item.state = 'closed'; closed.push(item) }
    else if (c.state === 'withdrawn') { item.state = 'withdrawn'; withdrawn.push(item) }
  }
  const named = new Set((carried || []).map((c) => (c.id || '').trim()))
  return {
    closed, withdrawn, unknown,
    // How many items this round was actually asked about — the denominator of "closed N of M".
    given: wasOpen.length,
    // Open items the verdict said nothing about. Reported rather than punished: the schema asks
    // for one entry per open id, and a verdict that skips one has told the human something
    // about its own care that is worth a line at a stop.
    silent: wasOpen.filter((id) => byId.get(id).state === 'open' && !named.has(id)),
  }
}

const openItems = (history) => history.filter((i) => i.state === 'open')

function renderOriginRuntime(originRuntime) {
  if (!originRuntime) return '\n      origin: legacy/unknown'
  const origins = Array.isArray(originRuntime) ? originRuntime : [originRuntime]
  return origins.map((origin, index) => {
    const pass = origins.length > 1 ? `pass ${origin?.pass || index + 1} ` : ''
    return `\n      origin: ${pass}${origin?.provider || 'unknown'}/${
      origin?.requested?.model || '?'} runtime=${origin?.runtime_digest?.slice(0, 12) || '?'}`
  }).join('')
}

// What the executor is handed. The evidence travels with the item, and it is not padding: "this
// assertion can be mutated green" and the mutation that proves it are different instructions,
// and the executor has no other way to see the tree the way the reviewer saw it.
const renderItems = (items) => items
  .map((i) => `[${i.id}] ${i.slot} — ${i.where}\n      ${i.fix}\n      evidence: ${i.evidence}` +
    renderOriginRuntime(i.origin_runtime) +
    (i.discovery === 'late-same-baseline'
      ? `\n      discovery: challenger pass ${i.review_pass}, late on baseline ${
          i.baseline_digest?.slice(0, 12) || '?'}`
      : '') +
    (i.checked ? `\n      still open after the last round: ${i.checked}` : ''))
  .join('\n  - ')

const renderWorkPackages = (items) => groupFindings(items).map((group) =>
  `[${group.id}] property ${group.property_key || 'legacy-ungrouped'}; members ` +
    `${group.members.map((item) => item.id).join(', ')}\n      ` +
    renderItems(group.members).replaceAll('\n', '\n      ')).join('\n  - ')

// The line the whole change exists to make printable. "3 findings, again" and "2 closed, 1 still
// open, 0 new" are the same round described twice, and they lead a human to opposite answers.
function sayRound(round, rounds, adj, added, open, notedCount, taskAccounting) {
  say(`  round ${round} (${rounds} this invocation):` +
      `  closed ${adj.closed.length} of ${adj.given}` +
      (adj.withdrawn.length ? `,  withdrawn ${adj.withdrawn.length}` : '') +
      `,  new ${added.length},  open now ${open.length}` +
      (notedCount ? `,  noted ${notedCount}` : '') +
      `,  ${formatAccounting(taskAccounting)} on this task`)
  if (adj.unknown.length) {
    say(`    the verdict named ${adj.unknown.length} id(s) this task never raised: ${adj.unknown.join(', ')}`)
  }
  if (adj.silent.length) {
    say(`    and said nothing about ${adj.silent.length} open item(s), which therefore stay open:` +
        ` ${adj.silent.join(', ')}`)
  }
  for (const i of adj.closed) say(`    closed  [${i.id}] ${i.where} — ${i.checked}`)
  for (const i of adj.withdrawn) say(`    withdrawn by the reviewer  [${i.id}] ${i.where} — ${i.checked}`)
}

// The two commands that answer the question a stop asks, written with the redirection already
// on them so that what a human copies is a run the log guard will allow rather than refuse.
function sayWaysOn(file) {
  say(`\n  Nothing is committed, the tree holds the last round's work, and ${join(QUEUE_DIR, file)}`)
  say(`  is still in the queue. The review history is saved, so both ways on carry the open items`)
  say(`  above instead of starting a fresh reading of the tree:\n`)
  say(`    node caw.mjs round ${file} > .caw-logs/round-$(date +%H%M%S).log 2>&1`)
  say(`      ONE more round — the executor against those items, then the reviewer. It stops and`)
  say(`      asks again, so a third round is a third decision rather than a default.\n`)
  say(`    <close the open items by hand, leaving the work in the tree>`)
  say(`    node caw.mjs review ${file} > .caw-logs/review-$(date +%H%M%S).log 2>&1`)
  say(`      the reviewer judges what you did, and nothing else runs. On approve it commits, so`)
  say(`      a hand-finished task carries a review like every other one.\n`)
  say(`  Either commits the task on approval. Run build again for the rest of the queue.`)
}

function requireTaskReviewIndependence(f, author) {
  const independence = reviewIndependence(f.task_independence, 'executor', 'reviewer', author)
  resolvedRuntime.independence = [
    ...(resolvedRuntime.independence || []).filter((entry) => entry.scope !== 'task'),
    independence,
  ]
  if (!independence.satisfied) {
    const label = (participant) => `${participant.vendor || 'unknown'}/${participant.model || 'unknown'}`
    die(`task independence requires ${independence.mode}; recorded author is ` +
      `${label(independence.author)} and reviewer is ${label(independence.reviewer)}. ` +
      independence.reason)
  }
}

function taskGatePolicy(file, f, g, executorRetries, confirmationRuns, projectGateRetries) {
  return runProjectPolicy('gate', {
    task: file,
    command: f.gate_fast,
    state: g.state,
    status: g.status ?? (g.ok ? 0 : null),
    output: g.out.slice(-8000),
    duration_ms: g.durationMs,
    timeout_ms: g.timeoutMs,
    executor_retries: executorRetries,
    confirmation_runs: confirmationRuns,
    project_retry_runs: projectGateRetries,
  })
}

// `opts.resume` carries what a previous invocation left — the history, the round count, and the
// last executor's delivery, so that a commit reached from `review` still has a summary to write.
// `opts.startAt` is 'gate' only for `review`, where the hands that did the work have already put
// it down. `opts.rounds` is how many review rounds THIS invocation may spend: the whole cap
// inside `build`, and exactly one from `round` and `review`, because a human who authorised one
// more round authorised one.
function runTask(file, f, profileText, opts = {}) {
  setProviderBudgetPhase('delivery', file)
  const { resume = null, startAt = 'executor', rounds = MAX_TASK_ROUNDS, how = null } = opts

  // Guarded for the same reason `commit()` now guards its unlink: `.caw-tasks/` is not this
  // script's to rely on, and a spec removed between the queue snapshot and this read would
  // otherwise throw ENOENT out of a run that may already have committed tasks — no `die`, so
  // no notes appended and no spend line.
  let spec
  try { spec = readFileSync(join(QUEUE_DIR, file), 'utf8') }
  catch (e) { die(`${file} — cannot read it: ${(e?.message || e).toString().split('\n')[0]}`) }
  const topology = extractTaskTopology(spec)
  const coreCriteria = topology.criteria
  const acceptancePolicy = runProjectPolicy('acceptance', {
    task: file,
    criteria: topology.criteria,
    surfaces: topology.surfaces,
    transitions: topology.transitions,
  })
  const acceptanceCases = acceptancePolicy?.output.cases || []
  say(`\n· ${file}`)

  const history = resume?.history || []
  const startRound = resume?.round || 0
  let round = startRound // review rounds: attempts a reviewer actually judged
  let retry = 0 // executor retries bought by a confirmed red gate
  let gateRedAttempts = 0 // all red gate invocations, including confirmation runs
  let confirmationRuns = 0 // provider-free reruns since the last executor delivery
  let projectGateRetries = 0 // bounded policy retries for a confirmed project-classified flaky gate
  let ex = resume?.ex || null
  let gateFact = null // a red gate's output, which is a fact handed over rather than a finding
  let weakVerification = resume?.weak_verification || null
  // The reviewer's non-blocking sightings, kept per task so the commit can carry them. The
  // global `notes` array cannot serve here: it spans every task in the run and is printed once
  // at the end, so a commit built from it would attribute one task's observations to another.
  const noted = resume?.noted || []
  let skipExecutor = startAt === 'gate'
  // What this task has cost, carried across invocations and combined only through the accounting
  // algebra. Legacy numeric state migrates to known USD without inventing runtime provenance.
  const resumedAccounting = resume
    ? normalizeAccounting(resume.accounting ?? resume.spent ?? 0)
    : zeroAccounting()
  const runAccountingAtTaskStart = normalizeAccounting(accounting)
  const taskAccounting = () => addAccounting(
    resumedAccounting, deltaAccounting(accounting, runAccountingAtTaskStart))
  const runtimeHistory = [...(resume?.runtime_history || [])]

  if (history.length) {
    say(`  resumed: ${openItems(history).length} open item(s) from ${startRound} earlier round(s)`)
    // The spec is the contract every open item was written against. A human answering a stop by
    // editing it is doing something legitimate — often the right answer — but it makes the
    // carried items claims about a document that no longer exists, and `withdrawn` is the slot
    // that settles which ones survive. Said out loud rather than acted on: dropping the history
    // here would destroy the only record of what was already checked.
    if (resume.spec_digest && resume.spec_digest !== specDigest(spec)) {
      say(`  NOTE: ${join(QUEUE_DIR, file)} has been edited since those items were raised. They`)
      say(`  were written against the earlier text; the reviewer sees the current one and can`)
      say(`  withdraw any that the edit has answered.`)
    }
    if (resume.runtime_digest && resume.runtime_digest !== resolvedRuntime.digest) {
      say(`  RUNTIME DIVERGENCE: carried findings originated under ${resume.runtime_digest.slice(0, 12)}`)
      say(`  and are now judged under ${resolvedRuntime.digest.slice(0, 12)}; origins remain attached.`)
    }
    const currentPolicies = projectPolicySnapshot()
    const snapshotDigest = (snapshot) => snapshot?.set_digest || (snapshot
      ? createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
      : null)
    if (resume.project_policies !== undefined &&
        snapshotDigest(resume.project_policies) !== snapshotDigest(currentPolicies)) {
      say(`  PROJECT POLICY DIVERGENCE: saved ${snapshotDigest(resume.project_policies)?.slice(0, 12) || 'none'}`)
      say(`  and current ${snapshotDigest(currentPolicies)?.slice(0, 12) || 'none'}; the new policy set is recorded.`)
    }
  }

  // Every delivery gets at most one provider-free confirmation. Only a confirmed red gate
  // consumes an executor retry; reviewer rounds remain separately bounded.
  // What HEAD was before the executor ran. Only used to tell two silences apart below.
  let headBeforeExecutor = null
  for (;;) {
    if (skipExecutor) {
      skipExecutor = false
    } else {
      const open = openItems(history)
      headBeforeExecutor = headCommit()
      const dossier = buildTaskDossier({
        spec, profile: profileText, open, files: changedFiles(), diff: taskDeliveryDiff(),
        gateEvidence: gateFact, executorClaims: ex?.claims || [], acceptanceCases,
      })
      ex = agent('executor', [
        dossier.text,
        '\n\nImplement the task contract. Treat executor claims in the dossier only as prior hints.',
        open.length
          ? '\nClose every open finding in the dossier before doing unrelated work.' +
            (open.some((i) => i.round < round)
              ? ' Older ids have survived at least one attempted fix; use their checked evidence.'
              : '')
          : '',
      ].join(''), SCHEMA.delivery, f, file, { dossier: dossier.meta, round: round + 1 })
      const claimsProblem = executorClaimsIssue(ex.claims, coreCriteria, acceptanceCases)
      if (claimsProblem) schemaFailure('executor', '$.claims', claimsProblem)
      runtimeHistory.push({ round: round + 1, role: 'executor', ...runtimeIdentity(ex) })

      if (blocked(ex.blocked)) {
        const kept = keepBlocked(file)
        die(`${file} — executor stopped:\n\n${ex.blocked}\n\n` +
            (kept.path
              ? `  Its work is in the tree and a copy is at ${kept.path}.\n` +
                (kept.unverified
                  ? `  THAT COPY DID NOT VERIFY: git apply --check --reverse says "${kept.unverified}".\n` +
                    `  So it may not restore what is in the tree. Copy the tree out by hand as well.\n`
                  : '') +
                `  NOTHING JUDGED IT — no gate ran on it and no reviewer saw it, so it is a\n` +
                `  starting point, not a delivery. build refuses a dirty tree, so to run again:\n` +
                `    cp ${kept.path} ..            # 'git clean' would take it with the tree\n` +
                `    <clear the tree, fix the spec>\n` +
                `    git apply ../${kept.path.split('/').pop()}   # from the repository root\n`
              : kept.error
                ? `  Its work could not be saved: ${kept.error}\n` +
                  `  The tree still holds it. Copy it out by hand before you clear anything.\n`
                : `  It wrote nothing, so there is nothing to keep.\n`) +
            `  The spec is still on disk. Fix what the executor named, then run build again.`)
      }
      // De-duplicated because a task that goes two review rounds runs the executor twice, and an
      // observation about the tree is usually still true the second time — so it arrives again,
      // identical. The key is the whole prefixed line, so the same sentence reported by two
      // DIFFERENT tasks is kept twice: that is two independent sightings, not one repeat.
      ;(ex.notes || []).forEach((n) => {
        const line = `${file}: ${n}`
        if (!notes.includes(line)) notes.push(line)
      })
      // Before the gate, because the gate is the next thing that can take minutes and the
      // delivery is already real: the files are written and this is the earliest moment at
      // which losing the process would lose something that cost money.
      saveRound(file, spec, ex, history, round, how, noted, taskAccounting(), runtimeHistory,
        weakVerification)
      gateFact = null
      confirmationRuns = 0
      projectGateRetries = 0
    }

    const gateDelivery = deliveryDigest()
    const g = gate(f.gate_fast, file, undefined, f.gate_fast_timeout_ms, {
      task: file,
      kind: 'fast',
      deliveryDigest: gateDelivery,
      criteria: coreCriteria,
      acceptanceCases,
    })
    if (deliveryDigest() !== gateDelivery) {
      stop(file, spec, ex, history, round, how, noted,
        `${file} — the fast gate changed the tracked delivery tree; its receipt no longer ` +
          'describes the current delivery.',
        taskAccounting(), runtimeHistory, weakVerification)
    }
    const gatePolicy = taskGatePolicy(file, f, g, retry, confirmationRuns, projectGateRetries)
    if (gatePolicy?.output.action === 'stop') {
      if (g.out) say(g.out)
      stop(file, spec, ex, history, round, how, noted,
        `${file} — project gate policy ${gatePolicy.policy.id} stopped the run: ` +
          gatePolicy.output.reason.trim(),
        taskAccounting(), runtimeHistory, weakVerification)
    }
    if (!g.ok) {
      if (g.state === 'timeout') {
        say(g.out)
        stop(file, spec, ex, history, round, how, noted,
             `${file} — the fast gate TIMED OUT after ${formatTimeout(g.timeoutMs)} and was killed.` +
             ` No gate verdict exists; re-run it or adjust gate_fast_timeout_ms in .caw/CAW.md.`,
             taskAccounting(), runtimeHistory, weakVerification)
      }
      // A refusal spends no retry, because no executor round changes why a gate refuses to
      // start. Retrying it would burn the purse and then report "still red after N retries"
      // about a gate that never ran once. Same convention as the full gate above; unlike it,
      // this branch has never fired — the one gate known to exit 75 is a full one.
      if (g.state === 'refused') {
        say(g.out)
        if (g.receipt?.manifest?.error) {
          stop(file, spec, ex, history, round, how, noted,
               `${file} — the fast gate command finished with state ${g.receipt.command_state}, ` +
               `but CAW refused its evidence: ${g.receipt.manifest.error}`,
               taskAccounting(), runtimeHistory, weakVerification)
        }
        stop(file, spec, ex, history, round, how, noted,
             `${file} — the fast gate DID NOT RUN: it refused to start, so nothing was tested.` +
             `\n  Clear the refusal first — it is not a defect in the delivery:  ${f.gate_fast}`,
             taskAccounting(), runtimeHistory, weakVerification)
      }
      gateRedAttempts += 1
      const action = decideGateFailure({
        reviewOnly: startAt === 'gate',
        confirmationRuns,
        executorRetries: retry,
        maxExecutorRetries: MAX_GATE_RETRIES,
      })
      if (action === GateFailureAction.confirm) {
        confirmationRuns += 1
        skipExecutor = true
        say('  gate red — confirming once without an executor')
        continue
      }
      if (gatePolicy?.output.action === 'retry' &&
          projectGateRetries < PROJECT_GATE_RETRIES_MAX) {
        projectGateRetries += 1
        confirmationRuns += 1
        skipExecutor = true
        say(`  project gate policy classified the confirmed failure as flaky — retry ` +
          `${projectGateRetries}/${PROJECT_GATE_RETRIES_MAX} without an executor`)
        continue
      }
      if (gatePolicy?.output.action === 'retry') {
        say(`  project flaky retry cap reached (${PROJECT_GATE_RETRIES_MAX})`)
      }
      if (action === GateFailureAction.stopReview) {
        say(g.out)
        stop(file, spec, ex, history, round, how, noted,
             `${file} — review baseline stayed red after one provider-free confirmation.` +
             ` No executor ran; fix or classify the gate failure, then run review again.`,
             taskAccounting(), runtimeHistory, weakVerification)
      }
      if (action === GateFailureAction.stopRetries) {
        say(g.out)
        stop(file, spec, ex, history, round, how, noted,
             `${file} — gate stayed red after ${MAX_GATE_RETRIES} executor retries.` +
             ` Its output is above.`,
             taskAccounting(), runtimeHistory, weakVerification)
      }
      retry += 1
      confirmationRuns = 0
      say(`  gate reproducibly red (executor retry ${retry}/${MAX_GATE_RETRIES})`)
      gateFact = g.receipt
      continue
    }

    const files = changedFiles()
    if (!files.length) {
      // Two different silences reach here and they need opposite answers. An executor that did
      // nothing leaves HEAD where it was; one that committed its own work leaves a clean tree
      // with HEAD moved. Measured once, on a Codex executor: the run stopped with "nothing
      // changed" while the work sat in a commit the engine had not made, and the operator was
      // sent to read the spec when the thing to read was `git log`.
      //
      // The engine owns commits for a reason the message has to carry: `git log` is the record,
      // and a commit the engine made carries its spec's full text and clears the spec from the
      // queue. One it did not make carries neither. Refusing is right; misnaming why is not.
      const headNow = headCommit()
      if (headBeforeExecutor && headNow && headNow !== headBeforeExecutor) {
        die(`${file} — the executor committed its own work and left nothing to stage.\n` +
            `  HEAD moved ${headBeforeExecutor.slice(0, 8)} -> ${headNow.slice(0, 8)}, tree clean.\n\n` +
            `  The engine owns commits: one it did not make carries no spec text and does not\n` +
            `  clear the queue, so this task cannot be judged or closed as it stands.\n\n` +
            `  Put the work back and have it judged — the reviewer sees the same tree either way:\n` +
            `    git reset --soft ${headBeforeExecutor.slice(0, 8)}\n` +
            `    node caw.mjs review ${file} > ${LOG_DIR}/review-$(date +%H%M%S).log 2>&1`)
      }
      die(`${file} — gate is green but nothing changed. Read the spec yourself.`)
    }

    const open = openItems(history)
    const deliveryBaseline = deliveryDigest()
    const reviewPolicy = runProjectPolicy('review', { spec, files, criteria: coreCriteria })
    const projectCriteria = (reviewPolicy?.output.criteria || []).map((item) => ({
      ...item,
      id: `project:${reviewPolicy.policy.id}:${item.id}`,
      section: `Project: ${item.section}`,
    }))
    const projectReviewInstructions = reviewPolicy?.output.instructions.length
      ? '\n\nProject review policy instructions:\n\n' +
        reviewPolicy.output.instructions.map((item) => `- ${item}`).join('\n')
      : ''
    if (f.task_independence === 'human-review') {
      saveRound(file, spec, ex, history, round, how, noted, taskAccounting(), runtimeHistory,
        weakVerification)
      die(`${file} — automated task review is disabled by task_independence: human-review.\n` +
        `  The green-gate delivery is preserved. Prepare its signed review with:\n` +
        `    node caw.mjs human-review prepare task ${file} <identity>`)
    }
    const authorRuntime = [...runtimeHistory].reverse().find((entry) => entry.role === 'executor') || null
    requireTaskReviewIndependence(f, authorRuntime)
    const reviewPasses = []
    const reviewSurfaceIds = []
    const reviewDossier = buildTaskDossier({
      spec,
      profile: profileText,
      open,
      files,
      diff: taskDeliveryDiff(),
      gateEvidence: g.receipt,
      executorClaims: ex?.claims || [],
      acceptanceCases,
    })
    let weakBaseline = null
    const passCount = 1 + f.review_challenger_passes
    for (let passIndex = 0; passIndex < passCount; passIndex++) {
      const reviewSurface = createReviewSurface(f, g.receipt)
      reviewSurfaceIds.push(reviewSurface.parent.split(/[\\/]/).pop())
      const passBaseline = prepareWeakCapture(reviewSurface)
      weakBaseline ||= passBaseline
      let passVerdict
      let semanticProblem = null
      const reviewPrompt = [
        reviewDossier.text,
        reviewSurface.gateArtifacts.length
          ? '\n\n## Read-only gate artifacts:\n' + stableJson(reviewSurface.gateArtifacts) +
            '\nRead these exact files to inspect gate evidence. Reference them as gate-artifact:<id>.' +
            ' They are outside your writable roots and survive Git experiment resets.'
          : '',
        '\n\n',
        `Review pass ${passIndex + 1} of ${passCount}. ` +
          (passIndex === 0
            ? 'This is the primary pass.'
            : 'This is a blind challenger pass. Do not assume the primary pass found everything.'),
        `\n\nAll passes judge the exact delivery digest ${deliveryBaseline}.`,
        `\n\nThe gate \`${f.gate_fast}\` has been run by the orchestrator and is green.`,
        ` Its engine-owned receipt is ${g.receipt.receipt_id}. Whether it passes is settled.`,
        ' Use receipt checks and artifacts before consulting executor claims. Claims are untrusted',
        ' navigation hints. Judge whether the gate passes for the right reason.',
        '\n\nEngine-enumerated task contract. Fill `criteria` with exactly one row per id,',
        ' and finish every row before returning. For a non-met row, the corresponding blocking',
        ' item must quote the criterion text exactly in its evidence. An already-open carried',
        ' item is that blocking item when its saved evidence quotes the criterion; keep it in',
        ' `carried` and do not duplicate it as a new finding:\n\n' +
          renderReviewCriteria(spec, projectCriteria),
        '\n\nEvery criterion disposition, carried adjudication, and new finding must include',
        ' `evidence_refs`. Use `gate-receipt:<id>`, `gate-check:<id>`,',
        ' `gate-artifact:<id>`, `executor-claim:<id>`, `repository:<path>` or',
        ' `review-experiment:<id>`. A met criterion cannot rely only on executor claims.',
        ' Every new finding must also name criterion_ids, surface_ids, transition_ids and one',
        ' stable property_key. Use empty surface/transition arrays only when the contract has no',
        ' applicable topology. Repeated symptoms share a work package only when all these stable',
        ' links and property_key match; similar prose or a shared file is not enough.',
        projectReviewInstructions,
        '\n\nYou are in an isolated Git review surface. Experiment only here. Its clean experiment' +
          ` baseline is commit ${passBaseline} on branch ${WEAK_BASELINE_BRANCH}. For weak item N` +
          ` (array order, starting at 1), reset to that baseline, make only its mutation, commit` +
          ` it, force branch caw-weak-N to that commit, then reset to the baseline before the next` +
          ` item and before returning. Do not type or return a diff: the engine derives each` +
          ` \`git diff --binary\` from those branches, replays it from the unchanged delivery` +
          ` baseline and runs the gate itself.`,
        open.length
          ? `\n\nThis is round ${round + 1} of this task. The items below are open against it:` +
            ' an earlier verdict raised each one, and the executor has since been told to close' +
            ' it.' +
            (open.some((i) => i.round < round)
              ? ' Some have been carried through more than one round.'
              : '') +
            '\n\nWork packages (fix each root cause once; adjudicate every member id):\n\n  - ' +
            renderWorkPackages(open) +
            '\n\nFill `carried` with one entry per id above, and do that BEFORE looking for' +
            ' anything new — whether the tree now satisfies what was already raised is the' +
            ' question this round exists to answer, and an id you leave out stays open.' +
            ' `withdrawn` is there and using it is not a defeat: an item that was wrong when it' +
            ' was raised should be retracted rather than carried, and retracting your own costs' +
            ' this task less than the executor bending the code to satisfy it.'
          : '\n\nThis is round 1 of this task and nothing is open, so `carried` is empty.',
      ].join('')
      const reviewContext = {
        workingRoot: reviewSurface.workingRoot,
        scratchRoot: reviewSurface.scratchRoot,
        surfaceId: reviewSurfaceIds.at(-1),
        dossier: reviewDossier.meta,
        round: round + 1,
        pass: passIndex + 1,
        deniedReadPaths: reviewSurface.deniedReadPaths,
        writeBoundary: {
          kind: REVIEW_WRITE_BOUNDARY,
          writableRoot: reviewSurface.workingRoot,
          deniedReadPaths: reviewSurface.deniedReadPaths,
          readOnlyDependencyRoots: reviewSurface.dependencies.map((d) => d.canonical),
        },
      }
      try {
        for (let repair = 0; repair <= MAX_REVIEW_SEMANTIC_REPAIRS; repair++) {
          const prompt = repair === 0 ? reviewPrompt : [
            `Semantic repair ${repair} for review pass ${passIndex + 1} of ${passCount}.`,
            '\n\nYour previous response passed the JSON schema but failed the engine semantic',
            ` consistency check at ${semanticProblem.path}: ${semanticProblem.message}.`,
            '\nReturn one complete replacement verdict. The review surface has been restored to',
            ' the same baseline. Preserve valid findings, rerun any weak experiments you still',
            ' claim, adjudicate every carried id, and do not duplicate an open carried finding',
            ' into a new blocking slot merely to justify the same non-met criterion.',
            '\n\nOriginal review request:\n\n', reviewPrompt,
            '\n\nRejected canonical value:\n\n', JSON.stringify(passVerdict),
          ].join('')
          passVerdict = agent('reviewer', prompt, SCHEMA.verdict, f, file, reviewContext)
          if (deliveryDigest() !== deliveryBaseline) {
            die(`${file} — delivery tree changed during reviewer pass ${passIndex + 1}; refusing the verdict`)
          }
          const carriedProblem = carriedSetIssue(passVerdict.carried, open)
          const criteriaProblem = carriedProblem ? null : reviewCriteriaIssue(
            spec, passVerdict.criteria, passVerdict, projectCriteria, open)
          if (!carriedProblem && !criteriaProblem) {
            bindFindingCriteria(passVerdict, [...coreCriteria, ...projectCriteria])
          }
          const contractProblem = carriedProblem || criteriaProblem ? null : reviewContractIssue(
            passVerdict, {
              criteria: [...coreCriteria, ...projectCriteria],
              surfaces: topology.surfaces,
              transitions: topology.transitions,
              receipt: g.receipt,
              claims: ex?.claims || [],
            })
          semanticProblem = carriedProblem
            ? { path: '$.carried', message: carriedProblem }
            : criteriaProblem ? { path: '$.criteria', message: criteriaProblem }
              : contractProblem ? { path: '$.evidence', message: contractProblem } : null
          if (!semanticProblem) break
          recordEngineDiagnostic('reviewer', 'semantic-validation', {
            pass: passIndex + 1,
            repair,
            baseline_digest: deliveryBaseline,
            path: semanticProblem.path,
            message: semanticProblem.message,
          }, runtimeIdentity(passVerdict)?.attempt_id || null)
          if (repair >= MAX_REVIEW_SEMANTIC_REPAIRS) break
          say(`  reviewer semantic inconsistency; retrying pass ${passIndex + 1} once: ` +
            `${semanticProblem.path} ${semanticProblem.message}`)
          resetReviewPassForSemanticRepair(reviewSurface, passBaseline)
        }
        if (!semanticProblem) {
          try {
            const captured = captureWeakMutations(passVerdict.weak, reviewSurface, passBaseline)
            passVerdict.weak = captured.accepted
            passVerdict.noted.push(...captured.noted)
          } catch (error) {
            die(`${file} — invalid weak evidence: ${error?.message || error}`)
          }
        }
      } catch (error) {
        throw error
      } finally {
        removeReviewSurface(reviewSurface)
      }
      if (semanticProblem) schemaFailure('reviewer', semanticProblem.path, semanticProblem.message)
      let verified
      try { verified = verifyWeakMutations(passVerdict.weak, f, file, deliveryBaseline) }
      catch (error) { die(`${file} — invalid weak evidence: ${error?.message || error}`) }
      passVerdict.weak = verified.accepted
      passVerdict.noted.push(...verified.noted)
      const runtime = runtimeIdentity(passVerdict)
      runtimeHistory.push({ round: round + 1, role: 'reviewer', pass: passIndex + 1,
        baseline_digest: deliveryBaseline, ...runtime })
      reviewPasses.push({ verdict: passVerdict, runtime, weakEvents: verified.events,
        weakVerification: verified.verification })
    }
    const mergedReview = mergeReviewPasses(reviewPasses, deliveryBaseline)
    const rv = mergedReview.verdict
    const weakEvents = mergedReview.weakEvents
    weakVerification = mergedReview.weakVerification
    const reviewerRuntime = reviewPasses.length === 1 ? reviewPasses[0].runtime
      : reviewPasses.map((pass, index) => ({
        pass: index + 1, baseline_digest: deliveryBaseline, ...pass.runtime,
      }))
    const reviewSurface = { id: reviewSurfaceIds.join(',') }

    // The reviewer's own sightings go where the executor's go — printed once at the end of the
    // run, carried in the commit — and they are labelled, because the commit message names who
    // was speaking and that sentence would otherwise become false.
    ;(rv.noted || []).forEach((n) => {
      if (!noted.includes(n)) noted.push(n)
      const line = `${file}: (reviewer) ${n}`
      if (!notes.includes(line)) notes.push(line)
    })

    const adj = adjudicate(history, rv.carried)
    round++
    recordWeakVerification(file, round, weakVerification)
    const added = ingest(history, rv, round, weakEvents, reviewerRuntime)
    const nowOpen = openItems(history)
    // The verdict is the expensive, irreplaceable half of a round — the executor's work is in
    // the tree and can be read, a reviewer's reading of it cannot — so it goes to disk before
    // anything is printed about it.
    saveRound(file, spec, ex, history, round, how, noted, taskAccounting(), runtimeHistory,
      weakVerification)
    const certification = recordTaskCertification({
      task: file,
      round,
      criteria: rv.criteria,
      open: nowOpen,
      author: authorRuntime,
      reviewer: reviewerRuntime,
      reviewSurface,
      reviewBaseline: weakBaseline,
      weakVerification,
      gateReceipt: g.receipt,
      acceptanceCases,
      executorClaims: ex?.claims || [],
    })
    sayRound(round, round - startRound, adj, added, nowOpen, (rv.noted || []).length, taskAccounting())

    if (!nowOpen.length) {
      return commit(file, spec, ex, f, round, gateRedAttempts, how, noted, deliveryBaseline,
        certification)
    }

    // Two ways to reach the human and they ask different questions. The budget says "this has
    // now cost what this invocation was given"; no-progress says "the last round moved nothing",
    // which is the sharper of the two and the only one that can fire early.
    const stalled = round >= 2 && !adj.closed.length && !adj.withdrawn.length && adj.given > 0
    if (stalled || round - startRound >= rounds) {
      // `stop` prints the open items itself, so this branch does not.
      stop(file, spec, ex, history, round, how, noted, stalled
        ? `${file} — round ${round} closed none of the ${adj.given} item(s) it was handed.` +
          ` Another reading is not what is missing.`
        : rounds === 1
          ? `${file} — the one round this command runs is done.`
          : `${file} — ${rounds} rounds, the cap this tool stops to ask at.`,
        taskAccounting(), runtimeHistory, weakVerification)
    }
    say(`    open:\n  - ${renderItems(nowOpen)}`)
  }
}

// The one exit a task takes when it is not committed. It writes the history down FIRST, because
// everything after that line is words on a terminal and the next invocation reads none of them.
//
// `die` still ends the process — the run did not do what it was asked, and a caller reading the
// exit code must not be told otherwise — but the death is now recoverable, which is the whole
// change: the tree, the spec and every open item outlive it, and `round` or `review` starts from
// exactly here.
// Saved after every completed round, and again at a stop. The second call is not the one that
// matters: a stop is an orderly exit that could have written anything, while the whole reason
// this is a function is the exit that writes NOTHING.
//
// Measured on one Python install, 2026-08-27, the first live block on this loop. The machine was
// rebooted during task 002's second round, and because the state was written only at a stop, a
// reboot took the round with it: three `weak` findings, each carrying a mutation the reviewer
// had actually run, and the fact that the executor had just been told to close them. The work
// itself survived — it was in the tree — so what was destroyed was only the record that anything
// had been asked. `review` then judged the tree from a clean sheet, which is precisely the
// memoryless round this whole branch exists to abolish, reintroduced through the one exit
// nobody had thought about.
//
// The three findings were in fact closed; re-running all three mutations against the block's
// last commit turns the suite red on each. That is the cheerful reading and it is not the one to
// build on: nothing in the pipeline established it, a person did, afterwards, by hand — which is
// the labour the carried record exists to remove.
//
// `ex` is saved too, and from BEFORE the reviewer runs, because a round killed after the
// executor still leaves its work in the tree: without this, a later `review` that approves would
// commit that work under the previous round's summary.
function saveRound(file, spec, ex, history, round, how, noted, taskAccounting, runtimeHistory = [],
  weakVerification = null) {
  writeRoundState(file, {
    state_version: 5,
    spec_digest: specDigest(spec),
    round,
    history,
    how,
    noted,
    accounting: normalizeAccounting(taskAccounting),
    runtime_digest: taskAccounting?.legacy ? null : resolvedRuntime.digest,
    runtime_provenance: taskAccounting?.legacy ? 'legacy-unknown' : 'explicit-adapter-runtime',
    runtime_history: runtimeHistory,
    project_policies: projectPolicySnapshot(),
    weak_verification: weakVerification,
    // Kept so that a `review` which approves has a delivery to commit. A hand-finished task has
    // no executor of its own, and a commit with an empty summary line is one nobody can read
    // back later.
    ex: ex ? { summary: ex.summary, notes: ex.notes || [], claims: ex.claims || [] } : null,
  })
}

function stop(file, spec, ex, history, round, how, noted, why,
  taskAccounting = zeroAccounting(), runtimeHistory = [], weakVerification = null) {
  saveRound(file, spec, ex, history, round, how, noted, taskAccounting, runtimeHistory,
    weakVerification)
  const open = openItems(history)
  say(`\n· ${why}`)
  say(`  This task has cost ${formatAccounting(taskAccounting)} over ${round} round(s).`)
  if (open.length) {
    say(`\n  ${open.length} item(s) open after ${round} round(s):\n  - ${renderItems(open)}`)
  }
  sayWaysOn(file)
  die(`${file} — stopped for a decision. Nothing is lost: the two commands above are the answer.`)
}

// ---------------------------------------------------------------- resuming one task
//
// `round` and `review` are the two answers to the question a stop asks, and they are commands
// rather than a keystroke for a reason that is a property of this tool rather than a preference.
// Every documented way to launch a run redirects both streams into `.caw-logs/` — the README
// calls saving a run mandatory and `require_caw_log.py` enforces it — so a prompt written to
// stdout would be written into a file nobody is watching, and the run would hang at a question
// the human cannot see. A stop that ends the process and a command that resumes it survive the
// terminal being closed, which a keystroke does not.
function prepareTaskReviewRisk(f) {
  const planText = existsSync(PLAN) ? readFileSync(PLAN, 'utf8') : null
  activePopulationCertification = planText
    ? readPlanPopulationRecord(planText)
    : { state: 'unknown', source: 'no-plan-artifact', digest: null }
  let risk = null
  try { risk = readRiskRecord() }
  catch (error) { die(error?.message || String(error)) }
  const planDeclaresRisk = /^risk_class:\s*\S+/m.test(planText || '')
  if (planDeclaresRisk && !risk) {
    die(`${PLAN} declares project risk, but ${RISK_RECORD} is missing; run review-specs again`)
  }
  let fullGateBaseline = null
  if (risk) {
    requireMatchingPlanRisk(planText, risk)
    requireCurrentRiskPolicy(risk)
    applyRiskPopulationCertification(risk)
    fullGateBaseline = requirePersistedFullGateBaseline(f, risk)
    const run = beginRunRecord()
    run.risk = risk
    if (fullGateBaseline) run.fullGateBaseline = fullGateBaseline
    writeRunManifest('active')
  }

  return { risk, fullGateBaseline }
}

function finishReviewedTask(f, risk, fullGateBaseline) {
  if (fullGateBaseline) runFinalFullGate(f, fullGateBaseline.head, fullGateBaseline)
  if (risk && !specFiles().length) {
    if (existsSync(PLAN)) {
      unlinkSync(PLAN)
      say(`  cleared ${PLAN} — the queue it planned is empty`)
    }
    clearRiskRecord()
  }
}

function resumeTask(cmd, arg) {
  const { f, text } = profile()
  if (!arg) die(`${cmd} needs a spec filename, e.g.: caw.mjs ${cmd} 001_registry-and-scan.md`)
  const name = arg.replace(/^(\.\/)?tasks\//, '')
  if (!specFiles().includes(name)) {
    die(`${name} is not in the queue (ls .caw-tasks/ is the queue). A task whose spec is gone was\n` +
        `  committed — there is nothing left to review.`)
  }

  requireTaskBranch(f)

  // The work being judged is the dirty tree. A clean one means there is nothing for a reviewer
  // to read, and the two ways that happens want opposite advice, so both are named.
  if (!changedFiles().length) {
    die(`the working tree is clean, so there is no delivery to judge.\n` +
        `  If the work is not done yet, do it and run this again; the spec is still on disk.\n` +
        `  If you already committed it by hand, this cannot review a commit — take the spec out\n` +
        `  of the queue with:  node caw.mjs done ${name}`)
  }

  const { risk, fullGateBaseline } = prepareTaskReviewRisk(f)

  const resume = readRoundState(name)
  if (!resume) {
    say(`· no saved review history for ${name} — judging it as a first round.`)
  }
  // Said, not refused, and the asymmetry is deliberate. `build` refuses on a withdrawn
  // approval because it is about to spend a queue's worth of executor rounds against specs
  // nobody has re-judged. Here the money is spent, the work is in the tree, and the only
  // question left is whether anything reviews it — so a refusal would push the human onto
  // `done`, which reviews nothing at all. The worse outcome is not the one to guard towards.
  if (existsSync(PLAN) && /^approved:\s*false\s*$/m.test(readFileSync(PLAN, 'utf8'))) {
    say(`· ${PLAN} reads approved: false — the QUEUE's approval was withdrawn or never given.`)
    say(`  This command judges the delivery in front of it against ${join(QUEUE_DIR, name)} as it`)
    say(`  stands, and nothing here re-judges the spec against the request. If the spec is what`)
    say(`  is in doubt, that is 'review-specs', and it is a different question from this one.`)
  }
  noticeNotesLog()
  runTask(name, f, text, {
    resume,
    startAt: cmd === 'review' ? 'gate' : 'executor',
    rounds: 1,
    how: cmd === 'review' ? 'hand' : 'resumed',
  })
  finishReviewedTask(f, risk, fullGateBaseline)
  say(`\n  spent ${formatAccounting(accounting)}`)
}

// The spec is deleted once its task is committed, so `ls .caw-tasks/` is the queue. Its exact
// text survives in the Git-private audit record written before the commit. The public commit is
// deliberately compact and carries the audit SHA-256; project-specific subject policy cannot
// change staging, evidence or the private record.
// `how` records the shape of the round that earned the approval, and it exists because the
// signature line is the thing this loop is for. `null` — the ordinary case, the whole task ran
// inside one `build`. `'resumed'` — a human authorised further rounds after a stop. `'hand'` —
// no executor ran in the approving round, so the code came from a hand or from a round this
// pipeline started and never judged.
//
// The third is the one worth having. Before it, the only way out of a task the loop could not
// approve was `done`, which removes a spec from the queue with no judgement of the work at all
// — so the tasks most likely to need a review were exactly the ones guaranteed not to get one.
function commit(file, spec, ex, f, round, gateRedAttempts, how = null, noted = [],
  reviewedDigest = null, certification = null) {
  requireTaskBranch(f)
  // .caw-tasks/ must never enter a commit, and it takes both lines because each has a hole.
  // `git add -A` already skips ignored files, so the .gitignore line the README asks for
  // does the job; the reset covers a project that has not added it. An explicit
  // `:(exclude)tasks` pathspec cannot do either job — git refuses a pathspec naming an
  // ignored path, which is how the .gitignore advice broke this line the day it was given.
  //
  // This staging happens HERE — after the gate, after the reviewer — and that ordering is a
  // trap this script sets for every project gate. Until this line runs, the files the
  // executor just wrote are untracked, so a gate check that enumerates through git's index
  // cannot see them, and a new file is the executor's characteristic product. Measured on one
  // install: a credential in an untracked file passed a `git ls-files`-based sweep and was
  // found by a plain recursive grep in the same second. The README tells installers to
  // enumerate with `--cached --others --exclude-standard`; nothing here can enforce it,
  // because a gate is one opaque command by design. Staging before the gate would close it
  // and is rejected: a red gate would then leave a staged index behind, and a gate should
  // measure the working tree rather than whatever someone remembered to add.
  //
  // `.caw-logs/` is reset for the same reason and it became load-bearing the day `blocked`
  // started writing a patch there: that patch is the whole delivery of a task nobody judged,
  // and the next task's commit would sweep it into the repository. The README asks installs
  // to gitignore both directories — for this one it gives the sharper reason, naming that
  // patch — so the line is not covering a gap in the advice but the install that has not
  // taken it. An earlier version of this comment said the README was silent here, which
  // was a claim about a file sitting three directories up that nobody checked.
  if (reviewedDigest && deliveryDigest() !== reviewedDigest) {
    die(`${file} — delivery tree differs from the tree the reviewer approved; refusing commit`)
  }
  const title = (spec.match(/^title:\s*(.+)$/m) || [, file])[1]
  const commitPolicy = runProjectPolicy('commit', {
    title,
    spec,
    files: changedFiles(),
    round,
    gate: f.gate_fast,
    gate_red_attempts: gateRedAttempts,
  })
  const subject = commitPolicy?.output.subject.trim() || title
  const files = changedFiles()
  const precommitSnapshot = deliverySnapshotDigest()
  git('add', '-A')
  try { git('reset', '-q', '--', QUEUE_DIR) } catch { /* nothing of .caw-tasks/ was staged */ }
  try { git('reset', '-q', '--', LOG_DIR) } catch { /* nothing of .caw-logs/ was staged */ }
  if (deliverySnapshotDigest() !== precommitSnapshot) {
    die(`${file} — delivery snapshot changed during staging; refusing commit`)
  }
  const stagedTree = git('write-tree').trim()
  const audit = writeTaskAudit({
    version: 2,
    task: file,
    title,
    public_subject: subject,
    created_at: new Date().toISOString(),
    spec,
    delivery: {
      summary: ex?.summary || null,
      executor_notes: ex?.notes || [],
      executor_claims: ex?.claims || [],
      reviewer_notes: noted || [],
      files,
      delivery_digest: reviewedDigest || deliveryDigest(),
      precommit_snapshot_digest: precommitSnapshot,
      staged_tree: stagedTree,
    },
    gate: {
      fast: f.gate_fast,
      state: 'green',
      earlier_red_attempts: gateRedAttempts,
      full: f.gate_full || null,
      full_state_at_task_commit: 'not-run',
    },
    review: { round, mode: how || 'pipeline', certification },
    project_policies: projectPolicySnapshot(),
  })
  // `--cleanup=verbatim` is load-bearing, not tidiness. A spec is markdown: `## Read`,
  // `## Done when`. Under git's `strip` mode every one of those lines is a comment and is
  // silently removed, leaving a message whose headings are gone and whose bullets have lost
  // what they belonged to. `-m` defaults to `whitespace`, which would be safe — but
  // `commit.cleanup` in a user's own gitconfig overrides that default, so relying on it makes
  // the integrity of this record depend on a setting outside the repository. Naming the mode
  // here takes it back.
  git('commit', '-q', '--cleanup=verbatim', '-m', [
    subject, '',
    // The summary line is what a later reader sees first, so it says only what this script
    // actually knows. `review` approves a tree no executor produced under its eye, and until the
    // round was saved before the gate there was only one way to arrive there: a human had
    // written it. There are two now — a round killed after its executor leaves exactly the same
    // shape — and this script cannot tell them apart, so it stopped claiming to. It says who
    // approved and how; the summary describes the last delivery anyone recorded, and the absence
    // of one is itself stated rather than filled in.
    ex?.summary || 'No executor round recorded for this task — the tree was finished outside the'
      + ' pipeline and approved by `review`.', '',
    `Gate: ${f.gate_fast} — green${gateRedAttempts ? ` (red on ${gateRedAttempts} earlier attempt${gateRedAttempts === 1 ? '' : 's'})` : ''}.` +
      ` Not run: ${f.gate_full || '(none configured)'}.`,
    `Review: ${certification?.state === 'limited' ? 'accepted with LIMITED certification' : 'approved'}, round ${round}${
      how === 'hand' ? " — approved by `review`: no executor ran in the approving round, so the"
                       + ' code above it was written by a hand or by an earlier round this'
                       + ' pipeline did not get to judge'
      : how === 'human' ? ' — approved by a signed human attestation'
      : how === 'resumed' ? ' — rounds beyond the cap were authorised one at a time'
      : ''}.`,
    // Notes and the exact spec live in the audit record above. Keeping them out of the public
    // commit is the separation this method enforces: the commit is a useful project history,
    // while the local private record is the complete operational history.
    '',
    `CAW-Audit: sha256:${audit.digest}`,
  ].join('\n'))
  const committedHead = git('rev-parse', 'HEAD').trim()
  let auditPath = audit.path
  try { auditPath = finalizeTaskAudit(audit, committedHead) }
  catch (error) {
    say(`  WARNING: audit record remains pending at ${audit.path}: ${error?.message || error}`)
  }
  clearRoundState(file)

  // That header used to call this the only durable copy, and the unlink below is what would
  // have made it true. `spec` was read once, before the first executor round, and every pass
  // since — executor and reviewer alike — was handed that same string. Meanwhile `.caw-tasks/` is a
  // directory this script owns and cannot defend: the executor holds Write and Edit, and a hand
  // or another session writes there freely. The window this actually covers is narrow and
  // worth stating: between the read at the top of `runTask` and this compare, for THIS
  // task only. A spec rewritten before its own task starts is read as gospel.
  // So the bytes preserved and the bytes destroyed were
  // two different things that nothing compared — the defect class this tool's own reviewer
  // exists to catch, in the tool.
  //
  // The queue is NOT the place to keep the divergent text, and a first draft of this that tried
  // it was worse than the defect. A spec left in `.caw-tasks/` is not dirt — `changedFiles()` filters
  // that directory — so the tree stays clean, `build` deletes PLAN.md at its end regardless, and
  // the next `build` finds the spec, skips the approval gate PLAN.md was carrying, and pays a
  // full executor round to redo a task that is already committed. The one file documented as
  // 'nothing here judged it' would have been the one built with the judgement bypassed.
  //
  // So the task completes exactly as before — its spec is consumed by its own commit, which is
  // true, the work is committed — and the divergent text is copied where this tool already puts
  // what must not be lost. Nothing about the queue, the plan or the next run changes.
  const rm = (pth) => { try { unlinkSync(pth) } catch (e) { say(`  could not remove ${pth}: ${(e?.message || e).toString().split('\n')[0]}`) } }
  const specPath = join(QUEUE_DIR, file)
  const onDisk = existsSync(specPath) ? readFileSync(specPath, 'utf8') : null
  const head = git('rev-parse', '--short', 'HEAD').trim()
  if (onDisk === null) {
    // The executor holds Write and Edit and could have removed it. Unlinking would throw ENOENT
    // out of a run that has already committed, taking the notes and the spend line with it.
    say(`  committed  ${head}  audit ${auditPath}`)
    say(`  note: .caw-tasks/${file} was already gone before this line ran`)
    clearTaskRecoveryArtifacts(file)
    return
  }
  if (onDisk !== spec) {
    let kept = null
    let retained = true
    try {
      pruneRecoveryArtifacts()
      const body = Buffer.from(onDisk)
      const base = file.replace(/[^\w.-]+/g, '_')
      if (body.length <= DIVERGED_SPEC_MAX) {
        kept = join(LOG_DIR, `diverged-${base}`)
        for (let n = 2; existsSync(kept); n++) kept = join(LOG_DIR, `diverged-${n}-${base}`)
        writePrivateFile(kept, body, DIVERGED_SPEC_MAX)
      } else {
        retained = false
        kept = join(LOG_DIR, `diverged-${base}-not-retained.json`)
        for (let n = 2; existsSync(kept); n++) kept = join(LOG_DIR, `diverged-${n}-${base}-not-retained.json`)
        writePrivateFile(kept, `${JSON.stringify({
          artifact: 'diverged-spec', spec: file, retained: false, bytes: body.length,
          limit: DIVERGED_SPEC_MAX, sha256: createHash('sha256').update(body).digest('hex'),
        }, null, 2)}\n`, 64 * 1024)
      }
    } catch { kept = null }
    rm(specPath)
    clearTaskRecoveryArtifacts(file)
    say(`  committed  ${head}  audit ${auditPath}`)
    say(`  .caw-tasks/${file} CHANGED under this run. The commit carries the text the executor and`)
    say(`  reviewer were actually given; the file on disk was something else and no role here`)
    say(kept && retained ? `  read it. It is at ${kept} — diff it against the spec in the commit.`
             : kept ? `  read it. It exceeded the retention bound and was not copied; ${kept}` +
                        ` records its size and digest.`
             : `  read it, and it could not be copied out. It is lost.`)
    return
  }
  rm(specPath)
  clearTaskRecoveryArtifacts(file)
  say(`  committed  ${head}  audit ${auditPath}`)
}

// ---------------------------------------------------------------- review-specs
//
// The plan reviewer runs only inside `plan`. A spec written by hand — the documented ticket
// path, "put a file in .caw-tasks/ and run build" — therefore reaches `build` having been judged
// by nobody: the task reviewer judges a diff against its spec, never the spec against the
// request. That makes the cheap path the one that skips the only role whose job is finding a
// hole in coverage. Every hole found while planning on one project was found by this role.
//
// Same role, same schema. It used to judge and stop: there was no architect to send holes
// back to, they were the author's, and the author was a human with an editor. Measured on one
// install: eleven rounds of exactly that — a person reading a finding, editing two or three
// specs and running the command again — $70 and a full working day, while the findings
// themselves kept being worth having. Nothing in that loop needed a human except the
// `undecidable` questions, which stop the run anyway.
//
// So the architect does the closing, in the revision mode the plan loop uses: it sees the
// specs, it sees the findings, it changes what a finding requires and declares any re-split.
// No new role — the one that writes specs is the one that should edit them, and a separate
// fixer with the right to reject a finding is a reviewer of the reviewer, which has no floor.
//
// Bounded on three sides, because an automatic loop that is wrong is worse than a manual one:
// FIX_ROUNDS caps the rounds a single invocation may take, the no-progress guard stops a round
// that closed nothing (the same guard `plan` has, for the same reason), and `undecidable` still
// ends the run at the human. Hitting any of them prints the surviving holes and exits 1 with
// the specs on disk — the next invocation picks up exactly where this one stopped. `--no-fix`
// is the old behaviour, kept because reading a verdict without changing anything is a real
// thing to want.
//
// Known limit: a finding that keeps coming back in different words is caught only when it stops
// reducing the count. Detecting a repeat properly needs the reviewer to name the spec it is
// about in a field of its own, rather than in prose. That is a schema change, and it is next.
const FIX_ROUNDS = 4

function clearSpecs() {
  for (const s of specFiles()) unlinkSync(join(QUEUE_DIR, s))
}

function reviewSpecs(description, noFix) {
  setProviderBudgetPhase('planning')
  const { f, text: profileText } = profile()
  const planning = applyPlanningPolicy(description, profileText)
  let text = planning.text

  // ONCE, before the loop — the rule enumerate() states about itself, and which this function
  // broke for as long as it has existed. The call sat inside judgeSpecs(), so a run that fixed
  // specs twice enumerated three times, on an input that had not changed by a single byte: the
  // population is a function of the request and the tree, `review-specs` writes no code, and the
  // role never sees the specs that fixSpecs rewrites between rounds.
  //
  // Measured on one install's logs for a single day: $66.89 across the first calls and $35.08
  // across five repeats — 34% of everything the role cost, spent re-deriving what was already
  // in hand. One run enumerated three times at $6.90, $4.94 and $6.43.
  //
  // What those repeats bought, and it is worth naming because it is now gone: they were the only
  // measurements of this role on a byte-identical input anywhere, and they said it returns 2% to
  // 24% different populations run to run. That number decided how much of the spread between
  // runs is sampling and how much is the request growing. Nothing else could have told them
  // apart, and after this line it has to be measured on purpose rather than found in the waste.
  const population = requireReadyRequest(enumerate(description, text, f), 'review-specs')
  const populationPolicy = applyPopulationPolicy(description, text, population, planning.risk)
  text = populationPolicy.text
  if (populationPolicy.risk) {
    writeRiskRecord(populationPolicy.risk)
    syncPlanRisk(populationPolicy.risk)
  } else {
    clearRiskRecord()
    syncPlanRisk(null)
  }

  for (let round = 1; round <= FIX_ROUNDS; round++) {
    const verdict = judgeSpecs(description, f, text, population)
    if (!verdict.problems.length) return approveSpecs(verdict.specs)

    say(`\nholes (round ${round}/${FIX_ROUNDS}):\n  - ${verdict.problems.join('\n  - ')}`)

    if (noFix) return stopWithHoles(verdict.problems, verdict.specs, 'run again to close them')
    if (round === FIX_ROUNDS) {
      return stopWithHoles(verdict.problems, verdict.specs,
        `${FIX_ROUNDS} rounds is this command's cap — run it again to continue, or close these by hand`)
    }

    fixSpecs(description, f, text, verdict.specs, verdict.problems, round)
  }
}

// Rewrite the queue from the architect's revision. The specs are deleted first because a
// re-split renames files: closing a hole by moving a case into a new task leaves the old
// `007_role-clone.md` on disk beside the new `007_clone-and-guards.md`, and both are in the
// build glob.
function fixSpecs(description, f, text, specs, problems, round) {
  const bodies = specs
    .map((s) => `### .caw-tasks/${s}\n\n${readFileSync(join(QUEUE_DIR, s), 'utf8')}`)
    .join('\n\n')

  const out = agent('architect', [
    'These task specs are on disk and a reviewer has found holes in them. Close every one.',
    '\n\nRequest they must satisfy:\n\n' + description,
    '\n\nProfile:\n\n' + text,
    '\n\nThe specs, in the order they run:\n\n' + bodies,
    '\n\nHoles to close:\n- ' + problems.join('\n- '),
    '\n\nReturn the whole plan again with the holes closed, and change only what closing them',
    ' requires: a spec nobody raised a hole about comes back as it was. Where a hole is about a',
    ' boundary — a case sitting in a task that cannot verify it, an ordering that puts a task',
    ' before what it needs — move it, and record every such move in `resplit` with the hole that',
    ' forced it. A hole is closed when `done_when` checks it on the tree the task leaves behind,',
    ' not when `change` mentions it.',
    ' Preserve the explicit surfaces and state machines. Split unrelated surfaces into separate',
    ' tasks unless the task carries a concrete indivisible_reason.',
  ].join(''), SCHEMA.plan, f)

  validatePlanRelations(out)

  if (out.blocked) {
    die(`architect stopped while closing holes:\n\n${out.blocked}\n\n` +
        `  The specs are untouched on disk. Answer this where a later run will find it — a file\n` +
        `  under '## Canonical docs' in .caw/CAW.md — then run this command again.`)
  }
  if (!out.tasks?.length) die('architect returned no tasks and no reason')

  clearSpecs()
  writeSpecs(out.tasks, out.coverage)
  if (out.resplit?.length) say(`  re-split (round ${round}):\n    - ${out.resplit.join('\n    - ')}`)
}

function stopWithHoles(problems, specs, why) {
  say(`\n${problems.length} hole(s) in ${specs.length} spec(s) — ${why}.`)
  say(`  spent ${formatAccounting(accounting)}`)
  process.exit(1)
}

// The disk form of what the architect returns as arrays. `review-specs` judges specs that may
// have been hand-written or hand-edited since, so the collision check has to read them back out
// of the markdown rather than trust a plan object that no longer exists.
function specTask(name, body) {
  const bullets = (heading) => {
    const sec = body.split(/^## /m).find((x) => x.toLowerCase().startsWith(heading))
    return sec ? sec.split('\n').slice(1).filter((l) => l.startsWith('- ')).map((l) => l.slice(2)) : []
  }
  return {
    slug: name.replace(/^\d+_/, '').replace(/\.md$/, ''),
    title: body.match(/^title:\s*(.+)$/m)?.[1]?.trim() || name,
    read: bullets('read'),
    must_cover: bullets('must cover'),
    change: bullets('change'),
    done_when: bullets('done when'),
  }
}

function specsPlanningLedger(specs) {
  const tasks = specs.map((name) => specTask(name, readFileSync(join(QUEUE_DIR, name), 'utf8')))
  const coverage = tasks.flatMap((task) => task.must_cover.map((caseText) => ({
    case: caseText,
    task: task.slug,
    acceptance_criteria: [...task.done_when],
  })))
  return planningLedger({ tasks, coverage })
}

// `population` is enumerated once by the caller and handed down, never re-derived here — see
// reviewSpecs(). The hand-written path needs it more than `plan` does, not less: there is no
// architect here, so the specs' own `## Must cover` blocks are the only claim about the
// population, and they were written by whoever wrote the specs. Measured on one project: both
// specs for a ticket were written by hand and the ticket behind them understated its own
// population by four sites.
function judgeSpecs(description, f, text, population) {
  const specs = specFiles()
  if (!specs.length) die('.caw-tasks/ is empty — nothing to review')

  const bodies = specs
    .map((s) => `### .caw-tasks/${s}\n\n${readFileSync(join(QUEUE_DIR, s), 'utf8')}`)
    .join('\n\n')

  const collided = collisions(
    specs.map((x) => specTask(x, readFileSync(join(QUEUE_DIR, x), 'utf8'))))
  sayCollisions(collided)
  const ledger = specsPlanningLedger(specs)

  const r = agent('plan-reviewer', [
    'Judge these task specs. There is no code for them yet: you are judging the split and its',
    ' coverage. They are already on disk and will be built as they stand unless you name a hole.',
    '\n\nRequest they are meant to satisfy:\n\n' + description,
    '\n\nProfile:\n\n' + text,
    '\n\nThe specs, in the order they will run:\n\n' + bodies,
    '\n\nThese were written by hand, so there is no separate coverage mapping: each spec\'s',
    ' "## Must cover" block is its coverage claim, and a spec with no such block is claiming',
    ' nothing.',
    '\n\nEngine-owned relation ledger. For hand-edited specs each case is conservatively linked',
    ' to every Done when item in its task. Return exactly one `relations` row for every id:',
    '\n\n' + JSON.stringify(ledger.relations, null, 2),
    populationBlock(population),
    collisionBlock(collided),
    '\n\nFill only the slots that apply; every slot you leave empty is your approval of that',
    ' dimension.',
  ].join(''), SCHEMA.planReview, f)

  const relationProblem = planRelationIssue(ledger, r.relations)
  if (relationProblem) schemaFailure('plan-reviewer', '$.relations', relationProblem)

  // The four other slots are built BEFORE the question is raised, so a verdict that stopped
  // the run still shows what else it found. It was paid for either way: the same call fills
  // all five, and dying first threw four of them away unread. What it costs to keep is this
  // reordering and nothing else — the run still stops, because a fix written under an
  // unsettled question is a guess.
  const problems = [
    ...r.relations.filter((row) => row.state === 'uncovered')
      .map((row) => `uncovered relation [${row.id}] — ${row.evidence}`),
    ...(r.uncovered || []).map((x) => `uncovered — ${x}`),
    ...(r.unverifiable || []).map((x) => `unverifiable — ${x}`),
    ...(r.misordered || []).map((x) => `misordered — ${x}`),
    ...(r.out_of_scope || []).map((x) => `out of scope — ${x}`),
  ]

  if (r.undecidable?.length) {
    die(`the request itself does not settle:\n\n  - ${r.undecidable.join('\n  - ')}\n\n` +
        `  This is a question about the request, not a defect in the specs. Decide it first.` +
        (problems.length
          ? `\n\n  The same verdict also found, and these are NOT answers to the question` +
            ` above —\n  they may themselves rest on it:\n\n  - ${problems.join('\n  - ')}`
          : `\n\n  Nothing else in this verdict: the other four slots came back empty.`))
  }

  return { specs, problems }
}

// Approving the specs is exactly what the flag was waiting for, so this is where it flips.
// No `--force` on `build` does this job: a flag that bypasses a gate is the one that gets
// typed reflexively, whereas the cheap path here is also the correct one.
function approveSpecs(specs) {
  if (existsSync(PLAN)) {
    const before = readFileSync(PLAN, 'utf8')
    if (/^approved:\s*false\s*$/m.test(before)) {
      // The holes leave with the flag they were holding down. A plan reading `approved:
      // true` while still listing what it was stopped on cannot be told apart from one a
      // hand flipped — and telling those apart is what build() does with exactly this
      // section. Nothing is lost by removing it: these holes were judged closed just now,
      // and the reasoning that produced the plan sits above them in the same file.
      // Recorded here because this is the only moment anything knows which bytes were judged, and
      // the queue is deleted spec by spec after it. `build` compares against this; a plan approved
      // before the section existed simply has none, and is read as silence rather than tampering.
      const judged = specs.map((s) => `- ${s}  ${specDigest(readFileSync(join(QUEUE_DIR, s), 'utf8'))}`)
      const flipped = before
        .replace(/^approved:\s*false\s*$/m, 'approved: true')
        .replace(/\n## Undecidable[\s\S]*?(?=\n## |$)/, '\n')
        .replace(/\n## Unclosed[\s\S]*$/, '\n')
        .split(APPROVED_HEAD)[0].trimEnd()
      writeFileSync(PLAN, `${flipped}\n\n${APPROVED_HEAD}\n\n${judged.join('\n')}\n`)
      // What was judged is the specs on disk. Nothing compared them to the task list inside
      // PLAN.md, so a spec deleted by hand or added by one leaves the flag saying more than
      // was checked.
      say(`\n  ${PLAN} — approved: true. Judged: the ${specs.length} spec(s) in .caw-tasks/`)
    }
  }
  say(`\n${specs.length} spec(s), no holes. Ready for: node caw.mjs build`)
  say(`  spent ${formatAccounting(accounting)}`)
}

const HUMAN_REVIEW_MAX = 1024 * 1024

function exactObject(value, keys, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) die(`${where} must be an object`)
  const extra = Object.keys(value).filter((key) => !keys.includes(key))
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key))
  if (extra.length || missing.length) {
    die(`${where} is malformed${extra.length ? `; unknown ${extra.join(', ')}` : ''}` +
      `${missing.length ? `; missing ${missing.join(', ')}` : ''}`)
  }
}

function planningLedgerFromArtifact(text) {
  const encoded = text.match(/## Planning relation ledger[\s\S]*?```json\n([\s\S]*?)\n```/)?.[1]
  if (!encoded) die(`${PLAN} has no readable planning relation ledger`)
  try { return JSON.parse(encoded) }
  catch (error) { die(`${PLAN} planning relation ledger is invalid: ${error?.message || error}`) }
}

function humanReviewSigners(f) {
  const configured = f.human_review_allowed_signers
  if (!configured || isAbsolute(configured) || configured.split(/[\\/]+/).includes('..')) {
    die('.caw/CAW.md human_review_allowed_signers must name a repository-relative allowed-signers file')
  }
  const root = realpathSync('.')
  const candidate = resolve(root, configured)
  try {
    const stat = lstatSync(candidate)
    if (!inside(root, candidate) || !stat.isFile() || stat.isSymbolicLink()) throw new Error('not regular')
  } catch {
    die(`human review allowed-signers file is missing or unsafe: ${configured}`)
  }
  return candidate
}

function writeHumanReviewTemplate(name, value) {
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 })
  const path = join(LOG_DIR, name)
  writePrivateFile(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), HUMAN_REVIEW_MAX)
  say(`wrote ${path}`)
  say(`fill every evidence field, then sign the exact file bytes:`)
  say(`  ssh-keygen -Y sign -f <private-key> -n caw-review ${path}`)
  say(`accept it with:`)
  say(`  node caw.mjs human-review accept ${path} ${path}.sig`)
}

// Sign the task text and resolved policy contract, not just ordinal criterion ids.
function humanTaskContract(file, spec) {
  const topology = extractTaskTopology(spec)
  const reviewPolicy = runProjectPolicy('review', {
    spec, files: changedFiles(), criteria: topology.criteria,
  })
  const projectCriteria = (reviewPolicy?.output.criteria || []).map((item) => ({
    ...item, id: `project:${reviewPolicy.policy.id}:${item.id}`, section: `Project: ${item.section}`,
  }))
  const acceptancePolicy = runProjectPolicy('acceptance', {
    task: file, criteria: topology.criteria, surfaces: topology.surfaces,
    transitions: topology.transitions,
  })
  const acceptanceCases = acceptancePolicy?.output.cases || []
  const contractDigest = createHash('sha256').update(stableJson({
    spec, topology, projectCriteria, acceptanceCases,
  })).digest('hex')
  return { topology, projectCriteria, acceptanceCases, contractDigest }
}

function prepareHumanReview(args) {
  const [scope, targetOrIdentity, maybeIdentity] = args
  const { f } = profile()
  humanReviewSigners(f)
  if (scope === 'plan') {
    const identity = targetOrIdentity
    if (f.planning_independence !== 'human-review') {
      die('planning_independence is not human-review')
    }
    if (!identity || /[\r\n]/.test(identity) || !existsSync(PLAN)) {
      die('usage: caw.mjs human-review prepare plan <identity>')
    }
    const text = readFileSync(PLAN, 'utf8')
    const ledger = planningLedgerFromArtifact(text)
    writeHumanReviewTemplate('human-review-plan.json', {
      version: 1, scope: 'plan', identity, target: PLAN,
      artifact_digest: createHash('sha256').update(text).digest('hex'),
      decision: 'approve', statement: '',
      relations: ledger.relations.map((relation) => ({
        id: relation.id, state: 'covered', evidence: '',
      })),
    })
    return
  }
  if (scope !== 'task') die('human-review scope must be plan or task')
  const file = targetOrIdentity?.replace(/^(?:\.\/)?(?:\.caw-tasks\/)?/, '')
  const identity = maybeIdentity
  if (f.task_independence !== 'human-review') die('task_independence is not human-review')
  if (!file || !identity || /[\r\n]/.test(identity) || !specFiles().includes(file)) {
    die('usage: caw.mjs human-review prepare task <spec> <identity>')
  }
  if (!changedFiles().length) die('the delivery tree is clean — there is no task delivery to review')
  const spec = readFileSync(join(QUEUE_DIR, file), 'utf8')
  const { topology, projectCriteria, contractDigest } = humanTaskContract(file, spec)
  const coreCriteria = topology.criteria
  const resume = readRoundState(file)
  writeHumanReviewTemplate(`human-review-${taskArtifactBase(file)}.json`, {
    version: 3, scope: 'task', identity, target: file,
    contract_digest: contractDigest,
    artifact_digest: deliveryDigest(), decision: 'approve', statement: '',
    criteria: [...coreCriteria, ...projectCriteria].map((criterion) => ({
      id: criterion.id, state: 'met', evidence: '', evidence_refs: [],
    })),
    carried: openItems(resume?.history || []).map((item) => ({
      id: item.id, state: 'closed', evidence: '', evidence_refs: [],
    })),
  })
}

function readSignedHumanReview(attestationPath, signaturePath, f) {
  let bytes, value, signature
  try {
    const stat = lstatSync(attestationPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > HUMAN_REVIEW_MAX) throw new Error('unsafe')
    bytes = readFileSync(attestationPath)
    value = JSON.parse(bytes.toString('utf8'))
    if (typeof value.identity !== 'string' || !value.identity || value.identity.length > 256 ||
        /[\r\n]/.test(value.identity)) throw new Error('identity is invalid')
    const signatureStat = lstatSync(signaturePath)
    if (!signatureStat.isFile() || signatureStat.isSymbolicLink() ||
        signatureStat.size > HUMAN_REVIEW_MAX) throw new Error('signature is unsafe')
    signature = readFileSync(signaturePath)
  } catch (error) { die(`cannot read human review attestation: ${error?.message || error}`) }
  const signers = humanReviewSigners(f)
  const verify = spawnSync(process.env.CAW_SSH_KEYGEN || 'ssh-keygen',
    ['-Y', 'verify', '-f', signers, '-I', value.identity || '', '-n', 'caw-review', '-s', signaturePath],
    { input: bytes, encoding: 'utf8', timeout: 10000 })
  if (verify.error || verify.status !== 0) {
    die(`human review signature is invalid: ${verify.error?.message || verify.stderr || verify.stdout}`)
  }
  return { value, bytes, signature }
}

function retainHumanReview(value, bytes, signature) {
  const root = resolve(execFileSync('git', ['rev-parse', '--git-path', 'caw/human-reviews'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim())
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const digest = createHash('sha256').update(bytes).digest('hex')
  writePrivateFile(join(root, `${digest}.json`), bytes, HUMAN_REVIEW_MAX)
  writePrivateFile(join(root, `${digest}.sig`), signature, HUMAN_REVIEW_MAX)
  return { identity: value.identity, attestation_digest: digest,
    signature_digest: createHash('sha256').update(signature).digest('hex') }
}

function acceptHumanReview(attestationPath, signaturePath) {
  if (!attestationPath || !signaturePath) {
    die('usage: caw.mjs human-review accept <attestation.json> <attestation.json.sig>')
  }
  const { f } = profile()
  const signed = readSignedHumanReview(attestationPath, signaturePath, f)
  const a = signed.value
  if (a.scope === 'plan') {
    exactObject(a, ['version', 'scope', 'identity', 'target', 'artifact_digest', 'decision',
      'statement', 'relations'], 'human plan review')
    if (a.version !== 1 || a.target !== PLAN || a.decision !== 'approve' || !a.statement?.trim()) {
      die('human plan review must be version 1, approve PLAN.md, and contain a statement')
    }
    if (f.planning_independence !== 'human-review') die('planning_independence is not human-review')
    const text = readFileSync(PLAN, 'utf8')
    if (createHash('sha256').update(text).digest('hex') !== a.artifact_digest) {
      die('PLAN.md changed after the human attestation was prepared')
    }
    for (const [index, row] of (a.relations || []).entries()) {
      exactObject(row, ['id', 'state', 'evidence'], `human plan review relations[${index}]`)
    }
    const issue = planRelationIssue(planningLedgerFromArtifact(text), a.relations)
    if (issue || a.relations.some((row) => row.state !== 'covered')) {
      die(`human plan review does not approve every relation${issue ? `: ${issue}` : ''}`)
    }
    retainHumanReview(a, signed.bytes, signed.signature)
    const approved = text.replace(/^approved:\s*false\s*$/m, 'approved: true')
      .replace(/\n## Unclosed — this plan was NOT approved[\s\S]*$/, '\n')
    writeFileSync(PLAN, approved)
    say(`${PLAN} approved by signed human review from ${a.identity}`)
    return
  }
  exactObject(a, ['version', 'scope', 'identity', 'target', 'artifact_digest', 'decision',
    'statement', 'contract_digest', 'criteria', 'carried'], 'human task review')
  if (a.version !== 3 || a.scope !== 'task' || a.decision !== 'approve' || !a.statement?.trim()) {
    die('human task review must be version 3, approve one task, and contain a statement')
  }
  if (f.task_independence !== 'human-review') die('task_independence is not human-review')
  const file = a.target
  requireTaskBranch(f)
  if (!specFiles().includes(file) || !changedFiles().length) die('human-reviewed task is not pending')
  const digest = deliveryDigest()
  if (digest !== a.artifact_digest) die('task delivery changed after the human attestation was prepared')
  const { risk, fullGateBaseline } = prepareTaskReviewRisk(f)
  const spec = readFileSync(join(QUEUE_DIR, file), 'utf8')
  const { topology, projectCriteria, acceptanceCases, contractDigest } = humanTaskContract(file, spec)
  if (contractDigest !== a.contract_digest) {
    die('task contract changed after the human attestation was prepared; prepare and sign it again')
  }
  const coreCriteria = topology.criteria
  const gateContext = {
    task: file, kind: 'fast', deliveryDigest: digest, criteria: coreCriteria, acceptanceCases,
  }
  let taskGate
  let confirmationRuns = 0
  let projectGateRetries = 0
  let gateRedAttempts = 0
  for (;;) {
    taskGate = gate(f.gate_fast, file, undefined, f.gate_fast_timeout_ms, gateContext)
    if (deliveryDigest() !== digest) {
      die(`${file} — the fast gate changed the signed delivery tree; refusing acceptance`)
    }
    const policy = taskGatePolicy(file, f, taskGate, 0, confirmationRuns, projectGateRetries)
    if (policy?.output.action === 'stop') {
      die(`${file} — project gate policy ${policy.policy.id} stopped the run: ${policy.output.reason.trim()}`)
    }
    if (taskGate.ok) break
    if (taskGate.state === 'red') {
      gateRedAttempts++
      if (decideGateFailure({ reviewOnly: true, confirmationRuns, executorRetries: 0, maxExecutorRetries: 0 }) ===
          GateFailureAction.confirm) {
        confirmationRuns++
        continue
      }
      if (policy?.output.action === 'retry' && projectGateRetries < PROJECT_GATE_RETRIES_MAX) {
        projectGateRetries++
        confirmationRuns++
        continue
      }
    }
    die(`${file} — human-reviewed delivery has no current green gate (${taskGate.state})`)
  }
  const verdict = { criteria: a.criteria, carried: a.carried, broken: [], uncovered: [], weak: [], noted: [] }
  for (const [index, row] of (a.criteria || []).entries()) {
    exactObject(row, ['id', 'state', 'evidence', 'evidence_refs'], `human task review criteria[${index}]`)
    if (!['met', 'broken', 'uncovered', 'weak'].includes(row.state)) {
      die(`human task review criteria[${index}] has an invalid state`)
    }
  }
  for (const [index, row] of (a.carried || []).entries()) {
    exactObject(row, ['id', 'state', 'evidence', 'evidence_refs'], `human task review carried[${index}]`)
    if (!['closed', 'open', 'withdrawn'].includes(row.state)) {
      die(`human task review carried[${index}] has an invalid state`)
    }
  }
  const criteriaIssue = reviewCriteriaIssue(spec, a.criteria, verdict, projectCriteria)
  const contractIssue = criteriaIssue ? null : reviewContractIssue(verdict, {
    criteria: [...coreCriteria, ...projectCriteria], surfaces: topology.surfaces,
    transitions: topology.transitions, receipt: taskGate.receipt,
  })
  if (criteriaIssue || contractIssue || a.criteria.some((row) => row.state !== 'met')) {
    die(`human task review does not approve every criterion${
      criteriaIssue ? `: ${criteriaIssue}` : contractIssue ? `: ${contractIssue}` : ''}`)
  }
  const resume = readRoundState(file)
  const history = resume?.history || []
  validateCarriedSet(a.carried, openItems(history))
  if (a.carried.some((row) => row.state === 'open' || !row.evidence.trim())) {
    die('human task review must settle and evidence every carried item')
  }
  const authorRuntime = [...(resume?.runtime_history || [])].reverse()
    .find((entry) => entry.role === 'executor') || null
  requireTaskReviewIndependence(f, authorRuntime)
  adjudicate(history, a.carried)
  const human = { kind: 'human', ...retainHumanReview(a, signed.bytes, signed.signature) }
  const round = (resume?.round || 0) + 1
  const certification = recordTaskCertification({
    task: file, round, criteria: a.criteria, open: openItems(history),
    author: authorRuntime,
    reviewer: human, reviewSurface: null, reviewBaseline: null,
    weakVerification: resume?.weak_verification || null,
    gateReceipt: taskGate.receipt,
    acceptanceCases,
    executorClaims: resume?.ex?.claims || [],
  })
  commit(file, spec, resume?.ex || null, f, round, gateRedAttempts, 'human', [], digest, certification)
  finishReviewedTask(f, risk, fullGateBaseline)
}

function humanReview(args) {
  const [action, ...rest] = args
  if (action === 'prepare') return prepareHumanReview(rest)
  if (action === 'accept') return acceptHumanReview(...rest)
  die('usage: caw.mjs human-review prepare plan <identity> | prepare task <spec> <identity> | accept <json> <sig>')
}

function probeProvider(providerId) {
  if (!providerId || !/^[\w.-]+$/.test(providerId) || providerId === '.' || providerId === '..') {
    die('usage: caw.mjs probe <provider>')
  }
  const { f } = profile(false)
  resolvedRuntime = loadRuntime(f)
  const adapter = adapters.get(providerId)
  if (!adapter) die(`no trusted adapter named ${JSON.stringify(providerId)}`)
  const roles = ROLES.filter((role) => resolvedRuntime.value.roles[role].provider === providerId)
  if (!roles.length) die(`runtime.json binds no role to ${providerId}`)
  const executable = adapter.resolveExecutable(process.env)
  const versionCall = adapter.versionInvocation(executable)
  const versionLaunch = providerLaunch(versionCall.executable, process.platform, providerId)
  const versionResult = spawnSync(versionLaunch.executable,
    [...versionLaunch.leadingArgs, ...versionCall.args], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, ...(versionCall.env || {}) },
  })
  if (versionResult.error || versionResult.status !== 0) {
    die(`cannot probe ${providerId}: executable ${executable} has no usable version response`)
  }
  const cliVersion = versionResult.stdout.trim().split('\n')[0] || 'version unreported'
  const provider = { adapter, executable, cliVersion }
  const providerVector = providerLaunch(executable, process.platform, providerId)
  printRuntimeResiduals({ runtime: resolvedRuntime.value, providerId })
  const probes = []
  for (const role of roles) {
    const descriptor = adapter.describe({ role, cliVersion })
    validateDescriptor(role, descriptor)
    requireHostMechanisms(role, descriptor, adapter)
    for (const [guarantee, value] of Object.entries(descriptor.guarantees)) {
      if (!value.probe) continue
      const existing = probes.find((entry) => entry.probe.id === value.probe.id)
      if (!existing) {
        probes.push({ role, guarantee, state: value.state, by: value.by, probe: value.probe })
      } else if (value.by === 'os-boundary' ||
        (value.by === 'isolated-surface' && existing.by !== 'os-boundary')) {
        existing.state = value.state
        existing.by = value.by
      }
    }
  }
  if (!probes.length) die(`${providerId} declares no versioned probes for its configured roles`)
  let allGreen = true
  for (const entry of probes) {
    const parent = mkdtempSync(join(tmpdir(), 'caw-provider-probe-'))
    const workingRoot = join(parent, 'surface')
    const outsideRoot = join(parent, 'outside')
    const scratchRoot = join(parent, 'provider-tmp')
    const repositoryReadPath = join(workingRoot, 'README.md')
    mkdirSync(workingRoot, { mode: 0o700 })
    mkdirSync(outsideRoot, { mode: 0o700 })
    mkdirSync(scratchRoot, { mode: 0o700 })
    const repositoryNonce = `repository-read-${createHash('sha256')
      .update(`${Date.now()}:${Math.random()}`).digest('hex')}`
    writeFileSync(repositoryReadPath, repositoryNonce, { mode: 0o600 })
    surfaceGit(workingRoot, 'init', '-q', '-b', 'main')
    surfaceGit(workingRoot, 'config', 'user.name', 'CAW Provider Probe')
    surfaceGit(workingRoot, 'config', 'user.email', 'probe@example.invalid')
    surfaceGit(workingRoot, 'add', 'README.md')
    surfaceGit(workingRoot, 'commit', '-q', '-m', 'probe fixture')
    const sentinel = `caw-probe-${createHash('sha256').update(`${Date.now()}:${Math.random()}`).digest('hex')}`
    const shellAttemptPath = join(workingRoot, 'shell-attempt.txt')
    const enginePrivateBoundary = entry.by === 'os-boundary' &&
      entry.state === 'engine-private-only'
    const insidePath = enginePrivateBoundary
      ? join(scratchRoot, 'inside.txt')
      : join(workingRoot, 'inside.txt')
    const outsidePath = enginePrivateBoundary
      ? join(workingRoot, 'delivery-write.txt')
      : join(outsideRoot, 'outside.txt')
    const env = { ...process.env, PWD: workingRoot, CAW_ROLE: entry.role }
    let result = { status: null, stdout: '', stderr: '' }
    let invocation
    try {
      invocation = adapter.buildProbeInvocation({
        role: entry.role,
        guarantee: entry.guarantee,
        probe: entry.probe,
        binding: resolvedRuntime.value.roles[entry.role],
        executable: providerVector.executable,
        executableArgs: providerVector.leadingArgs,
        sentinel,
        execution: {
          workingRoot, insidePath, outsidePath, scratchRoot, repositoryReadPath, shellAttemptPath,
          surfaceId: parent.split(/[\\/]/).pop(),
          deniedReadPaths: [], readOnlyDependencyRoots: [], env,
          writeBoundary: entry.by === 'os-boundary' ? entry.state : 'isolated-review-surface',
          writeBoundaryBy: entry.by,
        },
      })
      const invocationVector = providerLaunch(invocation.executable, process.platform, providerId)
      result = spawnSync(invocationVector.executable,
        [...invocationVector.leadingArgs, ...invocation.args], {
        input: invocation.input, cwd: invocation.cwd, env: invocation.env,
        encoding: 'utf8', timeout: AGENT_TIMEOUT_MS, killSignal: 'SIGKILL',
        maxBuffer: 256 * 1024 * 1024,
      })
    } catch (error) {
      result = { status: null, stdout: '', stderr: error?.message || String(error), error }
    }
    const insidePresent = existsSync(insidePath) && readFileSync(insidePath, 'utf8') === sentinel
    const outsidePresent = existsSync(outsidePath)
    let answer = null
    if (result.status === 0 && invocation) {
      try {
        const finalResponseText = consumeInvocationTransport(invocation, adapter.features.resultTransport)
        const decoded = adapter.decodeSuccess(result.stdout, {
          binding: resolvedRuntime.value.roles[entry.role],
          requestedNative: invocation.requestedNative,
          role: entry.role,
          finalResponseText,
        })
        answer = decodedProbeAnswer(decoded)
      } catch { /* an undecodable probe is unavailable; filesystem facts are not enough */ }
    }
    const insideAttempted = answer?.inside_attempted ?? null
    const outsideAttempted = answer?.outside_attempted ?? null
    const repositoryReadAttempted = answer?.repository_read_attempted ?? null
    const insideWrite = insideAttempted === true ? insidePresent : null
    const outsideWrite = outsideAttempted === true ? outsidePresent : null
    const repositoryRead = repositoryReadAttempted === true
      ? answer?.observed_nonce === repositoryNonce
      : null
    const requiresRepositoryRead = entry.probe.repositoryRead === true
    const toolContract = Array.isArray(entry.probe.expectedTools) && entry.probe.shellDenied === true
    const requestMarkerReceived = toolContract ? answer?.received_marker.includes(sentinel) === true : null
    const reportedTools = toolContract && Array.isArray(answer?.reported_tools)
      ? answer.reported_tools : null
    const reportedToolsMatch = reportedTools
      ? stableJson([...reportedTools].sort()) === stableJson([...entry.probe.expectedTools].sort())
      : null
    const shellToolRequested = toolContract ? answer?.shell_tool_requested ?? null : null
    const shellWrite = toolContract ? existsSync(shellAttemptPath) : null
    const green = toolContract
      ? result.status === 0 && requestMarkerReceived === true && reportedToolsMatch === true &&
        shellToolRequested === false && shellWrite === false
      : result.status === 0 &&
        insideAttempted === true && outsideAttempted === true &&
        insideWrite === true && outsideWrite === false &&
        (!requiresRepositoryRead ||
          (repositoryReadAttempted === true && repositoryRead === true))
    let reason = null
    if (!green && answer) {
      reason = structuredProbeReason(answer)
    } else if (!green && Number.isInteger(result.status) && result.status !== 0) {
      reason = failureProbeReason(adapter, result)
    } else if (!green && result.status === 0) {
      reason = missingProbeAnswerReason(invocation, adapter.features.resultTransport)
    } else if (!green && result.status === null) {
      reason = probeLaunchFailureReason(result)
    }
    discardInvocationTransport(invocation)
    allGreen &&= green
    const attestation = {
      version: 1,
      ...probeKey(providerId, entry.probe, adapter, executable),
      // Recorded, not matched: this says which build was watched doing it, and preflight reports
      // the drift when a later build runs on the same evidence.
      cli_version: cliVersion,
      role: entry.role,
      guarantee: entry.guarantee,
      shipped: false,
      green,
      created_at: new Date().toISOString(),
      observations: {
        child_status: result.status,
        timed_out: result.error?.code === 'ETIMEDOUT',
        inside_attempted: insideAttempted,
        outside_attempted: outsideAttempted,
        repository_read_attempted: requiresRepositoryRead ? repositoryReadAttempted : null,
        repository_read: requiresRepositoryRead ? repositoryRead : null,
        inside_write: insideWrite,
        outside_write: outsideWrite,
        ...(toolContract ? {
          request_marker_received: requestMarkerReceived,
          reported_tools: reportedTools,
          reported_tools_match: reportedToolsMatch,
          shell_tool_requested: shellToolRequested,
          shell_write: shellWrite,
        } : {}),
      },
      environment: probeEnvironmentObservation(env, invocation?.env || {}),
      ...(reason ? { reason } : {}),
    }
    const path = writeProbeAttestation(providerId, attestation)
    removeTree(parent)
    const summary = probeReasonSummary(reason)
    say(`${entry.probe.id}: ${green ? 'green' : 'unavailable'}${summary ? ` — ${summary}` : ''} — ${path}`)
  }
  if (!allGreen) {
    process.exitCode = 1
    say(`${providerId} remains unavailable for at least one configured role; no guarantee was weakened.`)
  }
}

function smokeRoles(target) {
  if (!target || (target !== 'all' && !ROLES.includes(target))) {
    die(`usage: caw.mjs smoke <all|${ROLES.join('|')}>`)
  }
  const { f } = profile(false)
  resolvedRuntime = loadRuntime(f)
  preflightRuntime(f, true)
  setProviderBudgetPhase('smoke')
  const selected = target === 'all' ? ROLES : [target]
  const schema = closeSchema({
    type: 'object',
    properties: { marker: { type: 'string', enum: ['caw-role-smoke'] } },
    required: ['marker'],
  })
  for (const role of selected) {
    const before = deliveryDigest()
    const surface = createReviewSurface(f)
    let value
    try {
      const reviewer = role === 'reviewer'
      value = agent(role,
        'Role smoke only. Read README.md, make no project change, and return marker ' +
          '`caw-role-smoke` exactly. This validates the configured model and reasoning path.',
        schema, f, null, {
          workingRoot: surface.workingRoot,
          scratchRoot: surface.scratchRoot,
          surfaceId: surface.parent.split(/[\\/]/).pop(),
          deniedReadPaths: surface.deniedReadPaths,
          ...(reviewer ? { writeBoundary: {
            kind: REVIEW_WRITE_BOUNDARY,
            readOnlyDependencyRoots: surface.dependencies.map((dependency) => dependency.canonical),
          } } : {}),
        })
    } finally {
      removeReviewSurface(surface)
    }
    if (value.marker !== 'caw-role-smoke' || deliveryDigest() !== before) {
      die(`${role} smoke did not preserve the delivery tree`)
    }
    const binding = resolvedRuntime.value.roles[role]
    const provider = resolvedRuntime.providers.get(binding.provider)
    const runtime = runtimeIdentity(value)
    const path = writeRoleSmoke(role, {
      ...roleSmokeKey(role, binding, provider),
      green: true,
      created_at: new Date().toISOString(),
      requested_native: runtime?.requested?.native || null,
      observed_models: runtime?.models || [],
      delivery_digest: before,
    })
    say(`${role}: green — ${path}`)
  }
}

function artifacts(args) {
  const [action = 'list', target] = args.filter((value) => !value.startsWith('--'))
  const forceActive = args.includes('--force-active')
  if (action === 'list') {
    const local = existsSync(LOG_DIR) ? readdirSync(LOG_DIR).sort() : []
    const probeRoot = localProbeRoot()
    const probes = probeRoot && existsSync(probeRoot)
      ? readdirSync(probeRoot).map((name) => `probes/${name}`).sort()
      : []
    const surfaces = existsSync(REVIEW_SURFACE_PARENT)
      ? readdirSync(REVIEW_SURFACE_PARENT).filter((name) => name.startsWith('surface-')).sort()
      : []
    const transports = existsSync(ADAPTER_TRANSPORT_PARENT)
      ? readdirSync(ADAPTER_TRANSPORT_PARENT).filter((name) => adapterTransportPath(name))
        .map((name) => `transports/${name}`).sort()
      : []
    say(`artifacts:\n${[...local, ...probes, ...surfaces, ...transports]
      .map((name) => `  ${name}`).join('\n') || '  (none)'}`)
    return
  }
  if (action === 'purge' && target?.startsWith('probes/')) {
    const provider = target.slice('probes/'.length)
    if (!provider || !/^[\w.-]+$/.test(provider) || provider === '.' || provider === '..') {
      die('invalid probe provider')
    }
    const root = localProbeRoot()
    const path = root && join(root, provider)
    if (!path || !existsSync(path) || !inside(realpathSync(root), realpathSync(path))) {
      die(`no retained probe evidence matches ${provider}`)
    }
    removeTree(path)
    say(`purged probes/${provider}`)
    return
  }
  if (action === 'purge' && target?.startsWith('transports/')) {
    const name = target.slice('transports/'.length)
    const path = adapterTransportPath(name)
    if (!path || !existsSync(path)) die(`no retained adapter transport matches ${name}`)
    let manifest = null
    try { manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) } catch { /* removable */ }
    let alive = false
    if (manifest?.state === 'active') {
      try { process.kill(manifest.pid, 0); alive = true } catch { /* dead creator */ }
    }
    if (alive && !forceActive) {
      die(`${target} is active; repeat with --force-active to purge it`)
    }
    removeAdapterTransport(path)
    say(`purged ${target}`)
    return
  }
  if (action !== 'purge' || !target || target.includes('/') || target.includes('\\') || target === '..') {
    die('usage: caw.mjs artifacts list | artifacts purge <run-id|task|surface-id|transports/id> [--force-active]')
  }
  const runPath = join(LOG_DIR, target)
  if (target.startsWith('run-') && existsSync(runPath) && inside(resolve(LOG_DIR), resolve(runPath))) {
    try { exportRunMetrics(runPath) }
    catch (error) { die(`could not export compact metrics before purging ${target}: ${error?.message || error}`) }
    removeTree(runPath)
    say(`purged ${target}`)
    return
  }
  const surfacePath = join(REVIEW_SURFACE_PARENT, target)
  if (target.startsWith('surface-') && existsSync(surfacePath)) {
    const parent = realpathSync(REVIEW_SURFACE_PARENT)
    if (!inside(parent, realpathSync(surfacePath))) die(`refusing surface outside retention parent: ${target}`)
    removeTree(surfacePath)
    say(`purged ${target}`)
    return
  }
  const base = taskArtifactBase(target.replace(/\.md$/, ''))
  const active = specFiles().some((file) => taskArtifactBase(file) === base)
  if (active && !forceActive) {
    die(`${target} is active; repeat with --force-active to purge its recovery artifacts`)
  }
  const matches = existsSync(LOG_DIR)
    ? readdirSync(LOG_DIR).filter((name) =>
      (name.startsWith(`blocked-${base}-`) || name.startsWith(`diverged-${base}-`)))
    : []
  if (!matches.length) die(`no retained artifact matches ${target}`)
  matches.forEach((name) => unlinkSync(join(LOG_DIR, name)))
  say(`purged ${matches.length} artifact(s) for ${target}`)
}

// ---------------------------------------------------------------- entry

async function main() {
const [cmd, ...rest] = process.argv.slice(2)
providerBudgetState.command = cmd || null
const noFull = rest.includes('--no-full')
const arg = rest.filter((x) => !x.startsWith('--')).join(' ')
// Reading what this tool is cannot depend on the matrix being usable — the same rule that puts
// `artifacts` and `probe` above the guarantee gate below. Before this, `node caw.mjs` with no
// arguments, `--help`, `--version` and a mistyped command all ran the all-five preflight first
// and answered with nine lines about missing probe evidence. That is the first command a reader
// types, and it was answered by a refusal about something they had not tried to do yet.
const USAGE = `caw.mjs ${VERSION} — a small agentic pipeline.

  caw.mjs plan "<description>"            architect + reviewers -> specs in ${QUEUE_DIR}/
  caw.mjs build [--no-full]               each spec: executor -> fast gate -> reviewer
  caw.mjs ship "<description>"            both, without stopping to show you the plan
  caw.mjs review-specs "<description>"    judge hand-written specs in ${QUEUE_DIR}/
  caw.mjs round <NNN_slug.md>             one more review round on a stopped task
  caw.mjs review <NNN_slug.md>            review a task finished by hand, and commit
  caw.mjs done <NNN_slug.md>              remove a spec with no review at all
  caw.mjs probe <provider>                refresh machine-local live evidence
  caw.mjs smoke <role|all>                verify exact model/reasoning role bindings
  caw.mjs human-review prepare|accept ... signed human planning or task review
  caw.mjs verify-project                  validate configured project policies
  caw.mjs artifacts list|purge <id>       inspect or remove retained artifacts

Every pipeline command refuses until all five roles resolve and carry current green probe
evidence. Run \`caw.mjs probe <provider>\` on the machine that will execute it.`

const KNOWN = ['plan', 'build', 'ship', 'review-specs', 'round', 'review', 'done', 'probe', 'smoke',
  'human-review',
  'verify-project', 'artifacts']
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { say(USAGE); return }
if (cmd === '--version' || cmd === '-v') { say(VERSION); return }
if (!KNOWN.includes(cmd)) die(`unknown command: ${cmd}\n\n${USAGE}`)

// Recovery precedes every refusal. These sweeps need neither a usable runtime nor role guarantees,
// and a command that later dies in pipeline preflight must still scrub abandoned credentials and
// classify dead review surfaces.
pruneAdapterTransports()
pruneReviewSurfaces()
pruneInvocationScratch()
// Artifact inspection/purge is independent of the runtime. Probe needs trusted adapters plus a
// valid binding and target CLI, but deliberately reaches probeProvider before role guarantees are
// compared: repairing the matrix cannot depend on the matrix already being usable.
if (cmd === 'artifacts') { artifacts(rest); return }
if (cmd === 'verify-project') {
  try { projectPolicySet = readProjectPolicies() }
  catch (error) { die(error?.message || String(error)) }
  verifyProjectPolicies(projectPolicySet)
  return
}
await discoverAdapters()
if (cmd === 'probe') { probeProvider(rest[0]); return }
if (cmd === 'smoke') { smokeRoles(rest[0]); return }
try { projectPolicySet = readProjectPolicies() }
catch (error) { die(error?.message || String(error)) }
if (cmd === 'human-review') { humanReview(rest); return }
// Pipeline and queue commands retain the all-five preflight selected in slice 2.1.
profile()

// A run under a non-default cap has to be identifiable in its own log. Comparing two runs
// later without either saying which cap it ran under is one more claim about a relation
// between two artifacts that nothing compared.
if (AGENT_TIMEOUT_MS !== AGENT_TIMEOUT_DEFAULT_MS) {
  say(`agent timeout: ${formatTimeout(AGENT_TIMEOUT_MS)} from CAW_AGENT_TIMEOUT_MS ` +
      `(default ${formatTimeout(AGENT_TIMEOUT_DEFAULT_MS)})`)
}

if (cmd === 'plan') { if (!arg) die('plan needs a description'); plan(arg) }
else if (cmd === 'build') build(noFull)
else if (cmd === 'ship') { if (!arg) die('ship needs a description'); plan(arg); build(noFull) }
else if (cmd === 'round' || cmd === 'review') resumeTask(cmd, arg)
else if (cmd === 'review-specs') {
  if (!arg) die('review-specs needs the request the specs are meant to satisfy')
  reviewSpecs(arg, rest.includes('--no-fix'))
}
else if (cmd === 'done') {
  // Remove one spec whose task was finished BY HAND after the two-round ceiling. The pipeline
  // deletes a spec at its own commit; a hand-finished task has no such moment. An install
  // guarding its queue with .caw/hooks/ cannot delete it from a session either: a shell write
  // into .caw-tasks/ rightly withdraws the plan's approval, because the guard cannot tell "removed
  // since its work is committed" from "quietly dropped". Measured there: four hand deletions
  // by the owner across two runs before they asked for this. The removal goes through the tool
  // the queue belongs to, which the guards exempt, so the verdict survives — and this supplies
  // what the guards cannot check: the working tree must be clean, because a dirty tree means
  // the task's work is NOT committed and the spec being removed is the only statement of what
  // that work had to be.
  if (!arg) die('done needs a spec filename, e.g.: caw.mjs done 007_retire-principal-stub.md')
  const name = arg.replace(/^(\.\/)?tasks\//, '')
  const file = join(QUEUE_DIR, name)
  if (!specFiles().includes(name)) die(`${name} is not in the queue (ls .caw-tasks/ is the queue)`)
  if (changedFiles().length) {
    // The advice used to end at "commit it first", which was the only advice there was. There is
    // a better one now and it is one command away: the work is in the tree, the spec is on disk,
    // and that is exactly what `review` judges — so the same keystrokes that would have removed
    // the spec unreviewed can instead earn it a review and commit it. `done` stays for the case
    // `review` cannot serve, which is work that is already committed.
    die('working tree is dirty, so the hand-finished work is not committed yet.\n' +
        `  Have it reviewed and committed instead of removing the spec unjudged:\n` +
        `    node caw.mjs review ${name} > ${LOG_DIR}/review-$(date +%H%M%S).log 2>&1\n` +
        '  If you mean to commit it by hand and take no review at all, do that first: the spec\n' +
        '  being removed is the only statement of what the work had to be.')
  }
  unlinkSync(file)
  clearTaskRecoveryArtifacts(name)
  // The review history goes with the spec it was about. Left behind, it would be picked up by a
  // later task that happened to reuse the number, and handed to a reviewer as this task's open
  // items — a finding about code from another plan entirely.
  clearRoundState(name)
  const left = specFiles()
  say(`removed ${file} — its task was finished by hand.`)
  if (left.length) say(`queue: ${left.join(', ')}`)
  else {
    // The rule build() applies at its own end: PLAN.md dies when the queue empties.
    say('queue is empty')
    if (existsSync(PLAN)) {
      unlinkSync(PLAN)
      say(`  cleared ${PLAN} — the queue it planned is empty`)
    }
    clearRiskRecord()
  }
}
else die(USAGE)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => die(error?.message || String(error)))
}

export {
  GateFailureAction, PlanningAction, SCHEMA, addAccounting, buildTaskDossier,
  canonicalAuthorityPaths, compactRunMetrics,
  collectGateEvidence, retainGateEvidence,
  decideGateFailure, decidePlanningAction, deltaAccounting, executorClaimsIssue,
  extractReviewCriteria, formatAccounting,
  extractTaskTopology, groupFindings, mergeReviewPasses, normalizeAccounting, planRelationIssue, planningLedger,
  reviewContractIssue, reviewCriteriaIssue,
  populationBlock, providerLaunch, readProjectPolicies, resolvePopulation, resolvePopulationSource,
  resolveProviderBudgets, roleGuaranteeMismatch, removeTree, restoreWeakReplaySurface,
  retainWeakVerificationEvents,
  runProjectPolicy, runWeakReplaySession, taskDeliveryDiff, verifyProjectPolicies, zeroAccounting,
}
