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

## [0.1.0] - 2026-09-03

- First public research release of the minimal task, gate, review, and commit pipeline.

[Unreleased]: https://github.com/30nt/CrossAgenticWarden/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/30nt/CrossAgenticWarden/releases/tag/v0.1.0
