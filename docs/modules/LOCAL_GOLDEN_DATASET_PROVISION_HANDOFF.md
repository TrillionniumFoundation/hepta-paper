# Local golden-dataset provisioning handoff

This document describes the bounded Rust source slice for
`operator/local-golden-dataset-provision`. It is a migration handoff, not a
parity or production-activation claim.

## Source and call chain

The incumbent route is `paper-core/bin/local-golden-dataset-provision.mjs`,
which delegates to
`paper-adapters/automation/local-golden-dataset-provisioner.mjs` and its
no-clobber repository. The current native chain is:

| Rust source | Symbols | Role |
|---|---|---|
| `rust/crates/hepta-paper-service/src/bin/hepta-paper-rust.rs` | `command` | Selects the route, prints help/report JSON and exits 2 for the blocked execute report. |
| `rust/crates/hepta-paper-service/src/local_golden_dataset.rs` | `parse_local_golden_dataset_provisioning_arguments` | Parses the closed `plan`/`execute` option surface and rejects duplicate, positional or missing arguments. |
| `rust/crates/hepta-paper-service/src/local_golden_dataset.rs` | `inspect_local_golden_dataset_provisioning_v1` | Reads only explicit local inputs, checks private roots and immutable dataset identity, and computes the source-bound plan hashes. |
| `rust/crates/hepta-paper-service/src/local_golden_dataset.rs` | `execute_local_golden_dataset_provisioning_v1` | Rechecks the exact plan ID and returns a fail-closed blocked report before reading a private key or writing any output. |
| `rust/crates/hepta-paper-service/tests/local_golden_dataset_provision.rs` | three tests | Help bytes, plan no-write/execute refusal, production-root and symlink rejection. |

## Plan boundary

The plan path supports the checked-in `ml_algorithm_benchmark` harness profile.
It validates canonical private runtime/control roots, an immutable recursive
dataset manifest, complete split assignments, 32 or more seed/repetition cells
with eight cases per cell, research semantics, the local-only public trust-store
scope, and a maximum 31-day signed time window. It computes the Node-compatible
record hashes for the dataset, split, harness, analysis, semantics, trust-store,
private-key path, runtime scope and provisioning plan. It performs no writes and
never opens the private-key path.

The route rejects the built-in protected production roots, the incumbent
repository/workspace root, default sibling asset/runtime roots, and the
`HEPTA_PAPER_ASSET_ROOT`, `HEPTA_PAPER_RUNTIME_ROOT`, and
`HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT` environment roots before any
source-bound report is constructed. Symlinked roots are also rejected. The
analysis protocol now requires the canonical Node v1/v2 top-level and bounded
`ml_algorithm_benchmark` contract; the authority window is checked against the
current clock as well as the 31-day lifetime. Split assignments are checked
against the normalized eligible split set, public trust stores are checked for
global key shape/role/uniqueness and private-material absence, and harness
oracle values remain finite and bounded. It reports only local evidence and
always keeps `academicPromotionEligible=false`,
`externalTrustClaimed=false` and `externalActionPerformed=false` in its plan
payload.

## Execute boundary and remaining work

`execute` requires `--execute` and the exact plan ID, then returns
`rust_local_golden_dataset_execute_not_ported` with exit code 2. It does not read
private key material, sign the v4 local authority document, authorize a dataset
mount, or publish an envelope, trust store, mount, or receipt. This is an
intentional fail-closed boundary while the remaining contract is ported.

Still open are all-family harness and analysis-contract normalization, exact
authority-document signing and verification, runtime-bound envelope and mount
authorization, atomic no-clobber publication/recovery, complete CLI error and
environment compatibility, and independent command acceptance. The native
route therefore cannot establish academic promotion eligibility, external trust,
production readiness, or Node retirement.

## Validation

Run with the repository-pinned Rust toolchain:

```sh
cargo test --manifest-path rust/Cargo.toml -p hepta-paper-service \
  --test local_golden_dataset_provision --locked
```

The focused test compares help bytes with the Node entrypoint and verifies
source-bound plan hashes and the complete plan JSON with the Node entrypoint;
it also verifies no-write behavior, fail-closed execute, protected-root and
symlink rejection, semantic split binding, canonical analysis rejection and
authority-window failures.
