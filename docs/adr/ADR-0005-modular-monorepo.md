# ADR-0005: retain a modular monorepo during control-plane migration

Status: **accepted as the current target decision; implementation and qualification remain gated**

## Context

The system is simultaneously changing control-plane language, authority
boundaries, module contracts, qualification schemas, and team ownership. Splitting
repositories now would convert atomic protocol and evidence changes into an
unqualified cross-repository version-combination problem.

## Decision

Retain one repository while introducing independently owned modules, strict
public contracts, generated bindings, module-aware CI, and deployment isolation
only where authority, credentials, runtime, or failure containment requires it.
A module is not required to be a service or repository.

## Consequences

- Cross-language schemas, golden vectors, migration adapters, and qualification
  subjects change atomically.
- Team autonomy is provided by module ownership and affected CI rather than
  repository separation.
- Repository-wide coupling remains visible and can be measured.
- Future extraction requires a stable protocol, independent release cadence,
  clear operational ownership, and a proven benefit greater than coordination
  and qualification cost.

## Rejected alternatives

- Immediate microservice decomposition: expands operational and authority
  surfaces before contracts are stable.
- One permanent monolith: preserves hidden implementation coupling and review
  serialization.

## Adoption gates

`MOD-001`, `MOD-004`, `ORG-001`, and `ORG-003` must close before module autonomy
is claimed. This ADR grants no production authority.
