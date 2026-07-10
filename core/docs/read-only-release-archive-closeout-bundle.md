# Read-only Release Archive Closeout Bundle

`src/read-only-release-archive-closeout-bundle.mjs` combines a ready
`ReadOnlyReleaseArchiveManifest` and its validation report into a final
dashboard/archive closeout record.

Run:

```bash
npm run release:archive-closeout
```

The CLI reads `reports/read-only-release-archive-latest.json`, validates it
with `read-only-release-archive-validator`, checks that the archive hash and
validation hash chain agree, then writes
`reports/read-only-release-archive-closeout-latest.json` and `reports/read-only-release-archive-closeout-latest.md` plus timestamped
copies.
It keeps the archive manifest's dispatch readiness totals, blocked handoff
count, and dashboard warning count in the final closeout metrics.

## Boundary

The bundle is local and read-only. It packages release archive and validation
evidence only. It never executes adapters, uploads, submits, sends messages,
accepts delivery, pays, deploys, fetches channel state, applies lifecycle state,
grants permission, or replaces external-runner approval, evidence, replay,
duplicate, channel-state, and current-chat checks.
