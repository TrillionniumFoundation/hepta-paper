# Read-only Release Verification Bundle

`src/read-only-release-verification-bundle.mjs` combines a
`ReadOnlyReleaseHealthManifest` and its validation report into a final
dashboard/archive record.

Run:

```bash
npm run release:verify
```

The CLI reads `reports/read-only-release-health-latest.json`, validates it with
`read-only-release-health-validator`, checks that the manifest health hash and
validation hash chain agree, then writes
`reports/read-only-release-verification-latest.json` and `reports/read-only-release-verification-latest.md` plus timestamped
copies.
The verification metrics carry the release health dispatch readiness totals,
including blocked handoffs and dashboard warnings, instead of collapsing the
read-only feedback handoff signal to sample counts only.

Run `npm run validate:release-verification` afterward to independently
recompute the verification hash, check hash/report-file bindings, and reject
unsafe external-action claims in the generated bundle.

## Boundary

The bundle is local and read-only. It packages release health and validation
evidence only. It never executes adapters, uploads, submits, sends messages,
accepts delivery, pays, deploys, fetches channel state, applies lifecycle state,
grants permission, or replaces external-runner approval, evidence, replay,
duplicate, channel-state, and current-chat checks.
