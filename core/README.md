# Design Production Core

`design-production-core` is the channel-neutral contract layer for the local design business.

It is not a replacement for `zbj-auto-intake`, `epwk-auto-intake`, or Hepta. It defines the shared language that those systems should speak so production logic does not get copied into each channel.

## Split

Business lines / channel adapters answer:

- Where did the task/order come from?
- What are the platform limits?
- What account gates, duplicate gates, upload limits, and submit APIs exist?
- What evidence is required before an external action?

Product lines / production workflows answer:

- What is the deliverable?
- How should the brief be understood?
- Which reference pack and industry route applies?
- What artifacts should be generated?
- What QA, review, and packaging gates must pass?

The control plane owns the shared gates:

- semantic intake and subject contract
- refpack and industry routing
- prompt compiler/readiness hash contracts
- generation and artifact manifests
- provider routing, spend guard, and model cache
- package review, final review, and referee evidence
- approval packet, fresh evidence, and policy profile
- task lock, audit stream, and state transition
- channel-specific prepare/submit/fulfillment adapter

## Canonical Contract

The stable shape is:

```text
ChannelTask
  -> CreativeBrief
  -> ProductionPlanEnvelope
  -> ArtifactPackage
  -> ReviewReport
  -> ChannelSubmission
```

Existing systems can migrate gradually:

- ZBJ keeps its mature implementation and exports/adapts into this shape.
- EPWK stays a channel adapter and reuses product workflows instead of duplicating generation and QA.
- Hepta website owns order UX and delivery UX, then calls the same product workflows.

## Current Status

This package is the local contract, runtime-proof, and gate control plane for
ZBJ, EPWK, and Hepta production workflows. It still has no provider calls, no
browser automation, no upload logic, no submit logic, and no platform
credentials.

It includes read-only mapping adapters and channel/runtime contracts for:

- ZBJ task-like objects -> `ChannelTask`
- EPWK radar/detail task-like objects -> `ChannelTask`
- Hepta order-like objects -> `ChannelTask`

`refpack-outcome-scoring` is the shared local outcome-learning scorer for
design reference packages. It turns normalized reference-pack metadata and
case-ledger buckets into score rows, pattern evidence, recommendations, and a
stable report hash without reading channel stores or granting execution
permission.

`prompt-artifact-compiler` is the shared local prompt compiler surface. It
compiles channel-neutral prompt artifacts from subject, route strategy,
industry, design-reference grammar, outcome learning, and retrieval evidence.
It is a pure function layer: no provider/model calls, browser/platform opens,
uploads, submits, messages, acceptance, payment, deployment, channel-state
fetches, state transitions, or execution permission.

`prompt-readiness-gate` is the shared local readiness and prompt-set strategy
gate. It validates compiled prompt artifacts, stale compiler hashes, structured
route strategy presence, route/proof/differentiation diversity, application
proof, and local-only safety flags before a channel may request provider
generation. It remains control-plane proof only and grants no execution
permission.

`prompt-production:contract-gate` is the core-side prompt production boundary.
It validates a sibling planner's `PromptCompilerReport` and
`PromptReadinessReport`, including
`promptCompilerHash`, `readinessHash`, refpack/retrieval bindings, per-artifact
compiler hashes, required prompt sections, prompt-set strategy status, and
local-only safety flags. Outputs are
`reports/prompt-production-contract-gate-latest.json` and
`reports/prompt-production-contract-gate-latest.md`.

`generation-contracts` is the shared local generation manifest contract. It
builds generation job descriptors, artifact requests, QA records, attachment
guards, and plan/manifest sync checks for prompt compiler hashes, route strategy
hashes, prompt readiness, route contracts, submit limits, industry, and
refpacks. It remains descriptor-only: no provider/model call, browser/platform
open, upload, submit, message, acceptance, payment, deployment, channel-state
fetch, state mutation, or execution permission.

`route-contracts` is the shared local delivery-route contract. It normalizes
semantic/workflow route intent into image-set, single-PDF, or text-form
delivery shapes; binds the route into a plan; and validates that the route still
fits observed live-submit limits. It is local contract proof only and grants no
execution permission.

`semantic-visual-model-policy` is the shared local model-selection policy for
semantic visual reviewers. It requires an explicit model, blocks known
disallowed semantic visual model routes by default, and returns package-review
blockers without calling providers/models or granting execution permission.

`next-action-advisor` is the shared local operator advice contract. It turns a
hard gate and blocker into a command id bank, local repair intent, prompt-only
model-advisor context, and model-advice validation that rejects unknown commands
and submit/live actions. Channel packages own the actual command templates and
any model/provider call wrapper; core remains local advice only and grants no
execution permission.

`policy-profiles` is the shared local policy matrix for provider spend,
semantic reviewer spend, local import, live-page reads, prepare uploads, real
submits, and external notifications. It preserves the canonical `safe-plan`,
`spend-allowed`, `prepare-allowed`, and `submit-allowed` profiles as
control-plane checks only: no provider/model calls, browser/platform reads,
uploads, submits, messages, acceptance, payment, deployment, state mutation, or
execution permission.

`src/channel-adapter-interface.mjs` is the shared adapter contract above those
normalizers. It aligns ZBJ, EPWK, and Hepta around one descriptor for task
normalization, supported adapter actions, runner boundaries, read-only probes,
and redacted source policy. Runner locations must point to external sibling
workspaces, not back into `design-production-core`. See
`docs/channel-adapter-interface.md`.

`runtime:dry-run-harness` is the local runtime closure probe. It builds
synthetic ready fixtures for every ZBJ / EPWK / Hepta adapter route through
approval/fresh evidence, execution gate, state transition, action manifest,
adapter preview, pending ledger, outbox, replay guard, dispatch envelope,
runner registry/selection, assignment, readiness report, and adapter-runner SDK
contract. It also runs negative scenarios for an accidental core execute flag,
missing replay guard, unsupported runner route, and core-local runner location.
Ready handoffs expose `runnerLocationExternalWorkspace`, and the report summary
counts external/internal runner locations so top-level health checks do not need
to reparse runner paths.
The harness writes
`reports/runtime-dry-run-harness-latest.json` and
`reports/runtime-dry-run-harness-latest.md`; it never spawns a runner, opens a
browser/API session, uploads, submits, messages, accepts, pays, deploys, calls a
provider/model, fetches channel state, mutates lifecycle state, or grants
execution permission.

`runtime:post-action-evidence-matrix` continues from that dry-run handoff
surface and builds synthetic post-action receipts plus read-only channel state
proofs for all 20 ready adapter routes. It proves the action-specific SDK
receipt/proof fields can produce accepted receipts and verified proofs while
preserving the original runtime handoff identity and manifest/preview/approval/
evidence hashes. Missing or tampered fields fail closed. Outputs are
`reports/post-action-evidence-matrix-latest.json` and
`reports/post-action-evidence-matrix-latest.md`; the matrix is also synthetic
and never performs external work.

`runtime:post-action-audit-bundle-matrix` continues one layer further. It builds
synthetic receipt/proof/transition inbox chains, verified external-action
ledgers, and verified audit bundles for the same 20 ready routes. It also proves
raw ledgers and ledgers missing transition-inbox evidence cannot become final
audit bundles. Outputs are
`reports/post-action-audit-bundle-matrix-latest.json` and
`reports/post-action-audit-bundle-matrix-latest.md`.

`runtime:post-action-audit-archive-matrix` closes the next archive/index layer.
It archives the 20 verified audit bundles into synthetic per-route and aggregate
`ExternalActionAuditArchive` records while proving duplicate bundle/ledger
hashes, tampered bundle hashes, raw bundles, missing transition evidence, and
empty archives fail closed. Outputs are
`reports/post-action-audit-archive-matrix-latest.json` and
`reports/post-action-audit-archive-matrix-latest.md`.

`runtime:post-action-replay-guard-matrix` checks the archive-backed replay
boundary for the same 20 routes. It proves new candidates stay clear, archived
task/action repeats block without explicit approval, repeat-approved candidates
clear only when customer-message `messagePreviewHash` and human-feedback
`humanFeedbackRevisionContractHash` repeat scope matches, exact bundle/ledger
replay remains blocked even with repeat approval, and blocked archives cannot
clear a candidate. Outputs are
`reports/post-action-replay-guard-matrix-latest.json` and
`reports/post-action-replay-guard-matrix-latest.md`.

`runtime:post-action-dispatch-envelope-matrix` checks the post-replay dispatch
handoff boundary for the same 20 routes. It proves repeat-approved replay guard
decisions can produce ready `AdapterDispatchEnvelope` records while replay
conflicts, candidate mismatches, tampered outbox hashes, and missing replay
guards fail closed; customer-message envelopes keep `messagePreviewHash` and
human-feedback envelopes keep `humanFeedbackRevisionContractHash` in the
replay candidate and runner hash binding. It binds the upstream post-action
audit archive matrix hash plus replay guard matrix hash in its own report hash.
Outputs are
`reports/post-action-dispatch-envelope-matrix-latest.json` and
`reports/post-action-dispatch-envelope-matrix-latest.md`.

`runtime:post-action-dispatch-completion-matrix` checks the dispatch completion
evidence chain for the same 20 routes. It proves dispatch receipts, dispatch
receipt/proof/transition inboxes, final ledgers, audit bundles, audit archives,
archived replay guards, and the upstream dispatch envelope matrix hash all close
through the dispatch-specific inbox chain, while tampered dispatch receipts,
missing proof, missing transition evidence, raw bundles, and missing-transition
bundles fail closed. Outputs are
`reports/post-action-dispatch-completion-matrix-latest.json` and
`reports/post-action-dispatch-completion-matrix-latest.md`.

`runtime:post-action-reconciliation-matrix` checks the local reconciliation layer
after dispatch completion. It proves the dispatch completion aggregate archive,
per-route archives, audit bundles, ledgers, dispatch inbox hashes, and upstream
completion matrix hash all reconcile for the same 20 routes, while missing
aggregate entries, tampered bundle hashes, missing dispatch chains, and
per-route archive drift fail closed. Outputs are
`reports/post-action-reconciliation-matrix-latest.json` and
`reports/post-action-reconciliation-matrix-latest.md`.

`runtime:post-action-runtime-status` writes the stable top-level runtime status
report behind `external-action-lifecycle`. It consumes the existing runtime and
post-action matrix reports, verifies each stage is passing, checks the 20-route
/ 7-action-class closure, requires 20 external and 0 internal ready runner
locations, and validates upstream matrix hash continuity through reconciliation.
It also promotes required summary metrics for customer-message preview-hash and
human-feedback contract coverage so the top-level status fails closed if
those semantic bindings regress while downstream reports still look complete.
Outputs are `reports/post-action-runtime-status-latest.json` and
`reports/post-action-runtime-status-latest.md`. It never performs external work.

`runtime:channel-runner-coverage-matrix` cross-checks the 20 runtime-ready
adapter routes against locally audited channel runner entrypoints. It classifies
routes as implemented live entrypoints, guarded provider/model spend, prepare
only, or preview-only customer messaging. EPWK modify/bid/customer-message
routes are represented in the runtime adapter matrix and lifecycle-enforced by
the coverage report. Outputs are
`reports/channel-runner-coverage-matrix-latest.json` and
`reports/channel-runner-coverage-matrix-latest.md`.

`src/channel-production-pipeline.mjs` is the shared production-chain contract
for all three channels:
`ChannelTask -> CreativeBrief -> ProductionPlanEnvelope -> ArtifactPackage ->
ReviewReport -> ChannelSubmission -> AdapterRunReceipt -> ChannelStateProof`.
It records channel differences such as ZBJ duplicate/captcha gates, EPWK
prepare-only/account gates, and Hepta deployment proof without making one
channel inherit another channel's platform details. Its runner locations follow
the same external workspace boundary. See
`docs/channel-production-pipeline.md`.

Run:

```bash
npm run selftest
```

Run the strict local integration gate after architecture changes:

```bash
npm run gate:integration:strict
```

The gate syntax-checks the lifecycle schema/facade, contract schema/exporter,
compatibility export policy/exporter, integration gate tooling/exporter,
channel import allowlist/exporter, package-root resolver/exporter,
package-root import migration/exporter, package-root import regression exporter,
package-root symbol manifest/exporter, package-root symbol regression exporter,
package-root symbol minimization/exporter, read-only report chain/exporter,
report freshness/exporter, report freshness regression/exporter,
integration gate sequence regression/exporter, report inventory consistency
exporter, report schema contract/exporter, report lineage topology/exporter,
report hash stability regression/exporter, report output pairing/exporter,
report artifact reproducibility/exporter, report self-reference boundary
regression/exporter, report contract manifest/exporter, report contract
required coverage regression/exporter, report contract doc coverage
regression/exporter, report contract syntax coverage regression/exporter,
report contract source derivation regression/exporter, report contract summary
key regression/exporter, report contract audit forwarding regression/exporter,
report contract checkpoint binding shape regression/exporter, report contract
gate summary shape regression/exporter, report contract exporter stdout shape
regression/exporter, report contract safety flag regression/exporter, report manifest drift
regression/exporter, report latest recovery regression/exporter, report bootstrap seed
regression/exporter, report gate clean rerun regression/exporter, report clean
gate idempotence regression/exporter, report final settlement
regression/exporter, report runner contract regression/exporter, report
retention prune command, report retention
regression/exporter, public API, selftest lane reporter, architecture
checkpoint exporter, and integration audit. It then exports
contract schemas, exports the compatibility policy, exports the read-only report
chain, exports the package surface smoke report, exports the channel import
allowlist, exports the package-root resolver report, exports the package-root
import migration plan, exports the package-root import regression fixture,
exports the package-root symbol manifest, exports the package-root symbol
regression fixture, exports the package-root symbol minimization report, exports
the report freshness regression fixture, exports the report retention regression
fixture, exports the integration gate sequence regression fixture, exports the
report inventory consistency fixture, exports the report schema contract, exports
the report lineage topology guard, exports the report hash stability regression,
exports the report output pairing guard, exports the report artifact
reproducibility guard, exports the report self-reference boundary regression
guard, exports the report contract manifest guard, exports the report contract
required coverage regression guard, exports the report contract doc coverage
regression guard, exports the report contract syntax coverage regression guard,
exports the report contract source derivation regression guard, exports the
report contract summary key regression guard, exports the report contract audit
forwarding regression guard, exports the report contract checkpoint binding
shape regression guard, exports the report contract gate summary shape
regression guard, exports the report contract exporter stdout shape regression
guard, exports the report contract safety flag regression guard, exports the report manifest drift regression guard, exports
the report latest recovery regression guard, exports the report
bootstrap seed regression guard, exports the report gate clean rerun regression
guard, exports the report clean gate idempotence guard,
exports the report final settlement guard, exports the report runner contract regression guard,
exports the report freshness guard before tooling metadata, the
integration gate tooling report, runs selftest, runs the selftest lane report,
runs strict integration audit, and refreshes child report freshness again. The
package surface
smoke test verifies the package root import and blocked deep `src/` import by
Node; the channel import allowlist verifies ZBJ/EPWK/Hepta cannot add package
deep imports, internal core imports, compatibility imports, or stable modules
outside their explicit channel allowlist, writing
`reports/integration-dependency-gate-latest.{json,md}`.

Summarize selftest by architecture lane:

```bash
npm run selftest:lanes
```

The lane report writes `reports/selftest-lanes-latest.{json,md}` so failures in
the large selftest output are grouped by contract, planning, lifecycle,
dispatch, and read-only release areas.

Write a current architecture checkpoint:

```bash
npm run checkpoint:architecture
```

The checkpoint binds public API counts, selftest lanes, contract schema hash,
compatibility export policy, package surface, channel import allowlist,
package-root resolver, package-root migration, package-root regression,
package-root symbol manifest, package-root symbol regression, package-root
symbol minimization, integration gate tooling, read-only report chain, strict
report freshness, report freshness regression, integration gate sequence
regression, report inventory consistency, report schema contract, report lineage
topology, report hash stability regression, report output pairing, report
artifact reproducibility, report self-reference boundary regression, report
contract manifest, report contract required coverage regression, report contract
doc coverage regression, report contract syntax coverage regression, report
contract source derivation regression, report contract summary key regression,
report contract audit forwarding regression, report contract checkpoint binding
shape regression, report contract gate summary shape regression, report manifest
drift regression, report latest recovery regression, report bootstrap seed regression,
report gate clean rerun regression,
report clean gate idempotence regression, report final settlement
regression, report runner contract regression, report retention regression,
integration audit, integration gate, report retention,
and channel import status into
`reports/architecture-checkpoint-latest.{json,md}`. The checkpoint summary also
surfaces the post-action runtime status required summary metric pass count, so
customer-message preview-hash and human-feedback contract drift coverage stay
visible at the final architecture index.

Audit the current architecture workflow chain:

```bash
npm run audit:architecture-workflow
```

The architecture workflow audit writes
`reports/architecture-workflow-audit-latest.{json,md}`. It checks the
ChannelTask -> product-line decision -> workflow registry -> plan-only ->
design-reference -> prompt artifact compiler -> prompt readiness gate ->
prompt production contract -> generation contracts -> route contracts ->
semantic visual model policy -> approval/evidence -> policy profiles ->
execution gate -> state transition -> action manifest -> next-action advisor ->
adapter handoff -> runner registry -> receipt/proof inbox -> post-action runtime
chain, binds the agent decision-node audit, design-reference taxonomy sync gate,
prompt readiness selftest, prompt production contract gate, generation contracts
selftest, route contracts selftest, semantic visual model policy selftest, and
next-action advisor selftest, and proves that text-only product routing fails
closed while explicit/agent semantic routes still plan correctly. It also
verifies that channel pipeline and outbox contracts remain descriptor-only and
do not grant execution permission.

Export the versioned public contract JSON Schema snapshot:

```bash
npm run schema:contracts
```

The exporter writes `reports/contract-schemas-latest.{json,md}` and keeps the
contract enum/schema snapshot hashable for fixtures, docs, and channel
validators. The snapshot also includes the adapter runner SDK contract schemas
so external-runner phases, required evidence kinds, hash bindings, and current
chat approval boundaries are gate-visible. See `docs/contract-json-schema.md`.

Export the compatibility export policy:

```bash
npm run compatibility:policy
```

The exporter writes `reports/compatibility-export-policy-latest.{json,md}` and
keeps every legacy root export tied to a replacement surface, channel-runtime
rule, removal phase, and a freeze cap that prevents new compatibility exports
from being added casually. See `docs/public-api.md`.

Export the integration gate tooling metadata:

```bash
npm run integration:tooling
```

The exporter writes `reports/integration-gate-tooling-latest.{json,md}` and
keeps `integration-dependency-audit.mjs` as a CLI-only/internal gate tool rather
than a root compatibility export. It also checks that package-name imports land
on the stable root surface and that no `./src/*` package subpaths are exposed.
See `docs/integration-gate-tooling.md`.

Export the package surface smoke report:

```bash
npm run package:surface
```

The exporter writes `reports/package-surface-latest.{json,md}` and verifies
that `import('design-production-core')` reaches the stable root while
`design-production-core/src/index.mjs` is blocked by the package export map.

Export the channel import allowlist:

```bash
npm run channel:imports
```

The exporter writes `reports/channel-import-allowlist-latest.{json,md}` and
checks ZBJ, EPWK, and Hepta runtime imports against explicit per-channel module
allowlists. Package root imports are the only expected channel surface after
the rewrite. Package deep `design-production-core/src/*` imports, sibling
relative `design-production-core/src/*.mjs` imports, relative imports to
internal/compatibility modules, and unlisted stable module imports fail the gate.
See `docs/channel-import-allowlist.md`.

Export the package-root resolver smoke report:

```bash
npm run package-root:resolver
```

The exporter writes `reports/package-root-resolver-latest.{json,md}` and checks
that the local workspace package link lets ZBJ, EPWK, and Hepta runtime roots
resolve `import('design-production-core')` while deep `src/` package imports
remain blocked. See `docs/package-root-resolver.md`.

Export the package-root import migration plan:

```bash
npm run package-root:migration
```

The exporter writes `reports/package-root-import-migration-latest.{json,md}` and
proves the real channel tree has zero remaining sibling relative imports and
zero file plans after the package-root rewrite. It does not edit channel files. See
`docs/package-root-import-migration.md`.

Export the package-root import regression fixture:

```bash
npm run package-root:regression
```

The exporter writes `reports/package-root-import-regression-latest.{json,md}`.
It runs a synthetic bad fixture and passes only when sibling relative
`design-production-core/src/*.mjs` imports are blocked by the allowlist and the
package-root migration report. It also scans Markdown import examples so docs
cannot teach channel consumers to import core source files after the package-root
rewrite.

Export the package-root symbol manifest:

```bash
npm run package-root:symbols
```

The exporter writes `reports/package-root-symbol-manifest-latest.{json,md}` and
checks that ZBJ, EPWK, and Hepta only use explicit per-channel allowed named
imports from `design-production-core`. It blocks package-root namespace/default
imports, unlisted symbols, and symbols missing from the package root. See
`docs/package-root-symbol-manifest.md`.

Export the package-root symbol regression fixture:

```bash
npm run package-root:symbol-regression
```

The exporter writes `reports/package-root-symbol-regression-latest.{json,md}`.
It runs a synthetic bad fixture and passes only when namespace imports, default
imports, unlisted symbols, and missing package-root exports are rejected by the
symbol manifest.

Export the package-root symbol minimization report:

```bash
npm run package-root:symbol-minimize
```

The exporter writes `reports/package-root-symbol-minimization-latest.{json,md}`.
It compares each channel's allowed package-root named symbols with the real
currently imported symbols, then emits an exact-current proposal and unused
allowance list without editing channel files or shrinking the manifest. See
`docs/package-root-symbol-minimization.md`.

Export the read-only report chain:

```bash
npm run readonly:report-chain
```

The exporter writes `reports/read-only-report-chain-latest.{json,md}` and binds
the dashboard, closeout, release, verification, archive, and archive-closeout
modules into one stable read-only facade. See `docs/read-only-report-chain.md`.

Export the latest report freshness guard:

```bash
npm run reports:freshness
```

The exporter writes `reports/report-freshness-latest.{json,md}` and verifies
that required latest reports are present, ok, hashable, and, in final mode,
match the hashes recorded by the latest integration gate. See
`docs/report-freshness.md`.

Export the report freshness negative regression fixture:

```bash
npm run reports:freshness-regression
```

The exporter writes `reports/report-freshness-regression-latest.{json,md}` and
proves missing, not-ok, missing-hash, gate-hash drift, missing-gate, and
gate-file-hash drift cases still trigger the expected freshness blockers.

Export the integration gate sequence negative regression fixture:

```bash
npm run reports:gate-sequence-regression
```

The exporter writes
`reports/integration-gate-sequence-regression-latest.{json,md}` and proves the
child freshness, tooling metadata, selftest, audit, and skip-gate ordering
cannot drift silently. See `docs/integration-gate-sequence-regression.md`.

Export the report inventory consistency negative regression fixture:

```bash
npm run reports:inventory-consistency
```

The exporter writes `reports/report-inventory-consistency-latest.{json,md}` and
proves the freshness/tooling/checkpoint/gate-summary/script inventory cannot
drift silently. See `docs/report-inventory-consistency.md`.

Export the latest report schema contract:

```bash
npm run reports:schema-contract
```

The exporter writes `reports/report-schema-contract-latest.{json,md}` and
proves latest JSON reports keep stable kind, status, ok, generatedAt, hash,
safety, and blocker shape. See `docs/report-schema-contract.md`.

Export the report lineage topology negative regression fixture:

```bash
npm run reports:lineage-topology
```

The exporter writes `reports/report-lineage-topology-latest.{json,md}` and
proves latest-report DAG dependencies, required terminal nodes, gate steps,
package scripts, checkpoint bindings, and gate summary hash keys cannot drift
silently. See
`docs/report-lineage-topology.md`.

Export the report hash stability negative regression fixture:

```bash
npm run reports:hash-stability-regression
```

The exporter writes `reports/report-hash-stability-regression-latest.{json,md}`
and proves latest report hashes ignore volatile generatedAt/output path/key
order noise while still changing for semantic summary, blocker, and safety
changes. See `docs/report-hash-stability-regression.md`.

Export the report output pairing negative regression fixture:

```bash
npm run reports:output-pairing
```

The exporter writes `reports/report-output-pairing-latest.{json,md}` and proves
latest JSON reports have Markdown pairs, exact README entries, aligned
`reportFiles` pointers, and package/freshness index coverage. See
`docs/report-output-pairing.md`.

Export the report artifact reproducibility guard:

```bash
npm run reports:artifact-reproducibility
```

The exporter writes
`reports/report-artifact-reproducibility-latest.{json,md}` and proves latest
report artifact digests are stable across volatile metadata, output path, and
key-order noise while semantic report changes alter the digest and synthetic
gate/checkpoint hash binding drift fails closed. See
`docs/report-artifact-reproducibility.md`.

Export the report self-reference boundary regression guard:

```bash
npm run reports:self-reference-boundary-regression
```

The exporter writes
`reports/report-self-reference-boundary-regression-latest.{json,md}` and proves
mid-gate reports may observe stale gate/checkpoint bindings without failing,
required-binding fixtures still fail closed, and final `reports:freshness` owns
live gate summary hash drift. See
`docs/report-self-reference-boundary-regression.md`.

Export the report contract manifest guard:

```bash
npm run reports:contract-manifest
```

The exporter writes `reports/report-contract-manifest-latest.{json,md}` and
proves report exporter contracts are maintained in one manifest instead of a
parallel runner list. It also checks required contract ids, latest report ids,
stdout hash fields, gate summary hash keys, and gate step ids stay unique. See
`docs/report-contract-manifest.md`.

Export the report contract required coverage regression guard:

```bash
npm run reports:contract-required-coverage-regression
```

The exporter writes
`reports/report-contract-required-coverage-regression-latest.{json,md}` and
proves every manifest contract is required by default unless it has an explicit
non-empty optional reason. See
`docs/report-contract-required-coverage-regression.md`.

Export the report contract doc coverage regression guard:

```bash
npm run reports:contract-doc-coverage-regression
```

The exporter writes
`reports/report-contract-doc-coverage-regression-latest.{json,md}` and proves
every manifest contract has a docs file, a README command entry, a README docs
link, and a reports README latest-file listing. See
`docs/report-contract-doc-coverage-regression.md`.

Export the report contract syntax coverage regression guard:

```bash
npm run reports:contract-syntax-coverage-regression
```

The exporter writes
`reports/report-contract-syntax-coverage-regression-latest.{json,md}` and
proves every manifest contract has source and exporter syntax checks in the
integration gate, with source syntax before exporter syntax and exporter syntax
before each report export step. See
`docs/report-contract-syntax-coverage-regression.md`.

Export the report contract source derivation regression guard:

```bash
npm run reports:contract-source-derivation-regression
```

The exporter writes
`reports/report-contract-source-derivation-regression-latest.{json,md}` and
proves every manifest contract's source/exporter/docs/report/script/hash fields
derive from its `contractId` before summary-key coverage is allowed to pass. See
`docs/report-contract-source-derivation-regression.md`.

Export the report contract summary key regression guard:

```bash
npm run reports:contract-summary-key-regression
```

The exporter writes
`reports/report-contract-summary-key-regression-latest.{json,md}` and proves
every manifest contract is observable through integration gate, architecture
checkpoint, integration audit, selftest, and selftest-lanes summary/hash/scenario
keys before manifest drift is allowed to pass. See
`docs/report-contract-summary-key-regression.md`.

Export the report contract audit forwarding regression guard:

```bash
npm run reports:contract-audit-forwarding-regression
```

The exporter writes
`reports/report-contract-audit-forwarding-regression-latest.{json,md}` and
proves every manifest contract's child blockers are forwarded into integration
audit with the contract id prefix, child code, child notes, and
`design-production-core` owner before manifest drift is allowed to pass. See
`docs/report-contract-audit-forwarding-regression.md`.

Export the report contract checkpoint binding shape regression guard:

```bash
npm run reports:contract-checkpoint-binding-shape-regression
```

The exporter writes
`reports/report-contract-checkpoint-binding-shape-regression-latest.{json,md}`
and proves every manifest contract has a required architecture checkpoint
binding, primary hash extractor, summary hash/scenario/blocker fields, and
markdown hash line before manifest drift is allowed to pass. See
`docs/report-contract-checkpoint-binding-shape-regression.md`.

Export the report contract gate summary shape regression guard:

```bash
npm run reports:contract-gate-summary-shape-regression
```

The exporter writes
`reports/report-contract-gate-summary-shape-regression-latest.{json,md}` and
proves every manifest contract has canonical strict-gate ok/hash extraction and
markdown ok/hash rendering before manifest drift is allowed to pass. See
`docs/report-contract-gate-summary-shape-regression.md`.

Export the report contract exporter stdout shape regression guard:

```bash
npm run reports:contract-exporter-stdout-shape-regression
```

The exporter writes
`reports/report-contract-exporter-stdout-shape-regression-latest.{json,md}` and
proves every manifest exporter prints canonical strict-gate stdout fields for
ok, status, hash, summary, blocker codes, reportFiles, and strict failure
exits before manifest drift is allowed to pass. See
`docs/report-contract-exporter-stdout-shape-regression.md`.

Export the report contract safety flag regression guard:

```bash
npm run reports:contract-safety-flag-regression
```

The exporter writes
`reports/report-contract-safety-flag-regression-latest.{json,md}` and proves
every manifest latest report exposes canonical local-only/read-only safety flags
and explicit false flags for report mutation, browser automation, provider spend,
external submission, messaging, payment, acceptance, deployment, channel-state
fetching, local state transitions, and execution permission before manifest drift
is allowed to pass. See `docs/report-contract-safety-flag-regression.md`.

Export the report contract artifact binding regression guard:

```bash
npm run reports:contract-artifact-binding-regression
```

The exporter writes
`reports/report-contract-artifact-binding-regression-latest.{json,md}` and
proves every manifest latest JSON/Markdown artifact is visible to the reports
README, freshness inventory, tooling inventory, schema contract, output pairing,
and artifact reproducibility chain, with self-cycle skips made explicit before
manifest drift is allowed to pass. See
`docs/report-contract-artifact-binding-regression.md`.

Export the report contract doc index anchor regression guard:

```bash
npm run reports:contract-doc-index-anchor-regression
```

The exporter writes
`reports/report-contract-doc-index-anchor-regression-latest.{json,md}` and proves
every manifest contract keeps a canonical docs H1 anchor, executable docs command,
README command/docs/latest entries, and reports README command/latest entries
before manifest drift is allowed to pass. See
`docs/report-contract-doc-index-anchor-regression.md`.

Export the report contract doc page latest detail regression guard:

```bash
npm run reports:contract-doc-page-latest-detail-regression
```

The exporter writes
`reports/report-contract-doc-page-latest-detail-regression-latest.json` and
`reports/report-contract-doc-page-latest-detail-regression-latest.md` and proves
every manifest contract's own docs page explicitly names both latest output
files with qualified `reports/` paths before manifest drift is allowed to pass.
See `docs/report-contract-doc-page-latest-detail-regression.md`.

Export the report contract doc page command section regression guard:

```bash
npm run reports:contract-doc-page-command-section-regression
```

The exporter writes
`reports/report-contract-doc-page-command-section-regression-latest.json` and
`reports/report-contract-doc-page-command-section-regression-latest.md` and
proves every manifest contract's own docs page keeps the canonical command,
latest output, strict-gate, and safety sentences in order before manifest drift
is allowed to pass. See
`docs/report-contract-doc-page-command-section-regression.md`.

Export the report contract doc page safety section detail regression guard:

```bash
npm run reports:contract-doc-page-safety-section-detail-regression
```

The exporter writes
`reports/report-contract-doc-page-safety-section-detail-regression-latest.json`
and `reports/report-contract-doc-page-safety-section-detail-regression-latest.md`
and proves every manifest contract's own docs page keeps a native safety section
with local-only/read-only, report-file, no-external-action, and execution
permission boundaries before manifest drift is allowed to pass. See
`docs/report-contract-doc-page-safety-section-detail-regression.md`.

Export the report contract doc page strict gate section regression guard:

```bash
npm run reports:contract-doc-page-strict-gate-section-regression
```

The exporter writes
`reports/report-contract-doc-page-strict-gate-section-regression-latest.json`
and `reports/report-contract-doc-page-strict-gate-section-regression-latest.md`
and proves every manifest contract's own docs page keeps a native strict-gate
section with the gate command, cross-report participation, final closeout
probes, and post-gate writer recovery boundary before manifest drift is allowed
to pass. See `docs/report-contract-doc-page-strict-gate-section-regression.md`.

Export the report contract doc page output section regression guard:

```bash
npm run reports:contract-doc-page-output-section-regression
```

The exporter writes
`reports/report-contract-doc-page-output-section-regression-latest.json` and
`reports/report-contract-doc-page-output-section-regression-latest.md` and
proves every manifest contract's own docs page keeps a native output section
with latest JSON/Markdown artifact paths, README/reports README binding, and
cross-report visibility before manifest drift is allowed to pass. See
`docs/report-contract-doc-page-output-section-regression.md`.

Export the report contract doc page cross-report section regression guard:

```bash
npm run reports:contract-doc-page-cross-report-section-regression
```

The exporter writes
`reports/report-contract-doc-page-cross-report-section-regression-latest.json`
and
`reports/report-contract-doc-page-cross-report-section-regression-latest.md`
and proves every manifest contract's own docs page keeps a native cross-report
visibility section listing freshness, tooling, schema, output pairing, artifact
reproducibility, audit, selftest, selftest-lanes, and architecture checkpoint
bindings before manifest drift is allowed to pass. See
`docs/report-contract-doc-page-cross-report-section-regression.md`.

Export the report contract doc page closeout section regression guard:

```bash
npm run reports:contract-doc-page-closeout-section-regression
```

The exporter writes
`reports/report-contract-doc-page-closeout-section-regression-latest.json` and
`reports/report-contract-doc-page-closeout-section-regression-latest.md` and
proves every manifest contract's own docs page keeps a native closeout section
listing final freshness, architecture checkpoint, bootstrap seed clean,
active seed, docs placeholder, and diff-check probes before manifest drift is
allowed to pass. See
`docs/report-contract-doc-page-closeout-section-regression.md`.

Export the report contract doc page post-gate writer section regression guard:

```bash
npm run reports:contract-doc-page-post-gate-writer-section-regression
```

The exporter writes
`reports/report-contract-doc-page-post-gate-writer-section-regression-latest.json`
and
`reports/report-contract-doc-page-post-gate-writer-section-regression-latest.md`
and proves every manifest contract's own docs page keeps a native post-gate
writer section naming blocked latest writers, drift proof, classification,
inventory, recovery command order, and zero-seed recovery before manifest drift
is allowed to pass. See
`docs/report-contract-doc-page-post-gate-writer-section-regression.md`.

Export the report contract doc page retention section regression guard:

```bash
npm run reports:contract-doc-page-retention-section-regression
```

The exporter writes
`reports/report-contract-doc-page-retention-section-regression-latest.json`
and
`reports/report-contract-doc-page-retention-section-regression-latest.md`
and proves every manifest contract's own docs page keeps a native retention
section naming retention dry-run, latest artifact retention, archived-zero
expectation, report-retention latest, retention-regression, and retention
safety boundaries before manifest drift is allowed to pass. See
`docs/report-contract-doc-page-retention-section-regression.md`.

Export the report contract doc page freshness hash section regression guard:

```bash
npm run reports:contract-doc-page-freshness-hash-section-regression
```

The exporter writes
`reports/report-contract-doc-page-freshness-hash-section-regression-latest.json`
and
`reports/report-contract-doc-page-freshness-hash-section-regression-latest.md`
and proves every manifest contract's own docs page keeps a native freshness
hash section naming gate hash parity, comparable-gate counts, missing-hash
blockers, gate report inclusion, recovery ordering, and freshness/hash safety
boundaries before manifest drift is allowed to pass. See
`docs/report-contract-doc-page-freshness-hash-section-regression.md`.

Export the report contract doc page checkpoint hash section regression guard:

```bash
npm run reports:contract-doc-page-checkpoint-hash-section-regression
```

The exporter writes
`reports/report-contract-doc-page-checkpoint-hash-section-regression-latest.json`
and
`reports/report-contract-doc-page-checkpoint-hash-section-regression-latest.md`
and proves every manifest contract's own docs page keeps a native checkpoint
hash section naming checkpoint hash binding, checkpoint scenario binding,
checkpoint blocker binding, checkpoint extractor binding, checkpoint markdown
binding, and checkpoint/hash safety boundaries before manifest drift is allowed
to pass. See
`docs/report-contract-doc-page-checkpoint-hash-section-regression.md`.

Export the report contract doc page bootstrap seed section regression guard:

```bash
npm run reports:contract-doc-page-bootstrap-seed-section-regression
```

The exporter writes
`reports/report-contract-doc-page-bootstrap-seed-section-regression-latest.json`
and
`reports/report-contract-doc-page-bootstrap-seed-section-regression-latest.md`
and proves every manifest contract's own docs page keeps a native bootstrap
seed section naming allowed seed files, self-reference break conditions, final
clean seed probe, active seed marker scan, seed report evidence, and bootstrap
seed safety boundaries before manifest drift is allowed to pass. See
`docs/report-contract-doc-page-bootstrap-seed-section-regression.md`.

Export the report contract doc page clean rerun section regression guard:

```bash
npm run reports:contract-doc-page-clean-rerun-section-regression
```

The exporter writes
`reports/report-contract-doc-page-clean-rerun-section-regression-latest.json`
and
`reports/report-contract-doc-page-clean-rerun-section-regression-latest.md`
and proves every manifest contract's own docs page keeps a native clean rerun
section naming repeated clean strict gate runs, zero seed writes, stable gate
hashes, tracked idempotent reports, post-recovery closeout order, and clean
rerun safety boundaries before manifest drift is allowed to pass. See
`docs/report-contract-doc-page-clean-rerun-section-regression.md`.

Export the report contract doc page final settlement section regression guard:

```bash
npm run reports:contract-doc-page-final-settlement-section-regression
```

The exporter writes
`reports/report-contract-doc-page-final-settlement-section-regression-latest.json`
and
`reports/report-contract-doc-page-final-settlement-section-regression-latest.md`
and proves every manifest contract's own docs page keeps a native final
settlement section naming final strict gate, retention dry-run, freshness,
checkpoint, seed-clean, and local-only no-grant safety before manifest drift is
allowed to pass. See
`docs/report-contract-doc-page-final-settlement-section-regression.md`.

Export the report contract doc page closeout index section regression guard:

```bash
npm run reports:contract-doc-page-closeout-index-section-regression
```

The exporter writes
`reports/report-contract-doc-page-closeout-index-section-regression-latest.json`
and
`reports/report-contract-doc-page-closeout-index-section-regression-latest.md`
and proves every manifest contract's own docs page keeps a native closeout
index section naming strict gate, retention, freshness/checkpoint, seed-clean,
active seed scan, placeholder scan, diff-check, and local-only no-grant safety
before manifest drift is allowed to pass. See
`docs/report-contract-doc-page-closeout-index-section-regression.md`.

Export the report contract doc page closeout evidence section regression guard:

```bash
npm run reports:contract-doc-page-closeout-evidence-section-regression
```

The exporter writes
`reports/report-contract-doc-page-closeout-evidence-section-regression-latest.json`
and
`reports/report-contract-doc-page-closeout-evidence-section-regression-latest.md`
and proves every manifest contract's own docs page keeps a native closeout
evidence section naming the exact latest JSON/Markdown artifacts for closeout
index, strict gate hash, freshness hash, checkpoint hash, retention, seed-clean,
diff-check, and local-only no-grant safety before manifest drift is allowed to
pass. See
`docs/report-contract-doc-page-closeout-evidence-section-regression.md`.

Export the report contract doc page closeout ledger section regression guard:

```bash
npm run reports:contract-doc-page-closeout-ledger-section-regression
```

The exporter writes
`reports/report-contract-doc-page-closeout-ledger-section-regression-latest.json`
and
`reports/report-contract-doc-page-closeout-ledger-section-regression-latest.md`
and proves every manifest contract's own docs page keeps a native closeout
ledger section tying final closeout commands to local evidence hashes, owner
surfaces, recovery invalidation, retention proof, and no-grant safety before
manifest drift is allowed to pass. See
`docs/report-contract-doc-page-closeout-ledger-section-regression.md`.

Export the contract doc page closeout retention proof section regression guard:

```bash
npm run reports:contract-doc-page-closeout-retention-proof-section-regression
```

The exporter writes
`reports/report-contract-doc-page-closeout-retention-proof-section-regression-latest.json`
and
`reports/report-contract-doc-page-closeout-retention-proof-section-regression-latest.md`
and proves every manifest contract's own docs page keeps native retention
dry-run, latest artifact protection, seed-clean, active seed scan,
placeholder-scan, diff-check, and no archive/delete/write grant proof before
manifest drift is allowed to pass. See
`docs/report-contract-doc-page-closeout-retention-proof-section-regression.md`.

Export the contract doc page closeout probe bundle section regression guard:

```bash
npm run reports:contract-doc-page-closeout-probe-bundle-section-regression
```

The exporter writes
`reports/report-contract-doc-page-closeout-probe-bundle-section-regression-latest.json`
and
`reports/report-contract-doc-page-closeout-probe-bundle-section-regression-latest.md`
and proves every manifest contract's own docs page keeps one compact closeout
probe bundle for final retention, freshness, checkpoint, seed-clean,
active-seed scan, placeholder scan, diff-check, and no-grant fields before
manifest drift is allowed to pass. See
`docs/report-contract-doc-page-closeout-probe-bundle-section-regression.md`.

Export the contract doc page closeout signoff section regression guard:

```bash
npm run reports:contract-doc-page-closeout-signoff-section-regression
```

The exporter writes
`reports/report-contract-doc-page-closeout-signoff-section-regression-latest.json`
and
`reports/report-contract-doc-page-closeout-signoff-section-regression-latest.md`
and proves every manifest contract's own docs page keeps final local-only
closeout signoff bindings for the probe bundle artifacts, strict gate hash,
freshness hash, checkpoint hash, seed-clean decision, final scans, and no-grant
boundary before manifest drift is allowed to pass. See
`docs/report-contract-doc-page-closeout-signoff-section-regression.md`.

Export the contract doc page closeout release manifest section regression guard:

```bash
npm run reports:contract-doc-page-closeout-release-manifest-section-regression
```

The exporter writes
`reports/report-contract-doc-page-closeout-release-manifest-section-regression-latest.json`
and
`reports/report-contract-doc-page-closeout-release-manifest-section-regression-latest.md`
and proves every manifest contract's own docs page keeps final release-manifest
readiness bindings for the upstream signoff artifacts, strict gate, freshness,
checkpoint, seed-clean, final probes, and local-only no-grant release boundary
before manifest drift is allowed to pass. See
`docs/report-contract-doc-page-closeout-release-manifest-section-regression.md`.

Export the contract doc page release archive index section regression guard:

```bash
npm run reports:contract-doc-page-release-archive-index-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-archive-index-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-archive-index-section-regression-latest.md`
and proves every manifest contract's own docs page keeps final release archive
index bindings for the release-manifest artifacts, strict gate, freshness,
checkpoint, retention dry-run, seed-clean probe, and local-only no-grant
archive boundary before manifest drift is allowed to pass. See
`docs/report-contract-doc-page-release-archive-index-section-regression.md`.

Export the contract doc page release handoff ledger section regression guard:

```bash
npm run reports:contract-doc-page-release-handoff-ledger-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-handoff-ledger-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-handoff-ledger-section-regression-latest.md`
and proves every manifest contract's own docs page keeps final release handoff
ledger bindings for release archive index artifacts, strict gate, freshness,
checkpoint, retention dry-run, seed-clean probe, and local-only no-grant
handoff boundary before manifest drift is allowed to pass. See
`docs/report-contract-doc-page-release-handoff-ledger-section-regression.md`.

Export the contract doc page release delivery readiness section regression guard:

```bash
npm run reports:contract-doc-page-release-delivery-readiness-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-delivery-readiness-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-delivery-readiness-section-regression-latest.md`
and proves every manifest contract's own docs page keeps final release delivery
readiness bindings for release handoff ledger artifacts, strict gate,
freshness, checkpoint, retention dry-run, seed-clean probe, and local-only
no-grant delivery boundary before manifest drift is allowed to pass. See
`docs/report-contract-doc-page-release-delivery-readiness-section-regression.md`.

Export the contract doc page release execution denial section regression guard:

```bash
npm run reports:contract-doc-page-release-execution-denial-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-execution-denial-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-execution-denial-section-regression-latest.md`
and proves every manifest contract's own docs page separates final release
delivery readiness from archive, delete, upload, submit, IM, acceptance,
payment, deployment, provider/model spend, browser live action, channel-state
fetch, local state transition, runner dispatch, and execution permission. See
`docs/report-contract-doc-page-release-execution-denial-section-regression.md`.

Export the contract doc page release operator approval section regression guard:

```bash
npm run reports:contract-doc-page-release-operator-approval-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-operator-approval-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-operator-approval-section-regression-latest.md`
and proves every manifest contract's own docs page requires a separate
current-chat human/operator approval naming the exact target and action before
any external action can be queued, dispatched, uploaded, submitted, messaged,
accepted, paid, deployed, or otherwise performed. See
`docs/report-contract-doc-page-release-operator-approval-section-regression.md`.

Export the contract doc page release approval ledger section regression guard:

```bash
npm run reports:contract-doc-page-release-approval-ledger-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-approval-ledger-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-approval-ledger-section-regression-latest.md`
and proves every manifest contract's own docs page binds operator approvals into
an append-only auditable ledger with approver identity, target, action, channel,
artifacts, hashes, freshness, expiry, and revocation boundaries before manifest
drift is allowed to pass. See
`docs/report-contract-doc-page-release-approval-ledger-section-regression.md`.

Export the contract doc page release action queue section regression guard:

```bash
npm run reports:contract-doc-page-release-action-queue-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-action-queue-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-action-queue-section-regression-latest.md`
and proves every manifest contract's own docs page can turn approval-ledger
evidence into only a local review queue record with queue identity, preflight
status, expiry, replay-denial, and readyForExecution=false until a separate
fresh current-chat execution approval is captured. See
`docs/report-contract-doc-page-release-action-queue-section-regression.md`.

Export the contract doc page release runner dispatch denial section regression guard:

```bash
npm run reports:contract-doc-page-release-runner-dispatch-denial-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-runner-dispatch-denial-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-runner-dispatch-denial-section-regression-latest.md`
and proves every manifest contract's own docs page keeps local queued-action
evidence non-dispatchable: no runner, live browser/API action, upload, submit,
IM, acceptance, payment, deployment, provider/model spend, channel-state fetch,
local state transition, or execution permission may follow without fresh
current-chat execution approval and matching evidence. See
`docs/report-contract-doc-page-release-runner-dispatch-denial-section-regression.md`.

Export the contract doc page release live action preflight section regression guard:

```bash
npm run reports:contract-doc-page-release-live-action-preflight-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-live-action-preflight-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-live-action-preflight-section-regression-latest.md`
and proves every manifest contract's own docs page requires separate read-only
live-action preflight evidence while still denying runner dispatch, browser/API
writes, upload, submit, IM, acceptance, payment, deployment, provider/model
spend, local state transition, and execution permission. See
`docs/report-contract-doc-page-release-live-action-preflight-section-regression.md`.

Export the contract doc page release execution intent capture section regression guard:

```bash
npm run reports:contract-doc-page-release-execution-intent-capture-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-execution-intent-capture-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-execution-intent-capture-section-regression-latest.md`
and proves every manifest contract's own docs page separates read-only preflight
evidence from a fresh current-chat execution intent record while still denying
runner dispatch, browser/API writes, upload, submit, IM, acceptance, payment,
deployment, provider/model spend, local state transition, approval, and
execution permission. See
`docs/report-contract-doc-page-release-execution-intent-capture-section-regression.md`.

Export the contract doc page release execution approval boundary section regression guard:

```bash
npm run reports:contract-doc-page-release-execution-approval-boundary-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-execution-approval-boundary-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-execution-approval-boundary-section-regression-latest.md`
and proves every manifest contract's own docs page separates fresh current-chat
execution intent from an explicit execution approval boundary while still
denying runner dispatch, browser/API writes, upload, submit, IM, acceptance,
payment, deployment, provider/model spend, local state transition, and
execution permission unless a later runner/external-action lifecycle gate
verifies exact approval, artifacts, replay, platform-state, receipt, and audit
evidence. See
`docs/report-contract-doc-page-release-execution-approval-boundary-section-regression.md`.

Export the contract doc page release runner execution gate section regression guard:

```bash
npm run reports:contract-doc-page-release-runner-execution-gate-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-runner-execution-gate-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-runner-execution-gate-section-regression-latest.md`
and proves every manifest contract's own docs page binds explicit approval
boundary evidence into a separate runner lifecycle pre-dispatch gate while
still denying runner dispatch, browser/API writes, upload, submit, IM,
acceptance, payment, deployment, provider/model spend, local state transition,
and execution permission until a later dispatch implementation gate verifies
platform state, dry-run replay, post-action receipt, proof bundle, ledger, and
audit evidence. See
`docs/report-contract-doc-page-release-runner-execution-gate-section-regression.md`.

Export the contract doc page release dispatch implementation denial section regression guard:

```bash
npm run reports:contract-doc-page-release-dispatch-implementation-denial-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-dispatch-implementation-denial-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-dispatch-implementation-denial-section-regression-latest.md`
and proves every manifest contract's own docs page keeps runner execution gate
evidence non-dispatching: it can describe a future implementation review, but
cannot implement, enable, call, click, POST, upload, submit, IM, accept,
pay, deploy, spend provider/model credits, mutate local state, or grant
execution permission without a separate platform-state/replay/receipt/proof
bundle/ledger/audit gate plus fresh current-chat approval. See
`docs/report-contract-doc-page-release-dispatch-implementation-denial-section-regression.md`.

Export the contract doc page release platform-state snapshot denial section regression guard:

```bash
npm run reports:contract-doc-page-release-platform-state-snapshot-denial-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-platform-state-snapshot-denial-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-platform-state-snapshot-denial-section-regression-latest.md`
and proves every manifest contract's own docs page requires read-only platform-state snapshot evidence while denying browser/API write, click, POST, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, background runner action, external action, or execution permission from this guard. See
`docs/report-contract-doc-page-release-platform-state-snapshot-denial-section-regression.md`.

Export the contract doc page release dry-run replay denial section regression guard:

```bash
npm run reports:contract-doc-page-release-dry-run-replay-denial-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-dry-run-replay-denial-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-dry-run-replay-denial-section-regression-latest.md`
and proves every manifest contract's own docs page requires read-only dry-run replay evidence while denying live replay, browser/API write, click, POST, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, background runner action, external action, or execution permission from this guard. See
`docs/report-contract-doc-page-release-dry-run-replay-denial-section-regression.md`.

Export the contract doc page release proof-bundle denial section regression guard:

```bash
npm run reports:contract-doc-page-release-proof-bundle-denial-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-proof-bundle-denial-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-proof-bundle-denial-section-regression-latest.md`
and proves every manifest contract's own docs page requires read-only proof-bundle evidence while denying proof-bundle execution, live replay, browser/API write, click, POST, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, background runner action, external action, or execution permission from this guard. See
`docs/report-contract-doc-page-release-proof-bundle-denial-section-regression.md`.

Export the contract doc page release ledger denial section regression guard:

```bash
npm run reports:contract-doc-page-release-ledger-denial-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-ledger-denial-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-ledger-denial-section-regression-latest.md`
and proves every manifest contract's own docs page requires read-only ledger evidence while denying ledger mutation, proof-bundle execution, live replay, browser/API write, click, POST, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, background runner action, external action, or execution permission from this guard. See
`docs/report-contract-doc-page-release-ledger-denial-section-regression.md`.

Export the contract doc page release audit-evidence denial section regression guard:

```bash
npm run reports:contract-doc-page-release-audit-evidence-denial-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-audit-evidence-denial-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-audit-evidence-denial-section-regression-latest.md`
and proves every manifest contract's own docs page requires read-only audit evidence while denying audit write, ledger mutation, proof-bundle execution, live replay, browser/API write, click, POST, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, background runner action, external action, or execution permission from this guard. See
`docs/report-contract-doc-page-release-audit-evidence-denial-section-regression.md`.

Export the contract doc page release receipt-evidence denial section regression guard:

```bash
npm run reports:contract-doc-page-release-receipt-evidence-denial-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-receipt-evidence-denial-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-receipt-evidence-denial-section-regression-latest.md`
and proves every manifest contract's own docs page requires read-only receipt evidence while denying receipt write, receipt append, receipt mutation, receipt replay, audit write, ledger mutation, proof-bundle execution, live replay, browser/API write, click, POST, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, background runner action, external action, or execution permission from this guard. See
`docs/report-contract-doc-page-release-receipt-evidence-denial-section-regression.md`.

Export the contract doc page release post-action receipt denial section regression guard:

```bash
npm run reports:contract-doc-page-release-post-action-receipt-denial-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-post-action-receipt-denial-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-post-action-receipt-denial-section-regression-latest.md`
and proves every manifest contract's own docs page requires read-only post-action receipt evidence while denying post-action receipt write, receipt write, audit write, ledger mutation, proof-bundle execution, live replay, browser/API write, click, POST, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, background runner action, external action, or execution permission from this guard. See
`docs/report-contract-doc-page-release-post-action-receipt-denial-section-regression.md`.

Export the contract doc page release post-action audit denial section regression guard:

```bash
npm run reports:contract-doc-page-release-post-action-audit-denial-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-post-action-audit-denial-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-post-action-audit-denial-section-regression-latest.md`
and proves every manifest contract's own docs page requires read-only post-action audit evidence while denying post-action audit write, post-action receipt write, receipt write, audit write, ledger mutation, proof-bundle execution, live replay, browser/API write, click, POST, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, background runner action, external action, or execution permission from this guard. See
`docs/report-contract-doc-page-release-post-action-audit-denial-section-regression.md`.

Export the contract doc page release post-action reconciliation denial section regression guard:

```bash
npm run reports:contract-doc-page-release-post-action-reconciliation-denial-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-post-action-reconciliation-denial-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-post-action-reconciliation-denial-section-regression-latest.md`
and proves every manifest contract's own docs page requires read-only post-action reconciliation evidence while denying post-action reconciliation write, post-action audit write, post-action receipt write, receipt write, audit write, ledger mutation, proof-bundle execution, live replay, browser/API write, click, POST, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, background runner action, external action, or execution permission from this guard. See
`docs/report-contract-doc-page-release-post-action-reconciliation-denial-section-regression.md`.

Export the contract doc page release post-action settlement denial section regression guard:

```bash
npm run reports:contract-doc-page-release-post-action-settlement-denial-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-post-action-settlement-denial-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-post-action-settlement-denial-section-regression-latest.md`
and proves every manifest contract's own docs page requires read-only post-action settlement evidence while denying post-action settlement write, post-action reconciliation write, post-action audit write, post-action receipt write, receipt write, audit write, ledger mutation, proof-bundle execution, live replay, browser/API write, click, POST, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, background runner action, external action, or execution permission from this guard. See
`docs/report-contract-doc-page-release-post-action-settlement-denial-section-regression.md`.

Export the contract doc page release post-action acceptance denial section regression guard:

```bash
npm run reports:contract-doc-page-release-post-action-acceptance-denial-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-post-action-acceptance-denial-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-post-action-acceptance-denial-section-regression-latest.md`
and proves every manifest contract's own docs page requires read-only post-action acceptance evidence while denying post-action acceptance write, post-action settlement write, post-action reconciliation write, post-action audit write, post-action receipt write, receipt write, audit write, ledger mutation, proof-bundle execution, live replay, browser/API write, click, POST, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, background runner action, external action, or execution permission from this guard. See
`docs/report-contract-doc-page-release-post-action-acceptance-denial-section-regression.md`.

Export the contract doc page release post-action payment denial section regression guard:

```bash
npm run reports:contract-doc-page-release-post-action-payment-denial-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-post-action-payment-denial-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-post-action-payment-denial-section-regression-latest.md`
and proves every manifest contract's own docs page requires read-only post-action payment evidence while denying post-action payment write, post-action acceptance write, post-action settlement write, post-action reconciliation write, post-action audit write, post-action receipt write, receipt write, audit write, ledger mutation, proof-bundle execution, live replay, browser/API write, click, POST, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, background runner action, external action, or execution permission from this guard. See
`docs/report-contract-doc-page-release-post-action-payment-denial-section-regression.md`.

Export the contract doc page release post-action deployment denial section regression guard:

```bash
npm run reports:contract-doc-page-release-post-action-deployment-denial-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-post-action-deployment-denial-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-post-action-deployment-denial-section-regression-latest.md`
and proves every manifest contract's own docs page requires read-only post-action deployment evidence while denying post-action deployment write, post-action payment write, post-action acceptance write, post-action settlement write, post-action reconciliation write, post-action audit write, post-action receipt write, receipt write, audit write, ledger mutation, proof-bundle execution, live replay, browser/API write, click, POST, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, background runner action, external action, or execution permission from this guard. See
`docs/report-contract-doc-page-release-post-action-deployment-denial-section-regression.md`.

Export the contract doc page release post-action provider spend denial section regression guard:

```bash
npm run reports:contract-doc-page-release-post-action-provider-spend-denial-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-post-action-provider-spend-denial-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-post-action-provider-spend-denial-section-regression-latest.md`
and proves every manifest contract's own docs page requires read-only post-action provider/model spend evidence while denying post-action provider/model spend write, post-action deployment write, post-action payment write, post-action acceptance write, post-action settlement write, post-action reconciliation write, post-action audit write, post-action receipt write, receipt write, audit write, ledger mutation, proof-bundle execution, live replay, browser/API write, click, POST, upload, submit, IM, acceptance, payment, deployment, local state transition, queue consumption, background runner action, external action, or execution permission from this guard. See
`docs/report-contract-doc-page-release-post-action-provider-spend-denial-section-regression.md`.

Export the contract doc page release post-action state transition denial section regression guard:

```bash
npm run reports:contract-doc-page-release-post-action-state-transition-denial-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-post-action-state-transition-denial-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-post-action-state-transition-denial-section-regression-latest.md`
and proves every manifest contract's own docs page requires read-only post-action local state transition evidence while denying post-action local state transition write, post-action provider/model spend write, post-action deployment write, post-action payment write, post-action acceptance write, post-action settlement write, post-action reconciliation write, post-action audit write, post-action receipt write, receipt write, audit write, ledger mutation, proof-bundle execution, live replay, browser/API write, click, POST, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, background runner action, external action, or execution permission from this guard. See
`docs/report-contract-doc-page-release-post-action-state-transition-denial-section-regression.md`.

Export the contract doc page release post-action queue consumption denial section regression guard:

```bash
npm run reports:contract-doc-page-release-post-action-queue-consumption-denial-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-post-action-queue-consumption-denial-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-post-action-queue-consumption-denial-section-regression-latest.md`
and proves every manifest contract's own docs page requires read-only post-action queue consumption evidence while denying queue consumption consume/dequeue/ack, background runner dispatch, local state transition write, post-action provider/model spend write, post-action deployment write, post-action payment write, post-action acceptance write, post-action settlement write, post-action reconciliation write, post-action audit write, post-action receipt write, receipt write, audit write, ledger mutation, proof-bundle execution, live replay, browser/API write, click, POST, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, external action, or execution permission from this guard. See
`docs/report-contract-doc-page-release-post-action-queue-consumption-denial-section-regression.md`.

Export the contract doc page release post-action background runner denial section regression guard:

```bash
npm run reports:contract-doc-page-release-post-action-background-runner-denial-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-post-action-background-runner-denial-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-post-action-background-runner-denial-section-regression-latest.md`
and proves every manifest contract's own docs page requires read-only post-action background runner evidence while denying background runner run/start/dispatch, runner job claim/lease, queue consumption consume/dequeue/ack, local state transition write, post-action provider/model spend write, post-action deployment write, post-action payment write, post-action acceptance write, post-action settlement write, post-action reconciliation write, post-action audit write, post-action receipt write, receipt write, audit write, ledger mutation, proof-bundle execution, live replay, browser/API write, click, POST, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, background runner, external action, or execution permission from this guard. See
`docs/report-contract-doc-page-release-post-action-background-runner-denial-section-regression.md`.

Export the contract doc page release post-action dispatch completion denial section regression guard:

```bash
npm run reports:contract-doc-page-release-post-action-dispatch-completion-denial-section-regression
```

The exporter writes
`reports/report-contract-doc-page-release-post-action-dispatch-completion-denial-section-regression-latest.json`
and
`reports/report-contract-doc-page-release-post-action-dispatch-completion-denial-section-regression-latest.md`
and proves every manifest contract's own docs page requires read-only post-action dispatch completion evidence while denying dispatch completion complete/finish/acknowledge/commit, background runner run/start/dispatch, runner job claim/lease, queue consumption consume/dequeue/ack, local state transition write, post-action provider/model spend write, post-action deployment write, post-action payment write, post-action acceptance write, post-action settlement write, post-action reconciliation write, post-action audit write, post-action receipt write, receipt write, audit write, ledger mutation, proof-bundle execution, live replay, browser/API write, click, POST, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, background runner action, dispatch completion, external action, or execution permission from this guard. See
`docs/report-contract-doc-page-release-post-action-dispatch-completion-denial-section-regression.md`.

Export the report manifest drift regression guard:

```bash
npm run reports:manifest-drift-regression
```

The exporter writes
`reports/report-manifest-drift-regression-latest.{json,md}` and proves each
central manifest contract stays wired through package scripts, integration gate
steps, tooling metadata, freshness inventory, architecture checkpoint bindings,
gate summary hash keys, and exporter stdout/latest-file conventions. See
`docs/report-manifest-drift-regression.md`.

Export the report latest recovery regression guard:

```bash
npm run reports:latest-recovery-regression
```

The exporter writes
`reports/report-latest-recovery-regression-latest.{json,md}` and proves blocked
latest reports in the audit/tooling/freshness/schema/gate cycle fail closed,
bootstrap seed reports recover schema/freshness/tooling, and final freshness
passes only when the recovered report hashes match the gate summary. See
`docs/report-latest-recovery-regression.md`.

Export the report bootstrap seed regression guard:

```bash
npm run reports:bootstrap-seed-regression
```

The exporter writes
`reports/report-bootstrap-seed-regression-latest.{json,md}` and proves only the
allowlisted latest report ids can use temporary bootstrap seeds, every seed
must carry explicit recovery metadata and hashes, final reports must overwrite
those seeds without retaining bootstrap markers, and the gate summary must bind
to final report hashes. See `docs/report-bootstrap-seed-regression.md`.

Export the report gate clean rerun regression guard:

```bash
npm run reports:gate-clean-rerun-regression
```

The exporter writes
`reports/report-gate-clean-rerun-regression-latest.{json,md}` and proves a
second clean integration gate run skips all five bootstrap seed files, keeps
final report hashes, rejects seed marker/hash leaks, and verifies the seed
writer remains conditional in the gate source. See
`docs/report-gate-clean-rerun-regression.md`.

Export the report clean gate idempotence regression guard:

```bash
npm run reports:clean-gate-idempotence-regression
```

The exporter writes
`reports/report-clean-gate-idempotence-regression-latest.{json,md}` and proves
two clean gate snapshots keep the same semantic report hashes, skip all
allowlisted bootstrap seed files, keep gate summary hashes bound to final latest
reports, and run before runner contract validation. See
`docs/report-clean-gate-idempotence-regression.md`.

Export the report final settlement regression guard:

```bash
npm run reports:final-settlement-regression
```

This writes `reports/report-final-settlement-regression-latest.{json,md}` from
synthetic final closeout fixtures and gate source inspection. It proves final
gate, retention dry-run, final freshness, architecture checkpoint, and clean
bootstrap seed checks run in a stable order, requires the checkpoint to keep
post-action runtime status required metrics and read-only dispatch handoff
metrics green, verifies the terminal `release-final-settlement-latest.{json,md}`
report binding, and blocks mapped report writes after the final gate unless the
final settlement is refreshed.
See `docs/report-final-settlement-regression.md`.

Export the report post-final drift regression guard:

```bash
npm run reports:post-final-drift-regression
```

This writes `reports/report-post-final-drift-regression-latest.{json,md}` from
synthetic post-final drift fixtures and gate source inspection. It proves local
latest writers such as audit, tooling, selftest lanes, and output pairing are
blocked by final freshness/checkpoint after closeout until a clean gate,
freshness, checkpoint, and strict zero-seed closeout is rerun. See
`docs/report-post-final-drift-regression.md`.

Export the report closeout drift classification regression guard:

```bash
npm run reports:closeout-drift-classification-regression
```

This writes
`reports/report-closeout-drift-classification-regression-latest.{json,md}` from
synthetic command-class fixtures plus local source/docs inspection. It keeps
post-final commands classified as required clean closeout steps, blocked
gate-bound latest writers, allowed non-gate-bound writers, or read-only probes.
See `docs/report-closeout-drift-classification-regression.md`.

Export the report closeout command inventory regression guard:

```bash
npm run reports:closeout-command-inventory-regression
```

This writes
`reports/report-closeout-command-inventory-regression-latest.{json,md}` from
synthetic inventory fixtures plus local package/source/docs inspection. It
proves classified closeout commands, closeout guard scripts, integration gate
steps, and docs stay aligned before runner contract validation trusts the report
chain. See `docs/report-closeout-command-inventory-regression.md`.

Write the local bootstrap seeds used to break a latest-report self-reference
cycle:

```bash
npm run reports:bootstrap-seeds
```

This command is intentionally narrow: it conditionally writes temporary seed
JSON/Markdown pairs only for audit, tooling, freshness, schema, and gate latest
reports when they are missing, not ok, or already left as seeds. The integration
gate runs it before schema/freshness/tooling checks; clean runs skip all five
files, and polluted runs overwrite every seed with normal final report output.

Export the report runner contract regression guard:

```bash
npm run reports:runner-contract-regression
```

The exporter writes
`reports/report-runner-contract-regression-latest.{json,md}` and proves report
exporter package scripts, gate runner args, parseable JSON stdout, hash fields,
reportFiles pointers, gate summary hash keys, and freshness inventory entries
stay aligned. See `docs/report-runner-contract-regression.md`.

Export the report retention negative regression fixture:

```bash
npm run reports:retention-regression
```

The exporter writes `reports/report-retention-regression-latest.{json,md}` and
proves timestamped reports become archive candidates while `*-latest.{json,md}`
and `README.md` stay protected. It is synthetic-only and does not move or
delete real report files. See `docs/report-retention-regression.md`.

Prune old timestamped reports into the local archive:

```bash
npm run reports:prune
```

Export the current read-only integration sample set from local ZBJ state, EPWK
detail cache, and synthetic Hepta/human-feedback coverage:

```bash
npm run export:samples
```

The sample export writes `reports/read-only-samples-latest.{json,md}` and
timestamped copies. It intentionally disables raw `sourceSnapshot` capture so
platform-private objects stay in their owning channel workspace. The Hepta row
is local synthetic coverage for the buyer-facing vectorization/delivery path,
not account state. The export also carries synthetic human-feedback revision
samples for ZBJ, EPWK, and Hepta; dashboard/export validation now fails closed
if those samples, their revision contracts, or their customer-facing review
bindings disappear. Samples with plan-only blockers are also copied into
`unsupportedInventory`, which keeps unsupported or ambiguous records visible
with their blocker codes without granting execution permission. The export also
includes a synthetic control-plane dispatch readiness section, so dashboards can
show how many handoffs are ready for external-runner inspection versus blocked
by route/hash/selection/replay issues without contacting any platform. The same
section now reports dispatch hint catalog resolution so dashboard labels stay on
the whitelist, plus a dashboard-ready status object that keeps blocked handoffs
visible as warnings instead of treating them as export failures. See
`docs/read-only-sample-export.md`.

The reusable side-effect-free builder is `src/read-only-control-summary.mjs`.
Read-only report scripts import it directly; public consumers should use the
`read-only-report-chain` facade or the generated reports instead of the root
index.

`src/read-only-dashboard-snapshot.mjs` turns the sample summary plus control
summary into one dashboard-ready object with display metrics, warnings,
blockers, and a snapshot hash. `export:samples` uses that snapshot readiness in
its final `ok` flag. The builder remains a report-chain internal rather than a
root public export.

`src/read-only-sample-export-status.mjs` owns the final reusable export status
contract. It combines sample validation and dashboard snapshot readiness into a
hashed `ReadOnlySampleExportStatus`, so the CLI, dashboard, and future control
plane code use the same ready/blocked decision.

`src/read-only-sample-export-validator.mjs` verifies a generated
`read-only-samples-latest.json` report by recomputing the dashboard snapshot and
export status hashes. Run `npm run validate:samples` after
`npm run export:samples` to catch stale or tampered report payloads locally.

`src/adapter-runner-sdk.mjs` is the next handoff layer after dispatch
readiness. It turns a ready `AdapterDispatchReadinessReport` into a five-phase
external runner contract: `inspect -> prepare -> execute -> receipt ->
stateProof`. The contract is for ZBJ/EPWK/Hepta runner implementers; core still
does not run adapters, upload, submit, message, accept delivery, pay, deploy,
fetch channel state, or grant permission. Phase checklists now include
machine-readable evidence kinds for platform state snapshots, dry-run replay,
post-action receipts, channel state proof, and action-specific receipt/proof
fields so a ready handoff cannot be mistaken for permission to execute. See
`docs/adapter-runner-sdk.md`.

For a full local release close-out, run `npm run release:full-closeout`. It
executes the ordered read-only release chain from `gate:readonly` through
`release:archive-closeout`, stops on the first failing step, and prints a JSON
summary with the completed steps and latest report files. The wrapper only calls
local package scripts; it does not run adapters, upload, submit, message, accept
delivery, pay, deploy, fetch channel state, or grant permission.

For final settlement proof, run `npm run release:final-settlement`. It executes
the strict integration gate, retention dry-run, final freshness, architecture
checkpoint, bootstrap seed clean check, active seed marker scan, placeholder
token scan, `git diff --check -- .`, and a final latest-report dirty scan. The
command writes and then reads back `reports/release-final-settlement-latest.{json,md}`
with a non-recursive `writeIntegrity` proof. It blocks if retention still has
archive candidates, freshness loses the final gate hash, checkpoint loses the
final freshness hash, checkpoint stops proving all post-action runtime required
metrics, checkpoint stops proving read-only dispatch handoff metrics, bootstrap
seeds would be written, placeholder tokens remain, the local diff has
whitespace errors, any non-`reports/` file is still dirty, `reports/`
drift includes anything other than `reports/README.md` and
`reports/*-latest.{json,md}`, or the terminal latest report fails hash/status
readback after settlement.

For a manual local close-out, run `npm run gate:readonly`. It syntax-checks core
source files, parses fixture JSON, runs selftest, refreshes read-only samples,
validates the latest report, and writes
`reports/read-only-core-gate-latest.{json,md}` without touching any external
platform. Run `npm run validate:gate` after it to recompute the gate hash and
check the gate report's steps, failed-step list, report file bindings, and
read-only safety claims.

Run `npm run summarize:closeout` to turn the latest gate report and validation
result into `reports/read-only-closeout-latest.{json,md}`, a compact
dashboard-facing status record with the key hashes, counts, blockers, warnings,
dispatch readiness blocked-handoff metrics, dashboard warning counts, and
report links. Run `npm run validate:closeout` after it to recompute the
closeout summary hash and check the report-file bindings, preserved gate hashes,
required dispatch metrics, and read-only safety claims.

Run `npm run release:health` after closeout validation to write
`reports/read-only-release-health-latest.{json,md}`. The manifest combines gate,
gate validation, closeout summary, and closeout validation hashes into one
dashboard health record. Run `npm run validate:release-health` after it to
recompute the health hash and check hash fields, report-file bindings, manifest
checks, dispatch readiness metrics, and read-only safety claims.

Run `npm run release:verify` after release health validation to write
`reports/read-only-release-verification-latest.{json,md}`. The verification
bundle combines the release health manifest and its validator result into one
read-only dashboard/archive entry. Run `npm run validate:release-verification`
afterward to recompute the verification hash and check the bundle's hash fields,
report-file bindings, checks, metrics including blocked handoffs, and read-only
safety claims.

Run `npm run release:archive` after release verification validation to write
`reports/read-only-release-archive-latest.{json,md}`. The archive manifest
binds the verification bundle and verification validator hash chain into one
archive-ready read-only dashboard record. Run `npm run validate:release-archive`
after it to recompute the archive hash and check hash fields, report-file
bindings, checks, metrics including blocked handoffs, and read-only safety
claims.

Run `npm run release:archive-closeout` after archive validation to write
`reports/read-only-release-archive-closeout-latest.{json,md}`. The closeout
bundle binds the archive manifest and archive validator hash chain into a final
read-only dashboard/archive record.

## Public API

The package root is the stable import surface for channel adapters and control
plane code. It exports the contract, planning, approval/evidence, stable hash
utilities, contract JSON Schema, compatibility export policy, integration gate
tooling, the read-only report chain facade, the report freshness facade, and
the external action lifecycle
facade/schema without running any external action. New channel code should import
runner handoff, receipt, proof, inbox, dispatch, ledger, audit, replay, and
lifecycle schema helpers from `design-production-core`; those helpers are
exposed by the package-root lifecycle facade. The legacy root compatibility bridge is now
closed: `CORE_COMPATIBILITY_MODULES` is empty and the policy freeze cap is zero.
`package.json` also pins the package root export to `./src/index.mjs` and only
adds `./package.json` for metadata; package consumers must not deep-import
`design-production-core/src/*.mjs`. Older local scripts may use relative
implementation imports inside this repo or run the package scripts;
channel-facing code should stay on the stable facades.
The workspace-level local link `node_modules/design-production-core ->
../design-production-core` is validated by `npm run package-root:resolver`;
that report must stay green before sibling channel imports are rewritten to the
package root.
`integration-dependency-audit.mjs` remains CLI-only/internal; run it through
`npm run audit:integration:strict`. `npm run package:surface` performs the
actual Node package import smoke test and writes `package-surface-latest`.

Channel-specific runners should import from this file and keep browser
automation, provider calls, uploads, submits, messages, acceptance, payments,
and deployments outside core. See `docs/public-api.md`.

## Product Router

`src/product-router.mjs` is the shared product-line router. ZBJ, EPWK, and
Hepta should use this before choosing a production workflow.

The router priority is:

1. explicit structured `productLineId` / `kind` / enumerated or canonicalized `workflowId`
2. agent/LLM semantic route contract (`semanticRoute`, `agentRoute`, `modelRoute`, `routeContract`, or `semanticContract`)
3. fail-closed `generic_design` with `agent_semantic_product_line_required`

The router no longer uses title/category/requirement text regular expressions or
keyword rules. Requirement-body support phrases such as "可适配产品包装" are kept as
evidence for upstream semantic intake, but they cannot choose a product line in
core.

Router regression cases live in `fixtures/product-router-fixtures.json` and run
as part of `npm run selftest`. See `docs/product-router.md` for routing priority
and boundary notes.

Run the key decision-node audit:

```bash
npm run audit:agent-decisions
```

The audit writes `reports/agent-decision-node-audit-latest.{json,md}` and checks
that product routing, workflow inference, human-feedback revision routing,
plan-only planning, design-reference resolution, workflow registry, channel
pipeline, channel adapter contracts, channel-state proof, execution gate,
dispatch assignment, and runner registry are controlled by explicit/agent
semantic contracts or declarative gates, not regex or keyword routing. It also
scans route-sensitive source files for regex/text operators in decision lines and
keyword/string operators over unstructured route text, including tainted aliases
derived from title/category/requirement/status/message text and destructured
aliases such as `const { title: text } = input`. It also blocks generic helper
operators such as `value.includes('logo_brand')` unless they are declarative
membership checks, and tracks route-keyword arrays/constants before they are
reused inside string operators, including multi-line arrays/constants. Equality
and switch/case branches from tainted route text to route keywords are blocked as
well, as are object or `Map` lookups from tainted route text into route-keyword
tables. Allowed channel/action lists remain counted separately from keyword
routing.

## Workflow Registry

`src/workflow-registry.mjs` is the shared product workflow registry. It gives
each product line its default output mode, artifact-count policy, semantic and
reference policy, required gates, quality gates, and supported channels.

This is where reusable production rules belong:

- logo/VI quality gates and no-overlay rules
- packaging production-text locks
- PDF page render review
- naming text-form requirements
- Hepta vectorization package review
- post-submission revision invariants
- acceptance/delivery artifact binding

For `human_feedback` logo/vector handoff cases, the registry now treats the
buyer-selected image as the authoritative logo source. If a crop or threshold
cutout is visibly wrong, reconstruct the final logo/wordmark from that source
with the image model, run the reconstructed logo through Rust core
vectorization, and keep effect/backplate mockups as preview artifacts only.
Backplate/effect edits must preserve the accepted baseline geometry through
protected-region locks and change only the active atomic correction, such as a
dimension label or logo replacement. A generated backplate must not become the
vector source unless the buyer explicitly selects that generated effect image
as the logo source.

The registry is descriptive only. It does not execute provider/model spend,
prepare/upload, submit, acceptance, buyer messages, or deployment. See
`docs/workflow-registry.md` for the profile list and boundary rules.

## Plan-Only Adapter

`src/plan-only.mjs` is the shared planning entry point. It combines a channel
task/detail payload with `routeProductLine()` and `workflowProfile` to produce a
`PlanOnlyDraft`.

That draft contains:

- route decision
- compact workflow profile
- normalized `CreativeBrief`
- normalized `ProductionPlanEnvelope`
- plan-only warnings and blockers
- a hard safety declaration that no external action was taken

ZBJ, EPWK, and Hepta should call this before handing work to any execution
planner. The first integration is read-only: `npm run export:samples` now adds
`planOnly` status to every exported sample. See `docs/plan-only-adapter.md`.

## Migration Shims

`src/migration-shims.mjs` is the temporary compatibility layer for current
systems. It exposes:

- `buildZbjPlanOnlyMigration({ job, planSource, caseIndex })`
- `buildEpwkPlanOnlyMigration({ record, liveRules })`
- `buildHeptaPlanOnlyMigration({ order })`

The shims normalize existing channel payloads into `PlanOnlyDraft` without
changing the owning execution chain. They keep source snapshots redacted by
default and cannot perform provider/model spend, live prepare, upload, submit,
acceptance, customer messaging, deployment, payment, or account changes. See
`docs/migration-shims.md`.

## Execution Gates

`src/execution-gates.mjs` is the shared approval/evidence contract for external
actions. It evaluates whether an action request is `allow`, `needs_approval`, or
`blocked` under the current policy, approval packet, evidence bundle, channel
capability, package, review, prepare evidence, and duplicate preflight state.

Supported policy profiles:

- `safe-plan`
- `spend-allowed`
- `prepare-allowed`
- `submit-allowed`
- `acceptance-allowed`
- `deployment-allowed`

This module is also descriptive/evaluative only. It never calls providers,
models, live pages, uploads, submits, IM, acceptance, payments, or deployment.
See `docs/execution-gates.md`.

## Approval Packets

`src/approval-packets.mjs` builds deterministic `ApprovalPacket` and
`FreshEvidenceBundle` objects for the execution gate. The packet hash binds the
requested external action to the current task, plan, package, review, policy,
and budget. The evidence hash binds the latest package/review/prepare/duplicate
state to that exact approval hash.

Packets default to `pending_approval`. `execution-gates` now requires explicit
`ok: true`, so a hash alone cannot become permission. See
`docs/approval-packets.md`.

## State Machine

`src/state-machine.mjs` is the local lifecycle guard. It validates transitions
between `CORE_STAGES` and emits audit-only `StateAuditEvent` records. It blocks
illegal jumps such as `plan_ready -> submitted_verified`, prevents
`blocked_plan_only` drafts from advancing, and requires an allowed execution
gate before external-action transitions such as `live_prepare` or `live_submit`.
For human-feedback message handoffs, both the requested transition action and
the gate-decision action are compared after customer-message alias
canonicalization.

The state machine does not execute providers, models, live pages, uploads,
submits, customer messages, acceptance, payments, or deployment. See
`docs/state-machine.md`.

## Action Manifest

`src/action-manifest.mjs` converts an allowed execution gate plus an allowed
state transition into a `ChannelActionManifest`. The manifest maps a core
external action to a channel adapter descriptor such as `zbj.pitchSubmitLive`,
`epwk.prepareOnly`, or `hepta.deliveryDeploy`.

This is still not execution. The manifest is a redacted, hash-bound handoff
contract for the owning adapter runner. Unsupported channel/action pairs remain
`blocked_manifest`, and adapter runners must still require an explicit execute
flag. See `docs/action-manifest.md`.

## Adapter Runner Stub

`src/adapter-runner.mjs` turns a `ChannelActionManifest` into an
`AdapterRunPreview`. The preview shows the owning adapter action ID, a redacted
dry-run command preview, required flags, approval/evidence hashes, artifact
names, and blockers.

The root compatibility export for this module has been retired; use the stable
`external-action-lifecycle` facade or `adapter-runner-sdk` surface instead.

This module is deliberately a stub. It always sets `readyForExecution=false`,
blocks `execute: true`, and never calls providers, models, live pages, uploads,
submits, customer messages, acceptance, payments, or deployment. See
`docs/adapter-runner.md`.

## Adapter Runner Capabilities

`src/adapter-runner-capabilities.mjs` describes what an external channel runner
claims it can handle before the control plane sends it a dispatch envelope. The
descriptor binds runner ID, channel ID, supported action IDs, runner location,
and mandatory policy requirements such as explicit execute flag, current
approval, fresh evidence, and replay guard.

The root compatibility export for this module has been retired; import it
through `external-action-lifecycle` when local core code still needs it.

This module only validates the runner contract. It never runs the runner and
does not grant permission, even when a ready runner says it may execute external
actions outside core. Ready capabilities now also require `runnerLocation` to
point outside `design-production-core`; core-local paths are blocked before
registry, assignment, readiness, or SDK handoff. See
`docs/adapter-runner-capabilities.md`.

## Adapter Runner Registry

`src/adapter-runner-registry.mjs` collects ready runner capabilities into a
deterministic registry and selects a runner by channel/action. It blocks empty
registries, blocked capabilities, duplicate runner IDs, duplicate channel/action
routes, core-local runner locations, and unsupported selections.

The root compatibility export for this module has been retired; import it
through `external-action-lifecycle` when local core code still needs it.

The registry is not a scheduler and never runs adapters. A ready selection only
identifies the runner capability that matches the handoff; assignment and the
external runner still have to re-check approval, evidence, replay guard,
duplicate/channel state, and current-chat authorization. See
`docs/adapter-runner-registry.md`.

## Adapter Receipt

`src/adapter-receipt.mjs` verifies the redacted result returned by an external
channel runner after a manifest/preview handoff. It binds manifest hash, preview
hash, approval hash, evidence hash, platform state snapshot hash, dry-run replay
hash, external result ID, artifact evidence, and a state suggestion into an
`AdapterRunReceipt`.

Receipts are audit inputs only. They do not retry, resubmit, upload, message,
accept delivery, pay, or deploy; the owning control plane must still re-check
channel state before applying any lifecycle transition. See
`docs/adapter-receipt.md`.

## Channel State Proof

`src/channel-state-proof.mjs` records the independent current-channel read that
must confirm an accepted adapter receipt before lifecycle state advances. The
proof binds the receipt hash plus platform snapshot / dry-run replay hashes to
platform-state evidence such as ZBJ `worksId`, prepare upload artifact count,
message ID, acceptance ID, or deployment/build URL evidence.

This module does not fetch channel state. It only verifies normalized evidence
provided by the owning adapter and can produce a local state-machine transition
after proof passes. See `docs/channel-state-proof.md`.

## External Action Ledger

`src/external-action-ledger.mjs` chains the full handoff for one external action:
manifest, dry-run preview, adapter receipt, channel state proof, and local state
transition. It carries the receipt's platform snapshot and dry-run replay hashes
through the proof/ledger chain, and can show whether the handoff is still pending
a runner receipt, pending channel proof, pending local transition, fully
verified, or blocked by a hash/proof mismatch.

It can now also consume the standard inbox chain:
`AdapterReceiptInboxItem -> ChannelStateProofInboxItem -> ReceiptStateTransitionInboxItem`.
That path verifies the receipt/proof/transition intake hashes before a ledger is
considered fully verified.

It also supports the replay-guarded dispatch inbox chain:
`AdapterDispatchReceiptInboxItem -> AdapterDispatchChannelStateProofInboxItem -> AdapterDispatchReceiptStateTransitionInboxItem`.
That path additionally binds dispatch envelope, outbox, replay guard, archive,
and optional prior ledger hashes. Dispatch replay-guard ledger fixtures verify
that repeat-approved dispatch chains can be verified while replay-blocked or
candidate-mismatched chains remain `blocked_action_ledger`. Archive-loop
fixtures now carry the same replay path all the way back into the final ledger.

The ledger is an audit record only. It does not run adapters and cannot retry,
upload, submit, send, accept delivery, pay, or deploy. See
`docs/external-action-ledger.md`.

## External Action Audit Bundle

`src/external-action-audit-bundle.mjs` turns a verified inbox-chain
`ExternalActionLedgerEntry` into a redacted `ExternalActionAuditBundle` for the
control plane or external runner records. It requires the full ledger hash chain
and, by default, the receipt/proof/transition inbox hashes before a bundle can be
marked `verified_action_audit_bundle`. Dispatch-path bundles additionally keep
dispatch envelope, outbox, replay guard, archive, optional prior ledger, and
dispatch inbox hashes in the redacted hash binding.

The root compatibility export for this module has been retired; use
`external-action-lifecycle` as the stable facade.

Raw legacy ledgers stay as compatibility evidence; they cannot become final
audit bundles unless a caller explicitly opts out of the inbox-chain requirement.
The bundle is audit-only and never executes adapters, uploads, submits, sends
messages, accepts delivery, pays, deploys, fetches channel state, or applies
local lifecycle state. Dispatch replay-guard bundles require the dispatch replay
guard hash and dispatch inbox hashes before verification. Archive-loop ledgers
use the same audit-bundle boundary before archive promotion. See
`docs/external-action-audit-bundle.md`.

## External Action Audit Archive

`src/external-action-audit-archive.mjs` groups verified
`ExternalActionAuditBundle` records into a redacted archive/index. It records
task/action identity plus bundle and ledger hashes, blocks duplicate hashes, and
keeps raw or blocked records out of ready archives by default. Dispatch-path
entries preserve their dispatch chain markers so replay analysis can distinguish
standard inbox records from replay-guarded dispatch records. Dispatch
replay-guard archive fixtures verify that only verified dispatch replay bundles
enter ready archives; blocked replay bundles and duplicate dispatch ledgers keep
the archive blocked. Archive-loop bundles follow the same archive promotion
rules and preserve dispatch replay guard hashes for the next replay check.

The root compatibility export for this module has been retired; use
`external-action-lifecycle` as the stable facade.

The archive is not execution permission. It never runs adapters, uploads,
submits, sends messages, accepts delivery, pays, deploys, fetches channel state,
or applies lifecycle state. See `docs/external-action-audit-archive.md`.

## External Action Replay Guard

`src/external-action-replay-guard.mjs` checks a new handoff candidate against a
ready audit archive before the candidate is sent to an external runner. It
blocks exact bundle/ledger hash replay and blocks same task/action replay unless
an explicit, hash-intact, unexpired repeat `ApprovalPacket` is supplied. Dispatch
handoff candidates bind `outboxHash`; customer-message candidates also bind
`messagePreviewHash`, and human-feedback message candidates bind
`humanFeedbackRevisionContractHash`, so a clear guard for one outbox cannot
be reused for another same-identity customer message. When the archive row came
from a dispatch inbox chain, matched entries preserve dispatch envelope and
replay guard hashes for replay analysis. Dispatch replay-guard archive fixtures
now feed back through this guard so repeat-approved archived dispatch records
block exact replay and same task/action reuse unless a fresh repeat approval is
present.

The root compatibility export for this module has been retired; use
`external-action-lifecycle` as the stable facade.

A clear replay-guard decision is not permission to execute. It only says the
archive did not show a replay conflict; the normal approval/evidence gates and
real channel runner checks still apply. See
`docs/external-action-replay-guard.md`.

## Adapter Dispatch Envelope

`src/adapter-dispatch-envelope.mjs` combines a queued outbox item with a clear
replay-guard decision into a final redacted descriptor for an external runner to
inspect. It blocks dispatch when the outbox is not queued, the replay guard is
missing or blocked, hashes are tampered, or the guard candidate does not match
the outbox task/action identity, outbox hash, customer-message preview hash, or
human-feedback contract hash.

The root compatibility export for this module has been retired; use
`external-action-lifecycle` as the stable facade.

The envelope is still not execution permission and keeps
`readyForExecution=false`; the real runner must re-check approval, evidence,
current channel state, and append a receipt. Dispatch replay-guard decisions are
accepted as normal guard inputs, and blocked dispatch archive matches keep the
envelope blocked. The archive-loop fixtures also prove that replay decisions
created from dispatch replay-guard archives can ready a new descriptor only when
repeat-approved; archived replay and exact hash replay stay blocked. See
`docs/adapter-dispatch-envelope.md`.

## Adapter Dispatch Assignment

`src/adapter-dispatch-assignment.mjs` matches a ready dispatch envelope to a
ready adapter runner capability. It blocks blocked envelopes, blocked
capabilities, channel mismatches, unsupported action IDs, and inputs that claim
core execution permission.

The root compatibility export for this module has been retired; use
`external-action-lifecycle` as the stable facade.

When a registry selection is supplied, assignment binds the selection hash and
registry hash and verifies the selected channel/action, runner ID, and
capability hash against the envelope and capability.

A ready assignment only says the descriptor is compatible with the declared
runner. It is not execution permission and still requires the outside runner to
re-check approval, evidence, replay guard, duplicate state, channel state, and
current-chat authorization. See `docs/adapter-dispatch-assignment.md`.

## Adapter Dispatch Readiness Report

`src/adapter-dispatch-readiness-report.mjs` summarizes the final local handoff
state for a dashboard or external runner operator. It consumes the runner
registry, runner selection, dispatch envelope, and dispatch assignment and
checks that their hashes, channel/action route, runner ID, and capability hash
all bind together.

The root compatibility export for this module and the operator hint catalog has
been retired; use `external-action-lifecycle`, `adapter-runner-sdk`, and the
lifecycle schema as the stable surfaces.

The report blocks mismatched or unavailable selections, blocked envelopes,
blocked assignments, missing required handoff hashes, core-local runner
locations, or any input that claims core execution or permission. Operator
hints are resolved through
`src/dispatch-readiness-operator-hints.mjs`, so dashboards can only display
whitelisted labels and selftests catch unknown hint codes. A ready report is
still only a readiness summary; it never executes adapters and still requires
the external runner to re-check current approval, fresh evidence, replay guard,
duplicate/channel state, and current-chat authorization. See
`docs/adapter-dispatch-readiness-report.md` and
`docs/dispatch-readiness-operator-hints.md`.

## Adapter Dispatch Receipt Inbox

`src/adapter-dispatch-receipt-inbox.mjs` verifies the receipt returned after an
external runner inspected a dispatch envelope. It binds dispatch envelope,
outbox, replay guard, archive, optional ledger, receipt, manifest, preview,
approval, and evidence hashes before the successful result can ask for
independent channel-state proof.

The root compatibility export for this module has been retired; use
`external-action-lifecycle` as the stable facade.

Accepted non-success receipts become terminal records. Hash or identity
mismatches are blocked. Receipt inbox selftests now also cover envelopes created
from dispatch-archive replay guards: repeat-approved envelopes can request
channel-state proof, while blocked dispatch archive and candidate-mismatch
envelopes cannot accept runner receipts. Archive-loop envelope fixtures are also
fed into the receipt inbox so only repeat-approved loop descriptors can advance
to `channel_state_proof_required`. The module never runs adapters, fetches
channel state, applies lifecycle state, or grants execution permission. See
`docs/adapter-dispatch-receipt-inbox.md`.

## Adapter Dispatch Channel State Proof Inbox

`src/adapter-dispatch-channel-state-proof-inbox.mjs` verifies that a
`ChannelStateProof` belongs to a successful dispatch receipt inbox item. It binds
the dispatch receipt inbox, dispatch envelope, outbox, replay guard, archive,
optional ledger, receipt, and proof hashes before the local receipt transition
step can be considered.

The root compatibility export for this module has been retired; use
`external-action-lifecycle` as the stable facade.

This module does not fetch platform state or apply lifecycle state. It only
checks normalized read-only proof supplied by the owning channel adapter.
Dispatch replay-guard proof tests now cover the full gate from dispatch archive
guard to receipt inbox to proof inbox: only repeat-approved dispatch receipts
can become transition-ready. Archive-loop receipt inbox fixtures follow that
same rule before local transition. See
`docs/adapter-dispatch-channel-state-proof-inbox.md`.

## Adapter Dispatch Receipt State Transition Inbox

`src/adapter-dispatch-receipt-state-transition-inbox.mjs` verifies that a local
`ReceiptStateTransition` belongs to the transition-ready dispatch proof inbox
item. It binds dispatch proof inbox, dispatch receipt inbox, dispatch envelope,
outbox, replay guard, archive, optional ledger, receipt, proof, and transition
hashes before the final external action ledger can inspect the chain.

The root compatibility export for this module has been retired; use
`external-action-lifecycle` as the stable facade.

The transition inbox does not apply lifecycle state and does not grant execution
permission. It only advances clean dispatch-path transitions to
`external_action_ledger_ready`. Dispatch replay-guard transition tests now
prove that only repeat-approved dispatch proof inbox items can become
ledger-ready; replay-blocked or candidate-mismatched dispatch paths stay blocked
before ledger handoff. Archive-loop proof inbox fixtures now exercise the same
boundary. See `docs/adapter-dispatch-receipt-state-transition-inbox.md`.

## Dispatch Replay Cycle Invariant

`src/dispatch-replay-cycle-invariant.mjs` is the finite summary for the dispatch
replay-guard archive loop. It consumes the existing archive, replay guard,
dispatch envelope, receipt/proof/transition inbox, ledger, bundle, and next
archive records and proves the loop properties in one report.

The root compatibility export for this module has been retired; use
`external-action-lifecycle` as the stable facade.

The invariant says repeat-approved same task/action can continue through the
audit chain only while customer-message `messagePreviewHash` and
human-feedback `humanFeedbackRevisionContractHash` remain continuous;
archived replay, exact bundle/ledger replay, candidate mismatch, and binding
drift stay blocked. It is audit-only and never executes adapters, uploads,
submits, sends messages, accepts delivery, pays, deploys, fetches channel state,
applies lifecycle state, or grants permission. See
`docs/dispatch-replay-cycle-invariant.md`.

## Adapter Handoff Outbox

`src/adapter-handoff-outbox.mjs` packages a ready manifest, dry-run preview, and
optional pending-runner ledger into an `AdapterHandoffOutboxItem`. This is the
standard queue item for a real channel adapter to inspect outside core.

The root compatibility export for this module has been retired; use
`external-action-lifecycle` as the stable facade.

Outbox items can be queued or blocked. They never execute commands, and they
refuse completed or blocked ledgers so old receipts/proofs cannot be replayed as
new runner work. See `docs/adapter-handoff-outbox.md`.

## Adapter Receipt Inbox

`src/adapter-receipt-inbox.mjs` verifies a receipt returned by an external
runner against the queued outbox item. It checks channel/action/task identity and
manifest, preview, approval, evidence, and optional ledger hashes.

The root compatibility export for this module has been retired; use
`external-action-lifecycle` as the stable facade.

A successful receipt becomes `channel_state_proof_required`; failed or blocked
runner results become terminal records; mismatched receipts are blocked. The
inbox never runs adapters or fetches channel state. See
`docs/adapter-receipt-inbox.md`.

## Channel State Proof Inbox

`src/channel-state-proof-inbox.mjs` verifies that a `ChannelStateProof` belongs
to the received successful receipt that asked for channel proof. It binds the
receipt inbox hash, receipt hash, proof hash, channel/action/task identity, and
external ID before allowing the local receipt state transition step.

The root compatibility export for this module has been retired; use
`external-action-lifecycle` as the stable facade.

The proof inbox never fetches platform state and never applies lifecycle
transitions. See `docs/channel-state-proof-inbox.md`.

## Receipt State Transition Inbox

`src/receipt-state-transition-inbox.mjs` verifies that a local
`ReceiptStateTransition` belongs to the transition-ready proof inbox item. It
checks proof hash, task/action identity, and stage intent before the final
external action ledger chain can be considered ready.

The root compatibility export for this module has been retired; use
`external-action-lifecycle` as the stable facade.

The transition inbox never applies lifecycle state and never executes external
actions. See `docs/receipt-state-transition-inbox.md`.

## Non-Negotiables

- Channel adapters may never bypass core review gates.
- Product workflows may never call live platform submit APIs directly.
- Real provider/model spend, live prepare, submit, acceptance, IM, payments, deployments, and customer-facing sends stay behind explicit approval/evidence gates.
- Platform data and private customer data stay inside the owning channel workspace unless explicitly normalized into a redacted core contract.
