# hepta-orchestration-kernel

This crate provides six additive Rust orchestration library contracts. The
`hepta_control_plane::orchestration_kernel` re-export does not select them for an
existing command or replace the distinct Node/control-plane implementations.

It provides:

- a planning snapshot builder that checks supplied revision and barrier consistency;
- an integer-only Pareto candidate router with deterministic tie breaking;
- an in-memory hierarchical prepare/commit/finalize ledger with generation fencing and conservative expiry handling;
- low-cardinality privacy-safe telemetry that has no free-form identity fields;
- canonical workload performance qualification bound to exact source, binary, configuration and host-profile identities.
- deterministic integer planner calibration from caller-supplied observations.

The crate does not mint production authority. Target-host performance, external credentials, key custody, release, portal and submission acceptance remain independently controlled evidence.

The [development handoff](HANDOFF.md) defines each API's fields, limits, state
transitions, hashes, failure behavior, tests and remaining integration work. In
particular, snapshot isolation, observed binary provenance and crash persistence
are responsibilities of real external owners, not these data transformations.
