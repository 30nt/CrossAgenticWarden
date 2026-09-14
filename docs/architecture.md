# Architecture

*[Русская версия](architecture.ru.md)*

One file, five roles, two adapters, four guards. This is what each one owns and, more usefully,
what it is not allowed to own.

## The shape

```
                    .caw/CAW.md          the project's profile — a form, not a config
                    .caw/runtime.json    which provider runs which role
                          │
      request ──▶ ┌───────▼────────┐
                  │    caw.mjs     │  protocol · schemas · gates · state · commits
                  └───┬────────┬───┘
                      │        │
        ┌─────────────┘        └──────────────┐
        ▼                                     ▼
   .caw/agents/*.md                     .caw/adapters/*/
   what each role is                    how a provider is launched, and what it guarantees
        │                                     │
        └──────────────▶ provider CLI ◀───────┘
                              │
                        .caw/hooks/*.py    guards that bind the operator's own session
```

## The engine owns what a model must not

The division is the whole design. `caw.mjs` owns:

- **the protocol** — what is sent, in what order, with which prompt
- **the schemas** — every role returns JSON validated against a fixed shape; a malformed return
  is a failure, not an interpretation
- **the gates** — `bash -lc "<your command>"`, and the exit code is the verdict
- **the state** — the queue is a directory; a task's review history is a file the engine writes
- **the commits** — `git add -A` and the message, carrying the spec's full text

A model owns none of those. It returns JSON and, if it is the executor, it edits files. That is
the entire surface.

Project-specific additions use the versioned [project policy API](project-policies.md). API v2
planning policies classify request risk before enumeration and attest the resolved population
afterwards. A `complete` population is a project-owned claim bound to the exact population digest,
never an inference from one model draw. A risk class may also require a green `gate_full` on the
starting commit before any executor runs; the final full gate can then attribute a regression to
the build range. API v2 gate policies may classify a project-allowlisted flaky failure, while the
engine retains the confirmation and retry cap.
Required baseline caching is also project-aware: the engine hashes every input it owns and reuses
a result only when a v2 gate policy supplies the matching digest for external inputs.
API v3 adds an optional acceptance stage. The project maps each task's engine criteria, surfaces
and transitions to its own production consumers, scenarios, observables, mutations, evidence
kinds and selectors. The engine validates completeness and requires matching gate evidence, while
the domain-specific matrix remains outside core.

## The five roles

| role | reads | writes | what it produces |
|---|---|---|---|
| `architect` | repository | nothing in delivery | an ordered list of atomic tasks + a coverage mapping |
| `enumerator` | repository, `index_cmd` output | nothing | what the request **implied**, said without seeing the plan |
| `plan-reviewer` | repository, the plan | nothing in delivery | holes in the coverage claim |
| `executor` | repository | **delivery tree** | the change |
| `reviewer` | repository | an isolated surface only | filled slots, with evidence |

The enumerator is deliberately blind: it is asked what the request implies *before* it can be
shaped by the plan, so its list is a check on the architect rather than an echo of it.
Its canonical response is cached in Git-private state. Reuse requires one exact digest over the
request, effective profile and policy, canonical authorities, repository state, project index,
runtime, adapter, CLI, role instructions, schema, and engine. A mismatch causes a normal cache
miss; every hit or miss is written to the run manifest.

Every architect coverage row names a case, its task, and one or more exact `done_when` criteria
from that task. The engine assigns content-stable ids to tasks, requirements, cases and relations.
The plan reviewer must return one evidenced disposition for every relation id; missing, duplicate
or unknown ids invalidate the response. The complete ledger stays in `PLAN.md`, while each task
spec carries its own acceptance links.

Every task also declares independently changeable surfaces and one explicit state machine per
surface. Surface responsibilities and transitions become stable ledger requirements. The engine
requires globally unique surface ids and a concrete indivisibility reason whenever one task owns
more than one surface; otherwise the architect must split the work.

The reviewer states no verdict. Before the call, the engine gives every `Must cover`, `Change`,
and `Done when` bullet a stable id. The reviewer must return exactly one evidenced disposition
for each row in that atomic census. It also fills `broken`, `uncovered`, `weak` and `noted`, and
the script derives approval from whether anything blocking is open. From round 2 it is handed its
own open items by id and must return `closed`, `open` or `withdrawn` for each, with what it ran. An
id it omits stays open.

Executor and reviewer prompts start from a bounded task dossier. Each section has its own byte cap,
digest and truncation marker; the total is capped too. It contains the contract, changed files,
bounded diff, grouped open findings, executor claims, acceptance cases and gate receipt. This
limits repeated context without removing repository read access.

Executor checks are structured but untrusted claims. The gate runs with engine-provided private
manifest and artifact paths. CAW validates links, paths, kinds and bounds, hashes accepted files,
and creates a receipt bound to the delivery digest. Reviewer evidence references distinguish that
receipt from claims and from direct repository or isolated-surface experiments.

The engine also supplies the evidence timeline to both planning roles. A task reviewer receives
the `gate_fast` receipt before commit; the final `gate_full` receipt exists only after all task
reviews and commits. A task contract that requires the latter is therefore circular and must be
rejected as unverifiable during planning. Additional pre-review commands are project-owned fast
gate composition, not executor claims or repository proof artifacts.

An open carried item whose saved evidence quotes a criterion supports that criterion's non-met
state without becoming a duplicate new finding. If a schema-valid reviewer response is
semantically inconsistent with either ledger, the engine restores the same review baseline and
allows one correction call. A second inconsistency stops the run before later passes are merged.

A review round contains one primary pass plus `review_challenger_passes` blind challenger passes
(one by default, at most two). Every pass receives the same delivery digest in a fresh isolated
surface. The engine merges their census rows and findings before another executor can run.
Disagreement keeps a carried item open; challenger-only findings are labelled
`late-same-baseline` with that digest.

Each finding names criterion, surface and transition ids plus a stable property key. CAW retains
every pass observation and groups only an exact match of those fields into one executor work
package. This preserves provenance and prevents text similarity or a shared file from collapsing
different defects.

The derived result is retained as a [certification record](certification.md). Acceptance and full
certification are separate states: missing independent population or unavailable verification is
visible as `limited`, never silently called `approved`.

Task delivery has two records. The public commit contains the subject, compact gate/review result
and an audit digest. The private Git audit record contains the full task contract and evidence
identities, and binds them to both the reviewed delivery digest and the staged Git tree.

Weak verification can have two project-supplied controls. A source probe proves that the check
loaded files from the isolated review surface, and a positive control proves that `gate_fast` can
turn red for a known tracked-file change. They run before reviewer mutations and the surface is
restored afterwards. The pair is optional but indivisible: partial, invalid, timed-out or
ineffective controls make weak evidence unavailable rather than blocking delivery.

## Roles bind to adapters, and bindings are proved

`.caw/runtime.json` binds each role to a provider, model and reasoning level. That declaration is
not trusted on its own. Each role has a set of requirements:

`.caw/CAW.md` separately sets `planning_independence` and `task_independence`. `same-provider`
permits any pair, `different-model` requires a different vendor or model, and `cross-vendor`
compares the stable `vendor` owner reported by each adapter. `human-review` disables the relevant
automated reviewer and requires an OpenSSH-signed attestation over the exact `PLAN.md` bytes or
delivery digest. The attestation and signature are retained in Git-private `caw/human-reviews/`.
The resolved pairs and whether they satisfy policy are retained in every run manifest.

Adapters declare `modelSelection: explicit-id` and their supported CAW reasoning levels. The
engine validates the binding before a provider call. When `require_role_smoke` is enabled, each
exact provider/model/reasoning/CLI/adapter/engine tuple must have Git-private evidence from
`node caw.mjs smoke <role|all>`; changing a model invalidates only the affected role.

```js
executor: {
  repositoryRead: 'available', directEdit: 'available', shellExecution: 'available',
  externalToolAccess: 'forbidden', writeScope: 'delivery-tree',
}
```

An adapter describes what its provider actually offers, and the two are compared by an explicit
**per-key partial order** — a strictly stronger declaration satisfies a weaker requirement. Claude's
absent editor satisfies `directEdit: forbidden-delivery` for the planning roles, for instance.

`writeScope` is the key that carries the design:

| value | meaning |
|---|---|
| `none` | nothing |
| `engine-private-only` | engine-owned scratch, nothing else |
| `shell-residual-delivery` | **a shell can still reach delivery** — this is what a missing OS boundary looks like |
| `delivery-tree` | the executor, and only the executor |
| `isolated-review-surface` | the reviewer's copy, and nothing outside it |

A refusal names the guarantee, not the missing helper. `architect requires
writeScope=engine-private-only; adapter field is shell-residual-delivery` is what an absent
`bwrap` reads like on Linux.

## Probes: evidence beats declaration

A binding that declares a probe is unavailable until that probe is green **on this machine**.
`node caw.mjs probe <provider>` makes a live call that attempts a write inside the boundary and
one outside it, and stores an attestation keyed by provider, probe id, adapter digest,
OS/architecture and canonical executable path.

`cli_version` is deliberately **not** part of that key. Keying evidence to the exact build made
every routine provider update refuse the whole pipeline until three paid boundary calls
re-observed a mechanism that had not changed. The version is still recorded and reported when it
drifts; the refusal is what went. An unknown flag fails loudly and a tool name the CLI no longer
knows grants nothing rather than everything, so a provider update degrades noisily or safely.

Attestations expire after 30 days.

## The guards bind the operator, not the pipeline

`.caw/hooks/` is Python, wired into the operator's own agent session through its settings file.
They are not part of the engine and the engine never calls them.

| guard | refuses |
|---|---|
| `deny_tasks_bash.py` | a shell write into `.caw-tasks/PLAN.md`; withdraws approval on any other queue write |
| `deny_tasks_edit.py` | the same policy through direct file-edit tools |
| `require_caw_log.py` | a pipeline launch whose command line does not name `.caw-logs/` |

They exist because the tool cannot defend its own queue: `caw.mjs` owns it and excludes it from
every git read and write, but sees nothing else touching it. The guards close the agent-session
route. A hand or a script is still outside them.

Every pattern in the guards is written in the POSIX spelling and the input is normalised first —
backslashes become slashes, the project root is stripped in whichever spelling arrived, and runs
of slashes collapse. Three Windows spellings walked past an exact-match guard before that existed.

## What deliberately does not exist

- **No self-hosting.** This repository is edited by hand and tested by running it on something
  else. The previous version ran on itself, and that made every document about the pipeline
  simultaneously the product and an instance of it.
- **No metrics ledger, no queue file, no history tiers.** `ls .caw-tasks/` is the queue and
  `git log` is the record.
- **No scope-selection map.** Two gate tiers, `gate_fast` and `gate_full`, and no per-path rows.
- **No `--force` on `build`.**
