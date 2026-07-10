# Read-only Release Health Validator

`src/read-only-release-health-validator.mjs` verifies a generated
`ReadOnlyReleaseHealthManifest` before a dashboard or release archive consumes
it.

Run:

```bash
npm run validate:release-health
```

The CLI reads `reports/read-only-release-health-latest.json` by default. It
recomputes `healthHash`, checks required gate/closeout/sample/dashboard hashes,
verifies release-health report-file bindings, checks that dispatch readiness
metrics such as blocked handoffs and dashboard warnings are present, confirms
ready manifests have no failed checks, and blocks unsafe external-action
claims.

After this passes, `npm run release:verify` can package the release health
manifest and validation report into one final dashboard/archive verification
bundle.

## Boundary

The validator is local and read-only. It validates a report payload and
recomputes hashes only. It never executes adapters, uploads, submits, sends
messages, accepts delivery, pays, deploys, fetches channel state, applies
lifecycle state, grants permission, or replaces external-runner approval,
evidence, replay, duplicate, channel-state, and current-chat checks.
