# Legacy supplied-data planning contracts

Branch consolidation preserves three earlier public contracts under
`hepta_control_plane::legacy_planning`. The current planner selection,
optimizer calibration and telemetry journal APIs keep their existing behavior.

| Module | Preserved Git blob | Contract |
| --- | --- | --- |
| `calibration` | `67b74b797bdfcbef4732b76e2a2b0c1f88088440` | Fresh same-workload/predictor samples, p50/p95 duration/cost error, underestimate rate, confidence and expiry. |
| `model_selection` | `fb918ca567885cd749b0a486becfdfb6c09b671e` | Separate p95, underestimate and confidence gates for predictor champion/challenger selection; explicit both-unsafe and insufficient-improvement results. |
| `observability` | `09072e726f8acb752098683ba0ae3f8c1ccb6524` | Per-producer consecutive sequence high watermarks, exact retry/conflict handling, retention pruning, hashed exports and module/version-scoped calibration samples. |

The origin is `codex/rust-function-gap-closure-20260911` at
`409b2077029162f1ba718b7590d3e597688d1a69`; the other model-selection blob
`2b53107163a443427e075c01115f72c739ab10c1` differs in formatting. Imports now
resolve the preserved calibration types inside this namespace. Algorithm and
wire fields are unchanged. The shared canonical hash implementation is identical
to that source branch; provenance comments are the only other port edits.

All records use closed serde objects and explicit integer milliseconds,
micro-US dollars and parts-per-million. The calibration window has at most
100,000 samples, identifiers at most 128 ASCII bytes and checked error/rate
arithmetic. Policy/time/shape/mixed-workload failures retain the original error
enums. Ledger retained signals are capped at 1,000,000 and fields at 64, with
configured cardinality and retention ceilings. Exact export hashes use the
original canonical body, including the original ordered signal vector.

These are in-memory algorithms over caller-supplied observations. Report hashes
are copied into a decision and do not authenticate measurements or signers.
`select_predictor_v1` checks shape, time and thresholds; it does not rebuild a
supplied calibration report's hash. The retained high-watermark map survives
pruning and has no independent lifetime-wide producer-count limit. Callers must
bound the input population and owner lifetime; this legacy profile is not a
production telemetry sink. Extraction filters retained signals without an
implicit wallclock read; callers explicitly prune and apply the calibration
window. No data here grants resource, writer, provider or deployment authority.

Ten preserved unit tests exercise calibration time/bindings, independent safety
gates, challenger selection, exact retry/conflicting identity, privacy rejection,
retention/high-watermarks, complete export hashes and sample extraction:

```sh
cd rust
cargo test -p hepta-control-plane --lib legacy_planning --locked
```

The complementary grouped-module and matched-workload planner contract is
[documented separately](../../../hepta-orchestration-kernel/LEGACY_CALIBRATION.md).
