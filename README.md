# Cross-Agentic Warden

*[Русская версия](docs/readme.ru.md)*

A small agentic pipeline that splits one request into tasks, implements them one at a time,
and has a separately configured reviewer judge each one against evidence it had to produce.
The project can enforce same-provider, different-model, or cross-vendor review; CAW checks the
actual adapter vendor and model pair before any provider call.

Roles bind explicitly to trusted provider adapters. The engine owns the protocol, schemas,
gates, state and commits — the models own none of those. The runtime is a dependency-free Node
engine with small, vendored provider adapters.

```
request ──▶ architect ──▶ plan-reviewer ──▶ specs in .caw-tasks/
                 ▲             │
            enumerator ────────┘   (what the request implied, said blind)

each spec ──▶ executor ──▶ fast gate ──▶ primary + challenger review ──▶ commit
                  ▲                                 │
                  └──────── open items, by id ──────┘   (max 4 rounds, then it stops and asks you)
```

## The rule the rest follows from

> **Only the executor can write, and only code.**

Not as advice — as a `--tools` flag on every other agent's child process. [WHY.md](WHY.md) is
the measurement that produced that rule, and why this tool is deliberately small.

## What is actually different here

**The reviewer states no verdict.** It fills slots and the script derives one. A task is approved
when nothing blocking is open, and only then. Three slots block, and every item in them carries
`evidence` — what was run, mutated or quoted on the tree in front of the reviewer:

| slot | means | evidence must be |
|---|---|---|
| `broken` | the delivery does not do what it says | what was run |
| `uncovered` | a `Must cover`, `Change`, or `Done when` line the tree does not meet | what was checked |
| `weak` | a test green for the wrong reason | **the mutation that proves it** |

Before those slots, the engine creates an atomic census from every `## Must cover`, `## Change`,
and `## Done when` bullet. The reviewer must give every stable id one disposition and evidence;
missing, duplicate, and unknown ids invalidate the response.

An open carried item can support the same non-met criterion without being filed again. A
schema-valid but semantically inconsistent review gets one correction call on the unchanged
review baseline; another inconsistency stops the run.

By default, a primary and one blind challenger pass judge the exact same delivery digest before
the executor can run again. Their findings are merged conservatively. A challenger-only finding
is retained as `late-same-baseline`; disagreement about an older finding leaves it open.

A weakness nobody demonstrated is not a `weak`. A fourth slot, `noted`, never blocks and nothing
ever acts on it — it exists so the other three can stay strict.

**Read the `noted` items.** They are printed once at the end of a run and carried in the task's
commit, and that is the whole mechanism — there is no ledger and there will not be one. They are
also where the findings a gate cannot give you land. On one run here the reviewer deleted the
single line that publishes the cross-script channel a refactor had just made load-bearing, saw
the gate still exit 0, restored it, and filed that: the gate was green and blind, and nothing but
a `noted` said so.

**A reviewer must answer its own open items before finding new ones.** From round 2 it is handed
them by id and must return `closed`, `open` or `withdrawn` for each, with what it ran to decide.
An id it leaves out stays open: silence closes nothing. Without this, a reviewer redraws its list
every round and never converges — measured on one install as three round-2 items naming test code
no round-1 fix had touched.

**A gate result never passes through an agent.** Green or red is an exit code. A test-runner
specialist was deleted after measurement: 4 spawns, 256k tokens, 13% of a lane, 0 usable verdicts.

Task and queue evidence are deliberately separated. Before task review, the reviewer receives
only the engine-owned `gate_fast` receipt. `gate_full` runs once after every task is reviewed and
committed, so it is queue-finalization evidence and cannot be a task acceptance criterion.
Planning roles receive that lifecycle as engine-owned context. A project-specific pre-review
check belongs inside the project's fast gate; executor claims and proof files are not receipts.

The gate result now has an engine-owned receipt. It binds the command, status, duration, bounded
output and validated artifact digests to the exact delivery digest. Executor checks are separate
structured claims and remain untrusted. A reviewer sees both in a bounded task dossier instead of
receiving the whole accumulated conversation by default; it can still read the repository.

Findings carry stable criterion, surface, transition and property links. Exact root-cause keys are
presented to the executor as one work package while every original pass observation and its
provenance remains in history. Similar wording alone never merges findings.

Projects can opt into an API-v3 [acceptance matrix](docs/project-policies.md) without editing CAW
core. The project owns its consumers, scenarios, observables, mutations, evidence kinds and
selectors; CAW validates completeness and the gate evidence transport.

**Independent population is cached only on exact semantic identity.** Request, effective profile
and policy, canonical docs, repository state, project index, runtime, adapter, CLI, instructions,
schema, and engine all participate in the key. Any change runs the enumerator again.

The architect and plan-reviewer are cached the same way, on the whole prompt each was given. A
planning stage that dies part-way used to be paid for twice: measured on one install, an expired
token killed the plan-reviewer after the enumerator and the architect had both finished, and the
rerun re-derived everything for $4.78. A rerun now reuses whatever already answered the identical
question, and asks again for anything else. Cache entries are re-validated against the schema and
the run's own ledgers before they are trusted; a stale one misses rather than being handed on.

**Guarantees come from a live probe, not from a config file.** A binding is unavailable until a
probe on *this machine* proves the OS write boundary holds. A changed adapter implementation, an
expired attestation, or a red probe makes it unavailable before a pipeline call.

## Requirements

- **Node 18+**, and `bash` on `PATH` (Git Bash or WSL on Windows).
- **An OS filesystem boundary.** macOS arm64: the seatbelt via `/usr/bin/sandbox-exec`.
  Linux: `bubblewrap` (`apt install bubblewrap`). Neither is installed for you and neither
  substitutes for the other. A host without one refuses every pipeline command.
- **The provider CLIs you bind.** Claude resolves as `CAW_CLAUDE` or `claude`; Codex as
  `CAW_CODEX` or `codex`. Codex's measured executor/reviewer path is macOS arm64 only, so a
  Linux host runs Claude rows and refuses Codex rows.
- **`python3`** for the guard hooks, and **`pytest`** to verify they are wired.

## Quickstart

```bash
git clone https://github.com/30nt/CrossAgenticWarden.git
cd CrossAgenticWarden
node --test test/*.test.mjs        # engine suite, no spend
python3 -m pytest .caw/hooks       # guard suite, no spend
```

Then, in the project you want it to work on:

```bash
# 1. vendor the six paths — never copy .caw/ recursively
git -C <clone> -c core.autocrlf=false -c core.eol=lf archive --format=tar origin/main -- \
  caw.mjs .caw/agents .caw/adapters .caw/hooks .caw/CAW.md .caw/runtime.json | tar -xf -

# 2. fill in the profile and bind all five roles
$EDITOR .caw/CAW.md          # at minimum: gate_fast
$EDITOR .caw/runtime.json    # provider + model + reasoning, per role

# 3. prove the boundary on this machine — this one costs money
node caw.mjs probe claude

# 4. prove every exact model/reasoning role binding — this also costs provider calls
node caw.mjs smoke all

# 5. run something small and real
mkdir -p .caw-logs
node caw.mjs plan "<something small>" > .caw-logs/plan.log 2>&1
```

[docs/install.md](docs/install.md) is the full procedure, and it is long on purpose: wiring the
guards wrong is a way to lock a session out of `Bash` and `Edit` at once.

## Commands

```bash
node caw.mjs plan "<request>"        # architect + reviewers → specs in .caw-tasks/
node caw.mjs build [--no-full]       # each spec: executor → fast gate → reviewer, until approved
node caw.mjs ship "<request>"        # both, without stopping to show you the plan
node caw.mjs review-specs "<request>"  # judge (and fix) whatever is in .caw-tasks/
node caw.mjs round <spec>            # one more review round on a task that stopped
node caw.mjs review <spec>           # review a task you finished by hand, and commit it
node caw.mjs done <spec>             # remove a spec with no review at all
node caw.mjs probe <provider>        # write current machine-local guarantee evidence
node caw.mjs smoke <role|all>        # verify exact model/reasoning role bindings
node caw.mjs human-review prepare plan <identity>
node caw.mjs human-review prepare task <spec> <identity>
node caw.mjs human-review accept <json> <sig>
node caw.mjs verify-project          # validate project policy extensions
node caw.mjs artifacts list          # retained run/recovery/probe/transport artifacts
```

A run stopped by a role returning invalid canonical output never reaches a commit, so nothing
that normally carries a task — the public commit, the private audit with its spec verbatim —
is written. That failure is retained on its own under Git's private `caw/contract-failures/`,
with the spec or request, the rejected value, the repair attempts and the exact runtime, and it
is not swept by the rotation that keeps the newest twenty run records. An executor that stops on
`blocked` is retained the same way under `caw/executor-stops/`. `artifacts list` shows both.

`ls .caw-tasks/` is the queue. A task commit stays public and compact; its `CAW-Audit` digest
points to the complete private record under Git's `caw/audit/` path. That record keeps the spec,
notes, certification, policy identity, reviewed delivery digest and staged tree after the queue
file is deleted. Every command prints the resolved matrix and runtime digest before mutation or
spend.

Each provider call creates an immutable `attempt-*.json` before the child process starts. The run
manifest links that attempt to its success, failure, timeout, interrupted state, diagnostics, and
duration through one `attempt_id`. Usage is labelled `reported`, `estimated`, `partial`, or
`unknown`; unknown is never written as zero. A failed call receives only a clearly sourced
byte-based input estimate, never invented reported usage. Before old run records are pruned or explicitly purged,
CAW appends payload-free counters and durations to Git's private `caw/metrics/runs.jsonl`.

## Before you point this at a real repository

- It runs model-authored code and **commits it**. Use a scratch branch on a repository you can
  throw away until you trust it.
- **A write boundary is not a read boundary.** Any role with a shell can read outside the
  delivery tree and open network connections. [SECURITY.md](SECURITY.md) says exactly how far
  that goes; the engine prints a summary before every paid call.
- Automated review is a bounded sample, and the executor can still commit through provider tools
  despite the engine contract. These and the remaining hazards are tracked in
  [docs/limitations.md](docs/limitations.md), including the controls that exist today.

## Documentation

| | |
|---|---|
| [WHY.md](WHY.md) | why this is small, and what the previous version cost |
| [docs/install.md](docs/install.md) | the full installation manual |
| [docs/architecture.md](docs/architecture.md) | how the engine, roles, adapters and probes fit |
| [docs/adapters.md](docs/adapters.md) | writing an adapter for another provider |
| [docs/project-policies.md](docs/project-policies.md) | extending CAW without changing its core |
| [docs/certification.md](docs/certification.md) | task certification states and retained evidence |
| [docs/limitations.md](docs/limitations.md) | what is known to be broken or unexercised |
| [CHANGELOG.md](CHANGELOG.md) | released versions and the current unreleased changes |
| [SECURITY.md](SECURITY.md) | what is enforced, and what is not |
| [CONTRIBUTING.md](CONTRIBUTING.md) | what a useful contribution looks like here |

## Status and licence

**v0.2.0 is in development; v0.1.0 is the latest tagged release.** One maintainer, a research
tool, exercised on a handful of real projects rather than benchmarked. The adapter contract is
not stable until v1.

MIT. See [LICENSE](LICENSE).
