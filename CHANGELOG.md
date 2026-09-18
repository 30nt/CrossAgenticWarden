# Changelog

This project follows [Semantic Versioning](https://semver.org/) while its public contracts are
still allowed to change between `0.x` minor releases.

## [Unreleased]

Target release: **0.2.0**.

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

[Unreleased]: https://github.com/30nt/CrossAgenticWarden/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/30nt/CrossAgenticWarden/releases/tag/v0.1.0
