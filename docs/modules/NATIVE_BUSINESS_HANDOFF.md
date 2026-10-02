# Native business kernels: development handoff

This contract supplements the registered business-role specifications; it does not
replace the global plan or establish full Node-to-Rust business parity. The seven
kernels below are real Rust implementations that return prepared bytes. They do
not call a model, run arbitrary experiments, issue campaign commits, sign a
release, or send a submission. Production qualification and activation are
separate, independently evidenced states.

## Implementation and callable surface

The owner is `rust/crates/hepta-paper-service/src/native_business.rs`, with one
implementation file per kernel under `src/native_business/`. Use
`execute_native_business_for_capability_v1(job, capability_id)` at a capability
boundary. It rejects a mismatched job/capability before dispatch. The lower-level
`execute_native_business_v1` is a kernel dispatcher, not an authorization API.

`NativeBusinessJobV1` is a closed tagged JSON enum: the `kind` tag and enum variant
fields use snake_case. Embedded `ManuscriptSectionV1`, `ReviewPolicyV1`,
`ObservationV1`, and `BuildEntryV1` structs use camelCase. Unknown fields fail.
The public standalone `SubmissionPackageV1` struct also uses camelCase; do not
confuse it with the `prepare_submission` enum variant's snake_case fields.

The [executable examples](examples/native-business.v1.json) are direct kernel
inputs, NOT complete `ServiceRunV1` configurations or process-worker envelopes.
They contain no credentials, live accounts, deployment authority, or approvals.
The test harness reads this exact documentation file with `include_str!` rather
than maintaining an independent copy of the examples.

## Per-kernel contracts

| Capability / kind | Input and limits | Output and actual guarantee | Not established |
|---|---|---|---|
| `CAP-AUTHOR` / `author_draft` | Supplied `title` up to 512 bytes; `abstract_text`; 1–256 sections, headings up to 512 bytes; at most 4096 unique reference keys, each up to 256 bytes. Body fields up to 1 MiB, aggregate text up to 16 MiB. | One Markdown artifact and `NativeAuthorEvidenceV1`; validates and assembles supplied text, with sorted references. | Research planning, model-authored text/code, or revision quality. |
| `CAP-REVIEW` / `reviewer_assessment` | `manuscript` up to 1 MiB; policy with `minimumWordCount`, `requiredHeadings`, `forbiddenMarkers`; at most 4096 entries per rule list, each up to 512 bytes. | One JSON structural report and `NativeReviewerEvidenceV1`. Acceptance requires minimum word count, every required `##` heading, and no forbidden substring. | Independent model review, correctness, novelty, or venue acceptance. |
| `CAP-FORMAL` / `formal_certificate` | Assumptions, proof steps and goal in the closed proposition/step enums; at most 16384 steps and bounded assumptions; proposition depth at most 64 and node bound 65536. | One proof certificate and `NativeFormalEvidenceV1`; validates the supported propositional rules and final goal. | General theorem proving or complete Lean/formal-workflow parity. |
| `CAP-EMPIRICAL` / `empirical_aggregate` | 1–1000000 observations with unique bounded labels and finite `f64` values. | One statistics report and `NativeEmpiricalEvidenceV1`; count, mean, extrema, population/sample variance, input hash. | Experiment execution, dataset authority, multi-language workers or independent replication. |
| `CAP-NUMERICAL` / `numerical_linear_solve` | Finite square matrix and RHS of dimension 1–128; positive finite tolerance. | One solution/residual report and `NativeNumericalEvidenceV1`; rejects singular pivots and non-finite intermediate products/sums/residuals. | Tolerance is a pivot threshold, not a forward-error certificate; no blanket GPU/PDE parity. |
| `CAP-BUILD` / `build_package` | 1–4096 entries with relative safe paths (up to 1024 bytes), `mediaType` up to 256 bytes and bounded text `content`; no duplicate or file/directory-prefix collisions. Total encoded bundle at most 16 MiB. | TWO artifacts: JSON manifest, then `HEPTA-NATIVE-BUNDLE-V1` bytes; `NativeBuildEvidenceV1`. | LaTeX/PDF compilation, publication, signing or immutable retention. |
| `CAP-SUBMIT` / `prepare_submission` | `venue_id` up to 128 bytes; bounded relative artifact identifiers, cover letter up to 1 MiB, at most 64 supplementary references; optional advisory `recipient_hint`. | One prepared submission JSON and `prepared_submission_v1`, with `externalEffectAuthorized=false`. Recipient hint is not package authority. | Referenced artifact existence/content, remote delivery, portal account permission or submission receipts. |

Byte limits apply to UTF-8 bytes, not character counts. Identifier and text
validation remain implementation-owned; control characters, unsafe path
components and duplicate identities are rejected rather than normalized into an
accepted request. General dispatcher output must be nonempty, have at most eight
artifacts, and respect the per-artifact byte bound.

## Worked request and response interpretation

An empirical kernel request is:

```json
{"kind":"empirical_aggregate","observations":[{"label":"a","value":1.0},{"label":"b","value":3.0}]}
```

It returns prepared bytes describing count 2, mean 2, population variance 1,
sample variance 2, minimum 1 and maximum 3, plus hashes of the actual input/report.
These numbers are a deterministic example, not a claim that any experiment ran.
The public Rust return value is `NativeBusinessOutputV1 { artifacts, evidence }`.
`artifacts` contains raw bytes in process; process transport is a separate,
bounded base64 envelope described by the [service contract](../../rust/crates/hepta-paper-service/README.md).
A caller must not treat an evidence object, a hash-shaped string, or successful
structural review as an independent scientific verdict.

The bundle verifier `verify_native_build_bundle_v1(bytes, expected_sha256)`
checks bytes and bounded framing and returns in-memory entries. The expected hash
must come from independently selected manifest/CAS context. It does not extract
files or run content. Decoder and encoder share safe-path and collision rules.

## Errors, state and recovery

`NativeBusinessError` distinguishes `Contract`, `ProofInvalid`, `ProofLimit`,
`Numeric`, `SingularMatrix`, `Encoding` and `OutputLimit`. Errors return no accepted
prepared output. Direct kernel calls own no durable journal or writer authority;
identical valid input has deterministic output in the supported runtime profile.
The service, not the kernel, persists dispatch intent, prepared artifacts and
commit receipts and decides whether restart permits replay or requires
reconciliation. Re-execution of a pure kernel is not permission to repeat a
provider or external action.

The kernel itself has no long-lived process lifecycle or operational SLO. The
caller owns admission, CPU/memory limits, deadlines, telemetry and rollback. A
same-user process runner's resource/network declarations are not a hostile-code
sandbox. Module IDs, schema, implementation hash, configuration, attempt,
reservation and selected scientific/external verifiers must remain bound by the
qualified composition.

## Build, tests and handoff acceptance

Use the repository-pinned toolchain and lockfile. From the repository root:

```sh
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test documented_native_business
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test native_bundle_and_binding --test native_business_service
node --test paper-core/tests/node-rust-coverage-audit.test.mjs
node docs/tools/audit-node-rust-coverage.mjs
```

The documentation tests execute all seven examples through actual kernels,
check deterministic repeat output, artifact counts and evidence kinds, and
reject wrong capabilities and unknown fields. Existing tests cover bundle
corruption, bounds and service dispatch. These tests are source evidence only;
they do not exhaust every input boundary or prove complete business equivalence.

A handoff is accepted only with the exact commit/tree, passing tests, reviewed
interface/limit changes and a capability-specific parity decision. To expand a
kernel into a complete business role, separately implement and test the model or
runtime call chain, independent verification, resource/cost settlement,
crash/ambiguity recovery and external authority where applicable. Keep the
bounded kernel guarantee distinct from those additional guarantees.

## Paired-analysis extension

The seven original kernels above remain unchanged. The additional
`empirical_inference` job is a bounded paired-statistics computation sharing
`CAP-EMPIRICAL`, not a newly accepted full empirical business role. The
[native parity handoff](NATIVE_PARITY_HANDOFF.md) and
[executable request](examples/paired-analysis.v1.json) document its closed fields,
resampling work limits, source-bound Node oracle, finite arithmetic, durable
service integration and scientific/provenance exclusions.

## CAS research data worker v1

`NativeBusinessJobV1::ResearchDataWorkerV1` executes the three bounded data
calculations `artifact_integrity`, `csv_descriptive_statistics`, and
`json_assertions` through the existing worker-owned `ObjectStoreV1`, using
`CAP-EVD-VERIFY`. The request carries original parameter JSON text in
`parametersJson`; preserving that text avoids losing object insertion order or
UTF-16 escapes when an existing workflow serializes its job template. The worker
checks actual CAS bytes before and after calculation and emits a report artifact
whose evidence declares `scientificAcceptance: false` and
`externalEffectAuthorized: false`. The existing service owns prepared-result
persistence, commit, source tariff settlement, and unknown-start recovery.

Version 1 accepts at most 64 inputs and 4 MiB of aggregate input bytes, 64 KiB
parameter JSON, 100,000 parsed nodes at depth 64, and 4 MiB output. CSV additionally
limits 65,536 rows, 256 columns, 100,000 cells, and 64 KiB per cell. Input paths
must be bounded relative paths without empty, dot, parent, or backslash
components. Cancellation and changed or corrupt objects refuse without emitting
a report. The JSON data domain explicitly refuses inherited prototype paths and
custom coercion methods; CSV refuses the `__proto__` assignment domain. These are
versioned refusals, not assertions of complete JavaScript parameter parity.

The three calculations do not constitute the full paper research verification
adapter, independent reviewer execution, or ordinary batch route acceptance.
Normal scheduling must separately validate the actual worker plan, expected input
hashes, scientific profile, evidence contracts, and authority boundaries before
using their reports. No release or submission capability is granted by this
worker.

The data worker's JSON lookup borrows document subtrees. The exact shared JSON
encoder measures the complete report before any document subtree is cloned,
using the same 4 MiB encoded-byte ceiling, 100,000 value ceiling and 4 Mi UTF-16
unit ceiling for the output. Measurement and byte appends check cancellation.
The three calculations also tighten each CAS input read to the remaining
aggregate byte budget; an exhausted budget permits only the verifier's one-byte
sentinel so an empty immutable object remains representable. A nonempty object
then refuses before a larger input allocation.

## Actual plan-backed research data subworkflow v1

`native_research_plan::prepare_native_research_data_plan_v1` reads an actual immutable RESEARCH_WORKER_PLAN object and verified path-to-object bindings. It derives the three data worker jobs through the existing typed NativeJob contract. The actual original plan hash binds paper, task and claims; the planner does not admit formal workers or caller executable/authority declarations. Plan bytes are limited to 256 KiB, workers to 16, source bindings to 128, and aggregate inputs to 4 MiB, with the existing data-worker parameter and output limits. Selected CAS bytes are rechecked.

`native_research_workflow` composes these jobs as an existing LocalWorkflowV1. It preserves supplied ResearchWorkflowProfile identity and the trusted runtime registry, hard policy, resources and source tariff, and runs the original workflow admission. The actual plan is the initial CAS state. Its initialization calls the existing no-clobber kernel and populates that same CAS; failures after creation retain the incomplete runtime for existing recovery, without adopting or deleting it. Existing workflow Advance, Status and absolute through_steps retry perform durable commits and accounting.

Private actual tests match the three complete original Node data-result wires for one actual plan, then commit all three data reports, reopen without new attempts or source charges, preserve unknown starts after restoring corrupted inputs, and reject cancellation, missing objects, unknown modules and external-action policy before destination creation. Accounting uses source candidate tariffs, not measured provider charges. The whole original worker receipt, complete paper research adapter, ordinary inventory/batch consumer, paper six-node graph, independent review, scientific acceptance, live authority and H/M/host qualification remain open; these observations do not promote any 57-route decision.

## Derived research contracts v1

`native_research_contracts::build_native_research_contract_bundle_v1` computes the original four paper research contracts and their derived receipt from typed record inputs. It reuses existing text normalization, ECMAScript Number-to-string formatting, hash framing and read-only preflight budget owners. The caller cannot provide report hashes or counts. This component grants no scientific, release or submission authority and is not the complete evidence reader, academic intake or ordinary research verification route.

The v1 record domain shares one borrowed 1 MiB / 20,000-value / depth-64 input budget with 64 KiB strings, at most 1024 elements in each input collection and paper/task identifiers up to 256 bytes. Custom toString/valueOf coercion is refused. Item ceilings are the original 96 claims, 96 obligations, 160 evidence items and 96 reproducibility items; status retains original raw blocker/ref-array observations before normalization. Nine actual original Node cases compare all five full Values including hashes and safety fields, with two actual refusal/differential tests. Existing local submission calculations remain unchanged through the one-root budget wrapper. This is narrow calculation parity, not arbitrary parameter, full adapter, ordinary batch, independent-review, measured-provider-cost, Node retirement or H/M acceptance.

## Derived research claim graph v1

`native_research_claims::build_native_research_claim_registry_v1` and `transition_native_research_claim_v1` derive the original claim graph and guarded version transitions from bounded typed record inputs. Ordered duplicate identifiers, missing dependencies and complete cycle witnesses, formal and empirical canonical source bindings, NFKC manuscript text identity, original ECMAScript Number conversion and UTF-16 sorting are preserved. Caller hashes, counts and authority projections are refused.

The explicit v1 data domain has at most 256 claims and 256-byte identifiers, with the existing shared borrowed 1 MiB / 20,000-value / depth-64 input budget. Transition checks paper_task, claims, id, status and expected version together before any graph construction; the actual combined-overflow fixture proves that both historical halves pass separately and the complete request refuses. Custom object String coercion is refused. Actual original Node differential executes 16 full registries and three full version transitions, including hashes and statuses; refusal tests exercise cancellation, stale transitions, invalid status edges, budgets and caller projections. These records confer no scientific, release or submission authority and do not implement the complete source reader, academic intake, full research adapter or ordinary batch route. No H/M or installed-host acceptance follows from this component.

## Held research source snapshots v1

`native_research_source::inspect_native_research_source_snapshot_v1` derives complete valid source-tree workspace records, mode-bound manifest identity and the original source Merkle value through the existing held `SourceObservation` owner. The returned observation retains namespace/content descriptors and exposes `verify_unchanged` for later plan/queue admission. It accepts only an absolute physical source root; caller hashes, counts and authority projections are absent. Original fixed source exclusions, root-only mutable runtime exclusion, actual root venv names and pinned ICU 78.2 / CLDR 48 production collation are preserved.

The explicit valid v1 tree domain has at most 4 MiB aggregate file bytes, 4096 file/directory records, depth 64, 4096-byte relative paths and 1 MiB aggregate path bytes. Symlink, hardlink, special, non-UTF8 and aliased roots are refused; this refusal profile is not a claim of parity with every original negative report. Four actual original Node whole Values cover empty, modes, exclusions/nested runtime and Unicode ordering; real changed content/namespace, cancellation, expired deadline and byte-overflow refusals use the held owner. This read-only source identity grants no writer lease, scientific or external authority and does not implement evidence intake, the full adapter, ordinary batch, installed canary or H/M acceptance.

The 4096-record research profile counts included source files and directories after exclusions. The existing held observer separately bounds enumerated namespace entries, including excluded names, at 16384; its cached root enumeration is physically counted once.

Native literal theorem syntax derives comment masks, macro definitions, newtheorem declarations and theorem/proof pairing through native_latex_theorem_syntax. Its source limits and fixed work/match bounds have one machine source in the V1 Rust constants. The full source intake passes one borrowed LatexSyntaxControlV1 across files and phases with the existing request cancellation flag and absolute deadline. Actual original Node four-function values and UTF-16 offsets match in 937 cases; cancellation, deadline, sticky exhaustion and fresh retry have separate actual Rust coverage. These syntax records grant no academic, release or submission authority and do not establish the complete ordinary research route.


### Ordinary operator/batch inventory and preview

The normal `operator batch -- ARGV` frontend uses the existing strict child parser, selected physical workspace layout, held inventory owner, target-scope projection and complete campaign builder. The fixed `paper-core/config/paper-production-usage.v1.json` asset preserves incumbent help stdout; both Node and Rust consume that single asset. A preview is not a queue commit or completed author/reviewer/research execution.

The verification owner `paper-core/tests/native-batch-operator-normal.test.mjs` builds the current executable through the existing native producer, physically copies the ordinary ROOT/bin layout and actual Node module graph, and uses actual incumbent campaign registration to create its scratch inventory. It validates original task/state/semantic/scope/lineage/plan/report hashes with incumbent Node hash owners before explicitly normalizing clock fields. Relative argv and relative asset/runtime environment paths resolve at the wrapper's physical code workspace, while the independent caller directory stays distinct.

Native v1 retains explicit safety refusals: 300s cooperative admission, existing held inventory source limits, 8MiB retained-result reservation before result cloning, and a 16MiB bounded final report sink. The actual source and subprocess observers carry the remaining deadline; uninterruptible kernel work is not claimed to be preemptible. The normal batch adapter uses the existing immutable known-installed reader and holds missing WAL/SHM/journal edges across the whole observation; it never prepares coordination files. YAML skips business SQL after the same database admission. Only schema 25 with the exact base or complete known marker extension is accepted; partial, changed and unknown objects are refused without adopting old authority. The public ordinary inventory and verify/store reader keep their explicit ordinary-WAL semantics. Node warning/stack formatting, JSON object-key order, stricter schema and input bounds remain differences rather than complete route acceptance.

`--execute` remains fail-closed until the real mutation-coordinator/workflow boundary is connected. `--write-report` is local report persistence, not release or submission authority, and currently returns `native_batch_operator_local_report_persistence_v1_not_implemented` before file creation. The Node incumbent writes local reports/details/latest pointers under runtime/reports via its artifact write context; no unrelated irreversible permission is required merely to implement that local path. These are remaining implementation tasks, not external-account blockers.

Canonical 57-route operator/batch status stays partial. No preview, queued placeholder, synthetic fixture, old SHA or bounded source test grants production activation, target-host qualification, release/submission authority, writer cutover or Node retirement.

## Held research evidence and formal manuscript readers v1

`native_research_evidence::inspect_native_research_evidence_v1` retains the existing held `SourceObservation` for complete source/log/empirical file records and ordinary structured research records. Six actual original Node whole Values cover source/log roots, exact SQL-independent file identity, structured claim/evidence/experiment aliases, JSON key ordering, empty/absent inputs, short BMP String spread and the actual 125-character / 125-element derived object boundary. The existing record policy is reused by local_submission_projected_values_budget_v1: decimal-key bytes and derived nodes are reserved against the same shared limits before collection, while the final object retains the existing maximum of 128 fields. A legal 64 KiB ASCII experiment String is actually refused before expansion, cancelled input is refused, and a fresh valid retry succeeds. Supplementary String spread is explicitly refused because original JavaScript produces isolated UTF-16 surrogate field values unsupported by serde_json Value; an actual original Node whole JSON / code-unit receipt records this data-domain limit. The explicit v1 domain refuses a truthy `RESEARCH_WORKER_PLAN` and an empirical quality profile until canonical formal/empirical binding ports are composed; a null registry here is not an accepted full adapter. File bytes share a 4 MiB aggregate budget, each selected JSON is at most 1 MiB, and all selected output fields are checked against the existing shared 1 MiB / 20,000-value / depth-64 record budget before cloning. A repeated experiment identifier exceeding the aggregate output bound is actually refused before duplication.

`native_research_formal::inspect_native_formal_claim_universe_v1` derives actual include graphs, declarations, theorem and adjacent proof byte ranges, exact body/file hashes and formal universe identities. Twelve original Node whole Values include empty/unreadable roots, include ordering/cycles/limits, declarations/aliases/starred environments, malformed macros/comments, nested or unterminated environments, Unicode source bytes, alias cycles and invalid UTF-8. It reuses the frozen `native_latex_theorem_syntax` controlled parser and the existing source observation; `native_research_manuscript` supplies bounded Latin-1 / UTF-16 include and whitespace boundaries. A single cancellation flag and absolute deadline cover parser, token/include loops, alias traversal, sorting and hashing. The explicit read domain permits at most 128 visited files, 1 MiB per file, 4 MiB aggregate file bytes, depth 32, 4096-byte paths and 64 KiB aggregate visited paths; retained include/blocker projections have separate finite preallocation bounds and the final record value uses the shared record budget.

Both observations expose `verify_unchanged`; changed namespace/content, cancellation, expired deadline, overflow and unsafe source aliases are actual refusals. Production readers use Rust calculations and the existing filesystem owner; Node appears only in independent development differential tests. These source owners grant no scientific, release or submission authority and are not a full `runResearchVerifyAdapter`, ordinary batch execution, author/reviewer/provider billing, installed Node retirement, exact-head or prospective-merge qualification. Every historical failed compile/lint check remains in the review packet.
