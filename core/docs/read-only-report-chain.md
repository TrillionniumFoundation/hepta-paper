# Read-Only Report Chain

`src/read-only-report-chain.mjs` is the stable facade for the dashboard,
closeout, release, verification, archive, and archive-closeout report chain.

It does not replace the existing report builders yet. It binds the retired
read-only root compatibility modules into one versioned chain so callers can
depend on a single stable surface while local report scripts keep owning the
implementation files.

The chain also lifts the terminal archive-closeout dispatch readiness metrics
into its summary: total, ready, and blocked handoffs, operator hint counts, and
dashboard/export blocker counts. `archive_closeout` fails closed if those
metrics are missing or if total handoffs no longer equal ready plus blocked
handoffs, so final settlement can bind blocked human-feedback handoffs
instead of treating them as an opaque release hash.

Run:

```bash
npm run readonly:report-chain
```

The exporter writes `reports/read-only-report-chain-latest.json` and `reports/read-only-report-chain-latest.md`.
Report bindings use each stage report's semantic hash alias (`gateHash`,
`summaryHash`, `healthHash`, `verificationHash`, `archiveHash`, or
`archiveCloseoutHash`). The generic top-level `hash` is not a fallback when a
semantic alias is stripped.

## Stages

- `sample_dashboard`: sample export, dashboard snapshot, sample export status,
  and sample export validation
- `core_gate`: read-only core gate validation
- `closeout`: closeout summary and validation
- `release_health`: release health manifest and validation
- `release_verification`: release verification bundle and validation
- `release_archive`: release archive manifest and validation
- `archive_closeout`: release archive closeout bundle

## Boundary

The chain is local and read-only. It does not run providers, browser
automation, uploads, submissions, customer messages, payments, acceptance,
deployment, channel-state fetches, local lifecycle transitions, or execution
permission grants.
