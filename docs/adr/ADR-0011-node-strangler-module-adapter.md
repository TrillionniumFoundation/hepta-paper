# ADR-0011: migrate Node capabilities through a strangler module adapter

Status: **accepted as the current target decision; implementation and qualification remain gated**

## Context

The current Node control plane is authoritative and feature-rich. A big-bang
replacement would combine protocol, behavior, state, authority, and operational
risk in one cutover.

## Decision

Inventory stable capabilities, place current Node implementations behind the
same module protocol through a bounded legacy adapter, and migrate one capability
through:

```text
registered -> shadow -> canary -> authoritative -> Node path retired
```

Exact, semantic, evaluation, and retirement behavior are qualified separately.
At most one implementation may own a central write or external-effect
mutual-exclusion group.

## Consequences

Migration progress is capability-based rather than language-percentage based.
Rollback retains a known implementation without restoring dual authority. The
legacy adapter is explicitly temporary and cannot become a second permanent
architecture layer.

## Adoption gates

`MIG-001` through `MIG-006`, full parity dependencies, rollback rehearsal, and
Node authority reachability removal are required.
