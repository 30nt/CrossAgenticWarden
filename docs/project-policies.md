# Project policies

[Русская версия](project-policies.ru.md)

Project policies customize CAW without editing `caw.mjs` or the shipped roles. They live under
`.caw/project/`, belong to the project, and are not part of CAW install/update verification.

## Manifest

Create `.caw/project/manifest.json`:

```json
{
  "api_version": 1,
  "policies": {
    "planning": {
      "id": "product-boundaries",
      "command": ["node", ".caw/project/planning.mjs"],
      "timeout_ms": 5000
    }
  }
}
```

The admitted stages are `planning`, `review`, `gate`, and `commit`. API version 1 remains the
single-pass contract below. API version 2 adds risk-aware two-phase planning and a bounded flaky
retry decision to the gate contract; review and commit keep their version-1 output shapes. Unknown
fields, unknown stages, symlinks, oversized policy trees, invalid commands, and timeouts are refused.

## Protocol

CAW starts the command directly, without a shell. It writes one JSON object to stdin:

```json
{"api_version":1,"stage":"planning","context":{}}
```

The policy must write exactly one JSON object to stdout. Use stderr for diagnostics. Output is
limited to 256 KiB, input to 1 MiB, policy files to 2 MiB, and timeout to at most 60 seconds.

- API v1 `planning` returns `{"issues":[],"instructions":[]}`. Issues stop before provider calls;
  instructions are appended to the planning profile.
- `review` returns `{"criteria":[],"instructions":[]}`. Criteria are added to the core ledger
  under engine-namespaced ids; they cannot remove core criteria.
- API v1 `gate` returns `{"action":"continue","reason":""}` or a reasoned `stop`. It cannot
  turn a red, refused, or timed-out core gate green.
- `commit` returns `{"subject":""}`. A non-empty value changes only the commit subject. Core
  staging, audit text, and commit ownership remain unchanged.

## Risk-aware planning (API v2)

Set the manifest's `api_version` to `2`. CAW calls the planning policy twice.

The `request` phase runs before the enumerator. Its context contains `phase`, `request`, and
`profile`. Return:

```json
{
  "issues": [],
  "instructions": [],
  "risk": {
    "class": "regulated",
    "population_requirement": "complete",
    "require_full_gate_baseline": true
  }
}
```

The risk class is a project-owned lowercase id. Population requirement is `none`, `sample`, or
`complete`.

The `population` phase runs after independent enumeration and before the architect. Its context
contains the first risk result plus the resolved population, counts, source addresses, and digest.
Return:

```json
{
  "issues": [],
  "instructions": [],
  "attestation": {
    "state": "complete",
    "population_digest": "<copy context.population.digest exactly>",
    "evidence": "project-specific closed-set check"
  }
}
```

CAW never infers `complete` from a model sample. It accepts that state only from the trusted
project policy, for the exact population digest, with non-empty evidence. An attestation weaker
than the request-phase requirement stops before the architect.

When `require_full_gate_baseline` is true, CAW stores a private queue risk record. `build --no-full`
is refused, `gate_full` must be configured, and it must be green on the starting commit before the
first executor call. The final full gate then has a known green baseline, so a red result is
attributable to the build range. If a task stops for a decision, the baseline stays with the
queue. `round` and `review` accept it only while its commit is still an ancestor and `gate_full`
is unchanged, then run the final full gate after the recovered task. The risk record is removed
when the queue becomes empty.

Baseline reuse is opt-in. Before the full gate, a v2 gate policy receives
`kind: "full-baseline-inputs"` and `known_inputs`. To allow reuse, return a SHA-256 digest of every
additional input the gate can observe:

```json
{"action":"continue","reason":"","baseline_inputs_digest":"<64 lowercase hex>"}
```

Typical additional inputs are ignored dependencies and caches, SDK or simulator versions,
service state, and relevant environment configuration. CAW combines that project digest with
HEAD, delivery and queue digests, engine, profile, gate environment, policy set, risk attestation,
gate command, and timeout. A previous green baseline is reused only when the combined digest matches exactly. If the
field or a v2 gate policy is absent, CAW runs the full baseline again. On a cacheable miss, CAW
also resolves the project digest after the gate and refuses the baseline if it changed mid-run.

## Flaky gate classification (API v2)

A v2 gate policy may add `classification`: `defect`, `flaky`, `infrastructure`, or `unknown`.
After a red result it may return:

```json
{"action":"retry","classification":"flaky","reason":"matched the project allowlist"}
```

CAW still performs its own first confirmation. Only a confirmed red result can use the policy
retry, and the engine allows at most two policy retries for one delivery. No executor runs during
them. If the gate stays red, the normal bounded executor/review flow resumes. The allowlist and
classification rules live in project policy code; the run record stores every decision.

Policy commands run in a private temporary working directory with a reduced environment. CAW
checks that the delivery, HEAD, CAW files, policy files, and task queue did not change. This is a
side-effect check, not an OS security boundary: policies are trusted project code, like the
configured gate command.

## Verification and records

```bash
node caw.mjs verify-project
```

This executes every configured stage with a verification input and validates its output. API v2
planning is checked in both phases; its gate policy is also checked for ordinary gate and baseline
input phases. Normal run records contain the manifest digest, every policy digest, duration,
stage, and result. Saved task state records the policy set and reports divergence after a policy
change.
