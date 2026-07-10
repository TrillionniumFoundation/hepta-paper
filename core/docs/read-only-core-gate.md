# Read-only Core Gate

`npm run gate:readonly` runs the local regression checks that should close a
`design-production-core` change:

- syntax check every `src/*.mjs`
- parse every fixture JSON file
- run `src/selftest.mjs`
- run `src/export-readonly-samples.mjs`
- run `src/validate-readonly-samples.mjs`

The gate writes a `ReadOnlyCoreGateReport` with a deterministic `gateHash`,
step statuses, and compact child command summaries to:

- `reports/read-only-core-gate-latest.json`
- `reports/read-only-core-gate-latest.md`
- timestamped JSON/Markdown copies

Use `node src/read-only-core-gate.mjs --stdout-only` when a caller needs a
temporary report without writing the gate artifact.

Run `npm run validate:gate` after `npm run gate:readonly` to verify the latest
gate artifact. The validator recomputes the report's `gateHash`, checks
`stepCount`, `failedSteps`, required gate step names, `reportFiles`, and the
read-only safety claims in the gate and child command summaries.

Run `npm run summarize:closeout` after validation when a dashboard needs a small
status object instead of the full gate JSON. It writes
`reports/read-only-closeout-latest.json` and `reports/read-only-closeout-latest.md` plus timestamped copies.

## Boundary

This is a local regression gate. It writes local report artifacts and may
refresh local read-only sample reports through `export:samples`, but it never
executes adapters, uploads, submits, sends messages, accepts delivery, pays,
deploys, fetches channel state, applies lifecycle state, or grants permission.

The gate validator is also read-only. It only reads a local gate report and
recomputes/checks hashes and metadata; it does not rerun the gate or execute
external work.
