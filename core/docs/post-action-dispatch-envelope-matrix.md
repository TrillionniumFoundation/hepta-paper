# Post-action Dispatch Envelope Matrix

`runtime:post-action-dispatch-envelope-matrix` exports a local-only dispatch
envelope report:

```bash
npm run runtime:post-action-dispatch-envelope-matrix
```

Latest outputs:

- `reports/post-action-dispatch-envelope-matrix-latest.json`
- `reports/post-action-dispatch-envelope-matrix-latest.md`

The matrix starts from the ready handoffs produced by
`runtime:dry-run-harness`, the receipt/proof guarantees from
`runtime:post-action-evidence-matrix`, and the archive-backed replay decisions
from `runtime:post-action-replay-guard-matrix`. For every supported ZBJ / EPWK /
Hepta adapter route, it builds synthetic `AdapterDispatchEnvelope` records for:

- repeat-approved replay guard decisions that should produce ready dispatch
  envelopes,
- replay guard conflicts,
- replay guard candidate mismatches,
- tampered outbox hashes,
- and missing replay guard decisions.

The report passes only when all 20 routes can produce ready dispatch envelopes
with outbox, replay guard, archive, manifest, preview, approval, evidence,
customer-message `messagePreviewHash`, and human-feedback
`humanFeedbackRevisionContractHash` bindings where applicable. Dispatch
candidates and ready envelopes preserve canonical `packageRole` as part of the
handoff evidence so downstream completion/reconciliation reports can detect
role-only human-feedback identity. Provider/model spend candidates also carry
the same redacted `promptGenerationBinding` from the outbox, so repeat-approved
replay decisions cannot strip prompt/reference/generation-job identity before
dispatch. The conflict/mismatch/tamper/missing-guard cases all block.
The stripped outbox alias case also stays fail-closed: if `outboxHash` is
removed while generic `hash` remains, replay candidates must keep `outboxHash`
null and dispatch envelopes must block on `outbox_hash_alias_required`.

Safety boundary: this report uses synthetic fixture records only. Dispatch
envelopes are local handoff records, not runner execution. It never spawns or
dispatches a runner, opens a browser/API session, uploads, submits, sends
IM/customer messages, applies acceptance, pays, deploys, calls providers/models,
fetches channel state, mutates lifecycle state, or grants execution permission.
