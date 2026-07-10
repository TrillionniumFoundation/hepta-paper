# Read-only Release Verification Validator

`src/read-only-release-verification-validator.mjs` independently validates a
generated `ReadOnlyReleaseVerificationBundle`.

Run:

```bash
npm run validate:release-verification
```

The CLI reads `reports/read-only-release-verification-latest.json`, recomputes
the `verificationHash`, checks required health/validation/gate/closeout/sample
hash fields, validates release verification report-file bindings, checks bundle
metrics against blockers/warnings/checks, requires dispatch readiness metrics
such as blocked handoffs and dashboard warnings, and rejects unsafe
external-action claims.

After this passes, `npm run release:archive` can package the verification
bundle and validation report into an archive-ready local manifest.

## Boundary

The validator is local and read-only. It reads and validates local report
payloads only. It never executes adapters, uploads, submits, sends messages,
accepts delivery, pays, deploys, fetches channel state, applies lifecycle state,
grants permission, or replaces external-runner approval, evidence, replay,
duplicate, channel-state, and current-chat checks.
