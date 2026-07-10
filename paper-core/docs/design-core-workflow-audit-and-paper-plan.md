# Design Core Workflow Audit And Paper Plan

## Audit Scope

This audits the unmodified `core/` snapshot as a production kernel and decides
how the paper workflow should use it without importing old `paper_factory`
control-plane sprawl.

## Current Design Production Workflow

The design-production core has two layers.

Product chain:

```text
ChannelTask
-> CreativeBrief
-> ProductionPlanEnvelope
-> ArtifactPackage
-> ReviewReport
-> ChannelSubmission
-> AdapterRunReceipt
-> ChannelStateProof
```

Runtime handoff chain:

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

The core is descriptor-only. It does not run providers, browsers, uploads,
submissions, customer messages, acceptance, payment, deployment, or external
state mutation. A ready handoff only means an external runner can recheck the
bundle.

## What To Keep For Paper

Keep these concepts because they are domain-neutral and solve real production
risks:

- explicit product/task contract before work starts
- canonical workflow state
- immutable package/artifact hashes
- review/readiness gates before external action
- action manifest as the last local descriptor
- dry-run runner preview/receipt
- state proof after runner receipt
- replay guard, audit archive, reconciliation, final settlement shape
- runner must live outside the core workspace

## What To Replace With Paper Semantics

The following design concepts should not stay active in the paper workflow.
They should be replaced by paper equivalents in `paper-core/` and
`paper-adapters/`.

| Design concept | Paper replacement |
| --- | --- |
| `ChannelTask` marketplace/order task | `PaperTask` |
| `CreativeBrief` | `ManuscriptSource` / paper metadata contract |
| `ProductionPlanEnvelope` | `PaperProfileContract` / venue workflow plan |
| `ArtifactPackage` image/PDF deliverable | `PaperArtifactPackage` with PDF/source zip/checksums |
| visual/design review gates | compile, anonymity, source, claim/evidence, reproducibility gates |
| design reference/refpack | citation corpus, related-work, evidence/proof corpus |
| provider/model spend prompt chain | research/claim/proof worker execution contract |
| customer-message action | venue form packet / cover letter draft |
| acceptance/delivery/deployment | submission lifecycle / archive / reconciliation |
| ZBJ/EPWK/Hepta runner routes | paper adapter runner routes |

## What To Remove From The Paper Main Chain

Do not include these in the canonical paper production spine:

- design product profiles: logo, packaging, brochure, poster, naming, vector
- semantic visual referee modules
- design-reference taxonomy and refpack scoring
- buyer/customer feedback contracts except as a possible future reviewer
  revision pattern
- marketplace actions: acceptance apply, customer message, payment, deployment
- provider/model spend routes unless rewritten as paper research-worker
  contracts
- report-only/capstone/matrix modules from old `paper_factory`
- stale latest-report readers
- giant `bin/paperctl` command logic

These can remain in the copied `core/` snapshot because the snapshot is kept
unmodified, but the paper CLI must not route through them.

## Plugin Or Core Module

Use plugin/external-runner adapters for almost everything from old
`paper_factory`.

Paper plugins:

- `inventory`: read `registry/papers.yaml`, venues/workflows, drafts,
  submission, workspaces, templates, and later SQLite.
- `build-package`: LaTeX compile planning/execution, PDF discovery, source zip,
  checksums, package manifest.
- `research-verify`: claim/evidence/proof/referee/reproducibility scan and
  later real worker execution receipts.
- `referee-revise`: reviewer issue queue, patch plan, patch apply preview,
  compile recheck.
- `submission`: venue plan, form packet, dry-run handoff, receipt, venue state
  proof, archive, reconciliation.

Core modules should be minimal:

- paper contract types and hash helpers
- paper batch runner
- paper action manifest / handoff / receipt / proof schemas
- CLI/report rendering

Do not add paper code to `core/` unless we later choose to upstream a generic
plugin registry abstraction. The current source-parity rule is stronger:
`core/` must stay byte-for-byte comparable with the hepta snapshot.

## Can Design Modules Be Replaced By Paper Modules?

Yes in the paper workspace, no inside `core/`.

For paper production, design modules should be disabled by non-use: the paper
CLI imports `paper-core/` and `paper-adapters/`, not `core/src/workflow-registry`
or ZBJ/EPWK/Hepta adapter routes. Paper modules replace design semantics at the
overlay layer.

Do not delete or rewrite design modules inside `core/`; that would destroy the
clean kernel snapshot and make later hepta updates impossible to compare. Treat
design modules as examples of contract shape, not as active paper workflow code.

## Target Paper Workflow

```text
PaperTask
-> ManuscriptSource
-> PaperProfileContract
-> ClaimScopeContract
-> ProofObligationContract
-> EvidenceMatrixContract
-> ReproducibilityContract
-> RefereeReviewReport
-> PaperProductionGate
-> PaperArtifactPackage
-> SubmissionPreflight
-> WarningReview
-> ReleaseArchive
-> VenueSubmissionPlan
-> SubmissionApprovalPacket
-> FreshVenueEvidenceBundle
-> SubmissionActionManifest
-> SubmissionHandoffEnvelope
-> SubmissionReplayGuard
-> ExternalExecutorHandoffOutbox
-> ExternalSubmissionReceipt
-> VenueStateProof
-> SubmissionAuditArchive
-> Reconciliation
```

The current overlay implements the first usable cut:

```text
PaperTask
-> PaperWorkflowState
-> PaperArtifactPackage
-> VenueSubmissionPlan
-> PaperActionManifest
-> PaperHandoffEnvelope
-> PaperAdapterRunReceipt
-> VenueStateProof
-> SubmissionAuditArchive
```

## Implementation Plan

Phase A: Freeze core and paper overlay boundary

- keep `core/` unmodified
- keep paper contracts in `paper-core/`
- keep old `paper_factory` imports out of paper CLI
- preserve `diff -qr hepta-source core/ == 0`

Phase B: Strengthen canonical paper state

- split `source_present` into exact source classes: directory source, extracted
  source zip, frozen package source, generated runtime source
- add explicit blocker categories: source, venue, compile, evidence, package,
  submission
- make batch reports group by blocker family

Phase C: Inventory plugin v2

- add SQLite read support as optional source of truth
- keep YAML as readable fallback/export
- add template/venue workflow resolution
- quarantine rust-shadow/test fixture rows from production inventory

Phase D: Build/package plugin v2

- run compile only under runtime output directories
- write package manifests and SHA256SUMS
- verify source zip path safety and main TeX presence
- add anonymity/header/preflight checks

Phase E: Research/verify plugin v2

- replace filename evidence scan with typed claim/evidence/proof contracts
- integrate usable `research_compute` workers as external plugins
- reject capstone/report-only modules

Phase F: Referee revise plugin

- model reviewer comments as work items
- generate patch plan and dry-run apply receipt
- compile after patch
- never mutate source without explicit mode and rollback ledger

Phase G: Submission lifecycle

- venue dry-run stays default
- reviewed submit requires explicit approval packet and fresh venue evidence
- live submit executor remains a separate external runner
- archive/reconcile every receipt and venue proof

## Immediate Next Cut

The next useful coding step is not live submission. It is now implemented in
the overlay:

1. add blocker-family summary to batch reports;
2. quarantine fixture/shadow rows from production inventory;
3. add optional SQLite inventory reader;
4. make build/package write `PACKAGE_RECORD.json` and `SHA256SUMS.txt` under
   `runtime/packages/<paper_id>/`.

Operational behavior:

- `paper_factory.sqlite` is the default inventory source in `auto` mode, with
  YAML fallback/export still available via `--inventory-source yaml`.
- Quarantined rows are excluded from production batch runs unless
  `--include-quarantined` is set.
- Markdown and JSON reports now expose blocker families.
- Package records are generated in the overlay runtime tree, not in `core/` and
  not by mutating source workspaces.
