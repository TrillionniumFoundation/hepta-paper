# Runtime Dry-run Harness

`runtime:dry-run-harness` exports a local-only runtime closure report:

```bash
npm run runtime:dry-run-harness
```

Latest outputs:

- `reports/runtime-dry-run-harness-latest.json`
- `reports/runtime-dry-run-harness-latest.md`

The harness uses synthetic fixtures to prove the core can assemble the handoff
bundle up to the external-runner SDK boundary:

```text
approval/fresh evidence
  -> execution gate
  -> state transition
  -> channel action manifest
  -> adapter run preview
  -> pending external action ledger
  -> adapter handoff outbox
  -> replay guard
  -> dispatch envelope
  -> runner registry/selection
  -> dispatch assignment
  -> readiness report
  -> adapter-runner SDK contract
```

It includes ready fixtures for every ZBJ / EPWK / Hepta adapter route and four
fail-closed fixtures.

Ready fixture handoffs also expose SDK phase evidence kinds, including platform
state snapshot, dry-run replay, post-action receipt, and channel state proof
requirements. Those fields are interface checklists for an external runner, not
evidence that core executed or can execute those phases. Each ready handoff also
exposes the action-specific receipt and read-only state proof fields required by
the SDK contract, plus `runnerLocationExternalWorkspace` so downstream summaries
can prove ready handoffs stay outside `design-production-core` without reparsing
paths. The top-level summary reports external/internal runner-location counts
and the runner-location boundary block count. `runtime:post-action-evidence-matrix`
consumes those ready handoffs and proves the synthetic receipt/proof field matrix separately.
`runtime:post-action-audit-bundle-matrix` then proves the same ready routes can
continue through the synthetic inbox, ledger, and audit-bundle closure without
granting execution permission.

Ready handoffs expose canonical `packageRole` when a role is present. Customer
feedback roles such as `human-feedback-review` / `human_feedback_revision`
must remain canonical in the public harness output so downstream post-action
reports can still identify role-only feedback routes instead of relying only on
product/workflow fields.

Ready fixtures cover:

- ZBJ provider spend, model spend, prepare, submit, acceptance, and customer message handoffs
- EPWK provider spend, model spend, prepare, submit, acceptance, and customer message handoffs
- Hepta provider spend, model spend, customer message, and deployment handoffs

Fail-closed fixtures:

- accidental core execute flag
- missing replay guard
- unsupported runner route
- core-local runner location

Safety boundary: this harness never spawns a runner, opens a browser/API
session, uploads, submits, sends IM/customer messages, applies acceptance, pays,
deploys, calls providers/models, fetches channel state, mutates lifecycle state,
or grants execution permission. A `readyForExternalRunner` result means only
that an external runner can recheck the bundle; it is not permission to execute.
