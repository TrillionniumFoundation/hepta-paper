# hepta-paper architecture

This is the normative architecture description. Current operational readiness
and release-state counts live in `CURRENT_STATUS.md`; historical plans and
versioned architecture rationale live in `history/`.

## Source layers

- `workflow-kernel/` owns domain-neutral identity, hashing, time/process/file
  primitives and small runtime protocols.
- `paper-domain/` owns pure paper, research, evidence, journal, campaign and
  submission policy. It consumes only values and kernel primitives.
- `paper-ports/` defines typed capabilities. Ports may depend on domain and
  kernel contracts, never on concrete adapters.
- `paper-application/` owns use-case orchestration over injected ports. It does
  not import adapters, SQL, or CLI modules.
- `paper-adapters/` implements I/O and external runtimes. Adapters may consume
  ports, domain and kernel modules, but not application or composition policy.
- `paper-composition/` is the only layer that assembles concrete adapters into
  application contexts.
- `paper-core/bin/` and `paper-core/src/` expose executable and compatibility
  surfaces. They do not create a second business-policy layer.

The vendored `core/` tree is a hash-bound reference package, not a production
runtime dependency. Production reachability may not import `core/src`.

## Entrypoint taxonomy

`paper-core/src/architecture-entrypoint-manifest.mjs` and the npm command
manifest classify executable graphs as:

- production;
- compatibility;
- experimental;
- verification;
- maintenance;
- migration support.

Every repository module covered by the architecture inventory belongs to
exactly one category. There is no implicit `support` fallback: an orphan or a
new unclassified module fails the architecture gate. Each executable graph is
checked for dependency cycles and layer violations. High-risk modules are also
bounded by dependency fanout, public export count, their combined responsibility
surface and static control-flow points; line count remains only a final size
backstop rather than the sole decomposition signal.

## Authority boundaries

SQLite state changes go through injected Store capabilities. Artifact and
runtime materialization goes through scoped, no-follow, atomic repositories
that return hash-bound receipts. The campaign store is the operational DAG
authority and uses attempt/generation fencing plus recoverable prepared
integration. Submission handoff receives a query-only release capability;
writable release authority is not present in that object graph.

Worker execution uses a runner-issued, single-use, instance-bound execution
identity. Container tags are resolved to digests before execution, source and
dataset snapshots are verified before and after execution, and unsupported
sandbox backends fail closed.

Research promotion distinguishes generated claims from verified evidence.
Formal and empirical evidence must be bound to the campaign node, attempt,
source snapshot, verifier/runtime identity and release bundle. Machine
verification proves the formal statement or declared experiment protocol; it
does not by itself prove that a natural-language claim is semantically
equivalent or that a scientific conclusion is correct.

## Compatibility and retirement

Compatibility modules are explicit, owned and have retirement conditions.
Experimental TaskFlow coordination is outside the production graph. Historical
translation and migration modules may verify or preserve lineage but cannot
enter the production authority graph.

## Universal submission connectors

The provider-neutral submission model, connector-family registry, versioned
portal bindings and target coverage are documented in
[`universal-submission-system.md`](universal-submission-system.md). Provider
adapters run behind the independent signed submission service boundary; they
are not imported into the research executable graph. The existing durable
outbox remains the sole delivery authority and handles uncertain outcomes by
remote reconciliation rather than blind retry.

## Architecture gates

The primary checks are:

- `node --test paper-core/tests/architecture-conformance.test.mjs`
- `node --test paper-core/tests/repository-module-imports.test.mjs`
- `npm run static:check`
- `npm run safety:all`

Release verification adds capability, migration, evidence and isolated runtime
checks described in `OPERATIONS.md`.
