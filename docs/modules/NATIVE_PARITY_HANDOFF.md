# Native decision, analysis and SLO ports

This is a technical contract for additive Rust source under the existing
`node-control-plane`, `resource-allocator`, `empirical-node` and `observability`
roles. It does not register a new authority, change global module states, or
establish full command/business parity. The existing Node composition remains
the incumbent. Source tests, static bindings and independent acceptance are
separate claims.

## Source and callable boundaries

| Incumbent source | Native implementation | Actual callable surface |
|---|---|---|
| `paper-domain/automation/campaign-state-policy.mjs` | `rust/crates/hepta-paper-service/src/campaign_policy.rs` | `evaluate_campaign_policy_v1(CampaignPolicyRequestV1)` |
| `paper-domain/automation/campaign-mode-resource-budget.mjs` | same module | `resource_budget` and `empirical_profiles` requests |
| `paper-domain/automation/analysis-statistics.mjs` | `rust/crates/hepta-paper-service/src/native_business/inference.rs` | `evaluate_analysis_inference_v1(&AnalysisInferenceRequestV1)` and `NativeBusinessJobV1::EmpiricalInference` |
| `paper-domain/automation/campaign-slo.mjs` | `rust/crates/hepta-paper-service/src/campaign_slo.rs` | `build_campaign_slo_report_v1(&CampaignSloRequestV1)` and `slo` policy request |

The [source index](../migration/native-function-ports.v1.json) inventories all 26
exports of these four incumbent files: 23 functions and three public status
constants. Several convenience functions share one native report computation.
These are export counts, not accepted production capabilities or additions to
the 57-route command denominator. The three constant arrays are exposed and
differentially tested as well; they do not silently disappear from the inventory.

`ProductionCollationV1::load()` in `hepta-legacy-compatibility` reuses the pinned
ICU/CLDR data already used for production record hashes. No locale-dependent
lexical fallback is installed. The service gains one direct dependency edge to
that existing locked crate; no package version or checksum changes are needed.

## Pure campaign-decision requests

`CampaignPolicyRequestV1` is a closed internally tagged enum, with snake_case
`kind` and enum-field names. Nested `CampaignNodeViewV1` records use camelCase.
The `hepta-campaign-policy` executable accepts no command-line arguments and
reads exactly one JSON request from stdin, capped at 4 MiB. It emits one JSON
result and newline. Malformed/unknown/oversized requests exit nonzero with a
fixed bounded diagnostic, without echoing input text.

| Kind | Required enum fields | Result and boundary |
|---|---|---|
| `constants` | No fields beyond `kind` | Three incumbent status arrays; no operational effect. |
| `projection` | `nodes` | Incumbent status, phase and review-round projection. An empty graph is not completion. |
| `ready` | `nodes`, `limit` | Ordered ready **node IDs**, not full legacy records. Missing or incomplete dependencies block readiness. A zero limit uses one. |
| `failure` | `node`, `retryable` | Retry/terminal decision and event kind. An already integrated prepared result retains the incumbent one-extra-attempt rule. |
| `descendants` | `nodes`, `root_node_id` | Transitive dependent IDs, including the supplied root; cycles terminate. This does not cancel any node or process. |
| `future_round` | `nodes`, `after_round` | Queued future-round IDs excluding convergence-tail kinds. |
| `command` | `campaign_status`, `command` | Pure apply/nextStatus result for pause/resume/cancel/fail/stop. No state is written. |
| `manual_retry` | `node` | Whether a terminally failed node may be queued according to the incumbent policy. No attempt is launched. |
| `resource_budget` | `nodes`, `selector` | Planned agent-call and benchmark CPU/GPU upper bounds. Prediction is not reservation, physical metering or spending authority. |
| `empirical_profiles` | `languages`, `requires_gpu`, `exclude_lean` | Language/GPU profile projection, preserving duplicate language entries. |
| `slo` | `request` | SLO computation described below, without live-store access. |

A node view requires `nodeId`, `kind`, `status`. Optional nullable fields are
`priority`, `createdAt`, `roundIndex`, `attemptCount`, `maxAttempts`, and
`preparedIntegrationStatus`. `dependencies` defaults to an empty list and
`requiresGpu` to false. A caller must explicitly project a fuller legacy record:
unknown fields are rejected rather than silently read as trusted configuration.

Limits are 4,096 unique nodes, 32,768 total dependency edges, 256 UTF-8 bytes per
identity/text field, and exact JavaScript-safe integer magnitudes. Counter sums
and products use checked arithmetic and reject results above 2^53-1. Duplicate
IDs, control characters, string/boolean numeric coercions and larger numbers
are outside the supported compatibility domain. Missing prerequisites are
retained as blocked dependencies; cyclic dependent traversal uses a visited set.

The incumbent's `priority || 100` means explicit zero ranks as 100. Sorting for
readiness/projection is stable and uses the pinned locale for `createdAt` and ID
ties. Dependent and future-round ID lists instead use UTF-16 lexical order,
matching JavaScript `Array.sort()` without a comparator. These are intentionally
different orderings. `createdAt` is an ordering string in this decision API,
not a trusted clock, lease or parsed timestamp.

`BenchmarkBudgetViewV1` contains `selectorType`, `seedCount` and
`minimumRepetitions`. It is only a projection of a benchmark selector. An
`authorized_dataset_mount` label does not confer dataset-access authority.
Resource prediction does not claim to execute or qualify a benchmark.

The [ready-request example](examples/campaign-policy.v1.json) is consumed by the
actual CLI test. Expected output is `["write"]`. It is not a service configuration.

## Paired statistical analysis

`AnalysisInferenceRequestV1` is closed camelCase JSON, version one. The complete
[executable example](examples/paired-analysis.v1.json) is imported by actual
library, business-dispatch and durable-service tests.

| Field | Required contract |
|---|---|
| `version` | Exactly 1. |
| `values` | 1–65,536 finite f64 paired observations/differences, in a deliberately chosen order. Dataset provenance and pairing validity are not inferred. |
| `confidenceLevel`, `familyAlpha` | Strictly between zero and one. |
| `bootstrapResamples`, `signFlipDraws` | 1–65,536 each. |
| `exactMaximumObservations` | 0–16; zero always selects Monte Carlo. |
| `seed` | Unsigned JavaScript-safe integer. |
| `salt` | Nonempty, at most 256 UTF-8 bytes, no control characters. |
| `quantileProbabilities` | At most 64 values in [0,1]. |
| `winsorLowerProbability`, `winsorUpperProbability` | In [0,1], lower not greater than upper. |
| `hypotheses` | At most 4,096 unique IDs and finite supplied p-values in [0,1]. IDs follow the bounded text contract. |
| `power` | Null or closed `alpha`, `targetPower`, `standardizedEffect`, `hypothesisCount`; target power is in (0.5,1), positive finite effect, 1–4096 hypotheses. |

Before resampling, `(bootstrapResamples + actualSignFlipDraws) * observationCount`
must not exceed 4,000,000. Exact sign-flip draw count is 2^n. The checked product
prevents a superficially small request from creating unbounded CPU work. Vector
allocation and the public dispatcher output retain their existing byte limits.

The implementation preserves the incumbent's Neumaier sum, Welford sample
standard deviation/error, interpolated quantiles, winsorization, percentile
paired bootstrap, exact and Monte Carlo one-sided sign flips, Holm-Bonferroni
adjustment, inverse-normal approximation and paired-power calculation. The
bootstrap and sign-flip streams each start from the same separately constructed
seeded generator, as the original functions do. Seed mixing uses the actual
production `hashRecord` domain and the existing native compatibility serializer;
a new ad hoc Rust seed format is not substituted.

NaN, infinity, nonfinite intermediate arithmetic, excessive work, conflicting
hypothesis identity and unsafe integer results fail without a prepared success.
One observation has null standard deviation/error, not a fabricated zero.
Hypothesis correction operates on the **supplied** p-values; it does not verify
that each p-value came from a valid experiment. P-value ties use pinned locale
ordering and positive/negative zero compare numerically equal.

`NativePairedAnalysisReportV1` contains the descriptive statistics, quantiles,
winsorized values, bootstrap interval, sign-flip result, correction rows, optional
sample-size estimate and seed hash. It retains `scientificAcceptance=false`,
`datasetAuthorityVerified=false` and `productionActivation=false`.

The business enum adds `{"kind":"empirical_inference","request":...}` alongside
the original `empirical_aggregate` variant. It maps exclusively to `CAP-EMPIRICAL`.
The original seven example jobs are unchanged. The native implementation digest
now includes `inference.rs`, so registry/worker identity must be refreshed for
the new source rather than inheriting the old worker hash.

The actual service path is:

```text
NativeJobV1::Business / EmpiricalInference
-> admitted native worker binding
-> existing durable dispatch intent
-> bounded native inference
-> content-verified CAS report and evidence
-> independent prepared-result byte verification
-> existing SQLite sequencer and resource/cost debit
-> durable exact replay without duplicate debit
```

No additional journal, writer, process launcher, credential path or external
scientific authority is introduced. Generic resampling does not complete the
entire analysis-protocol validator, experiment executor or independent replication
chain. It also does not implement model authorship or reviewer quality evaluation.

## Native SLO report and input normalization

`CampaignSloRequestV1` consumes explicit timestamp/counter views rather than
calling Node date parsing or opening a production database. Limits are 4,096
campaign rows, 4,096 unique node rows, 32,768 events/dependencies and 16,384 telemetry
rows. Timestamps are null or unsigned UTC milliseconds through year 9999.
Counter totals must remain exact JavaScript-safe integers. Phases and latency
values must be finite and nonnegative. Unknown phase keys are rejected.

Campaign views require status, explicit `costKnown` and agent/CPU/GPU/token
counters. Node views bind ID/status, optional timestamp, dependencies and optional
child-session ID. Event views bind optional node ID, kind and optional timestamp.
Telemetry views contain a closed phase-key map, optional lock wait and optional
queue-contention count. Missing optional samples mean absence, not JavaScript's
`Number(null) == 0` coercion. A legacy adapter must perform and review this input
normalization before calling the native API.

The target defaults match the incumbent source but are **not measured production
SLO commitments**: success rate 0.95, queue P95 900,000 ms, recovery P95 300,000 ms,
and runtime quota 10 GiB. Explicit target changes are configuration changes.
Report computation preserves nearest-rank percentiles, cumulative histograms,
status counters, first-start queue waits, subsequent-start recovery times,
unknown-cost states and the original report hash. The last input completion event
for a node is retained, even when events arrive out of timestamp order; this is
incumbent behavior, not a newly certified event-ordering guarantee.

Absent samples remain `insufficient_data`. Neither a computed `campaign_slos_met`
status nor a matching report hash establishes authenticated telemetry, target-host
qualification, scientific validity or deployment authority.

## Validation and source binding

Run from the repository root with the locked compiler and Node oracle profile:

```sh
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test campaign_policy_parity --test analysis_inference_parity --test campaign_slo_parity --test native_business_service -- --nocapture
node docs/tools/validate-native-function-ports.mjs
node --test paper-core/tests/native-function-ports.test.mjs
cargo test --manifest-path rust/Cargo.toml --workspace --all-features --locked
cargo clippy --manifest-path rust/Cargo.toml --workspace --all-targets --all-features --locked -- -D warnings
cargo doc --manifest-path rust/Cargo.toml --workspace --all-features --locked --no-deps
cargo run --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --bin hepta-campaign-policy < docs/modules/examples/campaign-policy.v1.json
```

The three oracle adapters import the actual four incumbent modules; they contain
no copied expected-result algorithms. Tests verify Node/ICU/CLDR/profile and
source-byte hashes before comparing results. The campaign corpus uses 722
requests; statistical comparison uses 80 requests and 1e-12 absolute/relative
finite-float tolerance; SLO comparison uses 65 full reports and their production
hashes. Corpus size is not exhaustive proof. Rust's platform-dependent elementary
functions are not claimed to provide universal cross-platform bit identity.

The static source-index validator checks closed shapes, exact incumbent bytes,
export sets, native symbols and example/oracle/test links. Its output explicitly
says `testsExecutedByThisValidator=false` and `fullCommandParityAccepted=false`.
It cannot replace actual test execution, accepted input-domain decisions or
independent review. No existing machine status or accepted-parity row is promoted.

## Recovery, rollout and remaining work

Pure decisions own no persistent state. Statistical jobs use the existing service
intent/prepared/commit history; ambiguous started work remains subject to that
service's reconciliation contract. A pure math kernel does not authorize retry
of a provider call. Cost reporting remains the existing admitted upper-bound
settlement, not new OS metering.

An older executable does not understand the new business variant. Rollback must
stop admission of that variant and preserve completed/prepared histories and
compatible readers. Do not replace post-increment state with an older backup or
reuse a registry hash for changed native bytes.

`cancel-node` remains unmapped as a complete remote operation. The pure
`descendants` request merely calculates a dependency set: it does not stop an
in-flight child, reap descendants, settle costs or reconcile remote effects.
All 57 routes and their forwarded modes remain the full migration denominator.
General schema translation, permanent GC purge, real model/scientific evaluation,
branch dispositions, target-host/external evidence and Node retirement remain
separate obligations in the existing full-replacement acceptance contract.
