# hepta-paper development documentation

This directory is the single current development-document entry point for
`hepta-paper`. Every retained document describes the current system, an active
decision, an executable engineering contract, or a live qualification/runbook
surface. Superseded plans and snapshots are preserved by Git history rather than
kept beside current instructions.

## Read in this order

1. [`system/CURRENT_STATUS.md`](system/CURRENT_STATUS.md) — present static state,
   authority ceiling, and open blockers.
2. [`system/MASTER_PLAN.md`](system/MASTER_PLAN.md) — mission, workstreams,
   milestones, sequencing, and stop conditions.
3. [`system/ARCHITECTURE.md`](system/ARCHITECTURE.md) — target modular architecture
   and authority topology.
4. [`system/MILESTONE_GATES.md`](system/MILESTONE_GATES.md) and
   [`system/TRACEABILITY.md`](system/TRACEABILITY.md) — closure evidence and the
   capability→module→work→validation chain.
5. [`modules/MODULE_MODEL.md`](modules/MODULE_MODEL.md),
   [`modules/MODULE_PROTOCOL.md`](modules/MODULE_PROTOCOL.md), and
   [`modules/MODULE_TEMPLATE.md`](modules/MODULE_TEMPLATE.md) — independent module
   development rules.
6. [`control-plane/GLOBAL_OPTIMIZATION.md`](control-plane/GLOBAL_OPTIMIZATION.md),
   [`control-plane/RESOURCE_MODEL.md`](control-plane/RESOURCE_MODEL.md), and
   [`control-plane/COMMIT_SEQUENCER.md`](control-plane/COMMIT_SEQUENCER.md) — global
   planning, concurrency, fairness, and authoritative integration.
7. [`qualification/QUALIFICATION_MODEL.md`](qualification/QUALIFICATION_MODEL.md)
   and [`qualification/QUALIFICATION_SUBJECT_V3.md`](qualification/QUALIFICATION_SUBJECT_V3.md)
   — what evidence proves and what invalidates it.
8. [`governance/TEAM_TOPOLOGY.md`](governance/TEAM_TOPOLOGY.md) and
   [`governance/DELIVERY_AND_INTEGRATION.md`](governance/DELIVERY_AND_INTEGRATION.md)
   — team ownership, review, and integration discipline.

## Normative hierarchy

| Priority | Source | Purpose |
|---:|---|---|
| 1 | `docs/system/truth/*.json` | committed machine-readable global truth |
| 2 | JSON Schemas and protocol schemas | accepted shapes, versions, and limits |
| 3 | `docs/system`, `docs/modules`, `docs/control-plane` | global architecture and engineering rules |
| 4 | `docs/rust`, `paper-core/docs`, `docs/runtime` | scoped implementation projections and runbooks |
| 5 | workflow artifacts and externally signed packages | effective qualification for an exact immutable subject |
| 6 | Git history | historical audit trail only |

A lower-priority source cannot promote or contradict a higher-priority source.
Committed prose records static facts; it never grants production authority.

## Machine records

```text
docs/system/truth/program.v2.json
docs/system/truth/capabilities.v1.json
docs/system/truth/modules.v1.json
docs/system/truth/work-items.v2.json
docs/system/truth/milestones.v1.json
docs/system/truth/risks.v2.json
docs/system/truth/canonical-workloads.v1.json
docs/system/truth/evidence-bindings.v1.json
docs/system/truth/document-manifest.v1.json
```

Validate from the repository root:

```bash
node docs/tools/validate-development-docs.mjs
python3 docs/rust/tools/validate-program-truth.py
npm run scripts:check
npm run security:source-gate
npm run release:state-check
```

The documentation validator rejects invalid schemas, unknown or nonreciprocal
capability/module/work references, module dependency cycles, undeclared central
writers, missing canonical documents, and historical/checkpoint/trigger naming
patterns.

## Scope boundaries

- `paper-core/docs` describes the current Node implementation and operational
  surface.
- `docs/rust` describes the additive Rust control-plane and authority migration.
- `docs/adr` contains only active decisions.
- `docs/runtime`, `docs/security`, and `docs/qualification` contain current
  cross-subsystem contracts.
- Git history, pull-request discussions, issues, and retained CI/external
  artifacts preserve historical evidence.

A deleted historical document may be recovered for audit from Git, but it must
not be copied back into current documentation without a new current subject,
owner, manifest decision, and review.
