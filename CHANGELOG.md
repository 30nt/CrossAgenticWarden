# Changelog

This project follows [Semantic Versioning](https://semver.org/) while its public contracts are
still allowed to change between `0.x` minor releases.

## [Unreleased]

### Added

- An `oversized` plan-review slot: a task too large for one executor call is a hole that `plan`
  and `review-specs` close by splitting before approval. The architect is told to size tasks for
  one call and not to bundle separately deliverable work; tasks the engine already estimates as
  large executor work are handed to the plan reviewer as the first candidates. Per-task limits
  are the project's, stated through planning-policy `instructions`; the engine counts nothing.

## [0.2.3] - 2026-10-09

### Changed

- `ship` is `plan` followed by `autopilot` rather than by `build`: once the plan is approved, the
  stops whose answer is not in doubt are answered within the profile's `autopilot_*` limits, and
  the plan's own run record is closed as completed before the build starts. `plan` then `build`
  keeps the previous behaviour.

## [0.2.2] - 2026-10-07

### Changed

- `review-specs` asks the architect to return only the specs it changes or adds, with an `order`
  naming every task that remains, when the specs on disk are the exact ones the last plan wrote;
  the engine keeps every other task and its rendering as it was. A hand-written or hand-edited
  queue is still revised whole. The plan object behind the specs is recorded in Git's private
  `caw/plan-object.json`.

### Fixed

- Under `autopilot` the `.caw-tasks/notes.log` notice is shown once per run for each state of the
  file, not on every step; notes added during the run are announced again.

## [0.2.1] - 2026-10-01

### Fixed

- A full or batch gate that does not pass writes a stop record (`full-gate-red`,
  `full-gate-timeout`, `full-gate-refused`, `full-gate-policy`, and the `batch-gate-*` three), so
  `autopilot` names it in its journal and to `autopilot_notify_cmd` instead of reporting
  `unknown`. The decision stays with the human.

## [0.2.0] - 2026-09-30

### Added

- Explicit versioned runtime bindings for all five roles, with provider, model, and reasoning
  selected independently.
- Claude and Codex adapter API v3 implementations, live boundary probes, and exact role-smoke
  evidence.
- `fast`, `standard`, and `strict` pipeline modes; task, batch, and full gate lifecycles; adaptive
  executor budgets; bounded retries; and resumable gate recovery.
- Structured task evidence, independent challenger review, signed human review, exact authorship
  and delivery binding, and task certification records.
- Versioned project policies, project-owned acceptance matrices, independent population caching,
  and exact full-gate baseline caching.
- Payload-free private run metrics and provider attempt telemetry with explicit unknown and partial
  accounting states.
- The gate receives the contract its evidence manifest is judged against: `CAW_GATE_REQUIRED_CHECKS`
  as a plain id list and `CAW_GATE_CONTRACT` as version-1 JSON carrying the criterion census and
  acceptance cases with their required evidence kinds and selectors.
- A gate evidence contract preflight. A queue declaring `## Required gate checks` against a gate
  that writes no manifest is refused before any executor runs, and the result is cached per gate
  command, engine and profile.
- Executor mutations. A delivery may name up to eight `mutations` of the shipped code (`path`,
  an exactly-once `find`, `replace`, `breaks`). After a green gate the engine runs the fast gate
  on each one, on a disposable copy and outside the executor's boundary. A surviving mutation
  sends the delivery back to the executor before any reviewer is paid, at most twice per review
  round. A caught one is trusted review evidence as `executor-mutation:<id>`.
- Executor gate probe. Beside every executor call the engine starts a broker outside the
  executor's boundary and names a `caw-gate` command (`$CAW_GATE_PROBE`) in the prompt. It runs the
  profile's fast gate on a disposable copy of the executor's current tree, optionally with one
  `--mutation` applied, at most six times per call. Each use is recorded as a `gate-probe` run
  diagnostic; it certifies nothing.
- Reviewer mutation replay. Every open `weak` finding keeps the reviewer's captured patch, and
  after each green executor delivery the engine replays it on the same surface as the executor's
  mutations, after the same unmutated gate. A survived one sends the delivery back to the
  executor before any reviewer is paid; a caught one is trusted evidence as
  `review-mutation:<id>`, and a finding whose replay survived cannot be closed on that delivery.
- `autopilot [--no-full]`: `build` for an unwatched queue. Every task stop and every provider
  failure writes a machine-readable stop record when `CAW_STOP_RECORD` is set; `autopilot` reads
  it and answers only infrastructure stops (gate timeout or refusal, role timeout, expired
  credentials with `autopilot_reauth_cmd`) and progress stops (round cap, gate red after retries,
  red review baseline), within per-task limits from the profile. Stalls and judgement stops go
  to the human. Decisions are journalled to `.caw-logs/autopilot-*.jsonl`; `autopilot_notify_cmd`
  runs at the end. A commit whose extra rounds autopilot authorised says so on its `Review:` line.

### Changed

- Reviews run on isolated engine-owned surfaces and retain bounded recovery artifacts when cleanup
  or verification fails.
- Task and queue gate evidence are separate. `gate_full` can no longer satisfy a task acceptance
  criterion.
- Provider invocations fail before spend when their host boundary, probe, smoke evidence, budget,
  or declared capability is insufficient.
- Adapter identity covers the complete implementation tree, including runner and helper files and
  their executable modes. Symlinks inside an adapter implementation are rejected.

### Fixed

- A gate that times out, or finishes, no longer leaves processes behind: the fast gate and the weak
  control commands run in a process group of their own, and the whole group is stopped on timeout,
  on a signal, when the command exits and when the engine dies. A timed-out gate used to lose only
  its shell, and the build under it raced the next gate on the same simulator.
- An executor after a rejecting review is no longer shown the pre-review measurement of its own
  mutations, and one that returns the tree the reviewer rejected, unchanged, goes back to the
  executor without a gate, replay or reviewer; a second unchanged return stops the task.
- The reviewer reads each of its `noted` items against `## Must cover`, `## Change` and
  `## Done when` before returning, and moves one that names an unmet line to `uncovered`.
- A reviewer is offered `executor-mutation:<id>` and `review-mutation:<id>` only when the engine
  listed rows of that kind, and told that its own capture is `review-experiment:caw-weak-N`; citing
  its own weak branch as `review-mutation:` cost a semantic repair on every pass.
- Weak gates are asked once per exact delivery digest within an invocation: a green unmutated
  baseline and a caught or surviving mutation with the same patch bytes are reused, so a blind
  challenger no longer replays the primary pass's captures. A weak-mutation run receives
  `CAW_GATE_MUTATION_PATHS`, and a planned challenger pass says why it runs.
- The gate evidence-contract preflight no longer runs as the queue's first task and no longer
  refuses a queue over a red run: it is asked of no task (`CAW_SPEC` unset, `kind:
  contract-preflight`), and only a green gate without a manifest refuses. A red or refused one
  leaves the question unsettled and uncached, and each task's green gate is judged as before.
- Conservative review merging now retains disagreement, stable finding provenance, and exact
  baseline identity across retries and provider changes.
- Gate timeouts, unavailable verification, stale evidence, interrupted calls, and executor budget
  exhaustion remain distinct states instead of collapsing into success or an ordinary red gate.
- Architect and plan-reviewer canonical failures receive one bounded repair with the rejected
  value and exact diagnostic, without repeating independent enumeration.
- A placeholder in an executor's `blocked` field — `""`, `''`, `"none"`, bare `none` — no longer
  stops the task. Quoting is unwrapped before the field is judged, and for the executor a
  placeholder is read as not blocked, so the delivery goes on to the gate and the reviewer.
  Measured: a complete, gate-green delivery returned `blocked` as two quote characters and went to
  a blocked patch unjudged. Planning roles still refuse a placeholder, quoted or bare, and repair.
- A real executor stop is retained in Git's private `caw/executor-stops/` with the spec and the full
  response, and its message names `review <spec>` — which judges the tree as it stands — before any
  advice that clears the tree.
- A role contract failure is retained in Git's private `caw/contract-failures/`, outside the
  rotation that sweeps run records and operator logs. It carries the spec or planning request the
  run was about, the rejected value, every repair attempt, and the exact runtime — none of which
  survived before, because a task stopped this way never commits and the audit is written at the
  commit. `caw.mjs artifacts list` shows them.
- A reviewer is shown the engine-owned surface and transition ids every blocking finding must
  name. They are derived content hashes that appeared in no form the role read, so only a
  REJECTION could fail on them: an approval leaves the blocking slots empty and is never asked.
  Measured on one install, a correct finding about a real defect ended a run as an engine
  diagnostic instead of a verdict.
- A plan review's holes are carried to the next plan review by id and must each be answered
  `closed`, `open` or `withdrawn` with evidence; one left out stays open. This holds between `plan`
  rounds, from `PLAN.md`'s `## Unclosed` into `review-specs`, and between its fix rounds, and a
  `review-specs` that stops now writes its holes back to `## Unclosed`. Measured: `plan` reported 1
  and then 5 holes, each with a real one, and `review-specs` approved byte-identical specs without
  the architect running, because the second sample was never shown what the first had found.
- A task commit no longer says its full gate was `Not run`. The full gate is queue-final and runs
  after every task commit by design, so the line was in every commit and history kept it after
  the gate went green. A `Review:` line is written only when it carries something a reader acts on
  — LIMITED certification, a hand-finished tree, a human attestation, rounds past the cap. The
  README now states that `CAW-Audit` resolves only in the clone that made the commit.
- A finding's `property_key` has its rule named — in the schema, the prompt, the reviewer role
  file and the refusal — and case, underscores and spaces are normalised to it rather than refused.
  The rule lived only in a regex, and snake_case, the first choice for a "key", was the one it
  refused: measured, four reviewer calls in a row ($12.67) refused with `has invalid property_key`,
  a diagnostic naming the field and not the rule, while $11.51 of executor work sat unjudged.
  Normalising instead of widening keeps `a_b` and `a-b` one work package.
- Gate output keeps its end. The executor's dossier bounded the serialized receipt from the head,
  and a gate prints its failure last: measured, a red gate wrote 78,908 bytes with its compile
  error at byte 78,601, the dossier kept the first 24 KB, and two executor variants spent 3 and 9
  retries against a cause they were never shown. The dossier renders receipt metadata, then the
  output's head and tail with an explicit elision marker; receipts over 1 MiB keep head and tail too.
- Concurrent CAW processes no longer break each other's temp sweeps. An entry vanishing between
  readdir and lstat threw ENOENT out of whatever command had started; and a directory swept inside
  its creator's window between mkdtemp and writing its manifest was removed as abandoned — for an
  adapter transport, a directory holding a copied credential mid-call. Manifest-less entries
  younger than a minute are left alone; older ones are removed as before.
- A task commit's body describes the whole delivery. It was the executor's summary of its last
  round, which after a review sends it back is about closing findings: measured, three commits of
  four (+377 to +1565 lines) described only the last round's test hardening. One round keeps the
  summary; more build the body from the spec's `## Change` bullets and the staged file list. Every
  round's report stays in the private audit record.
- A `## Canonical docs` entry written as a markdown link is read relative to `.caw/`, where the
  profile is clicked from, so `[x](../docs/x.md)` is `docs/x.md` — the path every role is told to
  cite. The target used to enter the authority set verbatim, and an enumerator citing a canonical
  document by its real path was refused. Root-relative link targets keep working.
- A refused enumerator answer is retained with its value and a diagnostic. The request-issue check
  threw with neither, so the retained record read `"rejected_value": "null"` over an answer that
  held two real defects in the project's normative document.
- The reviewer is told to try to break every `Must cover` it would record `met`, and to record a
  surviving mutation as `weak` in the same round, and later rounds are shown what earlier rounds
  already `noted`. Measured: two of four tasks stopped at the round ceiling with one open item each
  after rounds raising 6, 1, 1, 1 ($94.07 of $187.11), and one note was re-derived seven times.
- The task certification record carries the topology its ids belong to and the criterion, surface
  and transition links of every open finding. `open_item_ids` alone could not say what a finding
  was about, and one install had to re-derive the engine's own hashing over the audit's spec
  string to read a transition id. The record is version 3.
- Executor and reviewer answers that fail canonical validation receive one bounded repair, the
  same one architect and plan-reviewer already had, with the exact diagnostic and the complete
  rejected value. The reviewer's surface is restored to its pass baseline between attempts. A
  second invalid answer still stops, with both attempts in the retained failure record.
- An expired or rejected provider credential is reported as itself rather than as `exited 1`, and
  says the tree, spec and request are not at fault. Measured on three installs; on two of them
  once per queue, both times to a reviewer mid-build.
- Architect and plan-reviewer canonical values are cached on exact identity, in Git's private
  `caw/planning-cache/`, the way the enumerator's population already was. A planning stage that
  died part-way charged again for every role that had already answered: measured, an expired token
  killed the plan-reviewer after the enumerator ($2.08) and the architect ($2.70) finished, and the
  rerun started from zero. A cached value is re-validated against its schema and the run's ledgers
  before it is used.
- A carried entry kept `open` may list `criterion_ids` of its own, so an item can answer for a
  criterion it was not raised against. Which criterion an open item blocks changes between rounds;
  the ids it was raised with are fixed, and the reviewer is told not to duplicate it as a new
  finding. Measured: three consecutive rejections on a resumed task with twelve open items,
  $43.40, and no verdict at all.
- A blocking item binds to a non-met criterion by listing its id in `criterion_ids`, which the
  schema already requires on every finding; quoting the criterion text verbatim is still accepted
  but no longer the only way. The substring rule made rejections unserializable: on one install
  four runs ($56.64) stopped on it, two reviews produced no verdict, and the repair call — even
  when told the exact text — broke the same rule on another criterion. Approvals were never asked.
- The queue guard no longer withdraws an approved plan over a call that never wrote to the queue.
  A write verb and a queue path are paired per statement, following one hop of binding, and the
  bytes a program writes are excluded from both halves — instead of matching anywhere in one
  command line. Measured: three false withdrawals across two installs, the last costing $6.74 to
  re-derive a verdict that already existed, over a heredoc rewriting a gate script whose new
  content had to name the queue to work.

## [0.1.0] - 2026-09-03

- First public research release of the minimal task, gate, review, and commit pipeline.

[Unreleased]: https://github.com/30nt/CrossAgenticWarden/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/30nt/CrossAgenticWarden/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/30nt/CrossAgenticWarden/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/30nt/CrossAgenticWarden/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/30nt/CrossAgenticWarden/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/30nt/CrossAgenticWarden/releases/tag/v0.1.0
