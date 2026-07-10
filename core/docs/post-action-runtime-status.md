# Post-Action Runtime Status

`post-action-runtime-status` is the stable summary helper for the runtime and
post-action proof chain. It lives behind the `external-action-lifecycle` facade:

```js
import {
  buildPostActionRuntimeStatus,
  summarizePostActionRuntimeStatus,
} from 'design-production-core';
```

Pass existing report objects into `buildPostActionRuntimeStatus`:

- `runtime_dry_run_harness`
- `channel_runner_coverage_matrix`
- `post_action_evidence_matrix`
- `post_action_audit_bundle_matrix`
- `post_action_audit_archive_matrix`
- `post_action_replay_guard_matrix`
- `post_action_dispatch_envelope_matrix`
- `post_action_dispatch_completion_matrix`
- `post_action_reconciliation_matrix`

The helper checks that all nine stages are passing, each stage exposes its
canonical hash, all expected 20 routes and 7 action classes remain covered, and
each downstream matrix binds the upstream hash it claims to consume. The final
stage must be `post_action_reconciliation_matrix`. The runtime dry-run stage
also requires all 20 ready handoffs to expose `runnerLocationExternalWorkspace`
and zero internal-workspace ready runners.
Stage identity is semantic-alias-only: each stage must expose its configured
hash key such as `runtimeDryRunHarnessHash` or
`postActionReconciliationMatrixHash`; generic `hash` cannot substitute for a
stripped stage alias.

The status report also lifts the customer-message, human-feedback, and
package-role invariants from every runtime/post-action stage into top-level
required summary metrics. It fails closed if any stage stops reporting all 20
package-role-bound ready routes, if any human-feedback stage stops reporting
all 4 package-role-bound customer-facing feedback routes, if the 5
customer-message routes stop binding `messagePreviewHash`, or if the 4
human-feedback customer-facing routes stop reporting and drift-probing
`humanFeedbackRevisionContractHash`.
The audit bundle, audit archive, replay guard, dispatch envelope, and dispatch
completion stages must also carry the stripped-payload/source-copy probes forward for
customer-message hashes, human-feedback contract hashes, prompt-generation
binding copies, outbox aliases, and bundle aliases. Audit bundle source-copy
probes cover both ledger `payload` and ledger `chain` copies after recomputing
the ledger hash; audit archive source-copy probes cover both `payload` and
`hashBinding` copies after recomputing the bundle hash, so a sibling source
cannot hide a missing bundle or archive input.
It also requires reconciliation to keep blocking all 20 stripped bundle alias,
missing aggregate entry, tampered bundle, missing dispatch chain, missing bundle
dispatch source, missing ledger dispatch source, and per-route archive drift
probes.

As of the runtime source-copy gate, `requiredSummaryMetricCount` is 70
and `requiredSummaryMetricOkCount` must also be 70 before the architecture
checkpoint can pass.

The same helper is exported as a first-class latest report:

```bash
npm run runtime:post-action-runtime-status
```

Outputs:

- `reports/post-action-runtime-status-latest.json`
- `reports/post-action-runtime-status-latest.md`

The helper module is intentionally report-summary only; the exporter only reads
existing local latest reports and writes the status report pair. Neither path
spawns runners, opens browser/API sessions, uploads, submits, sends messages,
accepts delivery, pays, deploys, fetches channel state, mutates lifecycle state,
consumes queues, or grants execution permission.
