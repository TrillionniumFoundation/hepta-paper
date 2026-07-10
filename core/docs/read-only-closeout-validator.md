# Read-only Closeout Validator

`src/read-only-closeout-validator.mjs` verifies a generated
`ReadOnlyCloseoutSummary` before a dashboard or control-plane archive consumes
it.

Run:

```bash
npm run validate:closeout
```

The CLI reads `reports/read-only-closeout-latest.json` by default. It
recomputes the summary hash, checks the gate hash against the recomputed gate
hash preserved in the summary, verifies required report-file bindings, checks
that dispatch readiness metrics such as blocked handoffs and dashboard warnings
are present, and blocks unsafe external-action claims.

After this passes, `npm run release:health` can combine the gate and closeout
reports into a single dashboard health manifest.

## Boundary

The validator is local and read-only. It validates a report payload and
recomputes hashes only. It never executes adapters, uploads, submits, sends
messages, accepts delivery, pays, deploys, fetches channel state, applies
lifecycle state, grants permission, or replaces external-runner approval,
evidence, replay, duplicate, channel-state, and current-chat checks.
