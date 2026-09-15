# Writing an adapter

English only — writing an adapter means reading the contract test and two reference
implementations, which are in English.

> **The adapter contract is not stable until v1.** `apiVersion` is `3` today and will change.
> Pin the tag you built against.

An adapter is an implementation directory at `.caw/adapters/<id>/`, rooted at `adapter.mjs`.
It may keep its provider runner and other helpers beside that entry point. It teaches the engine
how to launch one provider, what that provider guarantees per role, and how to read what comes
back. It does **not** decide policy — the engine compares what you declare against fixed role
requirements and refuses anything short.

The adapter digest covers every implementation file below that directory, recursively. Paths,
executable modes, and bytes all participate. The reserved legacy `probes/` directory may contain
only regular JSON evidence files and is excluded because those records contain the digest they
attest. Symlinks and other special entries are rejected so an implementation helper cannot escape
the trusted tree or change without invalidating probe and role-smoke evidence.

Two references ship in the tree: `.caw/adapters/claude/` and `.caw/adapters/codex/`. A minimal
third is at `test/third-adapter/adapter.mjs`, and `test/adapter-contract.test.mjs` is the
contract itself. Read the test first — it is the specification.

## The thirteen required keys

Every key is required. Extra keys are a load error, and so is a missing one: the engine refuses
an adapter it cannot fully account for rather than running a partial one.

```js
export default {
  apiVersion: 3,
  id: 'my-provider',        // must equal the directory name
  vendor: 'vendor-name',    // stable owner id used by cross-vendor review policy
  features,                 // transport and reporting capabilities
  resolveExecutable,        // (env) => path, honouring CAW_MY_PROVIDER then PATH
  versionInvocation,        // how to ask the CLI its version
  mechanismAvailable,       // is the OS boundary this adapter needs present on this host?
  verifyGuaranteeProbe,     // the live call that proves the write boundary
  describe,                 // (role, cliVersion) => guarantees
  buildInvocation,          // (binding, prompt, schema, execution) => argv + env
  buildProbeInvocation,     // the same, for the probe child
  decodeSuccess,            // provider output => { value, accounting }
  decodeFailure,            // provider output => a bounded reason
}
```

## `describe` is the part that matters

It returns, per role, a state and **how that state is achieved**:

```js
writeScope: {
  state: 'delivery-tree',
  by: 'native-policy',
  probe: { cliVersion, id: 'my-provider-boundary-v1' },
}
```

`state` is compared against the role's requirement through a per-key partial order, so a
strictly stronger declaration satisfies a weaker one. `by` is how it is enforced —
`native-tool`, `native-policy`, `absent`, `os-boundary`, `isolated-surface`. The values the
engine understands are in `GUARANTEE_ORDER` and `GUARANTEE_MECHANISMS` in `caw.mjs`; those two
objects are the vocabulary, not this file.

Declaring a `probe` makes the binding unavailable until that probe is green on the machine that
will run it. **Declare one for any `writeScope` you assert.** A boundary claim with no probe is
a sentence in a config file.

If your provider has no OS boundary on this host, say so: `writeScope: 'shell-residual-delivery'`
is the honest value, and the engine will refuse the planning roles with a message naming the
guarantee rather than the missing helper. That refusal is the adapter working correctly.

The closed `features` object also declares invocation capabilities:

```js
{
  schemaTransport: 'inline',
  resultTransport: 'stdout',
  reportsCost: true,
  reportsCacheCounters: true,
  reportsModels: true,
  modelSelection: 'explicit-id',
  reasoningLevels: ['low', 'medium', 'high', 'max'],
}
```

`explicit-id` means `runtime.json` model strings are provider-native ids and are passed without an
engine alias table. `reasoningLevels` lists the CAW levels the adapter maps to native options. A
binding outside that list refuses before the provider process starts. A successful
`node caw.mjs smoke <role>` is keyed to the exact model, reasoning, CLI, adapter and engine bytes;
changing any of them requires that role to be smoked again when the profile enables the check.

## Cost and tokens: unknown is a value

`decodeSuccess` returns accounting alongside the value. A provider that reports no price must
return **unknown**, never zero. The engine prints a total with any unpriced call as a lower bound
plus the unpriced count, and never adds different currencies:

```
at least $0.11, plus 1 unpriced call
```

A zero written where a number was unavailable is the one failure this design will not tolerate.

The canonical successful result also contains:

```js
telemetry: {
  eventCount: 12,       // provider event records, or null
  toolEventCount: 4,    // events representing tool use, or null
  eventBytes: 8192,     // raw provider event-stream bytes, or null
}
```

Every field is required and is either a non-negative safe integer or `null`. Do not estimate
provider events the CLI did not expose. CAW combines this with engine-known original prompt bytes
and token counters, retaining unknown counts explicitly and exporting summaries by task, round and
role.

## Getting it accepted here

1. `test/adapter-contract.test.mjs` green with your adapter added to its table.
2. A probe that actually fails when the boundary is absent — demonstrate it, do not assert it.
3. One real run: `plan` and `build` on a small repository, with the log.
4. The platforms you measured, named. "Works on Linux" without a version and an architecture is
   not a measurement.

An adapter for a provider nobody but you can run is still welcome — it just lands documented as
unexercised, in [limitations.md](limitations.md), which is where honest gaps live here.
