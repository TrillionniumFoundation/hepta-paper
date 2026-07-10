# Post-action Replay Guard Matrix

`runtime:post-action-replay-guard-matrix` exports a local-only replay guard
report:

```bash
npm run runtime:post-action-replay-guard-matrix
```

Latest outputs:

- `reports/post-action-replay-guard-matrix-latest.json`
- `reports/post-action-replay-guard-matrix-latest.md`

The matrix starts from the ready handoffs produced by
`runtime:dry-run-harness`, the receipt/proof guarantees from
`runtime:post-action-evidence-matrix`, and the all-routes archive produced by
`runtime:post-action-audit-archive-matrix`. For every supported ZBJ / EPWK /
Hepta adapter route, it builds synthetic `ExternalActionReplayGuardDecision`
records for:

- a new candidate that should remain clear,
- the same archived task/action without repeat approval,
- the same archived task/action with repeat enabled but missing approval,
- the same archived task/action with explicit repeat approval,
- exact bundle/ledger hash replay even with repeat approval,
- and a candidate checked against a blocked archive.

Customer-message rows carry `messagePreviewHash` into the replay candidate and
repeat approval; human-feedback customer-facing rows also carry
`humanFeedbackRevisionContractHash` for `customer_message`,
`live_submit` / EPWK `workModifyLive`, and `acceptance_apply`, so a repeat
approval cannot clear a same-identity replay for different customer-visible text
or a different feedback contract. These replay candidates derive the message
hash, feedback contract hash, and provider/model `promptGenerationBinding` only
from the audit bundle payload source copy. The matrix includes stripped-payload probes that
delete those payload fields while leaving sibling hash-binding / ledger copies
in place; the candidate field must become null and the replay guard must block
instead of falling back to sibling copies. Replay candidates also carry
canonical `packageRole`, so a role-only human-feedback handoff remains
distinguishable through replay checks instead of collapsing into a generic
customer-message identity.

The report passes only when all 20 routes clear new candidates, block archived
task/action replay, require repeat approval, clear explicitly approved repeats,
block exact bundle/ledger replay, and block decisions against a non-ready
archive.

Safety boundary: this report uses synthetic fixture records only. Replay guard
output is a check, not a queue write or execution grant. It never spawns a
runner, opens a browser/API session, uploads, submits, sends IM/customer
messages, applies acceptance, pays, deploys, calls providers/models, fetches
channel state, mutates lifecycle state, mutates replay state, or grants
execution permission.
