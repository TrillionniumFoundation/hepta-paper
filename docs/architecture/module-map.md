# Module map

Status: normative

## Scope

This map describes the active and support roots at the level developers need to locate ownership before changing code. File-level exports remain defined by source.

## Active roots

### `workflow-kernel`

Small domain-neutral primitives: immutable JSON handling, exact key checks, deterministic record hashing, runtime protocols, and benchmark harness identities. It must remain independent of paper policy and concrete infrastructure.

### `paper-domain`

Pure policy grouped by automation, contracts, evidence, governance, journal, operations, quality, repair, research, submission, and workflow. Contract implementations live in `paper-domain/contracts`; domain code must not reach stores, processes, networks, or CLI state.

### `paper-ports`

Typed boundaries and assertion functions for services used by application orchestration. The application service catalog makes every `ExecutionContext.services` dependency explicit so a new service-locator dependency cannot bypass a port decision.

### `paper-application`

Execution context validation, campaign automation, orchestration, reporting projections, and explicitly isolated experimental application flows. It coordinates injected services and owns no concrete SQL, filesystem, provider, or CLI implementation.

### `paper-adapters`

Concrete archives, artifacts, authority verification, automation executors, packaging, empirical analysis, governance, inventory, journal policy, persistence, proposal, referee, research verification, runtime, submission, and workspace implementations. Compatibility-only adapters remain outside the production graph.

### `paper-composition`

Automation, batch, bootstrap, compatibility, pilot, reporting, runtime, and submission object graphs. It selects concrete adapters, validates runtime roots, and supplies only the services required by each execution profile.

### `paper-core`

Executable commands, configuration, deployment templates, normative current-status and operations documents, compatibility exports, test suites, fixtures, and verification entrypoints. Business policy must remain in lower layers.

## Support roots

### `runtime-images`

Pinned Python CPU, Python GPU, and R scientific runtime definitions. Image identities, lockfiles, dataset supervisors, and source CAS inputs are part of reproducibility evidence.

### `store`

Ordered SQL migrations for native SQLite state, receipts, campaign operations, lineage, admission, and telemetry. Migrations are immutable after release and applied in sequence by store tooling.

### `migration`

Legacy semantic matrix, capability classifications, immutable fixtures, replays, owner/observer evidence intake, and retirement audit. It can prove lineage or replacement; it cannot execute the production workflow.

### `numerical-plugins`

Reference candidates and the development contract for adding numerical methods. A candidate becomes production-reachable only after domain registration, port/adapter implementation, reproducibility evidence, independent verification, and release qualification.

### `core`

A pinned reference submodule with an accepted baseline. It is inspectable for historical compatibility but forbidden from production reachability.

## Cross-cutting documentation

The contract semantics, workflow model, scientific traceability, threat model, operations, migration, and testing guides under `docs/` apply across module boundaries. A module README narrows these rules; it cannot weaken them.
