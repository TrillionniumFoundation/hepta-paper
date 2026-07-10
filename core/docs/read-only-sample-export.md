# Read-only Sample Export

`npm run export:samples` writes `reports/read-only-samples-latest.json` and
`reports/read-only-samples-latest.md` and timestamped copies. It reads local
channel state plus synthetic Hepta/human-feedback samples:

- ZBJ flow state and case files
- EPWK detail cache
- synthetic Hepta vectorization order fixture
- synthetic ZBJ, EPWK, and Hepta human-feedback revision fixtures
- synthetic dispatch readiness descriptors generated inside core

The export does not call providers, models, browsers, platform APIs, uploads,
submits, messages, acceptance, payments, or deployment.

## Contract Samples

The `samples` array normalizes local ZBJ records, local EPWK records, a
synthetic Hepta vectorization order, and synthetic cross-channel
human-feedback revision records into the shared core contracts:

- `ChannelTask`
- `CreativeBrief`
- `ProductionPlanEnvelope`
- optional `ArtifactPackage`
- optional `ReviewReport`

The export keeps `sourceSnapshot` disabled so raw platform objects stay in their
owning channel workspace. The Hepta sample is marked `synthetic` and uses local
fixture references only; it does not read Hepta account or buyer state.

Human-feedback samples are synthetic because they are coverage fixtures, not
live buyer threads. Each sample binds a `HumanFeedbackRevisionContract`, one
active atomic change, source snapshot hash, target artifact hash, baseline
invariant lock, review report, message preview hash, and customer-facing
validation. The export/dashboard/status/validator all fail closed if ZBJ, EPWK,
or Hepta human-feedback coverage disappears, if a sample identifies itself
as human feedback only through `packageRole`/`reviewType`/`role`, or if any
feedback sample loses its contract or customer-facing validation.

## Unsupported Inventory

The payload includes `unsupportedInventory` for samples whose plan-only draft is
blocked before any execution stage. This keeps unsupported or ambiguous local
records visible without hiding them from release health. The inventory is
read-only, carries blocker and warning codes, and never grants execution
permission.

## Control Plane

The `controlPlane.dispatchReadiness` section summarizes synthetic handoff
descriptors through `AdapterDispatchReadinessReport`.
The synthetic descriptors may be seeded with human-feedback aliases, but the
exported control-plane handoff rows expose canonical `customer_message` actions
and canonical human-feedback product/workflow IDs. They also preserve
canonical `packageRole`, `reviewType`, and `role` fields so role-only feedback
handoffs remain visible in dashboard output.
The generated Markdown summary also canonicalizes product/workflow summary
bucket keys, so direct alias inputs such as `consumer_feedback` or
`buyer-feedback` render as `human_feedback`, and raw role aliases such as
`human-feedback-review` render as `human_feedback_review`.

The synthetic control-plane payload is built by
`src/read-only-control-summary.mjs`, which is side-effect-free and imported
directly by the local read-only report scripts. Public consumers should use the
`read-only-report-chain` facade or generated reports instead of importing this
builder from the root index.

It reports ready versus blocked handoffs for dashboard/operator display:

- ready Hepta delivery handoff
- mismatched runner selection
- unsupported EPWK submit selection
- replay-conflict ZBJ submit envelope
- human-feedback message envelope missing the contract hash
- role-only human-feedback message envelope missing the contract hash

The Markdown table includes deterministic operator hint labels next to failed
checks so a dashboard can explain why a handoff is blocked without inventing a
runtime action. Those labels resolve through the dispatch-readiness operator
hint catalog, so unknown hint strings fail selftests instead of becoming
dashboard output. The export summary also includes the hint catalog resolution
count so dashboards can surface `unknown=0` as part of their read-only health
state.

The control summary also includes a `ReadOnlyControlDashboardStatus` object. It
is ready when the local summary is safe to display and all operator hints resolve
through the catalog. Blocked handoffs remain warnings inside that status because
they are useful operator information, not export failures.

The export also writes a top-level `dashboardSnapshot` built by
`src/read-only-dashboard-snapshot.mjs`. That snapshot combines sample summary,
human-feedback coverage, plan-only blockers, dispatch readiness, and hint
catalog health into one dashboard-ready object with a deterministic hash.

The export's final status is built by
`src/read-only-sample-export-status.mjs`. Its `ok` flag requires both sample
validation and `dashboardSnapshot.readyForDashboard`, and the status object
adds a deterministic `statusHash`. This keeps dashboard blockers from being
reported as a green export while making the decision reusable outside the CLI.

`npm run validate:samples` reads `reports/read-only-samples-latest.json` through
`src/read-only-sample-export-validator.mjs`. It recomputes the dashboard
snapshot and export status hashes, checks top-level status consistency, and
blocks unsafe external-action claims or missing human-feedback coverage in
the report payload. It recognizes human-feedback aliases across
product/workflow IDs and role-only fields such as `packageRole`, `reviewType`,
and `role` for coverage classification, but the public payload's sample rows,
unsupported inventory, and product/workflow summary buckets must already expose
canonical `human_feedback` IDs and canonical human-feedback package roles
rather than legacy aliases. The validator is read-only and writes no files.

These are local samples, not queued external work. A ready dispatch readiness
report only means the descriptor chain is internally consistent for an outside
runner to inspect. It is not permission to run adapters and cannot replace
current approval, fresh evidence, replay guard, duplicate/channel-state, or
current-chat checks.
