# Personal GPU operational gate check handoff

This handoff records the bounded Rust slice for
`operator/personal-gpu-operational-gate`. The accepted slice is read-only
`--check` receipt inspection. It does not execute GPU work, write a receipt,
grant production authority or retire the Node implementation.

## Source and call chain

| Source | Symbol | Responsibility |
|---|---|---|
| `paper-core/bin/personal-gpu-operational-gate.mjs` | `runPersonalGpuOperationalGateCli` | Incumbent CLI; `--check` loads an existing receipt, verifies it and exits zero only when `personalProductionReady` is true. |
| `rust/crates/hepta-paper-service/src/bin/hepta-paper-rust.rs` | `command` | Parses the Rust partial route, resolves Node-compatible roots/receipt defaults, performs bounded no-follow reads, emits JSON and preserves Node exit classes. |
| `rust/crates/hepta-paper-service/src/personal_self_hosted_gpu.rs` | `verify_personal_gpu_operational_receipt` | Verifies ready and blocked receipt shapes, nested field contracts, canonical blocker list, normalization and `personalGpuOperationalReceiptHash`. |
| the same module | `blocked_personal_gpu_receipt_v1` | Constructs the fail-closed fallback used when a receipt is missing or invalid; it never writes the fallback. |
| `rust/crates/hepta-paper-service/tests/personal_gpu_operational_gate_parity.rs` | six parity tests | Compares help, blocked/invalid-timestamp/ready fixtures, missing-receipt fallback and symlink rejection with the pinned Node oracle. |

The native route is:

```text
hepta-paper-rust personal-gpu-operational-gate --check \
  [--root PATH] [--runtime-root PATH] [--receipt PATH]
```

`--help` emits the incumbent usage text. `--write`, `--output-root`,
`--run-id` and `--deadline-ms` are accepted only in the parser-compatible
check-first surface; no Rust branch performs a write or starts execution.
Calling the route without `--check` fails closed with an explicit
“GPU execution is not ported” error.

## Receipt contract

The verifier mirrors the Node `buildPersonalGpuOperationalReceipt` and
`verifyPersonalGpuOperationalReceipt` semantics. A receipt must have exactly
the 17 top-level fields, profile/release policy constants, false external and
network action flags, a positive safe timestamp, canonical lowercase commit
when present, and a sorted unique string blocker list. Each nested GPU,
runtime, PDE, deep-learning and IR object is checked for exact keys, hash
format, fixed statuses and cross-field bindings. Invalid evidence is required
to be `null` in a blocked receipt, matching the Node builder's normalization;
the receipt hash is recomputed over the payload without
`personalGpuOperationalReceiptHash` using the production Node record hash.

Both classes are supported:

- A valid ready receipt has no blockers, `personalProductionReady=true` and
  exits zero.
- A valid blocked receipt has the exact derived blockers and
  `personalProductionReady=false`; it is emitted unchanged and exits 2.
- A missing, unreadable, unsafe or malformed receipt emits a newly constructed
  fail-closed fallback with a `personal_gpu_gate_failed:*` blocker and exits 2.

The check read mirrors Node's scoped reader: the parent scope must be a real
directory, the receipt must be a regular single-link file, the final open uses
`O_NOFOLLOW|O_CLOEXEC`, reads are capped at 64 MiB, and device/inode/mode/size/
mtime/link-count identity is compared before and after the read. No owner or
permission requirement is added beyond the Node contract.

## Execute boundary

The Node execute path is not represented by this route. It requires a real
single-device `nvidia-smi` observation, a loaded digest-bound Docker image,
private PDE and CuPy deep-learning runs, same-device deterministic replay,
process-isolated CPU oracle, sealed holdout evaluation, clean exact source
provenance and private artifact publication. A receipt check cannot mint any
of those facts. Second-hardware evidence, external authority, release
promotion, production activation, target-host qualification and Node
retirement remain open migration/acceptance work.

## Verification

Use the pinned Node v22.23.1 and Rust 1.98.0:

```sh
export PATH="$PWD/../toolchains/node-npm/node_modules/node-linux-x64/bin:$PATH"
rustup run 1.98.0 cargo test --manifest-path rust/Cargo.toml \
  -p hepta-paper-service --test personal_gpu_operational_gate_parity --locked
rustup run 1.98.0 cargo clippy --manifest-path rust/Cargo.toml \
  -p hepta-paper-service --lib --bin hepta-paper-rust --all-features --locked -- \
  -D warnings -D unsafe_code -D unused_must_use \
  -D clippy::todo -D clippy::unimplemented -D clippy::unwrap_used \
  -D clippy::expect_used -D clippy::panic
```

The command map remains `partial_local_source` with
`compatibilityDecision=candidate`; this handoff does not claim accepted parity,
production activation or Node retirement.
