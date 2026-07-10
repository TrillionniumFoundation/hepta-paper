# Post-action Audit Archive Matrix

`runtime:post-action-audit-archive-matrix` exports a local-only archive closure
report:

```bash
npm run runtime:post-action-audit-archive-matrix
```

Latest outputs:

- `reports/post-action-audit-archive-matrix-latest.json`
- `reports/post-action-audit-archive-matrix-latest.md`

The matrix starts from the ready handoffs produced by
`runtime:dry-run-harness`, the receipt/proof guarantees from
`runtime:post-action-evidence-matrix`, and the verified bundle chain from
`runtime:post-action-audit-bundle-matrix`. For every supported ZBJ / EPWK /
Hepta adapter route, it builds a synthetic per-route `ExternalActionAuditArchive`
entry and an aggregate all-routes archive.

The report passes only when all 20 ready routes archive as verified audit bundle
entries, with unique bundle and ledger hashes preserved in the archive index. It
also exposes customer-message preview-hash-bound archive entries and
human-feedback contract-bound archive entries, then fails closed if those
entry hashes drift from the verified bundle. Archive entries also expose
canonical `packageRole`, and per-route archive checks fail if a ledger role such
as `human_feedback_revision` does not survive into the archive index. It
proves fail-closed cases for duplicate bundle/ledger hashes, tampered bundle
hash content, raw bundles, bundles missing transition-inbox evidence, and empty
archives.

Safety boundary: this report uses synthetic fixture records only. Archive output
is a redacted index, not a write to an archive store. It never spawns a runner,
opens a browser/API session, uploads, submits, sends IM/customer messages,
applies acceptance, pays, deploys, calls providers/models, fetches channel
state, mutates lifecycle state, mutates archive storage, or grants execution
permission.
