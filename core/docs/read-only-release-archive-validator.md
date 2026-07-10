# Read-only Release Archive Validator

`src/read-only-release-archive-validator.mjs` independently validates a
generated `ReadOnlyReleaseArchiveManifest`.

Run:

```bash
npm run validate:release-archive
```

The CLI reads `reports/read-only-release-archive-latest.json`, recomputes the
`archiveHash`, checks the verification/validation hash chain, validates archive
report-file bindings, checks manifest metrics against blockers/warnings/checks,
requires dispatch readiness metrics such as blocked handoffs and dashboard
warnings, and rejects unsafe external-action claims.

## Boundary

The validator is local and read-only. It reads and validates local report
payloads only. It never executes adapters, uploads, submits, sends messages,
accepts delivery, pays, deploys, fetches channel state, applies lifecycle state,
grants permission, or replaces external-runner approval, evidence, replay,
duplicate, channel-state, and current-chat checks.
