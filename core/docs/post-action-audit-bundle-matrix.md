# Post-action Audit Bundle Matrix

`runtime:post-action-audit-bundle-matrix` exports a local-only audit closure
report:

```bash
npm run runtime:post-action-audit-bundle-matrix
```

Latest outputs:

- `reports/post-action-audit-bundle-matrix-latest.json`
- `reports/post-action-audit-bundle-matrix-latest.md`

The matrix starts from the ready handoffs produced by
`runtime:dry-run-harness` and the receipt/proof guarantees from
`runtime:post-action-evidence-matrix`. For every supported ZBJ / EPWK / Hepta
adapter route, it builds a synthetic standard inbox chain:

- `AdapterReceiptInboxItem`
- `ChannelStateProofInboxItem`
- `ReceiptStateTransitionInboxItem`
- `ExternalActionLedgerEntry`
- `ExternalActionAuditBundle`

The report passes only when all ready routes produce verified ledgers and
verified audit bundles with receipt/proof/transition inbox hashes present.
Every `customer_message` route must also keep its `messagePreviewHash` bound
from runtime handoff through ledger payload, ledger chain, audit-bundle payload,
and audit-bundle hashBinding. Human-feedback message routes additionally
keep `humanFeedbackRevisionContractHash` bound through the same final audit
record. Canonical `packageRole` also stays in the manifest, preview, outbox,
ledger, audit-bundle, and report row so packageRole-only feedback identity is
still visible after the runtime harness. The matrix fails if those
payload/hashBinding values are missing or drift.

It also proves two fail-closed cases for every route: a raw ledger without inbox
chain cannot become a final audit bundle, and a ledger missing the transition
inbox hash cannot become a final audit bundle.

Safety boundary: this report uses synthetic fixture records only. It never
spawns a runner, opens a browser/API session, uploads, submits, sends
IM/customer messages, applies acceptance, pays, deploys, calls providers/models,
fetches channel state, mutates lifecycle state, or grants execution permission.
