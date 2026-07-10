# Read-only Release Health Manifest

`src/read-only-release-health-manifest.mjs` combines the latest local gate,
gate validation, closeout summary, and closeout validation into one dashboard
health record.

Run:

```bash
npm run release:health
```

The CLI reads `reports/read-only-core-gate-latest.json` and
`reports/read-only-closeout-latest.json`, recomputes their validations, checks
that the gate hash and closeout hash chains agree, and writes
`reports/read-only-release-health-latest.json` and `reports/read-only-release-health-latest.md` plus timestamped copies.
It preserves the closeout dispatch readiness totals, including blocked
handoffs and dashboard warning counts, so role-only human-feedback blockers
remain visible in terminal release health records.

Run `npm run validate:release-health` after the manifest is written. The
validator recomputes `healthHash`, checks required hash/report-file fields and
ready-check status, and blocks unsafe external-action claims before dashboards
or archives consume the health record.

Run `npm run release:verify` after validation when a single final
dashboard/archive verification bundle is needed.

## Boundary

The manifest is local dashboard health only. It reads local report evidence and
recomputes validation hashes only. It never executes adapters, uploads, submits,
sends messages, accepts delivery, pays, deploys, fetches channel state, applies
lifecycle state, grants permission, or replaces external-runner approval,
evidence, replay, duplicate, channel-state, and current-chat checks.
