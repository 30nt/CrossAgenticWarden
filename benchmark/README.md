# CAW acceptance benchmarks

These cases live outside the engine tests so expected product behaviour is data, not an assertion
assembled from the implementation under test.

- `planning.json` checks coverage-ledger completeness and rejection of incomplete review.
- `execution.json` checks conservative multi-pass review and late-finding classification.

Run the phases separately:

```bash
node --test --test-name-pattern='benchmark: planning' test/benchmark.test.mjs
node --test --test-name-pattern='benchmark: execution' test/benchmark.test.mjs
```

Run both with `node --test test/benchmark.test.mjs`.
