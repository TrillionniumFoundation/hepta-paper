# paper-ports

Status: normative module guide

## Purpose

`paper-ports` defines typed capabilities between pure/application policy and concrete infrastructure. A port states the semantic behavior an application use case needs without selecting SQLite, files, containers, models, providers, clocks, or remote services.

## Responsibilities

The module contains ports for artifacts, authority verification, campaign state and release authority, clocks and identities, empirical/formal execution, inventory and journals, package lifecycle and recovery, persistence sessions and units of work, receipt ledgers, resources and scheduling, runtime retention, submission/outbox/portal boundaries, tools, workers, workspaces, and workflow state.

`application-service-port-catalog.mjs` names every service that may appear in `ExecutionContext.services`. Boundary schema catalogs make cross-process values explicit.

## Dependencies

Ports may depend on `paper-domain` and `workflow-kernel` values. They may not import concrete adapters, application orchestration, composition roots, CLI, SQL implementations, or provider SDKs.

Port assertion functions validate a capability surface but do not manufacture missing authority or silently add defaults.

## Contracts

Every operation follows [`../docs/contracts/port-semantics.md`](../docs/contracts/port-semantics.md): pre/postconditions, result/error variants, idempotency, ordering, cancellation, timeout, retry ownership, transaction boundary, fencing, limits, durability, security, and receipt identity.

Query and mutation authority are separate capabilities. Broad store or provider objects are not passed where a narrow query, append, acquire, verify, or reconcile capability is sufficient.

## Failure and recovery

Ports expose enough information for callers to distinguish deterministic rejection, contention, transient unavailability, deadline, cancellation, stale generation, unknown external outcome, and permanent failure. An adapter may not collapse these into an untyped false or generic success.

Prepared results and remote outcomes are recoverable through explicit lookup/reconcile operations. Retry is never inferred solely from an exception.

## Security

Capabilities are least-authority objects. Trusted writer, live submission, deletion, signing, release, and provider mutation ports require separately verified authority. Sensitive inputs are purpose-scoped and must not be exposed by broad diagnostic methods.

## Testing

Each port has assertion tests and a reusable conformance suite. Every concrete adapter runs positive, malformed, duplicate, stale-generation, cancellation, timeout, partial-write, restart, and authority-rotation cases applicable to that port. Application tests use fakes that preserve the real semantics rather than convenient mocks.

## Change rules

A new application service must be added to the service catalog, execution profile, composition root, conformance tests, and documentation. Breaking a port requires a versioned successor or bounded compatibility adapter; do not widen an existing capability to avoid creating a precise port.
