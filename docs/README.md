# hepta-paper documentation

Status: normative

## Scope

This index defines the maintained documentation surface for the active `hepta-paper` workspace. It does not replace the current release-state counts in [`../paper-core/docs/CURRENT_STATUS.md`](../paper-core/docs/CURRENT_STATUS.md) or the normative layer rules in [`../paper-core/docs/ARCHITECTURE.md`](../paper-core/docs/ARCHITECTURE.md). When an older phase, remediation, or retirement note conflicts with current status, current status wins.

## Architecture

- [`architecture/source-of-truth.md`](architecture/source-of-truth.md) assigns every major capability to one canonical owner.
- [`architecture/module-map.md`](architecture/module-map.md) explains each source root and its submodule families.
- [`architecture/dependency-rules.md`](architecture/dependency-rules.md) defines legal imports and effect boundaries.
- [`architecture/version-and-compatibility.md`](architecture/version-and-compatibility.md) defines version, schema, submodule, and compatibility policy.
- [`adr/0001-canonical-layering.md`](adr/0001-canonical-layering.md) records the one-way layered architecture decision.
- [`adr/0002-reference-package-boundary.md`](adr/0002-reference-package-boundary.md) records why `core/` is reference-only.

## Contracts and execution

- [`contracts/port-semantics.md`](contracts/port-semantics.md) is the common semantic contract for every port and adapter.
- [`workflows/campaign-state-machine.md`](workflows/campaign-state-machine.md) describes attempts, leases, prepared results, cancellation, retry, recovery, and terminal states.
- [`science/reproducibility-and-traceability.md`](science/reproducibility-and-traceability.md) defines claim-to-code-to-evidence traceability and reproducibility metadata.

## Security and operations

- [`security/threat-model.md`](security/threat-model.md) defines assets, actors, trust boundaries, threats, and required controls.
- [`operations/configuration-runtime-and-recovery.md`](operations/configuration-runtime-and-recovery.md) defines configuration precedence, filesystem separation, storage, backup, restore, and operational evidence.
- [`migrations/migration-policy.md`](migrations/migration-policy.md) defines native database migration and legacy semantic migration policy.

## Development governance

- [`documentation-standard.md`](documentation-standard.md) defines required module documentation sections and document status.
- [`development/testing-and-change-policy.md`](development/testing-and-change-policy.md) defines local checks, CI lanes, change evidence, review, and completion criteria.
- [`module-documentation-matrix.md`](module-documentation-matrix.md) is the human-readable coverage inventory enforced by the documentation integrity check.

## Document authority

Documents use one of three statuses:

- **normative**: current requirements that code and reviews must follow;
- **informative**: explanation or examples that do not override contracts;
- **historical**: immutable evidence of an earlier plan or state.

Normative documents must identify their scope, avoid mutable readiness counts unless they are the designated status source, and link to machine-verifiable contracts wherever possible. Historical documents must not be silently rewritten to look current.
