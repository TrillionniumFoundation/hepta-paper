# Read-only Core Gate Validator

`src/read-only-core-gate-validator.mjs` verifies a generated
`ReadOnlyCoreGateReport` without rerunning the gate.

It checks:

- report version and kind
- `status` / `ok` consistency
- `stepCount` versus actual steps
- required gate steps: `node_check_src`, `fixture_json_parse`, `selftest`,
  `export_samples`, and `validate_samples`
- `failedSteps` versus the steps whose `ok` flag is not true
- `gateHash` and generic `hash` against a recomputed hash using the gate
  contract, including a required alias/generic match
- `reportFiles` bindings for latest and timestamped JSON/Markdown artifacts
- read-only safety claims on the gate report and child command summaries

Run:

```bash
npm run validate:gate
```

By default the CLI validates `reports/read-only-core-gate-latest.json`. A custom
report path can be passed as the first argument.

For dashboard display, run `npm run summarize:closeout` after validation. That
CLI consumes the same latest gate report and emits a compact closeout summary.

## Boundary

The validator reads a local report and recomputes metadata only. It never
executes adapters, uploads, submits, sends messages, accepts delivery, pays,
deploys, fetches channel state, applies lifecycle state, grants permission, or
reruns provider/model/platform work.
