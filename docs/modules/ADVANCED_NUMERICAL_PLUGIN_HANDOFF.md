# Native advanced numerical reference candidate

This is a bounded Rust reference-candidate projection of the incumbent
`paper-core/bin/advanced-numerical-plugin.mjs` route. It does not claim to be a
replacement for the signed out-of-process plugin runner or a scientific
qualification service.

## Source and callable boundary

| Incumbent | Native source | Entry point |
|---|---|---|
| `paper-core/bin/advanced-numerical-plugin.mjs` and `paper-composition/automation/advanced-numerical-plugin-composition.mjs` | `rust/crates/hepta-paper-service/src/advanced_numerical.rs` | `execute_advanced_numerical_plugin_v1(&serde_json::Value)` |
| same route | `rust/crates/hepta-paper-service/src/bin/hepta-paper-rust.rs` | `advanced-numerical-plugin REQUEST` |

The native command reads one bounded JSON request and executes the three
reference-candidate families that are actually implemented by the checked-in
`numerical-plugins/reference-candidates/worker.py`: `linear-algebra`,
`monte-carlo`, and `optimization`. Linear solves use bounded pivoting, Monte
Carlo uses a deterministic SplitMix64 stream, and convex quadratic optimization
uses bounded gradient descent. Every result is finite-checked and carries the
incumbent request/result record hashes through the pinned production Node hash
adapter.

## Request and result contract

The request must be an `AdvancedNumericalPluginRequest` with an exact
`advancedNumericalPluginRequestHash`, a bounded object input, JavaScript-safe
integer seed, and all three assurance contract hashes. A mismatched hash,
nonfinite value, oversized vector/matrix/sample/iteration budget, or unsupported
family fails closed. The result keeps the incumbent
`AdvancedNumericalPluginResult` shape and adds `nativeExecution: true`,
`productionQualified: false`, `qualificationStatus: reference_candidate_unqualified`,
and a stable blocker list. It is a local candidate artifact, not an incumbent
execution receipt.

## Explicit gaps

The native path does not load or verify the signed plugin bundle, trust store,
descriptor entrypoint/source/package identity, local runtime identity, immutable
work root, kernel OS sandbox, network isolation, resource receipt, GPU container
authority, external provider, or independent oracle/replay/uncertainty evidence.
It supports three of ten declared analysis families and intentionally uses a
native deterministic stream rather than asserting byte-for-byte parity with the
Python reference stream. It never signs, publishes, grants production
qualification, activates a provider, or authorizes Node retirement.

## Verification

```bash
cargo +1.98.0 test --manifest-path rust/Cargo.toml -p hepta-paper-service \
  advanced_numerical --locked -- --nocapture
cargo +1.98.0 test --manifest-path rust/Cargo.toml -p hepta-paper-service \
  --test advanced_numerical_plugin --locked -- --nocapture
```

The integration tests cover CLI execution, deterministic unqualified output,
request-hash tampering, and unsupported families. Differential reference
qualification, complete incumbent argument/status modes, sandbox/runtime
identity, all ten families, independent scientific acceptance, and production
activation remain open work.
