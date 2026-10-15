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

## Passive repository-asset JSON compatibility

The ordinary `verify repository-assets` route reuses the existing passive Node date parser and bounded JSON coercion owner. Raw report fields preserve JavaScript Number rounding and original JSON types; restore receipts use strict primitive identity, and compound JSON members do not acquire object identity from equal bytes. This passive parser does not validate signed clocks, leases or external-reference authority.

The executable descriptor in `docs/tools/node-rust-asset-route-acceptance.mjs` supplies the same 41 data profiles to the normal copied frontends and the route contract: five argument modes yield 205 complete output or complete refusal-message comparisons. The existing contract also retains grammar, termination, unknown-result and fresh-retry cases. `routeAcceptanceCaseCountsV1()` derives counts from that executable owner. The Rust test owners are `repository_assets::coercion::tests`, `repository_assets_parity::domains`, and the existing qualified passive-date differential owner. Finite UTF-8 JSON is bounded to 16 MiB and depth 256; arbitrary custom methods, unpaired UTF-16, numeric overflow, non-array asset collections and unproven primitive-asset domains remain outside v1. Source observations do not change the 57-route decisions; current committed H/M acceptance and target-host retirement remain separate requirements.

## Ordinary local release-integrity key maintenance

`hepta-paper-rust maintenance release-integrity-key -- ...` now dispatches the existing local Ed25519 key owner with the original registry grammar, default deployment root and complete ordinary parameter-failure report. It uses no Node process. Status and explicit create-once provisioning preserve the original reports, physical decoupling, isolated-runtime refusal, pair validation, no-overwrite lock and identity-checked publication. Ready status reads the pair internally to verify consistency; reports contain no private key bytes. This key authenticates build/archive integrity only and grants no academic, referee, submission or production authority.

The controlled CLI borrows one cancellation flag and absolute deadline. Cancellation remains active around the existing read/write/publication hooks; cleanup retains the original identity checks and may remove only this invocation's owned artifacts. Actual copied test-ELF SIGTERM and SIGKILL owners verify clean cancellation with fresh retry, and locked unknown crash leftovers with no automatic repair. Two actual copied ordinary-frontend owners compare 21 complete Node parameter/default reports and isolated refusal, then create/reuse a synthetic key and preserve unknown pair contents; all 22 existing key differential/recovery owners remain required. These observations retain all 57 compatibility decisions; fresh committed H/M qualification and actual installed retirement remain separate.

## Ordinary passive external-authority intake

The ordinary operator external-authority-intake command uses the original closed registry arguments, fixed deployment workspace, four configuration environment fields, nullish precedence and lexical relative paths. The ordinary route uses the existing offline author identity verifier and bounded pinned private configuration readers under one borrowed cancellation flag and absolute deadline. Files must belong to the current UID, have no group/other permissions, and remain the same regular single-link file across the read. It never invokes a provider, signer process, reads a signing private key, or mutates service state.

Three copied ordinary-frontend owners compare 16 complete Node grammar/help reports and 21 passive configuration/default/path/header reports, plus cancellation, expiry, fresh stateless retry and unknown frontend refusal. Three additional V3 owners compare 44 complete original Node reports for Ed25519 signatures, signed wire order, time windows, revocation, independence, pins, file policy and descriptor errors; they also execute the ordinary copied frontend with joint passive author/KMS readiness and original cancellation, expiry and fresh retry. The four original intake owners, the original author identity owner with 26 complete cases, and seven existing signature/wire-order unit owners remain required. V3 inspection reuses the original pinned evidence verifier, collation and record hash under the borrowed cancellation and absolute deadline. It hashes public command files and credential-directory metadata but never executes those commands, reads credential contents or grants release/submission authority. Configured passive readiness leaves live principal binding, independent backend probe and active-key challenge deferred; fullProductionReady, externalActionPerformed and serviceStateChanged remain false. Actual accounts, live verification, provider billing and installed migration/canary/rollback/retirement remain unaccepted. The versioned bounded regular-file/JSON/Ed25519 domain and its size limits do not establish unbounded Node input equivalence. All 57 static decisions remain unchanged pending fresh immutable H/M and own-consumer acceptance.


## Ordinary personal, nested-runtime and portal qualification

The ordinary operator personal-self-hosted-readiness, nested-runtime-platform-qualification and portal-target-qualification routes reuse their existing native inspectors and signed-input validators. Their normal forwarded grammars come from the canonical resolver; standalone-only flags remain outside the normal registry. Grammar and help precede deployment-root selection. Copied executables use the existing deployment-marker owner, relative inputs use the selected physical workspace, and unknown copies require an explicit native root. The adapters preserve each original help format, full report, exit code and local side effects.

Each ordinary adapter supplies one cancellation flag and absolute deadline to its existing owner. Personal inspection uses the existing bounded Git observer and SQLite backup API, reads the backup hash in bounded chunks and retains source descriptor identity; its supported database domain is capped at 16 GiB. Passive date observations reuse the bounded native Date/TZif owner; historical offsets and mapped legacy timezone identifiers are a compatibility domain, not a signed-clock authority. Nested input checks retain original file and signature limits. Portal import uses the existing local lock, identity-checked atomic publisher and rollback; it performs no portal network operation.

The three native normal test files execute original Node frontends and copied Rust frontends against the same inputs, including actual local database backup/restore, independently signed qualification fixtures, and an actual local portal registry import with matching receipt and registry bytes. Their shared fixture lives in paper-core/tests/support/native-qualification-normal-fixture-v1.mjs. Original standalone differential owners and the inherited-control unit owners remain required. Immediate SIGTERM/SIGKILL observations prove unknown-entry interruption and fresh same-namespace retry, not a specific SQLite or publication crash phase.

Malformed runtime errors, broader unproven Date.parse/alias domains, database-backup death cleanup and publication-specific unknown-result recovery remain explicit compatibility work. Synthetic signing fixtures do not establish prepared independent accounts, live platform or portal qualification, provider billing or installed retirement. The bounded input domain and passive/local outputs do not grant academic, release, submission or production authority. All 57 static decisions remain unchanged; current committed H/M acceptance still requires its own fresh execution.


The original `operator personal-gpu-operational-gate -- --check` entry reuses the existing GPU argument parser, ordered receipt/hash verifier, filesystem reader, JSON encoder and local fallback publisher. Ready and blocked receipts preserve the original pretty bytes, newline and exit codes; `--write` on a valid receipt remains read-only. Missing or invalid receipts produce the original personal-only blocked receipt. Failed `--write` binds the opaque original retained receipt or genuine missing edge through the existing publisher to its final rename; it never adopts a freshly observed replacement. A fresh same-namespace check validates those actual published bytes without rewriting them. Physical copied deployment defaults and relative runtime/receipt/provenance paths follow the ordinary Node worker workspace. Complete closed grammar and help precede deployment selection; ignored check-branch options retain their original behavior.

The normal facade inherits the original cancellation flag and one absolute 120-second deadline. The held input is rechecked after bounded wire generation. Preallocation uses the existing measured encoder with a 4-MiB ceiling including newline. Controlled publication checks the original path/control binding before namespace changes, preserves foreign regular replacements and create-delete epochs, and rechecks the original leaf plus its held parent after creating its own temporary. When a missing parent is raced by another actor's `mkdir`, controlled `EEXIST` is rejected without chmod or adoption. Existing aliases, FIFO, hardlinks and overlimit inputs cannot acquire a writable fallback proof and remain unchanged. The original None parser, reader and publisher remain unchanged, including their original parent-creation branch. These are cooperative observations rather than a hostile same-UID immutable lease.

Actual tests cover post-wire rewrite/replacement/alias, cancellation/expiry, original-target handoff refusal, missing-parent epoch and first-parent creation races, wrong path/control refusal, exact fallback streams and physical publication, fresh same-namespace retry, original flat fifteen-case differential and twelve reader/publisher cases. The five normal copied-entry owners use the original 600-second budgets. TERM/KILL observations are unknown entry points and do not claim publication-phase durability or actual GPU work. Synthetic ready/blocked fixtures prove only the receipt protocol and bounded local effects; NVIDIA hardware, Docker, PDE/DL workers, independent machine, provider/scientific authority, canary, installation and release/submission remain unqualified. No-check GPU execution is explicitly unported, remaining V8 diagnostic families and native bounds remain partial, and current canonical H/M qualification is separate.

## Ordinary runtime-image reproducibility, bounded native entry

`operator/runtime-image-reproducibility` uses the native strict parser for the original `--help`, `--action`, `--config`, `--receipt`, `--runtime-root`, and `--root` grammar. It resolves the recognized shipping ELF's actual workspace with the shared native-workspace owner; relative paths use that workspace, and an unknown copied ELF requires explicit ROOT. The ordinary profile requires the original builtin three profiles (`python`, `pythonGpu`, `r`) and the authenticated builtin source bindings. The standalone signed subset extension retains its original API scope.

The ordinary operation creates one 120-second deadline and retains the same cancellation owner through source/provenance inspection, both parallel pinned-FD verifiers, final source/configuration/authority checks, and local publication. This is an explicit finite native ordinary domain: the original Node wrapper had no overall deadline, and the standalone per-verifier timeout configuration is unchanged. An uninterruptible kernel wait cannot be claimed preemptible; cancellation after local publication can leave a durable effect and must be treated as an unknown response rather than absence of a write.

The process wire uses the original request constructor order. Receipt publication preserves the actual captured verifier JSON insertion order, checks its semantic equality with the verified response, and uses the existing production JSON encoder for the original pretty bytes plus newline. Both compact request and pretty receipt reserve newline space within the existing 16 MiB encoder ceiling; no publisher/storage limit is raised. Offline storage, Ed25519 verification, generation/revocation rules, and existing recovery owners remain in place. No caller-provided response-order projection grants authority.

The real fixed R source-CAS input has 107 original files totaling 93,548,999 bytes and 104 packages. Its lock and manifest ordering uses the existing production collation owner, matching the original Node locale comparison. The preserved original manifest and package bytes are validation inputs, not a fabricated replacement archive or host qualification.

Private actual checks compare all four ordinary mode reports and complete published receipt bytes against original Node for both original and deliberately reversed verifier response insertion orders. They exercise the physical shipping ROOT, relative flags, unknown copied ELF refusal/fresh retry, exact help and parameter refusal, both live verifier PIDs on cancellation/deadline, and real SIGINT/SIGTERM exit propagation. A tracked ELF remains part of provenance; exceeding its existing member limit is refused rather than silently excluded. Incumbent 22 differential cases and the affected original CAS/pinned-executable owners are retained. Current-head and prospective-merge qualification must be run on the newly integrated tree; private checks are not either qualification.

`HEPTA_PAPER_RUNTIME_ISOLATED=1` refuses ordinary verify/publish before I/O. This exact environment boundary is not a claim that every V3/V4 research profile is evaluated by this command. Research admission continues through the existing opaque qualification/profile owner, which grants neither release nor submission authority. The local synthetic verifier keys prove development behavior only; live independent account/trust custody and installed canary qualification remain unavailable.


The existing ordinary research admission owner also exercises each automatic, production, release and submission authority escalation through both launch and converge. All eight attempts must refuse before workflow initialization or a signed broker request and leave readiness, release/submission authority, provider execution and external execution false. Restoring the same non-authorizing template still requires the original real opaque admission. This expands the existing owner; no production authority code, version or static compatibility decision changes. Versioned V3/V4, retained trust/currentness, recovery, capability differential and the compile-fail boundary remain required on the current composition. Synthetic fixtures do not qualify real accounts, installed canary or Node retirement.


## Ordinary passive reconciliation

The ordinary operator/reconcile route validates the original forwarded grammar: legacy-terminal-active-residue and campaign-id. Its selected physical workspace supplies runtime defaults and relative runtime resolution, and the database stays fixed at hepta-paper.sqlite. It exposes neither the standalone database/clock overrides nor writer/apply execution. Both standard reconciliation and legacy terminal residue reports delegate to the existing planner and original hash owner. Existing standalone and None-control APIs retain their original behavior.

The normal facade uses one inherited cancellation flag and absolute 120-second deadline, the existing held ordinary readonly-store owner, and fixed readonly planner queries. SQLite progress checks bound virtual-machine work; row, cell and selected-byte limits are charged before JSON allocation. The retained store is checked after successful planning and after bounded report serialization. Supported input remains the existing 16-GiB main/WAL domain; selected rows are limited to 20,000, each cell to 1 MiB, selected bytes and output to 4 MiB. The existing 10-second SQLite busy wait remains cooperative rather than a hard preemption guarantee. Early scope/open failures close resources and produce no successful report; they do not claim a completed final currentness observation.

The normal Node owner executes original Node and actual copied Rust frontends, covering closed grammar before root selection, default/empty/relative/absolute runtime selection, both modes, actual scope refusals, unknown copied executables, explicit native root extension, unknown-entry SIGTERM/SIGKILL and fresh same-namespace retry. Actual system clocks are range-checked and each report hash is independently validated through the original Node hash implementation. Fixed fixtures far from cutoff boundaries compare complete values after aligning only observed business-clock fields; they do not prove arbitrary concurrent clock-boundary equivalence or raw JSON field-order parity.

Read-only SQLite coordination can create an empty WAL and a 32-KiB SHM, and subsequent opens can change their timestamps. Actual physical observations remain recorded, with database bytes and identity unchanged; no sidecar is deleted to pass. This uses the existing typed coordination guard and does not classify historical unknown SHM failures. Full query/publication-phase death recovery, malformed runtime stack formatting, unbounded Node inputs and complete canonical route acceptance remain explicit work. This passive adapter grants no provider, academic, release, submission, production or GC/apply authority.


## Ordinary R source CAS normal entry

The original operator/runtime-r-source-cas route validates the closed registry grammar, selects the actual physical workspace and delegates status/acquire to the existing filesystem, lock/hash, archive executor and publisher owners. Status ignores seed and concurrency exactly as the original Node frontend does. Acquire uses optional seed plus fixed public snapshot downloads for missing archives, default concurrency 6 and safe integers 1..16. Its actual normal composition admits the held context before validating numeric concurrency; malformed lock and seed refusals retain their original layer order. Complete fixed-domain successful/blocked status and acquisition reports preserve original property order, pretty bytes, newline and exit behavior. The standalone exclusive seed/snapshot modes retain their original contracts.

One inherited cancellation flag and absolute 120-second deadline govern selected filesystem reads, source validation, bounded transport, worker joins, publication and report serialization. All workers join before known failure cleanup or publication. A fixed 1-GiB aggregate is reserved before archive-buffer allocation; existing SourceObservation aggregate, per-document and archive bounds remain. Downloads retry at most three known-terminal failures; cancellation and unverified process or filesystem currentness are not retried as known failures. Seed identity failures do not silently fall back to the network. The output buffer remains limited to 4 MiB including its reserved newline. Context/status observers remain held and are checked after encoding, with the original ENOENT missing-edge epochs and all nonabsence refusals retained.

Failure cleanup requires both process-group completion and exact current retained archive/namespace evidence. Foreign replacements, aliases, extra directories, cancellation, expiry and unknown postrename outcomes preserve original bytes. This is cooperative observation, not a hostile same-UID immutable lease. Fresh acquisition in the same namespace can publish without adopting or deleting an older unknown stage; a valid published destination replays offline without seed or archive tools. The ordinary signal adapter cleans resources before restoring the original SIGTERM terminal status. Active TERM tests require actual curl children and the owned group to stop before any test-harness corrective signal. SIGKILL observations remain unknown execution points and use explicitly recorded harness child cleanup, rather than claiming cooperative product cleanup.

Actual copied Node/native normal frontends cover closed grammar/default/root/report behavior and whole seed publication bytes. Mixed seed/network orchestration compares the original Node composition with a fixed injected transport against the actual native ordinary CLI fixed-tool boundary, including default/1/16 concurrency, lock order, three-attempt retry and same-namespace fresh replay. These controlled archive fixtures do not certify public package provenance, signatures, a scientific run or installation. The actual public fixed Posit origin observation returned HTTP 307: the original Node and native normal entry both refused, kept the lock and left no source-CAS publication. No redirect/origin protocol was relaxed; successful current real-origin acquisition remains unavailable in that observed scope.

Malformed manifest/lock and broad coercion/error text, original unbounded inputs, native finite alias/63-MiB archive versus original 64-MiB network domains and complete canonical H/M acceptance remain explicit partial work. Hash-bound manifests prove captured integrity, not an origin or publisher attestation. Normal fixed-domain positives, source drift, known/unknown failure and retry tests do not qualify target-host canary/rollback or Node retirement, and grant no provider, academic, release, submission or installation authority.


## Ordinary verify/trust finite source and proof composition

The ordinary hepta-paper-rust verify trust command uses the nullary registry grammar and shared physical workspace selector. It loads the current V2 implementation manifest, actual current source/provenance, release-bound conformance and independently signed operational proof through the existing owners, then computes the complete legacy gate and original constructor-order stdout bytes. A blocked gate exits 1. Default sibling runtime/assets and relative environment paths resolve from the physical workspace, independently of caller CWD. Copied frontends outside the recognized layout require explicit ROOT.

One original cancellation flag and one absolute 120-second deadline cover both source observations, proof loading, stdout serialization and final retained-currentness recheck. The normal frontend holds an opaque report with the original observation until the original stdout bytes have been encoded, then rechecks current source and all imported witnesses before returning the report and bytes. The public Value compatibility API completes the same owner before returning, and APIs without inherited deadline preserve their old behavior. Existing JSON proof ownership/permissions remain strict; source data keep the original source-file policy. Imported JSON is capped at 16 MiB, source files at the existing 32 MiB and operation reads at 2 GiB. The finite normal profile admits safe ROOT-relative paths up to 4096 bytes, at most 4096 receipts and 4096 targets per receipt, and nonempty string capability IDs up to 256 bytes. Retained identity witnesses are deduplicated and reserved before cloning, with 4096 witnesses, 65536 metadata entries and 4 MiB of path storage. Named asset symlink identities use the existing complete metadata comparison so immediate inode reuse is not accepted. Exotic paths or containers outside this domain refuse explicitly.

Tests compare the actual original Node gate as complete Value, exit status and raw stdout using local synthetic integrity fixtures. They exercise default/relative/explicit layouts, missing or revoked proof material, currentness drift, cancellation, expiry and fresh retry. The existing count-only primitive and APIs without inherited deadline keep their original behavior. A ready source/proof report creates no execution permit, credential, release/submission grant or installed canary qualification; imported passed labels remain evidence data. Source-only fixture results require fresh canonical head and prospective-merge validation.


### Ordinary incumbent campaign queries

`operator campaign -- --action list|status|events|logs [options]` now uses the incumbent business tables through `ordinary_campaign_query`, retaining the existing main/WAL/journal/SHM observation and the original read-only SQLite factory. The original strict child grammar, complete help, physical worker ROOT/default/relative runtime roots, scoped migration 21-25 source-byte bindings, row mappers, prepared/integration receipt hashes, ECMAScript number/string/UTF-16 presentation, effective-status-after-limit policy, two-stage event-limit conversion, first-node-or-kind log selection and final newline are covered by actual normal Node counterparts.

The same cancellation flag and absolute 120-second deadline cover discovery, source migration observations, fixed read queries, bounded values and original output generation; the original database/source observations survive until final currentness checks. Existing reconciliation readers and the default factory keep their original behavior. The query does not admit author/provider execution, campaign writers, release or submission. Legal `--apply` is refused. Native readonly isolation can query without an unrelated submission-handoff database; the original Node bootstrap requires offline provisioning of that database. The positive counterparts use its original offline provisioner and verify its complete main-file identity and bytes remain unchanged. This is an explicit finite Native extension, not a full legacy-domain compatibility acceptance.

Three actual Rust controls and five whole normal Node owners cover legal and refused child parameters before I/O, actual campaign/node/event rows, default/relative/absolute roots, full JSON bytes and exit behavior, lineage/unknown-cost projections, prepared/schema refusals, missing stores, unknown binary copies, writer/alias refusals and actual unknown-entry TERM/KILL followed by fresh same-namespace queries. Those interrupt observations do not prove a particular SQL or durable workflow phase. Broad malformed/coercion/resource-limit domains, author-review-revision-commit-settlement-ACK, GC/retention/apply actions, signed exact-head/prospective-merge, target-host migration/canary/rollback and Node retirement remain separate unaccepted work.


## Host-owned operator dataset observations

`inspect_operator_dataset_harness_v1` observes a normal mount with the existing
CAS descriptor owner, the runtime-private signed envelope and trust store, and
the actual verified plugin startup context. Keep the returned opaque observation
alive through worker use. `receipt()` is diagnostic data; reconstructing it from
JSON does not create an observation. `private_definition_for_host` lends hidden
definition and splits to the trusted host; `verified_plugin_context_for_host`
lends the complete verified package, registry, startup scope and descriptors.
Both refuse blocked authority and recheck the original cancellation object,
absolute deadline, held/named inputs, and actual signed validity windows.
Consumers must call `assert_current` before and after each worker admission.
Borrowing these values neither mounts an oracle nor authorizes publication.

The finite reader keeps constructor order and ECMAScript UTF-16 authority ordering,
validates the complete dataset/split manifest and analysis/inference contracts,
and rejects exposure of hidden evaluation data in worker-visible splits. Source
files, private documents and accumulated reads keep their existing CAS bounds;
configured plugin bundle and trust bytes are held before verification without
secondary path reads. Nonabsolute configured paths, aliasing, unsupported date
coercions, custom JavaScript coercions and non-Unicode list values remain explicit
refusals. Local-purpose fixture signatures establish no external dataset, release
or submission authority.

The actual incumbent provisioner and reader are exercised by the Rust owner in
`operator_dataset_harness::tests`. Run the repository-pinned default command
`cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --lib operator_dataset_harness::tests:: -- --test-threads=1`.
The machine source registry records each exact owner and its pinned implementation
inputs. Source differential qualification does not establish an ordinary
author/evaluator consumer, independent provider execution, installed migration,
cutover or Node retirement.

## Journal reopen continuity

The ordinary one-shot journal retains the original full directory and leaf epoch
checks around each SQLite named reopen. An additional kernel namespace observer
is registered on every held ancestor before initial leaf/namespace pinning. A
failed full epoch may retry a fresh, unused connection at most three times under
the original deadline only while target continuity, leaf identity, namespace and
absence of sidecars all remain proven. Every accepted connection still passes
the original full reopen check before any PRAGMA or query. The durable journal
epoch is never reset. Target rename/return, permission changes, private unknown
entries, watch loss, queue overflow, cancellation and expiry permanently refuse
the current observation. An unrelated ancestor sibling change can be observed
without granting authority to a changed target. Closing an unused writable FD is
not a content mutation; actual modifications continue to invalidate the owner.

The machine registry binds actual namespace/overflow/control owners, the original
Node journal transaction/row/replay counterparts, leaf and parent replacement
refusals, and the real process interruption owner. These source tests require
fresh composed and signed head/merge verification after integration; earlier
failures remain evidence of their original subjects.

## One-shot invocation-owned journal markers

`ordinary_one_shot::execution::OneShotJournalV1::claim_external_action_marker`
closes the journal ownership prerequisite for a future native ordinary execute
composition. It consumes the original append result once and returns an opaque
`OneShotExternalActionMarkerV1`. Only a newly appended, acknowledged, independently
verified and still-current `provider_started` or `launch_started` event can carry
that claim. The original journal instance has an unforgeable in-process owner;
reopening the same inode, inspecting/copying JSON, a reservation, a non-marker
append, a terminal receipt, an exact replay or acknowledgment loss cannot restore
ownership. The public diagnostic inspection and its original wire remain unchanged.

A claim is consumed before its live check. A failed check therefore cannot be
retried after clearing cancellation or supplying a new observation. Marker checks
use the journal's original cancellation object and absolute deadline, retained
runtime/control/database identities, complete schema and audited head. A check
failure on the originating owner permanently revokes that marker. A wrong-owner
check does not consume or revoke the actual owner's claim. Check/drop performs no
journal mutation, rollback, deletion or external action; unknown durable markers
remain available for historical observation and conservative recovery.

This is a journal-ownership observation, **not complete execution authority**.
The existing SQLite compare-and-append transaction remains the sole journal
writer boundary. The marker does not hold a transaction across a provider call,
exclude a noncooperating external writer, or close the check-to-effect interval.
An admitted consumer must still retain and recheck immutable mount/dataset/source
owners, live provider runtime and credential bindings, native worker bindings,
create-only campaign admission and the native-store single-writer fence at every
side-effect boundary. The future checked worker binding must also match the
consumer's expected attempt and action phase; same-journal ownership plus a
current marker alone is insufficient. There is no callback dispatch API or Node fallback here.
The ordinary `--action execute` route still returns
`native_one_shot_ordinary_execute_not_implemented`; it is not marked ported,
qualified, production-enabled, or eligible for Node retirement.

The source comparator is the actual pinned Node repository's
`assertExternalActionSideEffectPermit`/`assertExternalActionMarkerCurrent`, using
both marker phases, one-use consumption, cross-repository refusal, exact replay,
terminal staleness and post-commit acknowledgment loss. Native tests compare
complete inspections and all four business tables including rowids, and retain
raw main-file identity/bytes through claim and read-only checking. Additional
native checks cover cancellation, inherited expiry, byte-identical inode
replacement and a peer's durable terminal append. Native permanent revocation
and retained full filesystem epochs are intentional stricter bounds than the
incumbent, not broad malformed-domain equivalence.

Run the scoped owners with the repository-pinned Rust toolchain and a supported
real Node oracle selected by `HEPTA_TEST_NODE`:

```sh
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --lib ordinary_one_shot::execution::marker::tests -- --test-threads=1
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --lib ordinary_one_shot::execution::marker::native_tests -- --test-threads=1
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --lib ordinary_one_shot:: -- --test-threads=1
```

The separately named `native_tests` exercise the ownership/negative paths using
`captured-input.v1.json`, a synthetic input whose original repository, domain,
fixture builder and capture-script source hashes are checked at test time.
Those native-only tests are not live differential passes. The `tests` owner
still launches the actual Node comparator through the unchanged bounded process
owner. If that owner's UID/kill checks refuse the host, record the differential
as blocked; do not relax the process guard or count a captured input as a pass.

The existing `execution-contract.v1.json` verifies source hashes before opening
the journal. Its comparator pins are:

- `paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs`:
  `aeab2c37a6118804afb07ff0978d5b3c7ac58efae18415abad47b04d21ed9de9`
- `paper-composition/automation/autonomous-research-one-shot-campaign-attempt-state-machine.mjs`:
  `4eba4bb9590404c1bda5f316a3414301f49a0cfcc1347489e23f61ad976b88ba`
- `paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs`:
  `a220e6c9367007ea32b2926f38ef9c2882e20f9f634a97e51aa044f47bfd81e5`

These synthetic business records establish neither provider identity/canary,
scientific acceptance, deployment migration/rollback nor external authority.
