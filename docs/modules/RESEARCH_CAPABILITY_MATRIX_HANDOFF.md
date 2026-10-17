# Native research capability matrix projection

This component migrates the pure `buildResearchCapabilityMatrix` application
function. It does not migrate the command's environment composition or live
readiness observation. It belongs to `module.rust-control-plane-service` and
never returns an activation capability, portal permission or qualification.

## Sources and API

- Incumbent: `paper-application/automation/research-capability-matrix.mjs`.
- Rust: `rust/crates/hepta-paper-service/src/research_capability_matrix.rs`.
- Entry: `build_research_capability_matrix_v2(&serde_json::Value) -> Result<Value,
  ResearchCapabilityMatrixError>`.
- Bounded local CLI: `hepta-paper-rust research-capability-matrix --request
  ABSOLUTE_JSON_PATH [--require-production-ready]`. The request file is limited
  by the service's 16 MiB JSON reader. The command prints the descriptive matrix
  even when `--require-production-ready` fails closed with a non-zero exit; that
  flag is only a diagnostic assertion over the returned projection.
- Static input data: `research_capability_matrix/registry-inputs.v1.json` contains
  registered empirical family/oracle identities, runtime languages, formal
  template identities, proof strategy capabilities and backend descriptors. It
  contains no readiness result or precomputed output hash. The parity oracle
  verifies both the source hashes and these inputs against current Node exports.

The function calculates all ten capabilities, exact boolean gates, four evidence
levels, explicit evidence caps, sorted unique blockers, runtime-language filtering,
scopes, limitations, aggregate readiness and the `ResearchCapabilityMatrix` v2
production-compatible hash. JavaScript default sorting uses UTF-16 code units;
this implementation preserves that order, including supplementary characters.
The hash is recomputed through the existing qualified production hash encoder.

## Inputs and authority boundary

The input is an already-observed descriptive readiness report. Values must be the
actual boolean `true`; numbers, strings, arrays and objects cannot satisfy a ready
flag. Caller-supplied `true` values may be reflected in the returned description,
as in the incumbent application function. That is not independent verification.
No effectful caller may treat this JSON as an authenticated readiness capability.

Explicit evidence can lower the inferred evidence level but cannot exceed it.
Invalid levels and promotions return the incumbent stable error codes. Local
submission handoff retains its `real_runtime_fixture` evidence ceiling by default;
GPU PDE and deep-learning readiness require their own operational and production
gates, and cannot be inferred from legacy generic GPU booleans. Even the fully
ready descriptive projection always has `universalResearchClaimed: false`.

## Effects, failures and limits

The function performs no file access, process launch, network request, state write,
key loading or readiness probe. It needs no production Node runtime. The caller
owns the input JSON and any size bound appropriate to its reader; this function
is not an unbounded-input CLI. There is no transaction, retry or recovery state.

Malformed blocker containers and non-string truthy blocker entries are rejected
with Rust-specific `research_capability_*` errors instead of reproducing Node's
incidental JavaScript exceptions. Generic blocker arrays reject every non-string
entry, including null/false, because their incumbent substring filters cannot
handle them safely. This deliberate input tightening is separate from successful
projection parity. Null readiness input is also rejected. Deployment inspection
is a descriptive pass-through and never establishes trust.

## Verification

`rust/crates/hepta-paper-service/tests/research_capability_matrix_parity.rs` invokes
`rust/oracle/research-capability-matrix-v2.mjs` under Node 22.23.1 and compares every
returned field and recomputed hash for more than 700 current-source cases. Cases
cover individually missing gates, mixed readiness, wrong boolean types, all ten
capabilities and evidence levels, explicit evidence errors, runtime images,
Unicode blocker ordering and deployment inspection. A separate negative test
checks malformed input rejection and legacy GPU fields. The same parity test
invokes the native CLI for the all-ready and empty oracle fixtures, checks the
complete JSON projection, and verifies that the optional production-ready
assertion exits non-zero for the blocked fixture while still emitting its
descriptive report.

```bash
cargo +1.98.0 test --manifest-path rust/Cargo.toml -p hepta-paper-service \
  --test research_capability_matrix_parity --locked
```

The Node oracle is test-only. Completing the operator route still requires native
`composeAutomationReadinessDeploymentEnvironment`, `queryAutomationReadiness`,
all local/external observer dependencies, the incumbent's other command modes,
and independent acceptance. This handoff grants none of those statuses.
