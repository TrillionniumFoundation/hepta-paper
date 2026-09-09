# Rust orchestration-kernel implementation record

This document records the repository-local source implementation for deterministic orchestration behavior. It is not a target-host, credential, release, submission, or production-activation receipt.

## Canonical implementation

The canonical Rust implementation is `rust/crates/hepta-orchestration-kernel`, re-exported by `hepta-control-plane` as its deterministic orchestration facade. Production callers must not fall back to the legacy Node runtime for any behavior listed here.

## Implemented contracts

### Transaction-consistent planning snapshots

`src/snapshot.rs` accepts observations only when every component is bound to one campaign revision and one shared read-barrier identity. Duplicate components, mixed revisions, mixed barriers, invalid hashes, stale observations, empty payloads, and aggregate size overflow fail closed. Components are canonically ordered before the snapshot digest is derived.

### Deterministic candidate routing

`src/router.rs` uses integer-only constraints and scoring. It first rejects infeasible or disqualified candidates, then derives a Pareto frontier, then applies an overflow-checked weighted score with stable candidate-ID tie breaking. Input order cannot change the selected candidate or route digest.

### Hierarchical resource transactions

`src/resource.rs` implements prepare, commit, finalize, cancel, restart recovery, and scope fencing across parent and child limits. Every reservation binds a scope generation. Prepared expired work may be cancelled; committed expired work remains ambiguous and is not automatically refunded. A scope cannot advance generation while an affected reservation is active.

### Privacy-bounded telemetry

`src/telemetry.rs` stores only fixed event, module, outcome, severity, and bounded label enums. The raw observation contract has no free-form campaign, attempt, path, account, host, artifact, message, credential, or provider field. Events are immediately reduced into deterministic counters and latency buckets; clock regression and counter overflow fail closed.

### Canonical performance qualification

`src/performance.rs` requires a complete, duplicate-free canonical workload set and raw sample durations bound to exact repository, commit, tree, binary, configuration, and host-profile identities. Median, p95, throughput, and regression are computed in checked integer arithmetic. Missing, duplicate, extra, invalid, or regressed workloads cannot produce an accepted result. Repository-local or hosted results never set production authority.

## Validation and status boundary

The crate and its `hepta-control-plane` facade are subject to the pinned Rust 1.98 workspace format, test, Clippy, rustdoc, supply-chain, exact-head, program-truth, and qualification workflows. Static module status may be promoted only after those exact-head checks succeed on an unchanged candidate.

The implementation does not create any of the following facts:

- target-host systemd, listener, cgroup, principal, reboot, storage, or 72-hour soak qualification;
- independent capability-key lifecycle evidence;
- authenticated production Codex credential custody or live role canaries;
- KMS/HSM, WORM, release, portal, or submission authority;
- private 263-file legacy replay acceptance;
- independent governance approval or production Node-retirement observation.

Those facts remain controlled by their existing external evidence packages and issues. The production activation path must continue to fail closed until the corresponding verified receipts exist.
