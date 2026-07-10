# Post-action Evidence Matrix

`runtime:post-action-evidence-matrix` exports a local-only post-action evidence
report:

```bash
npm run runtime:post-action-evidence-matrix
```

Latest outputs:

- `reports/post-action-evidence-matrix-latest.json`
- `reports/post-action-evidence-matrix-latest.md`

The matrix starts from the ready handoffs produced by
`runtime:dry-run-harness`. For every supported ZBJ / EPWK / Hepta adapter route,
it builds:

- a synthetic `AdapterRunReceipt` with the action-specific receipt fields from
  `actionEvidenceContract`
- a synthetic read-only `ChannelStateProof` with the matching proof fields
- dynamic `humanFeedbackRevisionContractHash` receipt/proof requirements
  only for customer-message handoffs whose manifest/preview carries a
  human-feedback revision contract
- customer-message `messagePreviewHash` continuity that downstream ledger,
  audit-bundle, archive, and reconciliation reports consume as a required hash
- canonical `packageRole` continuity from the runtime handoff through manifest
  and preview payloads, so role-only human-feedback handoffs are not lost
  before receipt/proof evidence
- a negative receipt with the action fields removed
- a negative proof with action fields missing
- a negative proof with the first action field tampered

The report passes only when all ready routes produce accepted receipts and
verified proofs, while every missing/tampered field scenario stays blocked.
`runtime:post-action-audit-bundle-matrix` consumes this evidence boundary and
continues the synthetic chain through inbox, ledger, and audit-bundle closure.

Safety boundary: this report uses synthetic fixture records only. It never
spawns a runner, opens a browser/API session, uploads, submits, sends
IM/customer messages, applies acceptance, pays, deploys, calls providers/models,
fetches channel state, mutates lifecycle state, or grants execution permission.
