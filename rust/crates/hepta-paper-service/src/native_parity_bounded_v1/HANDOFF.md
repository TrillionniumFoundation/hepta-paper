# Strict normalized-input native contracts V1

`native_parity_bounded_v1` preserves three pure contracts recovered from the
retired native-parity transport payload during source consolidation. Callers
must opt into this namespace. Existing `campaign_policy`, `campaign_slo` and
`native_business::inference` public contracts and dispatch routes remain the
Node-parity entrypoints; this namespace has deliberately narrower inputs and
does not claim exact behavior for every input accepted by those entrypoints.

## Provenance and source disposition

The original eight-file payload is retained in the consolidation source archive.
Its decoded tar SHA-256 is
`d426fc7d952c57b945c11b25a2da386a8a03215c7ab745efda0c8f607b4d0dff`;
the obsolete workflow expected a different tar hash and was not executed.
The original policy, SLO and inference Git-format blob identities were
`c5550ae7cea14ea24cb07ddf47b4424b521ba4f3`,
`c23f0ba5bae54f94b39201b3b387102ca5734441` and
`fc771a7927f258449a6a0e6ee5cc393b6fa361e8` respectively. Namespace imports were
adapted, and the duplicate business-output adapter was omitted: the retained
inference API computes a report and cannot dispatch business work.

The [branch consolidation record](../../../../../docs/migration/BRANCH_CONSOLIDATION.md)
binds the archived transport, retained source and final branch identities.
Raw original source is archival evidence rather than an executable instruction.

## APIs and bounded input domains

- `campaign_policy::evaluate_campaign_policy_v1` accepts a closed tagged request
  for constants, projection, ready selection, failures, descendants, future
  rounds, commands, manual retry, resource budgets, profiles or this namespace's
  SLO report. Node records reject duplicate IDs and invalid bounded strings,
  enforce 4,096 nodes and 32,768 dependency edges, and use checked arithmetic
  restricted to JavaScript's safe integer range. Priority sorting uses pinned
  production collation; the API accepts normalized integers rather than general
  JavaScript coercions. Invalid input, overflow and unavailable collation return
  separate `CampaignPolicyError` variants.
- `campaign_slo::build_campaign_slo_report_v1` validates versioned normalized
  campaign/node/event/telemetry records before aggregating. It rejects duplicate
  node identities, unsafe counters, unknown telemetry phases, nonfinite or
  negative metrics, out-of-profile timestamps and invalid thresholds. Counter
  sums are checked rather than saturated. Empty measurements remain insufficient
  data. The report hash uses the shared production stable-JSON contract.
- `inference::evaluate_analysis_inference_v1` computes compensated statistics,
  quantiles, bootstrap intervals, exact or sampled sign flips, Holm adjustment
  and optional paired power. It validates probabilities, finite observations,
  unique hypothesis IDs, safe seed, sample/draw caps and a combined 4,000,000
  resampling-operation bound before allocating the repeated workloads. Numeric
  overflow returns `NativeBusinessError`; it cannot become a successful report
  with nonfinite values. Calculated evidence never grants scientific acceptance,
  dataset authority or production activation.

All functions operate on caller-supplied values. No production database, provider,
credential, lease, process or service state is accessed. There is no writer,
cutover or retirement capability, and no default CLI is rerouted to these APIs.
Rollback is a source change affecting explicit namespace consumers only.

## Verification

The integration targets are `native_parity_bounded_campaign_policy`,
`native_parity_bounded_campaign_slo` and `native_parity_bounded_inference`.
They retain the recovered contract vectors, hostile bounds and original Node
function comparisons. The oracle helper enforces finite process/input/output
bounds, owns and reaps its child, checks the complete production runtime profile
and matches exact incumbent source hashes. Node execution is test-only.
The inference business-dispatch checks were replaced with a deterministic pure
report/authority-ceiling check because this namespace has no dispatch adapter;
existing production-route tests remain separate.

Run from `rust` with the pinned qualified Node on PATH:

```sh
cargo test --locked -p hepta-paper-service --test native_parity_bounded_campaign_policy --test native_parity_bounded_campaign_slo --test native_parity_bounded_inference
```

The recovered `paper-core/tests/native-function-ports.test.mjs` also exercises
11 current static-validator regressions. It does not execute Rust functions or
promote command parity. Each result must be retained against the exact source
commit; this handoff does not declare a new successful CI or external acceptance.
