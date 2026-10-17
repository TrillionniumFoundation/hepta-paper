# Legacy module calibration and planner comparisons

`legacy_calibration_v1` preserves Git blob
`258c92497c27750587e2c457d91a5639e0d37879` from the original function-gap
branch. It coexists with the current calibration module; only provenance
comments and module registration changed. No current call site is redirected.

`calibrate_predictions_v1` groups up to 100,000 supplied observations by exact
module ID and semantic version, computes mean relative duration/cost/success
errors with checked arithmetic, and returns the original
`HeptaCalibrationReceiptV1` hash. Workload IDs remain supplied input;
the grouping key is module/version. `compare_planner_variants_v1` requires
exactly one observation per variant on an identical workload set, rejects hard
constraint violations and duplicate/missing observations, and compares summed
objective, summed latency regression and explicit challenger fallback policy.
Its output uses `HeptaChampionChallengerReceiptV1`. Both receipts keep
`grantsAuthority=false` and require no files, processes, database or network.

Closed serde records retain integer units, version checks and the original
identifier bounds. Comparison requires 1–10,000 minimum workloads, at most
100,000 total observations and a configured latency-regression threshold no
larger than 10,000,000 ppm. Contract, observation, mismatched-set, arithmetic and
encoding errors are explicit. The hash encoding is the original serde
JSON with length-prefixed domain/payload; it is intentionally not substituted
with the current module's different contract.

These calculations do not observe a real workload or qualify a deployed model.
The preserved tests cover version-separated grouping, deterministic hashing,
matched workload requirements, latency/fallback policy and zero hard violations.

```sh
cd rust
cargo test -p hepta-orchestration-kernel --lib legacy_calibration_v1 --locked
```
