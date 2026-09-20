# Personal GPU operational gate check handoff

This handoff records the Rust source candidate for
`operator/personal-gpu-operational-gate --check`. It verifies existing receipts
and supports the incumbent failure-only `--check --write` publication path.
GPU execution and independent migration acceptance remain open.

## Source and call chain

| Source | Symbol | Responsibility |
|---|---|---|
| `paper-core/verification/personal-gpu-operational-gate-runner.mjs` | `runPersonalGpuOperationalGateCli` | Incumbent argument, check, fallback and private-publication behavior. |
| `rust/crates/hepta-paper-service/src/bin/hepta-paper-rust.rs` | `parse_personal_gpu_arguments` / `command` | Strict argument parsing, roots/defaults, check result and failure-only write dispatch. |
| `rust/crates/hepta-paper-service/src/personal_self_hosted_gpu/files.rs` | `read_personal_gpu_receipt_v1` | Bounded descriptor-pinned receipt reads and path/metadata race rejection. |
| `rust/crates/hepta-paper-service/src/personal_self_hosted_gpu/wire.rs` | `parse_personal_gpu_operational_receipt_v1` / `personal_gpu_receipt_json_v1` | Preserves JSON property order, normalizes JavaScript numbers, verifies the wire contract and emits the original valid receipt in Node's pretty layout. |
| the same module | `encode_personal_gpu_operational_receipt_v1` | Orders locally built fallback fields to satisfy the Node verifier. |
| `rust/crates/hepta-paper-service/src/personal_self_hosted_gpu.rs` | `verify_personal_gpu_operational_receipt` / `blocked_personal_gpu_receipt_v1` | Value contracts, normalization, UTF-16 blocker sorting, production hashes and fail-closed fallback construction. |
| `rust/crates/hepta-paper-service/src/operational_status/provenance.rs` | `current_operational_code_provenance_v1` | Stable Git/content/package provenance; failed provenance produces a null commit in the fallback. Release commit overrides are ignored. |
| `rust/crates/hepta-paper-service/src/personal_self_hosted_gpu/publication.rs` | `write_personal_gpu_receipt_v1` | Private parent provisioning and descriptor-relative atomic fallback publication. |
| `rust/crates/hepta-paper-service/src/personal_self_hosted_readiness.rs` | `read_private_gpu_json` | Enforces the same wire-order contract for CPU/GPU readiness while retaining invalid-receipt diagnostic fields. |

```text
hepta-paper-rust personal-gpu-operational-gate --check [--write]
  [--root PATH] [--runtime-root PATH] [--receipt PATH]
```

`--help` emits incumbent usage. The strict parser accepts `--option=value`
and separate values, rejects duplicate/unknown options, empty/missing values,
boolean assignments, separators and positional arguments with Node's exit 2
and stderr. `--output-root`, `--run-id` and `--deadline-ms` are accepted but
unused by the check-first path. The default runtime is the installed source
workspace's sibling runtime, independently of provenance `--root`; a nonempty
`HEPTA_PAPER_RUNTIME_ROOT` or explicit `--runtime-root` overrides it. Calling
without `--check` still returns an explicit unsupported GPU execution error.

## Receipt contract

A receipt has exactly 17 top-level fields in builder order, fixed local-policy
and release-boundary object order, false external/network-action flags, and
an exact production record hash. Nested evidence property order is retained,
not forced into a sorted order. Duplicate JSON properties use the first
position and last value, like JSON.parse. The verifier supports numeric/array
string coercion where the Node contract explicitly requests it, case-insensitive
nested SHA-256 checks, safe integer memory/time checks and JavaScript UTF-16
blocker sorting. Invalid timestamps are allowed only in correctly hashed
blocked receipts with the required timestamp blocker; positive readiness
requires a positive safe timestamp. Invalid evidence normalizes to null.

- Valid ready receipts exit 0; valid blocked receipts exit 2. Their JSON output
  preserves Node's two-space layout and nested order. Neither is rewritten,
  even with `--write`.
- Missing, unreadable, unsafe or invalid receipts yield a new hash-bound blocked
  fallback and exit 2. Without `--write`, no publication occurs.
- With `--write`, only this failure path publishes the fallback. Publication
  errors leave the CLI blocked and reporting the fallback, as Node does.

The reader requires a real parent directory, regular single-link leaf,
64 MiB bound and `O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC`. The full mtime (seconds plus
nanoseconds), device, inode, mode, size and link count are compared for the
retained descriptor and named path before/after reading. Parent/leaf symlink
rebindings are rejected. A symlink above the parent scope is permitted by the
incumbent reader. The nonblocking open additionally prevents FIFO swaps from
hanging the process.

Publication creates missing directories with mode 0700 and requires an owned,
private real parent. It creates an exclusive mode-0400 temporary leaf, writes
and fsyncs it, verifies the retained parent, renames relative to that directory
and fsyncs the directory. Existing temp collisions are untouched; failed
publication cleans only the temp created by this invocation. A valid existing
receipt bypasses all write operations.

## Remaining compatibility and execute gaps

Malformed JSON currently uses `personal_gpu_existing_receipt_invalid` instead
of reproducing V8's detailed parse-error string. The ordered serde parser also
rejects unpaired UTF-16 surrogate strings and out-of-range JSON numbers that
JSON.parse can represent. Those inputs need additional wire-level work; the
successful fixture matrix does not establish exhaustive check parity.

The complete execute call chain remains unported: single-device nvidia-smi
observation, digest-bound Docker image loading, private PDE and CuPy runs,
deterministic replay, process-isolated CPU oracle, sealed holdout evaluation,
exact provenance and artifact publication. Implementing that orchestration
is source work; qualifying its real hardware behavior additionally requires
a suitable host and evidence. Second hardware, external authority, release
promotion, production activation, target-host qualification and Node retirement
remain open acceptance work.

## Verification

The integration suite compares strict parser stderr/exit codes, ready/blocked
receipts, invalid timestamps, inline values, read-only successful checks,
failure publication and permissions, nonprivate-parent refusal, full provenance,
coerced fields, Unicode blockers, duplicate properties, nested field order,
forged/reordered receipts, ancestor symlinks and hardlinks against pinned Node.
Unit regressions inject whole-second mtime changes, post-read parent rebinds,
FIFO open races, publication parent rebinds and reordered readiness evidence.

```sh
export PATH="$PWD/../toolchains/node-npm/node_modules/node-linux-x64/bin:$PATH"
rustup run 1.98.0 cargo test --manifest-path rust/Cargo.toml \
  -p hepta-paper-service --lib --test personal_gpu_operational_gate_parity \
  --test personal_self_hosted_readiness_parity --locked
rustup run 1.98.0 cargo clippy --manifest-path rust/Cargo.toml \
  -p hepta-paper-service --lib --bin hepta-paper-rust --all-features --locked -- \
  -D warnings -D unsafe_code -D unused_must_use \
  -D clippy::todo -D clippy::unimplemented -D clippy::unwrap_used \
  -D clippy::expect_used -D clippy::panic
```

The command map remains `partial_local_source` and `compatibilityDecision=candidate`.
This handoff does not grant accepted parity, production activation or Node retirement.
