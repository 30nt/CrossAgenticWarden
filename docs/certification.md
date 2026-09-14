# Certification records

[Русская версия](certification.ru.md)

Every task review writes `certification-<task>-round-<n>.json` into the current run record before
CAW prints or acts on the verdict.

The record contains the actual author and reviewer runtimes, enforced independence mode, complete
criterion ledger, population state, review-surface baseline, delivery digest, weak-verification
state, open finding ids, and project-policy digests.

Its state is:

- `approved` when the reviewer has no open item, an independently enumerated population survived,
  and the author runtime was observed;
- `limited` when the code is accepted but population or author provenance is missing, or weak
  verification is unavailable;
- `rejected` when blocking items remain.

A weak experiment that is caught by the gate is recorded as `refuted`. A baseline, mutation gate,
or replay that cannot complete is `unavailable`: CAW retains its evidence and limits the
certification, but does not turn it into a code requirement for the executor.
When `where` names an existing repository file, the captured mutation must change that exact file;
changing another component is unavailable evidence, not a confirmed weak test.
Captured mutation patches are private run-record artifacts. Verification and certification rows
retain their file name, byte count, and SHA-256 instead of embedding the patch in JSON.

Projects may make weak verification controlled by configuring both `weak_source_probe_cmd` and
`weak_positive_control_cmd`. The source probe must report the absolute files it actually loaded
from the isolated review surface. The positive control must change a tracked file and make
`gate_fast` red. CAW restores the surface before replaying reviewer mutations. A failed, timed-out,
invalid, mutating source probe or an uncaught positive control makes weak evidence unavailable and
the certification `limited`; it does not create work for the executor.

`PLAN.md` carries the population state, counts, and digest from planning into a later build. A
hand-written task or an old plan has `population: unknown`, so it cannot receive ordinary
certification. Its commit says `accepted with LIMITED certification`.

Certification files currently share run-record retention: newest 20 and at most 30 days. Before
the task commit, CAW also writes the complete task contract to Git's private `caw/audit/` path.
The public commit carries only a compact summary and the record's SHA-256. The record is first
durable as `pending-<digest>.json`, then renamed to `<commit>.json`; interruption cannot erase the
only copy. It contains the spec, notes, certification, policy snapshot, reviewed delivery digest
and exact staged tree. This private storage is local Git state and is not pushed automatically.

Before an old run record is pruned or explicitly purged, CAW appends compact call, usage-state,
duration and certification counters to `caw/metrics/runs.jsonl`. Provider responses, prompts and
diagnostic payloads are not copied into this metrics stream.
