# Refpack Outcome Scoring

`refpack-outcome-scoring` is the shared local outcome-learning score for design reference packages.

It accepts reference-pack metadata, workflow ids, and a local case-ledger bucket map. It produces `RefpackOutcomeScore` rows and a `RefpackOutcomeScoreReport` with stable hashes, status buckets, counts, promoted success patterns, rejected patterns, buyer-correction patterns, and recommendations for downstream prompt compilation.

The module is pure core logic. It does not read channel databases, discover tasks, call providers or models, open browsers, upload, submit, send IM, accept delivery, pay, deploy, mutate state, or grant execution permission. Channel adapters such as ZBJ remain responsible for loading their own case ledger and reference-pack registry, then passing normalized inputs into this scorer.

Typical flow:

1. Channel code loads its local case ledger and design-reference pack registry.
2. Channel code resolves each pack/workflow into a `DesignReferenceSpec`-shaped object.
3. Core `buildRefpackOutcomeScoreReport()` scores the rows and hashes the report.
4. Prompt artifact compilation consumes only the local evidence summary; executable provider paths must still pass readiness and production contracts.

Safety invariants:

- `localScoringOnly: true`
- `callsProviderOrModel: false`
- `opensBrowserOrPlatform: false`
- `uploadsOrSubmits: false`
- `sendsMessages: false`
- `acceptsDelivery: false`
- `paysOrDeploys: false`
- `grantsExecutionPermission: false`
