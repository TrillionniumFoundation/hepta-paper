# Read-only Release Archive Manifest

`src/read-only-release-archive-manifest.mjs` combines a
`ReadOnlyReleaseVerificationBundle` and its validation report into an
archive-ready dashboard record.

Run:

```bash
npm run release:archive
npm run validate:release-archive
```

The CLI reads `reports/read-only-release-verification-latest.json`, validates it
with `read-only-release-verification-validator`, checks that the verification
hash and validation hash chain agree, then writes
`reports/read-only-release-archive-latest.json` and `reports/read-only-release-archive-latest.md` plus timestamped copies.
The validator then recomputes the archive hash, checks report bindings and
read-only safety claims, and leaves external execution to channel runners.
Archive metrics preserve the verification bundle's dispatch readiness totals,
including blocked handoffs and dashboard warnings, so terminal archive records
do not hide read-only human-feedback handoff blockers.

## Boundary

The manifest is local and read-only. It packages release verification and
validation evidence only. It never executes adapters, uploads, submits, sends
messages, accepts delivery, pays, deploys, fetches channel state, applies
lifecycle state, grants permission, or replaces external-runner approval,
evidence, replay, duplicate, channel-state, and current-chat checks.
