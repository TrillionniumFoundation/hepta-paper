# Reports Retention

`reports/` is runtime audit output, not a durable source directory.

Keep `*-latest.*` files and this README in the repo. Treat timestamped reports
as local/archive state unless a specific release needs one pinned for review.

Historical report bursts should move to an ignored archive or external storage
instead of accumulating in source control.

Run:

```bash
npm run reports:prune
```

The prune command moves non-latest report files to
`../state/design-production-core/reports-archive/` and writes
`report-retention-latest.{json,md}`. It does not delete files.

Run:

```bash
npm run reports:freshness
```

The freshness command writes `report-freshness-latest.{json,md}` after checking
latest report files against the current integration gate summary hashes.
Required latest-report bindings use semantic report hash aliases; a generic
top-level `hash` cannot substitute when the report-specific alias is stripped.

Run:

```bash
npm run reports:freshness-regression
```

The freshness regression command writes
`report-freshness-regression-latest.{json,md}` from synthetic stale, missing, and
malformed latest-report fixtures.

Run:

```bash
npm run reports:gate-sequence-regression
```

The sequence regression command writes
`integration-gate-sequence-regression-latest.{json,md}` from source inspection
and synthetic bad step orders. It proves the integration gate keeps child
freshness and `--skip-gate` ordering intact without running the gate
recursively.

Run:

```bash
npm run reports:inventory-consistency
```

The inventory consistency command writes
`report-inventory-consistency-latest.{json,md}` from source inspection and
synthetic drift scenarios. It proves report freshness, integration gate tooling,
architecture checkpoint bindings, gate summary hash keys, and required scripts
stay in sync.

Run:

```bash
npm run reports:schema-contract
```

The schema contract command writes
`report-schema-contract-latest.{json,md}` from local latest JSON reports and
synthetic malformed report states. It proves report kind, status, ok,
generatedAt, hash, safety, and blocker shape stay stable before freshness binds
report hashes to the latest gate.

Run:

```bash
npm run reports:lineage-topology
```

The lineage topology command writes
`report-lineage-topology-latest.{json,md}` from local source/package metadata
and synthetic topology drift scenarios. It proves latest-report DAG dependencies,
required terminal nodes, gate steps, package scripts, checkpoint bindings, and
gate summary hash keys stay connected before freshness, checkpoint, and final
settlement trust the reports.

Run:

```bash
npm run reports:hash-stability-regression
```

The hash stability regression command writes
`report-hash-stability-regression-latest.{json,md}` from local latest JSON
reports and synthetic hash-noise scenarios. It proves generatedAt/output
path/key-order noise does not change canonical report hashes while summary,
blocker, and safety semantic changes do.

Run:

```bash
npm run reports:output-pairing
```

The output pairing command writes
`report-output-pairing-latest.{json,md}` from local latest report files,
`reports/README.md`, package scripts, and freshness inventory. It proves each
latest JSON report has a Markdown pair, reportFiles pointers stay aligned when
present, README entries are exact, and the script/freshness indexes include this
guard.

Run:

```bash
npm run audit:architecture-workflow
```

The architecture workflow audit writes
`architecture-workflow-audit-latest.json` and
`architecture-workflow-audit-latest.md`. It walks the local production workflow
chain from ChannelTask intake through routing, workflow profile selection,
plan-only drafting, design-reference resolution, prompt artifact compilation,
prompt readiness strategy gating, prompt production contract, generation
contracts, route contracts, semantic visual model policy, approval/evidence,
policy profiles, execution gate, state transition, manifest, next-action advice,
adapter handoff, runner registry, receipt/proof inbox, and post-action runtime
status. It binds the agent decision-node audit, design-reference taxonomy sync
gate, prompt readiness selftest, prompt production contract gate, generation
contracts selftest, route contracts selftest, semantic visual model policy
selftest, next-action advisor selftest, architecture checkpoint, runtime
dry-run, channel runner coverage, post-action runtime, and strict integration
gate reports without executing any external action.
Latest report bindings require their semantic hash aliases (for example
`checkpointHash`, `runtimeDryRunHarnessHash`, and `gateHash`); generic `hash`
fields are only matching bindings and cannot substitute for stripped aliases.

Run:

```bash
npm run design-reference:taxonomy-sync
```

The design-reference taxonomy sync gate writes
`design-reference-taxonomy-sync-gate-latest.json` and
`design-reference-taxonomy-sync-gate-latest.md` from static local source
snapshots. It proves `design-production-core` model taxonomy, ZBJ taxonomy, and
ZBJ/hepta-design refpack IDs remain aligned without running sibling package
code, using browser automation, calling provider/model routes, or granting
external execution permission.

Run:

```bash
npm run prompt-production:contract-gate
```

The prompt production contract gate writes
`prompt-production-contract-gate-latest.json` and
`prompt-production-contract-gate-latest.md` from local synthetic fixtures. It
proves a sibling planner's `PromptCompilerReport` and `PromptReadinessReport`
bind the same prompt compiler hash, readiness hash, refpack id, retrieval hash,
artifact compiler hashes, required prompt sections, prompt-set strategy status,
and safety flags before the workflow can proceed.

The report consumes prompt compiler reports that may be built by the shared
`prompt-artifact-compiler` public module and prompt readiness reports that may
be built by the shared `prompt-readiness-gate` public module. Compiler evidence
can include outcome rows built by the shared `refpack-outcome-scoring` public
module. All three are local proof code only; they do not call providers/models
or grant upload/submit/message/acceptance/payment/deployment permission.

Generation manifests should use the shared `generation-contracts` public module
after prompt production passes. It creates descriptor-only generation jobs,
artifact requests, QA records, attachment guards, and plan/manifest sync checks;
provider execution and semantic lock validators remain owned by channel
packages.

Route selection should use the shared `route-contracts` public module before
generation or submit preparation. It binds semantic/workflow route intent to the
final delivery shape and validates conflicts with observed live-submit limits
without uploading, submitting, or granting execution permission.

Semantic visual reviewers should use the shared
`semantic-visual-model-policy` public module before any channel provider/model
wrapper is considered. It requires explicit model selection, blocks disallowed
semantic visual model routes by default, and emits local package-review blockers
without calling providers/models or granting execution permission.

Operator repair dashboards can use the shared `next-action-advisor` public
module after the action manifest is known. It creates local command-bank advice,
prompt-only model-advisor context, and model-response validation while rejecting
unknown command ids and submit/live-action approvals. Channel packages still own
their concrete command templates and any provider/model wrapper.

Run:

```bash
npm run runtime:dry-run-harness
```

The runtime dry-run harness writes
`runtime-dry-run-harness-latest.json` and
`runtime-dry-run-harness-latest.md` from synthetic local fixtures. It proves the
core can assemble hash-bound ZBJ / EPWK / Hepta external-runner handoffs for
all supported adapter routes through the readiness report and adapter-runner SDK
contract while fail-closing accidental core execute flags, missing replay
guards, and unsupported runner routes.

Run:

```bash
npm run runtime:post-action-evidence-matrix
```

The post-action evidence matrix writes
`post-action-evidence-matrix-latest.json` and
`post-action-evidence-matrix-latest.md` from synthetic local fixtures. It proves
all 20 ready routes can produce action-specific accepted `AdapterRunReceipt`
records and verified `ChannelStateProof` records while preserving the runtime
handoff identity plus manifest/preview/approval/evidence hash continuity. It
also proves missing/tampered receipt or proof fields stay blocked.

Run:

```bash
npm run runtime:post-action-audit-bundle-matrix
```

The post-action audit bundle matrix writes
`post-action-audit-bundle-matrix-latest.json` and
`post-action-audit-bundle-matrix-latest.md` from synthetic local fixtures. It
proves all 20 ready routes can continue through receipt/proof/transition inbox
items into verified `ExternalActionLedgerEntry` records and verified
`ExternalActionAuditBundle` records, while raw ledgers and ledgers missing
transition-inbox evidence stay blocked.

Run:

```bash
npm run runtime:post-action-audit-archive-matrix
```

The post-action audit archive matrix writes
`post-action-audit-archive-matrix-latest.json` and
`post-action-audit-archive-matrix-latest.md` from synthetic local fixtures. It
proves all 20 verified audit bundles can be archived into per-route and
aggregate `ExternalActionAuditArchive` indexes, while duplicate bundle/ledger
hashes, tampered bundle hash content, raw bundles, missing transition evidence,
and empty archives stay blocked.

Run:

```bash
npm run runtime:post-action-replay-guard-matrix
```

The post-action replay guard matrix writes
`post-action-replay-guard-matrix-latest.json` and
`post-action-replay-guard-matrix-latest.md` from synthetic local fixtures. It
proves all 20 archive-backed routes clear new candidates, block archived
task/action replay without repeat approval, require explicit repeat approval,
clear repeat-approved candidates only when customer-message
`messagePreviewHash` and human-feedback
`humanFeedbackRevisionContractHash` repeat scope matches, block exact
bundle/ledger replay even with repeat approval, and block candidates checked
against non-ready archives.

Run:

```bash
npm run runtime:post-action-dispatch-envelope-matrix
```

The post-action dispatch envelope matrix writes
`post-action-dispatch-envelope-matrix-latest.json` and
`post-action-dispatch-envelope-matrix-latest.md` from synthetic local fixtures.
It proves all 20 repeat-approved archive-backed routes can produce ready
`AdapterDispatchEnvelope` handoff records with outbox/message/contract hash
scope preserved where applicable, while replay conflicts, candidate mismatches,
tampered outbox hashes, and missing replay guard decisions stay blocked. The
report hash also binds the upstream post-action audit archive matrix hash and
replay guard matrix hash.

Run:

```bash
npm run runtime:post-action-dispatch-completion-matrix
```

The post-action dispatch completion matrix writes
`post-action-dispatch-completion-matrix-latest.json` and
`post-action-dispatch-completion-matrix-latest.md` from synthetic local
fixtures. It proves all 20 dispatch envelopes can close through dispatch
receipt, proof, transition, ledger, bundle, archive, replay-guard evidence, and
the upstream dispatch envelope matrix hash while tampered receipts, missing
proof/transition evidence, raw bundles, and missing-transition bundles stay
blocked.

Run:

```bash
npm run runtime:post-action-reconciliation-matrix
```

The post-action reconciliation matrix writes
`post-action-reconciliation-matrix-latest.json` and
`post-action-reconciliation-matrix-latest.md` from synthetic local fixtures. It
proves all 20 dispatch completion records reconcile against the aggregate audit
archive, per-route archives, audit bundles, ledgers, and dispatch inbox hash
chain while missing aggregate entries, tampered bundle hashes, missing dispatch
chains, and per-route archive drift stay blocked. The report hash also binds the
upstream post-action dispatch completion matrix hash.

Run:

```bash
npm run runtime:post-action-runtime-status
```

The post-action runtime status report writes
`post-action-runtime-status-latest.json` and
`post-action-runtime-status-latest.md` from the existing local runtime and
post-action matrix latest reports. It proves all nine runtime/post-action stages
are passing, all 20 ready routes are complete, ready runner locations are 20
external and 0 internal, upstream hash continuity reaches reconciliation, and
the packageRole, customer-message preview-hash, and human-feedback contract
summary metrics remain bound through runtime, coverage, evidence, audit,
replay, dispatch, completion, and reconciliation. Runtime status now requires
all required summary metrics, including packageRole 20/20 and human-feedback
customer-facing packageRole 4/4, before checkpoint can pass. Each stage hash is read only from
its semantic hash key; generic `hash` cannot substitute for stripped stage
aliases.

Run:

```bash
npm run runtime:channel-runner-coverage-matrix
```

The channel runner coverage matrix writes
`channel-runner-coverage-matrix-latest.json` and
`channel-runner-coverage-matrix-latest.md` from local code/package-script
inspection plus synthetic runtime handoffs. It keeps the runtime-ready route
surface honest by classifying implemented live entrypoints, guarded
provider/model spend routes, prepare-only routes, preview-only message routes,
and audit-only live entrypoints without dispatching a runner or touching any
platform.

Run:

```bash
npm run runtime:human-feedback-identity-normalization-matrix
```

The human-feedback identity normalization matrix writes
`human-feedback-identity-normalization-matrix-latest.json` and
`human-feedback-identity-normalization-matrix-latest.md` from synthetic local
fixtures. It proves customer/consumer feedback aliases normalize across
manifest, preview, receipt, proof, transition, ledger, bundle, archive, replay,
outbox, dispatch assignment, dispatch readiness, and inbox surfaces while
preserving human-feedback contract hashes and only requiring message-preview
hashes for customer-message actions.

Run:

```bash
npm run reports:artifact-reproducibility
```

The artifact reproducibility command writes
`report-artifact-reproducibility-latest.{json,md}` from local latest reports,
integration gate summary hashes, architecture checkpoint bindings, and synthetic
drift scenarios. It proves volatile metadata/output path noise does not affect
reproducible artifact digests while semantic changes alter the digest and
synthetic binding drift fails closed.

Run:

```bash
npm run reports:self-reference-boundary-regression
```

The self-reference boundary regression command writes
`report-self-reference-boundary-regression-latest.{json,md}` from local source
inspection and synthetic stale-hash fixtures. It proves mid-gate report guards
may observe stale gate/checkpoint bindings without failing, required-binding
fixtures still fail closed, and final `reports:freshness` owns live gate summary
hash drift.

Run:

```bash
npm run reports:contract-manifest
```

The contract manifest command writes
`report-contract-manifest-latest.{json,md}` from the single exporter contract
manifest and runner source inspection. It proves the runner contract regression
imports the manifest instead of keeping a parallel list, and that required
contract ids, latest report ids, hash fields, and gate step ids stay unique.

Run:

```bash
npm run reports:contract-required-coverage-regression
```

The contract required coverage regression command writes
`report-contract-required-coverage-regression-latest.{json,md}` from the central
manifest source. It proves every manifest contract is required by default unless
it has an explicit non-empty optional reason, and that the required/optional
coverage exports stay available to downstream guards.

Run:

```bash
npm run reports:contract-doc-coverage-regression
```

The contract doc coverage regression command writes
`report-contract-doc-coverage-regression-latest.{json,md}` from the central
manifest, docs tree, main README, and reports README. It proves every manifest
contract has a docs file, README command entry, README docs link, and latest
report listing before manifest drift is allowed to pass.

Run:

```bash
npm run reports:contract-syntax-coverage-regression
```

The contract syntax coverage regression command writes
`report-contract-syntax-coverage-regression-latest.{json,md}` from the central
manifest, source tree, and integration gate source. It proves every manifest
contract has source and exporter syntax checks before the report export step.

Run:

```bash
npm run reports:contract-source-derivation-regression
```

The contract source derivation regression command writes
`report-contract-source-derivation-regression-latest.{json,md}` from the central
manifest, source/docs trees, and doc override map. It proves every manifest
contract derives its source/exporter/docs/report/script/hash fields from the
contract id before summary-key coverage is allowed to pass.

Run:

```bash
npm run reports:contract-summary-key-regression
```

The contract summary key regression command writes
`report-contract-summary-key-regression-latest.{json,md}` from the central
manifest and local gate/checkpoint/audit/selftest/selftest-lanes sources. It
proves every manifest contract has the downstream summary, hash, and scenario
keys needed for closeout evidence and ledger sections before manifest drift is
allowed to pass.

Run:

```bash
npm run reports:contract-audit-forwarding-regression
```

The contract audit forwarding regression command writes
`report-contract-audit-forwarding-regression-latest.{json,md}` from the central
manifest and integration audit source. It proves every manifest contract's child
blockers are forwarded into integration audit root blockers before manifest
drift is allowed to pass.

Run:

```bash
npm run reports:contract-checkpoint-binding-shape-regression
```

The contract checkpoint binding shape regression command writes
`report-contract-checkpoint-binding-shape-regression-latest.{json,md}` from the
central manifest and architecture checkpoint source. It proves every manifest
contract has a required checkpoint binding, primary hash extractor, summary
hash/scenario/blocker fields, and markdown hash line before manifest drift is
allowed to pass.

Run:

```bash
npm run reports:contract-gate-summary-shape-regression
```

The contract gate summary shape regression command writes
`report-contract-gate-summary-shape-regression-latest.{json,md}` from the
central manifest and strict gate source. It proves every manifest contract has
canonical gate summary ok/hash extraction and markdown ok/hash rendering before
manifest drift is allowed to pass.

Run:

```bash
npm run reports:contract-exporter-stdout-shape-regression
```

The contract exporter stdout shape regression command writes
`report-contract-exporter-stdout-shape-regression-latest.{json,md}` from the
central manifest and exporter sources. It proves every manifest exporter prints
canonical ok/status/hash/summary/blocker/reportFiles fields and fails strict
runs when the underlying report is blocked before manifest drift is allowed to
pass.

Run:

```bash
npm run reports:contract-safety-flag-regression
```

The contract safety flag regression command writes
`report-contract-safety-flag-regression-latest.{json,md}` from the central
manifest and latest report files. It proves every manifest latest report exposes
canonical local-only/read-only flags plus explicit false flags for report
mutation, browser automation, provider spend, external submission, messaging,
payment, acceptance, deployment, channel-state fetching, local state transitions,
and execution permission before manifest drift is allowed to pass.

Run:

```bash
npm run reports:contract-artifact-binding-regression
```

The contract artifact binding regression command writes
`report-contract-artifact-binding-regression-latest.{json,md}` from the central
manifest, latest report files, reports README, freshness inventory, tooling
inventory, schema contract, output pairing, and artifact reproducibility expected
sets. It proves every manifest latest artifact is cross-report bound, with
self-cycle skips made explicit before manifest drift is allowed to pass.

Run:

```bash
npm run reports:contract-doc-index-anchor-regression
```

The contract doc index anchor regression command writes
`report-contract-doc-index-anchor-regression-latest.{json,md}` from the central
manifest, docs tree, main README, and reports README. It proves every manifest
contract keeps a canonical docs H1 anchor, executable docs command, README
command/docs/latest entries, and reports README command/latest entries before
manifest drift is allowed to pass.

Run:

```bash
npm run reports:contract-doc-page-latest-detail-regression
```

The contract doc page latest detail regression command writes
`report-contract-doc-page-latest-detail-regression-latest.json` and
`report-contract-doc-page-latest-detail-regression-latest.md` from the central
manifest and docs tree. It proves every manifest contract's own docs page
explicitly names both latest output files with qualified `reports/` paths before
manifest drift is allowed to pass.

Run:

```bash
npm run reports:contract-doc-page-command-section-regression
```

The contract doc page command section regression command writes
`report-contract-doc-page-command-section-regression-latest.json` and
`report-contract-doc-page-command-section-regression-latest.md` from the central
manifest and docs tree. It proves every manifest contract's own docs page keeps
the canonical command, latest output, strict-gate, and safety sentences in order
before manifest drift is allowed to pass.

Run:

```bash
npm run reports:contract-doc-page-safety-section-detail-regression
```

The contract doc page safety section detail regression command writes
`report-contract-doc-page-safety-section-detail-regression-latest.json` and
`report-contract-doc-page-safety-section-detail-regression-latest.md` from the
central manifest and docs tree. It proves every manifest contract's own docs page
keeps native local, report-file, external-action, and execution-permission safety
boundaries before manifest drift is allowed to pass.

Run:

```bash
npm run reports:contract-doc-page-strict-gate-section-regression
```

The contract doc page strict gate section regression command writes
`report-contract-doc-page-strict-gate-section-regression-latest.json` and
`report-contract-doc-page-strict-gate-section-regression-latest.md` from the
central manifest and docs tree. It proves every manifest contract's own docs page
keeps native strict-gate command, cross-report participation, final closeout
probe, and post-gate writer recovery details before manifest drift is allowed to
pass.

Run:

```bash
npm run reports:contract-doc-page-output-section-regression
```

The contract doc page output section regression command writes
`report-contract-doc-page-output-section-regression-latest.json` and
`report-contract-doc-page-output-section-regression-latest.md` from the central
manifest and docs tree. It proves every manifest contract's own docs page keeps
native latest JSON/Markdown output paths, README/reports README binding, and
cross-report visibility before manifest drift is allowed to pass.

Run:

```bash
npm run reports:contract-doc-page-cross-report-section-regression
```

The contract doc page cross-report section regression command writes
`report-contract-doc-page-cross-report-section-regression-latest.json` and
`report-contract-doc-page-cross-report-section-regression-latest.md` from the
central manifest and docs tree. It proves every manifest contract's own docs
page keeps native cross-report visibility bindings for freshness, tooling,
schema, output pairing, artifact reproducibility, audit, selftest,
selftest-lanes, and architecture checkpoint before manifest drift is allowed to
pass.

Run:

```bash
npm run reports:contract-doc-page-closeout-section-regression
```

The contract doc page closeout section regression command writes
`report-contract-doc-page-closeout-section-regression-latest.json` and
`report-contract-doc-page-closeout-section-regression-latest.md` from the
central manifest and docs tree. It proves every manifest contract's own docs
page keeps native closeout probes for final freshness, architecture checkpoint,
bootstrap seed clean, active seed, docs placeholder, and diff-check before
manifest drift is allowed to pass.

Run:

```bash
npm run reports:contract-doc-page-post-gate-writer-section-regression
```

The contract doc page post-gate writer section regression command writes
`report-contract-doc-page-post-gate-writer-section-regression-latest.json` and
`report-contract-doc-page-post-gate-writer-section-regression-latest.md` from
the central manifest and docs tree. It proves every manifest contract's own
docs page keeps native post-gate writer recovery bindings for blocked latest
writers, drift proof, classification, inventory, recovery command order, and
zero-seed recovery before manifest drift is allowed to pass.

Run:

```bash
npm run reports:contract-doc-page-retention-section-regression
```

The contract doc page retention section regression command writes
`report-contract-doc-page-retention-section-regression-latest.json` and
`report-contract-doc-page-retention-section-regression-latest.md` from the
central manifest and docs tree. It proves every manifest contract's own docs
page keeps native retention/prune bindings for retention dry-run, latest
artifact retention, archived-zero expectation, report-retention latest,
retention-regression, and retention safety before manifest drift is allowed to
pass.

Run:

```bash
npm run reports:contract-doc-page-freshness-hash-section-regression
```

The contract doc page freshness hash section regression command writes
`report-contract-doc-page-freshness-hash-section-regression-latest.json` and
`report-contract-doc-page-freshness-hash-section-regression-latest.md` from the
central manifest and docs tree. It proves every manifest contract's own docs
page keeps native freshness/hash bindings for gate hash parity,
comparable-gate counts, missing-hash blockers, gate report inclusion, recovery
ordering, and freshness/hash safety before manifest drift is allowed to pass.

Run:

```bash
npm run reports:contract-doc-page-checkpoint-hash-section-regression
```

The contract doc page checkpoint hash section regression command writes
`report-contract-doc-page-checkpoint-hash-section-regression-latest.json` and
`report-contract-doc-page-checkpoint-hash-section-regression-latest.md` from the
central manifest and docs tree. It proves every manifest contract's own docs
page keeps native checkpoint/hash bindings for checkpoint hash exposure,
checkpoint scenario counts, checkpoint blocker visibility, checkpoint extractor
coverage, checkpoint markdown output, and checkpoint/hash safety before manifest
drift is allowed to pass.

Run:

```bash
npm run reports:contract-doc-page-bootstrap-seed-section-regression
```

The contract doc page bootstrap seed section regression command writes
`report-contract-doc-page-bootstrap-seed-section-regression-latest.json` and
`report-contract-doc-page-bootstrap-seed-section-regression-latest.md` from the
central manifest and docs tree. It proves every manifest contract's own docs
page keeps native bootstrap seed bindings for allowed seed files,
self-reference break conditions, final clean seed probes, active seed marker
scans, recovery evidence reports, and local-only no-grant safety before manifest
drift is allowed to pass.

Run:

```bash
npm run reports:contract-doc-page-clean-rerun-section-regression
```

The contract doc page clean rerun section regression command writes
`report-contract-doc-page-clean-rerun-section-regression-latest.json` and
`report-contract-doc-page-clean-rerun-section-regression-latest.md` from the
central manifest and docs tree. It proves every manifest contract's own docs
page keeps native clean rerun bindings for repeated clean strict gate runs,
zero seed writes, stable gate hashes, tracked idempotent reports,
post-recovery closeout order, and local-only no-grant safety before manifest
drift is allowed to pass.

Run:

```bash
npm run reports:contract-doc-page-final-settlement-section-regression
```

The contract doc page final settlement section regression command writes
`report-contract-doc-page-final-settlement-section-regression-latest.json` and
`report-contract-doc-page-final-settlement-section-regression-latest.md` from
the central manifest and docs tree. It proves every manifest contract's own
docs page keeps native final settlement bindings for final strict gate,
retention dry-run, freshness, checkpoint, seed-clean, and local-only no-grant
safety before manifest drift is allowed to pass.

Run:

```bash
npm run reports:contract-doc-page-closeout-index-section-regression
```

The contract doc page closeout index section regression command writes
`report-contract-doc-page-closeout-index-section-regression-latest.json` and
`report-contract-doc-page-closeout-index-section-regression-latest.md` from
the central manifest and docs tree. It proves every manifest contract's own
docs page keeps native closeout index bindings for strict gate, retention,
freshness/checkpoint, seed-clean, active seed scan, placeholder scan,
diff-check, and local-only no-grant safety before manifest drift is allowed to
pass.

Run:

```bash
npm run reports:contract-doc-page-closeout-evidence-section-regression
```

The contract doc page closeout evidence section regression command writes
`report-contract-doc-page-closeout-evidence-section-regression-latest.json` and
`report-contract-doc-page-closeout-evidence-section-regression-latest.md` from
the central manifest and docs tree. It proves every manifest contract's own
docs page keeps native closeout evidence bindings for exact closeout index,
strict gate hash, freshness hash, checkpoint hash, retention, seed-clean,
diff-check, and local-only no-grant latest artifacts before manifest drift is
allowed to pass.

Run:

```bash
npm run reports:contract-doc-page-closeout-ledger-section-regression
```

The contract doc page closeout ledger section regression command writes
`report-contract-doc-page-closeout-ledger-section-regression-latest.json` and
`report-contract-doc-page-closeout-ledger-section-regression-latest.md` from
the central manifest and docs tree. It proves every manifest contract's own
docs page keeps native closeout ledger bindings for command order, evidence
hashes, pass/fail owners, recovery invalidation, retention proof, and local-only
no-grant safety before manifest drift is allowed to pass.

```bash
npm run reports:contract-doc-page-closeout-retention-proof-section-regression
```

The contract doc page closeout retention proof section regression command
writes `report-contract-doc-page-closeout-retention-proof-section-regression-latest.json`
and `report-contract-doc-page-closeout-retention-proof-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page keeps native retention dry-run, latest artifact protection,
seed-clean, active seed scan, placeholder-scan, diff-check, and no
archive/delete/write grant proof before manifest drift is allowed to pass.

```bash
npm run reports:contract-doc-page-closeout-probe-bundle-section-regression
```

The contract doc page closeout probe bundle section regression command writes
`report-contract-doc-page-closeout-probe-bundle-section-regression-latest.json`
and `report-contract-doc-page-closeout-probe-bundle-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page keeps one compact final closeout probe bundle for retention,
freshness, checkpoint, seed-clean, active-seed scan, placeholder scan,
diff-check, and no-grant fields before manifest drift is allowed to pass.

```bash
npm run reports:contract-doc-page-closeout-signoff-section-regression
```

The contract doc page closeout signoff section regression command writes
`report-contract-doc-page-closeout-signoff-section-regression-latest.json`
and `report-contract-doc-page-closeout-signoff-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page keeps final local-only closeout signoff bindings for the probe
bundle artifacts, strict gate hash, freshness hash, checkpoint hash,
seed-clean decision, final scans, and no-grant boundary before manifest drift
is allowed to pass.

```bash
npm run reports:contract-doc-page-closeout-release-manifest-section-regression
```

The contract doc page closeout release manifest section regression command writes
`report-contract-doc-page-closeout-release-manifest-section-regression-latest.json`
and `report-contract-doc-page-closeout-release-manifest-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page keeps final release-manifest readiness bindings for upstream
signoff artifacts, strict gate, freshness, checkpoint, seed-clean, final
probes, and local-only no-grant release boundary before manifest drift is
allowed to pass.

```bash
npm run reports:contract-doc-page-release-archive-index-section-regression
```

The contract doc page release archive index section regression command writes
`report-contract-doc-page-release-archive-index-section-regression-latest.json`
and `report-contract-doc-page-release-archive-index-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page keeps final release archive index bindings for release-manifest
artifacts, strict gate, freshness, checkpoint, retention dry-run, seed-clean
probe, and local-only no-grant archive boundary before manifest drift is
allowed to pass.

```bash
npm run reports:contract-doc-page-release-handoff-ledger-section-regression
```

The contract doc page release handoff ledger section regression command writes
`report-contract-doc-page-release-handoff-ledger-section-regression-latest.json`
and `report-contract-doc-page-release-handoff-ledger-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page keeps final release handoff ledger bindings for release archive
index artifacts, strict gate, freshness, checkpoint, retention dry-run,
seed-clean probe, and local-only no-grant handoff boundary before manifest
drift is allowed to pass.

```bash
npm run reports:contract-doc-page-release-delivery-readiness-section-regression
```

The contract doc page release delivery readiness section regression command
writes
`report-contract-doc-page-release-delivery-readiness-section-regression-latest.json`
and `report-contract-doc-page-release-delivery-readiness-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page keeps final release delivery readiness bindings for release
handoff ledger artifacts, strict gate, freshness, checkpoint, retention
dry-run, seed-clean probe, and local-only no-grant delivery boundary before
manifest drift is allowed to pass.

```bash
npm run reports:contract-doc-page-release-execution-denial-section-regression
```

The contract doc page release execution denial section regression command
writes
`report-contract-doc-page-release-execution-denial-section-regression-latest.json`
and `report-contract-doc-page-release-execution-denial-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page separates final release delivery readiness from archive, delete,
upload, submit, IM, acceptance, payment, deployment, provider/model spend,
browser live action, channel-state fetch, local state transition, runner
dispatch, and execution permission before manifest drift is allowed to pass.

```bash
npm run reports:contract-doc-page-release-operator-approval-section-regression
```

The contract doc page release operator approval section regression command
writes
`report-contract-doc-page-release-operator-approval-section-regression-latest.json`
and `report-contract-doc-page-release-operator-approval-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page requires a separate current-chat human/operator approval naming
the exact target and action before any external action can be queued,
dispatched, uploaded, submitted, messaged, accepted, paid, deployed, or
otherwise performed.

```bash
npm run reports:contract-doc-page-release-approval-ledger-section-regression
```

The contract doc page release approval ledger section regression command
writes
`report-contract-doc-page-release-approval-ledger-section-regression-latest.json`
and `report-contract-doc-page-release-approval-ledger-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page binds operator approvals into an append-only auditable ledger
with approver identity, target, action, channel, artifacts, hashes, freshness,
expiry, and revocation boundaries before manifest drift is allowed to pass.

```bash
npm run reports:contract-doc-page-release-action-queue-section-regression
```

The contract doc page release action queue section regression command writes
`report-contract-doc-page-release-action-queue-section-regression-latest.json`
and `report-contract-doc-page-release-action-queue-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page can create only a local review queue record from approval-ledger
evidence while preserving replay-denial, readyForExecution=false, and no runner
dispatch or external execution permission.

```bash
npm run reports:contract-doc-page-release-runner-dispatch-denial-section-regression
```

The contract doc page release runner dispatch denial section regression command
writes
`report-contract-doc-page-release-runner-dispatch-denial-section-regression-latest.json`
and
`report-contract-doc-page-release-runner-dispatch-denial-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page keeps local queued-action evidence non-dispatchable without fresh
current-chat execution approval and matching artifact, replay, and platform-state
evidence.

```bash
npm run reports:contract-doc-page-release-live-action-preflight-section-regression
```

The contract doc page release live action preflight section regression command
writes
`report-contract-doc-page-release-live-action-preflight-section-regression-latest.json`
and
`report-contract-doc-page-release-live-action-preflight-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page requires separate read-only live-action preflight evidence before
any future execution consideration while still denying runner dispatch,
browser/API writes, upload, submit, IM, acceptance, payment, deployment,
provider/model spend, local state transition, and execution permission.

```bash
npm run reports:contract-doc-page-release-execution-intent-capture-section-regression
```

The contract doc page release execution intent capture section regression command
writes
`report-contract-doc-page-release-execution-intent-capture-section-regression-latest.json`
and
`report-contract-doc-page-release-execution-intent-capture-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page separates read-only preflight evidence from fresh current-chat
execution intent while still denying runner dispatch, browser/API writes,
upload, submit, IM, acceptance, payment, deployment, provider/model spend,
local state transition, approval, and execution permission.

```bash
npm run reports:contract-doc-page-release-execution-approval-boundary-section-regression
```

The contract doc page release execution approval boundary section regression
command writes
`report-contract-doc-page-release-execution-approval-boundary-section-regression-latest.json`
and
`report-contract-doc-page-release-execution-approval-boundary-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page separates current-chat execution intent from explicit execution
approval while still denying runner dispatch, browser/API writes, upload,
submit, IM, acceptance, payment, deployment, provider/model spend, local state
transition, and execution permission until a later lifecycle gate verifies
approval, artifact, replay, platform-state, receipt, and audit evidence.

```bash
npm run reports:contract-doc-page-release-runner-execution-gate-section-regression
```

The contract doc page release runner execution gate section regression command
writes
`report-contract-doc-page-release-runner-execution-gate-section-regression-latest.json`
and
`report-contract-doc-page-release-runner-execution-gate-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page binds explicit approval boundary evidence into a separate runner
lifecycle pre-dispatch gate while still denying runner dispatch, browser/API
writes, upload, submit, IM, acceptance, payment, deployment, provider/model
spend, local state transition, and execution permission until a later dispatch
implementation gate verifies platform-state, dry-run replay, post-action
receipt, proof bundle, ledger, and audit evidence.

```bash
npm run reports:contract-doc-page-release-dispatch-implementation-denial-section-regression
```

The contract doc page release dispatch implementation denial section regression
command writes
`report-contract-doc-page-release-dispatch-implementation-denial-section-regression-latest.json`
and
`report-contract-doc-page-release-dispatch-implementation-denial-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page keeps runner execution gate evidence non-dispatching: no runner
dispatch, browser/API write, click, POST, upload, submit, IM, acceptance,
payment, deployment, provider/model spend, local state transition, queue
consumption, background runner action, or external action can be implemented
or replayed from this docs guard.

```bash
npm run reports:contract-doc-page-release-platform-state-snapshot-denial-section-regression
```

The contract doc page release platform-state snapshot denial section regression
command writes
`report-contract-doc-page-release-platform-state-snapshot-denial-section-regression-latest.json`
and
`report-contract-doc-page-release-platform-state-snapshot-denial-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page treats platform-state snapshots as read-only observation evidence only.

```bash
npm run reports:contract-doc-page-release-dry-run-replay-denial-section-regression
```

The contract doc page release dry-run replay denial section regression command
writes
`report-contract-doc-page-release-dry-run-replay-denial-section-regression-latest.json`
and
`report-contract-doc-page-release-dry-run-replay-denial-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page treats dry-run replay evidence as simulation-only evidence that
cannot trigger live replay, browser/API write, click, POST, upload, submit, IM,
acceptance, payment, deployment, provider/model spend, local state transition,
or execution permission.

```bash
npm run reports:contract-doc-page-release-proof-bundle-denial-section-regression
```

The contract doc page release proof-bundle denial section regression command
writes
`report-contract-doc-page-release-proof-bundle-denial-section-regression-latest.json`
and
`report-contract-doc-page-release-proof-bundle-denial-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page treats proof-bundle evidence as evidence-only and unable to trigger
proof-bundle execution, live replay, browser/API write, click, POST, upload,
submit, IM, acceptance, payment, deployment, provider/model spend, local state
transition, or execution permission.

```bash
npm run reports:contract-doc-page-release-ledger-denial-section-regression
```

The contract doc page release ledger denial section regression command writes
`report-contract-doc-page-release-ledger-denial-section-regression-latest.json`
and
`report-contract-doc-page-release-ledger-denial-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page treats ledger evidence as evidence-only and unable to trigger
ledger mutation, proof-bundle execution, live replay, browser/API write, click,
POST, upload, submit, IM, acceptance, payment, deployment, provider/model
spend, local state transition, or execution permission.

```bash
npm run reports:contract-doc-page-release-audit-evidence-denial-section-regression
```

The contract doc page release audit-evidence denial section regression command writes
`report-contract-doc-page-release-audit-evidence-denial-section-regression-latest.json`
and
`report-contract-doc-page-release-audit-evidence-denial-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page treats audit evidence as evidence-only and unable to trigger audit
write, ledger mutation, proof-bundle execution, live replay, browser/API write,
click, POST, upload, submit, IM, acceptance, payment, deployment,
provider/model spend, local state transition, or execution permission.

```bash
npm run reports:contract-doc-page-release-receipt-evidence-denial-section-regression
```

The contract doc page release receipt-evidence denial section regression command
writes
`report-contract-doc-page-release-receipt-evidence-denial-section-regression-latest.json`
and
`report-contract-doc-page-release-receipt-evidence-denial-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page treats receipt evidence as evidence-only and unable to trigger
receipt write, receipt append, receipt mutation, receipt replay, audit write,
ledger mutation, proof-bundle execution, live replay, browser/API write, click,
POST, upload, submit, IM, acceptance, payment, deployment, provider/model
spend, local state transition, or execution permission.

Run:

```bash
npm run reports:contract-doc-page-release-post-action-receipt-denial-section-regression
```

The contract doc page release post-action receipt denial section regression
command writes
`report-contract-doc-page-release-post-action-receipt-denial-section-regression-latest.json`
and
`report-contract-doc-page-release-post-action-receipt-denial-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page treats post-action receipt evidence as evidence-only and unable to
trigger post-action receipt write, receipt write, audit write, ledger mutation,
proof-bundle execution, live replay, browser/API write, click, POST, upload,
submit, IM, acceptance, payment, deployment, provider/model spend, local state
transition, or execution permission.

Run:

```bash
npm run reports:contract-doc-page-release-post-action-queue-consumption-denial-section-regression
```

The contract doc page release post-action queue consumption denial section
regression command writes
`report-contract-doc-page-release-post-action-queue-consumption-denial-section-regression-latest.json`
and
`report-contract-doc-page-release-post-action-queue-consumption-denial-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page treats post-action queue consumption evidence as evidence-only and
unable to consume, dequeue, ack, dispatch a background runner, apply local state
transitions, perform provider/model spend, perform deployment/payment/
acceptance writes, or grant execution permission.

Run:

```bash
npm run reports:contract-doc-page-release-post-action-background-runner-denial-section-regression
```

The contract doc page release post-action background runner denial section
regression command writes
`report-contract-doc-page-release-post-action-background-runner-denial-section-regression-latest.json`
and
`report-contract-doc-page-release-post-action-background-runner-denial-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page treats post-action background runner evidence as evidence-only and
unable to run/start/dispatch a background runner, claim/lease a runner job,
consume/dequeue/ack a queue item, apply local state transitions, perform
provider/model spend, perform deployment/payment/acceptance writes, or grant
execution permission.

Run:

```bash
npm run reports:contract-doc-page-release-post-action-dispatch-completion-denial-section-regression
```

The contract doc page release post-action dispatch completion denial section
regression command writes
`report-contract-doc-page-release-post-action-dispatch-completion-denial-section-regression-latest.json`
and
`report-contract-doc-page-release-post-action-dispatch-completion-denial-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page treats post-action dispatch completion evidence as evidence-only
and unable to complete/finish/acknowledge/commit dispatch completion, run or
dispatch a background runner, claim/lease a runner job, consume/dequeue/ack a
queue item, apply local state transitions, perform provider/model spend,
perform deployment/payment/acceptance writes, or grant execution permission.

Run:

```bash
npm run reports:contract-doc-page-release-post-action-audit-denial-section-regression
```

The contract doc page release post-action audit denial section regression
command writes
`report-contract-doc-page-release-post-action-audit-denial-section-regression-latest.json`
and
`report-contract-doc-page-release-post-action-audit-denial-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page treats post-action audit evidence as evidence-only and unable to
trigger post-action audit write, post-action receipt write, receipt write, audit
write, ledger mutation, proof-bundle execution, live replay, browser/API write,
click, POST, upload, submit, IM, acceptance, payment, deployment,
provider/model spend, local state transition, or execution permission.

Run:

```bash
npm run reports:contract-doc-page-release-post-action-reconciliation-denial-section-regression
```

The contract doc page release post-action reconciliation denial section
regression command writes
`report-contract-doc-page-release-post-action-reconciliation-denial-section-regression-latest.json`
and
`report-contract-doc-page-release-post-action-reconciliation-denial-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page treats post-action reconciliation evidence as evidence-only and
unable to trigger post-action reconciliation write, post-action audit write,
post-action receipt write, receipt write, audit write, ledger mutation,
proof-bundle execution, live replay, browser/API write, click, POST, upload,
submit, IM, acceptance, payment, deployment, provider/model spend, local state
transition, or execution permission.

Run:

```bash
npm run reports:contract-doc-page-release-post-action-settlement-denial-section-regression
```

The contract doc page release post-action settlement denial section regression
command writes
`report-contract-doc-page-release-post-action-settlement-denial-section-regression-latest.json`
and
`report-contract-doc-page-release-post-action-settlement-denial-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page treats post-action settlement evidence as evidence-only and
unable to trigger post-action settlement write, post-action reconciliation
write, post-action audit write, post-action receipt write, receipt write, audit
write, ledger mutation, proof-bundle execution, live replay, browser/API write,
click, POST, upload, submit, IM, acceptance, payment, deployment,
provider/model spend, local state transition, or execution permission.

Run:

```bash
npm run reports:contract-doc-page-release-post-action-acceptance-denial-section-regression
```

The contract doc page release post-action acceptance denial section regression
command writes
`report-contract-doc-page-release-post-action-acceptance-denial-section-regression-latest.json`
and
`report-contract-doc-page-release-post-action-acceptance-denial-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page treats post-action acceptance evidence as evidence-only and
unable to trigger post-action acceptance write, post-action settlement write,
post-action reconciliation write, post-action audit write, post-action receipt
write, receipt write, audit write, ledger mutation, proof-bundle execution,
live replay, browser/API write, click, POST, upload, submit, IM, acceptance,
payment, deployment, provider/model spend, local state transition, or execution
permission.

Run:

```bash
npm run reports:contract-doc-page-release-post-action-payment-denial-section-regression
```

The contract doc page release post-action payment denial section regression
command writes
`report-contract-doc-page-release-post-action-payment-denial-section-regression-latest.json`
and
`report-contract-doc-page-release-post-action-payment-denial-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page treats post-action payment evidence as evidence-only and unable
to trigger post-action payment write, post-action acceptance write,
post-action settlement write, post-action reconciliation write,
post-action audit write, post-action receipt write, receipt write, audit
write, ledger mutation, proof-bundle execution, live replay, browser/API write,
click, POST, upload, submit, IM, acceptance, payment, deployment,
provider/model spend, local state transition, or execution permission.

Run:

```bash
npm run reports:contract-doc-page-release-post-action-deployment-denial-section-regression
```

The contract doc page release post-action deployment denial section regression
command writes
`report-contract-doc-page-release-post-action-deployment-denial-section-regression-latest.json`
and
`report-contract-doc-page-release-post-action-deployment-denial-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page treats post-action deployment evidence as evidence-only and
unable to trigger post-action deployment write, post-action payment write,
post-action acceptance write, post-action settlement write,
post-action reconciliation write, post-action audit write,
post-action receipt write, receipt write, audit write, ledger mutation,
proof-bundle execution, live replay, browser/API write, click, POST, upload,
submit, IM, acceptance, payment, deployment, provider/model spend, local state
transition, or execution permission.

Run:

```bash
npm run reports:contract-doc-page-release-post-action-provider-spend-denial-section-regression
```

The contract doc page release post-action provider spend denial section
regression command writes
`report-contract-doc-page-release-post-action-provider-spend-denial-section-regression-latest.json`
and
`report-contract-doc-page-release-post-action-provider-spend-denial-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page treats post-action provider/model spend evidence as evidence-only
and unable to trigger post-action provider/model spend write, post-action
deployment write, post-action payment write, post-action acceptance write,
post-action settlement write, post-action reconciliation write,
post-action audit write, post-action receipt write, receipt write, audit write,
ledger mutation, proof-bundle execution, live replay, browser/API write, click,
POST, upload, submit, IM, acceptance, payment, deployment, local state
transition, or execution permission.

Run:

```bash
npm run reports:contract-doc-page-release-post-action-state-transition-denial-section-regression
```

The contract doc page release post-action state transition denial section
regression command writes
`report-contract-doc-page-release-post-action-state-transition-denial-section-regression-latest.json`
and
`report-contract-doc-page-release-post-action-state-transition-denial-section-regression-latest.md`
from the central manifest and docs tree. It proves every manifest contract's
own docs page treats post-action local state transition evidence as
evidence-only and unable to trigger post-action local state transition write,
post-action provider/model spend write, post-action deployment write,
post-action payment write, post-action acceptance write, post-action settlement
write, post-action reconciliation write, post-action audit write,
post-action receipt write, receipt write, audit write, ledger mutation,
proof-bundle execution, live replay, browser/API write, click, POST, upload,
submit, IM, acceptance, payment, deployment, provider/model spend, local state
transition, or execution permission.

Run:

```bash
npm run reports:manifest-drift-regression
```

The manifest drift regression command writes
`report-manifest-drift-regression-latest.{json,md}` from the central manifest,
local package scripts, integration gate source, freshness inventory, tooling
report ids, architecture checkpoint bindings, and exporter sources. It proves
new or edited manifest contracts cannot silently drift away from downstream
runner/gate/freshness/checkpoint wiring.

Run:

```bash
npm run reports:latest-recovery-regression
```

The latest recovery regression command writes
`report-latest-recovery-regression-latest.{json,md}` from synthetic latest
report fixtures. It proves the real contamination recovery path: blocked audit,
tooling, freshness, schema, and gate latest reports fail schema/freshness/tooling
closed, local bootstrap seeds restore those checks, and final freshness passes
only when the gate summary hashes match the recovered reports. Bootstrap
recovery treats semantic `reportHash` / `gateHash` style aliases as required;
generic `hash` cannot substitute for stripped aliases.

Run:

```bash
npm run reports:bootstrap-seed-regression
```

The bootstrap seed regression command writes
`report-bootstrap-seed-regression-latest.{json,md}` from synthetic latest
report recovery fixtures. It proves temporary bootstrap seeds stay allowlisted,
explicitly marked, hash-bearing, and local-only; final reports overwrite the
seeds without retaining bootstrap markers; and the gate summary binds only to
final report hashes. Seed/final report identity must come from semantic
`reportHash` / `gateHash` style aliases; generic `hash` cannot substitute for
stripped aliases. The actual `reports:bootstrap-seeds` clean-skip writer uses
the same semantic-only hash binding.

Run:

```bash
npm run reports:gate-clean-rerun-regression
```

The gate clean rerun regression command writes
`report-gate-clean-rerun-regression-latest.{json,md}` from synthetic
two-cycle gate fixtures and integration gate source inspection. It proves dirty
latest recovery writes the five allowlisted seeds, a clean rerun skips all five,
final reports do not retain seed markers or hashes, and the final gate summary
binds only to clean report hashes. Clean rerun seed/final comparisons require
semantic report hash aliases; generic `hash` cannot substitute for stripped
aliases.

Run:

```bash
npm run reports:clean-gate-idempotence-regression
```

The clean gate idempotence regression command writes
`report-clean-gate-idempotence-regression-latest.{json,md}` from synthetic
two-run clean gate fixtures and integration gate source inspection. It proves
stable report hashes survive a repeated clean gate run, seed decisions stay
skipped, gate summary hashes remain bound to final latest reports, and the guard
runs after clean rerun validation but before runner contract validation.

Run:

```bash
npm run reports:final-settlement-regression
```

The final settlement regression command writes
`report-final-settlement-regression-latest.{json,md}` from synthetic final
closeout fixtures and integration gate source inspection. It proves final gate,
retention dry-run, final freshness, architecture checkpoint, and clean bootstrap
seed checks run in a stable order; mapped report writes after the final gate
fail closed unless the final gate/freshness/checkpoint settlement is refreshed,
the checkpoint must still prove post-action runtime required metrics, including
packageRole 20/20 and human-feedback customer-facing packageRole 4/4 coverage, the
checkpoint must still prove read-only dispatch handoff metrics from archive
closeout, and the terminal `release-final-settlement-latest.{json,md}` report
binding is covered by hash/status/reportFiles/write-integrity fixtures.
The live settlement wrapper itself writes
`release-final-settlement-latest.{json,md}` after `npm run release:final-settlement`;
that terminal report records the actual step results and proves any remaining
dirty worktree paths are limited to `reports/README.md` and formal
`reports/*-latest.{json,md}` outputs, then reads the JSON/Markdown pair back to
record a passing `writeIntegrity` proof.

Run:

```bash
npm run reports:post-final-drift-regression
```

The post-final drift regression command writes
`report-post-final-drift-regression-latest.{json,md}` from synthetic post-final
drift fixtures and integration gate source inspection. It proves audit,
tooling, selftest lanes, and output pairing latest refreshes after final
closeout are blocked by freshness/checkpoint until clean gate, final freshness,
checkpoint, and strict zero-seed closeout are rerun.

Run:

```bash
npm run reports:closeout-drift-classification-regression
```

The closeout drift classification regression command writes
`report-closeout-drift-classification-regression-latest.{json,md}` from
synthetic command-class fixtures and local source/docs inspection. It keeps
closeout commands classified as required clean closeout steps, blocked
gate-bound latest writers, allowed non-gate-bound writers, or read-only probes.

Run:

```bash
npm run reports:closeout-command-inventory-regression
```

The closeout command inventory regression command writes
`report-closeout-command-inventory-regression-latest.{json,md}` from synthetic
inventory fixtures and local package/source/docs inspection. It proves package
scripts, integration gate steps, docs, and exported classification constants
cover every closeout-related command before runner contract validation.

Run:

```bash
npm run reports:bootstrap-seeds
```

The bootstrap seed command conditionally writes temporary seed JSON/Markdown
pairs only for the five allowlisted cycle-breaker latest reports: audit,
tooling, freshness, schema, and gate. It skips clean pass reports, writes seeds
only for missing/not-ok/seeded files, and stays a local recovery entrypoint
rather than a standalone report contract. The normal gate/report exporters must
overwrite any seeds in the same run.

Run:

```bash
npm run reports:runner-contract-regression
```

The runner contract regression command writes
`report-runner-contract-regression-latest.{json,md}` from local package
scripts, integration gate source, freshness inventory, and exporter source
inspection. It proves each report exporter runs strict in package scripts and
gate steps, exposes parseable JSON stdout with hash and reportFiles pointers,
and stays bound by gate summary and freshness inventory indexes.

Run:

```bash
npm run reports:retention-regression
```

The regression command writes
`report-retention-regression-latest.{json,md}` from synthetic file inventories.
It proves timestamped reports are archive candidates while `*-latest.{json,md}`
and `README.md` stay protected, without moving or deleting real report files.

Current latest JSON reports include:

- `agent-decision-node-audit-latest.json`
- `architecture-checkpoint-latest.json`
- `channel-import-allowlist-latest.json`
- `compatibility-export-policy-latest.json`
- `contract-schemas-latest.json`
- `human-feedback-identity-normalization-matrix-latest.json`
- `integration-dependency-audit-latest.json`
- `integration-dependency-gate-latest.json`
- `integration-gate-sequence-regression-latest.json`
- `integration-gate-tooling-latest.json`
- `package-root-import-migration-latest.json`
- `package-root-import-regression-latest.json`
- `package-root-resolver-latest.json`
- `package-root-symbol-manifest-latest.json`
- `package-root-symbol-minimization-latest.json`
- `package-root-symbol-regression-latest.json`
- `package-surface-latest.json`
- `read-only-closeout-latest.json`
- `read-only-core-gate-latest.json`
- `read-only-release-archive-closeout-latest.json`
- `read-only-release-archive-latest.json`
- `read-only-release-health-latest.json`
- `read-only-release-verification-latest.json`
- `read-only-report-chain-latest.json`
- `read-only-samples-latest.json`
- `report-freshness-latest.json`
- `report-freshness-regression-latest.json`
- `report-artifact-reproducibility-latest.json`
- `report-contract-manifest-latest.json`
- `report-contract-required-coverage-regression-latest.json`
- `report-contract-doc-coverage-regression-latest.json`
- `report-contract-syntax-coverage-regression-latest.json`
- `report-contract-source-derivation-regression-latest.json`
- `report-contract-summary-key-regression-latest.json`
- `report-contract-audit-forwarding-regression-latest.json`
- `report-contract-checkpoint-binding-shape-regression-latest.json`
- `report-contract-gate-summary-shape-regression-latest.json`
- `report-contract-exporter-stdout-shape-regression-latest.json`
- `report-contract-safety-flag-regression-latest.json`
- `report-contract-artifact-binding-regression-latest.json`
- `report-contract-doc-index-anchor-regression-latest.json`
- `report-contract-doc-page-latest-detail-regression-latest.json`
- `report-contract-doc-page-command-section-regression-latest.json`
- `report-contract-doc-page-safety-section-detail-regression-latest.json`
- `report-contract-doc-page-strict-gate-section-regression-latest.json`
- `report-contract-doc-page-output-section-regression-latest.json`
- `report-contract-doc-page-cross-report-section-regression-latest.json`
- `report-contract-doc-page-closeout-section-regression-latest.json`
- `report-contract-doc-page-post-gate-writer-section-regression-latest.json`
- `report-contract-doc-page-retention-section-regression-latest.json`
- `report-contract-doc-page-freshness-hash-section-regression-latest.json`
- `report-contract-doc-page-checkpoint-hash-section-regression-latest.json`
- `report-contract-doc-page-bootstrap-seed-section-regression-latest.json`
- `report-contract-doc-page-clean-rerun-section-regression-latest.json`
- `report-contract-doc-page-final-settlement-section-regression-latest.json`
- `report-contract-doc-page-closeout-index-section-regression-latest.json`
- `report-contract-doc-page-closeout-evidence-section-regression-latest.json`
- `report-contract-doc-page-closeout-ledger-section-regression-latest.json`
- `report-contract-doc-page-closeout-retention-proof-section-regression-latest.json`
- `report-contract-doc-page-closeout-probe-bundle-section-regression-latest.json`
- `report-contract-doc-page-closeout-signoff-section-regression-latest.json`
- `report-contract-doc-page-closeout-release-manifest-section-regression-latest.json`
- `report-contract-doc-page-release-archive-index-section-regression-latest.json`
- `report-contract-doc-page-release-handoff-ledger-section-regression-latest.json`
- `report-contract-doc-page-release-delivery-readiness-section-regression-latest.json`
- `report-contract-doc-page-release-execution-denial-section-regression-latest.json`
- `report-contract-doc-page-release-operator-approval-section-regression-latest.json`
- `report-contract-doc-page-release-approval-ledger-section-regression-latest.json`
- `report-contract-doc-page-release-action-queue-section-regression-latest.json`
- `report-contract-doc-page-release-runner-dispatch-denial-section-regression-latest.json`
- `report-contract-doc-page-release-live-action-preflight-section-regression-latest.json`
- `report-contract-doc-page-release-execution-intent-capture-section-regression-latest.json`
- `report-contract-doc-page-release-execution-approval-boundary-section-regression-latest.json`
- `report-contract-doc-page-release-runner-execution-gate-section-regression-latest.json`
- `report-contract-doc-page-release-dispatch-implementation-denial-section-regression-latest.json`
- `report-contract-doc-page-release-platform-state-snapshot-denial-section-regression-latest.json`
- `report-contract-doc-page-release-dry-run-replay-denial-section-regression-latest.json`
- `report-contract-doc-page-release-proof-bundle-denial-section-regression-latest.json`
- `report-contract-doc-page-release-ledger-denial-section-regression-latest.json`
- `report-contract-doc-page-release-audit-evidence-denial-section-regression-latest.json`
- `report-contract-doc-page-release-receipt-evidence-denial-section-regression-latest.json`
- `report-contract-doc-page-release-post-action-receipt-denial-section-regression-latest.json`
- `report-contract-doc-page-release-post-action-audit-denial-section-regression-latest.json`
- `report-contract-doc-page-release-post-action-reconciliation-denial-section-regression-latest.json`
- `report-contract-doc-page-release-post-action-settlement-denial-section-regression-latest.json`
- `report-contract-doc-page-release-post-action-acceptance-denial-section-regression-latest.json`
- `report-contract-doc-page-release-post-action-payment-denial-section-regression-latest.json`
- `report-contract-doc-page-release-post-action-deployment-denial-section-regression-latest.json`
- `report-contract-doc-page-release-post-action-provider-spend-denial-section-regression-latest.json`
- `report-contract-doc-page-release-post-action-state-transition-denial-section-regression-latest.json`
- `report-contract-doc-page-release-post-action-queue-consumption-denial-section-regression-latest.json`
- `report-contract-doc-page-release-post-action-background-runner-denial-section-regression-latest.json`
- `report-contract-doc-page-release-post-action-dispatch-completion-denial-section-regression-latest.json`
- `report-hash-stability-regression-latest.json`
- `report-inventory-consistency-latest.json`
- `report-lineage-topology-latest.json`
- `report-latest-recovery-regression-latest.json`
- `report-bootstrap-seed-regression-latest.json`
- `report-gate-clean-rerun-regression-latest.json`
- `report-clean-gate-idempotence-regression-latest.json`
- `report-final-settlement-regression-latest.json`
- `release-final-settlement-latest.json`
- `report-post-final-drift-regression-latest.json`
- `report-closeout-drift-classification-regression-latest.json`
- `report-closeout-command-inventory-regression-latest.json`
- `report-manifest-drift-regression-latest.json`
- `report-output-pairing-latest.json`
- `report-runner-contract-regression-latest.json`
- `report-self-reference-boundary-regression-latest.json`
- `report-retention-latest.json`
- `report-retention-regression-latest.json`
- `report-schema-contract-latest.json`
- `selftest-lanes-latest.json`
