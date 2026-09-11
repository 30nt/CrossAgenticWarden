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

The admitted stages are `planning`, `review`, `gate`, and `commit`. Unknown fields, unknown
stages, symlinks, oversized policy trees, invalid commands, and timeouts are refused.

## Protocol

CAW starts the command directly, without a shell. It writes one JSON object to stdin:

```json
{"api_version":1,"stage":"planning","context":{}}
```

The policy must write exactly one JSON object to stdout. Use stderr for diagnostics. Output is
limited to 256 KiB, input to 1 MiB, policy files to 2 MiB, and timeout to at most 60 seconds.

- `planning` returns `{"issues":[],"instructions":[]}`. Issues stop before provider calls;
  instructions are appended to the planning profile.
- `review` returns `{"criteria":[],"instructions":[]}`. Criteria are added to the core ledger
  under engine-namespaced ids; they cannot remove core criteria.
- `gate` returns `{"action":"continue","reason":""}` or a reasoned `stop`. It cannot turn a
  red or refused core gate green.
- `commit` returns `{"subject":""}`. A non-empty value changes only the commit subject. Core
  staging, audit text, and commit ownership remain unchanged.

Policy commands run in a private temporary working directory with a reduced environment. CAW
checks that the delivery, HEAD, CAW files, policy files, and task queue did not change. This is a
side-effect check, not an OS security boundary: policies are trusted project code, like the
configured gate command.

## Verification and records

```bash
node caw.mjs verify-project
```

This executes every configured stage with a verification input and validates its output. Normal
run records contain the manifest digest, every policy digest, duration, stage, and result. Saved
task state records the policy set and reports divergence after a policy change.
