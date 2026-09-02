# Dependency rules

Status: normative

## Scope

These rules govern static imports, runtime service injection, side effects, and ownership transfers in the active graph.

## Allowed direction

- `workflow-kernel` may depend on the Node standard library and explicitly pinned neutral packages only.
- `paper-domain` may depend on `workflow-kernel`; it may not import ports, adapters, composition, CLI, SQL, or mutable runtime state.
- `paper-ports` may depend on domain and kernel values; it may not import concrete adapters.
- `paper-application` may depend on domain, ports, and kernel; it may not import adapters, composition, SQL, provider SDKs, or CLI modules.
- `paper-adapters` may depend on ports, domain, and kernel; production adapters may not import application or composition policy.
- `paper-composition` may depend on every active lower layer solely to assemble object graphs.
- `paper-core` entrypoints may invoke composition and expose compatibility facades, but may not duplicate domain contracts.
- Production-reachable code may not import `core/src`, `migration/retirement`, or experimental modules.

A lower layer never discovers a higher layer dynamically. Passing a function through an untyped object, service locator, environment variable, or global does not create an exception.

## Effects

Network, process, filesystem, database, clock, random identity, container, model, and portal effects enter through named ports. Application code receives a validated `ExecutionContext` profile. The declared capability list must exactly match the validated service set; extra authority is an error.

The default safety posture forbids external actions, forbids legacy control-plane imports, requires writes through declared ports, and exposes raw store access only to the explicit legacy profile.

## Data crossing boundaries

Boundary values must have a version, kind, exact required fields, validation, canonical hashing rules where identity matters, and a documented unknown-field policy. Domain objects are not silently coerced from untrusted JSON. Mutable adapter responses are normalized and frozen before entering policy code.

Receipts bind the operation, input identities, output identities, attempt or generation, implementation/runtime identity, time source, authority epoch, and failure state needed by the consuming gate.

## Cycles and compatibility

Dependency cycles are prohibited. A compatibility facade may translate at the edge but cannot become the source of truth, mint authority, or be imported by new production modules. Each exception is hash-bound in the compatibility manifest and has an owner and retirement condition.

## Enforcement

Architecture conformance and repository import tests classify every source module and executable graph. New unclassified modules fail. Documentation review must accompany any allowed-direction change, new cross-layer value, or new external effect.
