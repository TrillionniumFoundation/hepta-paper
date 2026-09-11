# hepta-orchestration-kernel

This crate is the canonical Rust facade for repository-local orchestration behavior that must not fall back to the legacy Node runtime.

It provides:

- a transaction-consistent planning snapshot builder bound to one revision and read barrier;
- an integer-only Pareto candidate router with deterministic tie breaking;
- a hierarchical resource prepare/commit/finalize ledger with generation fencing and conservative ambiguity recovery;
- low-cardinality privacy-safe telemetry that has no free-form identity fields;
- canonical workload performance qualification bound to exact source, binary, configuration and host-profile identities.

The crate does not mint production authority. Target-host performance, external credentials, key custody, release, portal and submission acceptance remain independently controlled evidence.
