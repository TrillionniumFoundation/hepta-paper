# Source of truth

Status: normative

## Scope

This document resolves ownership ambiguity among the active source layers, `paper-core`, the `core/` reference submodule, runtime images, storage migrations, and legacy migration evidence.

## Canonical owners

| Capability | Canonical owner | Supporting implementation | Not authoritative |
|---|---|---|---|
| Neutral hashing, exact JSON values, runtime primitives | `workflow-kernel/` | Node standard library | `core/` reference utilities |
| Paper, research, evidence, campaign, governance, repair, journal, quality, submission policy | `paper-domain/` | None | adapters, CLI, migration fixtures |
| Infrastructure and external capability boundaries | `paper-ports/` | assertion and capability constructors | concrete adapter behavior |
| Use-case orchestration and execution profiles | `paper-application/` | injected ports | CLI routing and SQL |
| Filesystem, SQLite, worker, provider, archive, package, review, authority implementations | `paper-adapters/` | external runtimes | domain policy |
| Concrete object graphs and least-capability bootstraps | `paper-composition/` | configuration and profile builders | reusable business rules |
| Supported CLI, verification entrypoints, deploy/config assets, compatibility facades | `paper-core/` | composition roots and tests | a second contract owner |
| Native database schema evolution | `store/migrations/` | store tooling | legacy semantic matrix |
| Legacy disposition and replay evidence | `migration/` | immutable fixtures and tests | production execution authority |
| Scientific runtime definitions | `runtime-images/` | pinned source CAS submodule | mutable tags or developer images |
| Candidate numerical plugin material | `numerical-plugins/` | qualification contracts and runners | automatic scientific promotion |
| Historical/reference implementation | `core/` | hash baseline | active production graph |

## Conflict resolution

When sources disagree, apply this order:

1. Machine-enforced domain contract, port, schema, or receipt validation.
2. `paper-core/docs/CURRENT_STATUS.md` for current readiness and external blockers.
3. `paper-core/docs/ARCHITECTURE.md` and this document for ownership and dependency rules.
4. Module READMEs and other normative guides.
5. Informative examples.
6. Historical documents and reference packages.

A historical file, similarly named adapter, generated report, fixture, or submodule implementation cannot override the canonical owner.

## Authority separation

Code ownership is not authority possession. Local code may validate a signed record, but it may not mint missing independent academic, operational, provider, owner, observer, release, or live-submission authority. Composition may inject an authority capability only when the corresponding verifier and trust material are present and valid.

Campaign completion creates a typed handoff candidate. Package publication, current-release selection, submission verification, provider draft creation, and live portal commit remain separate capabilities with separately scoped evidence.

## Evolution rule

Moving a responsibility requires an architecture decision record, updated import gates, updated tests, updated module documentation, compatibility analysis, and an explicit retirement path for the old owner. Copying behavior into a second layer without retiring the first owner is prohibited.
