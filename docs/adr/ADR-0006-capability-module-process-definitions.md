# ADR-0006: separate capability, module, crate, process, and service identities

Status: **accepted as the current target decision; implementation and qualification remain gated**

## Context

Existing planning sometimes uses directory, crate, workstream, and production
responsibility as interchangeable units. That prevents stable ownership and
capability-by-capability migration.

## Decision

- A **capability** is a stable system responsibility.
- A **module** is a registered, versioned, independently owned implementation of
  capabilities.
- A **crate/package** is a language build unit.
- A **process/service** is a deployment and failure/authority boundary.
- A **workstream** is a delivery-management grouping.

Only the module registry creates a module identity. Multiple crates may form one
module; one crate may expose several internal components. A module becomes a
separate process only when authority, secrets, containment, runtime, or recovery
requirements justify that boundary.

## Consequences

Capability IDs survive Node-to-Rust migration. Teams own stable modules instead
of arbitrary directories. Deployment count is controlled independently from
source decomposition.

## Adoption gates

The glossary, capability catalog, module registry, architecture inventory, and
CODEOWNER generator must use these definitions consistently.
