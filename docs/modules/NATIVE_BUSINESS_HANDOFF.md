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

`--execute` remains fail-closed until the real mutation-coordinator/workflow execution and authority chain is composed. `--write-report` now derives and persists the five local report artifacts with CAS objects, manifests and receipt-ledger provenance through `batch_local_reports::persist_native_local_batch_report_v1`. The private, versioned runtime namespace holds bounded prepared intents, known recovery and retained unprepared attempts; foreign or unknown state is preserved and refused. Existing completed Node vault materials are retained without adoption. Ordinary group data directories use the distinct local report directory type; private authority guards remain unchanged. This local persistence grants no release, submission, provider or business-store mutation authority. See the [local report handoff](../../rust/crates/hepta-paper-service/src/batch_local_reports/HANDOFF.md) for native safety bounds, namespace differences and actual normal/recovery test owners.

Canonical 57-route operator/batch status stays partial. No preview, queued placeholder, synthetic fixture, old SHA or bounded source test grants production activation, target-host qualification, release/submission authority, writer cutover or Node retirement.

## Held research evidence and formal manuscript readers v1

`native_research_evidence::inspect_native_research_evidence_v1` retains the existing held `SourceObservation` for complete source/log/empirical file records and ordinary structured research records. Six actual original Node whole Values cover source/log roots, exact SQL-independent file identity, structured claim/evidence/experiment aliases, JSON key ordering, empty/absent inputs, short BMP String spread and the actual 125-character / 125-element derived object boundary. The existing record policy is reused by local_submission_projected_values_budget_v1: decimal-key bytes and derived nodes are reserved against the same shared limits before collection, while the final object retains the existing maximum of 128 fields. A legal 64 KiB ASCII experiment String is actually refused before expansion, cancelled input is refused, and a fresh valid retry succeeds. Supplementary String spread is explicitly refused because original JavaScript produces isolated UTF-16 surrogate field values unsupported by serde_json Value; an actual original Node whole JSON / code-unit receipt records this data-domain limit. The actual formal `RESEARCH_WORKER_PLAN` domain is now composed through `native_research_canonical` using the same held source and aggregate read context; the empirical quality profile remains refused until both empirical reader ports are composed. A null or blocked registry is not an accepted full adapter. File bytes share a 4 MiB aggregate budget, each selected JSON is at most 1 MiB, and all selected output fields are checked against the existing shared 1 MiB / 20,000-value / depth-64 record budget before cloning. A repeated experiment identifier exceeding the aggregate output bound is actually refused before duplication.

`native_research_formal::inspect_native_formal_claim_universe_v1` derives actual include graphs, declarations, theorem and adjacent proof byte ranges, exact body/file hashes and formal universe identities. Twelve original Node whole Values include empty/unreadable roots, include ordering/cycles/limits, declarations/aliases/starred environments, malformed macros/comments, nested or unterminated environments, Unicode source bytes, alias cycles and invalid UTF-8. It reuses the frozen `native_latex_theorem_syntax` controlled parser and the existing source observation; `native_research_manuscript` supplies bounded Latin-1 / UTF-16 include and whitespace boundaries. A single cancellation flag and absolute deadline cover parser, token/include loops, alias traversal, sorting and hashing. The explicit read domain permits at most 128 visited files, 1 MiB per file, 4 MiB aggregate file bytes, depth 32, 4096-byte paths and 64 KiB aggregate visited paths; retained include/blocker projections have separate finite preallocation bounds and the final record value uses the shared record budget.

Both observations expose `verify_unchanged`; changed namespace/content, cancellation, expired deadline, overflow and unsafe source aliases are actual refusals. Production readers use Rust calculations and the existing filesystem owner; Node appears only in independent development differential tests. These source owners grant no scientific, release or submission authority and are not a full `runResearchVerifyAdapter`, ordinary batch execution, author/reviewer/provider billing, installed Node retirement, exact-head or prospective-merge qualification. Every historical failed compile/lint check remains in the review packet.

## Held canonical formal worker-plan composition v1

`native_research_canonical::inspect_native_canonical_formal_claim_registry_v1` derives the formal universe and claim bindings from actual held manuscript/include buffers. Sixteen complete original Node registry Values cover valid body/proof bindings, include graphs, missing/duplicate ids, duplicate theorem binding, unsafe/unlisted paths, wrong hashes/ranges and original obligation coercions. The existing manuscript identity/NFKC owner is reused through one crate-visible helper; no caller universe, source hash or count establishes acceptance. The crate-visible member accessor is limited to the observation's actual included records and rechecks exact captured size/hash plus the request cancellation/deadline; excluded/unlisted paths are not reopened.

`native_research_evidence::inspect_native_research_evidence_v1` now reads the actual worker-plan file and calls this native formal owner. Eight additional original Node whole Values cover the complete evidence/formal composition, including replacement of observed claims only when nonempty canonical formal claims exist, missing bindings, wrong hashes/duplicate ids, missing files and the original null-manuscript-path blocked result. The earlier six non-canonical complete Values and twelve formal universe Values are freshly revalidated. These source Values grant no scientific acceptance or formal kernel certificate.

`NativeResearchReadContextV1` in the existing manuscript support module is crate-visible and has a fixed 4 MiB aggregate. It reserves actual canonical held-root/member identities before file reading, so repository-root/source-member and source-root/member resolve to one physical key and repeated archive/JSON/member reads are charged once. Existing `SourceObservation` retains file descriptors, content and namespace guards. Size/identity changes, cancellation, expired deadline and any failed request make this context unusable; a fresh request creates a fresh fixed context. Actual tests establish two independently under-limit evidence/formal stages whose combined selected bytes exceed 4 MiB are refused before the excess file is read, duplicate charging is avoided, and fresh retry succeeds after the failed request. Per-file, paths, output records, parser work and absolute deadline limits remain independently enforced; the finite auxiliary context has at most 16,384 observed member keys. Public owned request APIs and the existing record hashes remain compatible in their previously accepted domains.

Node is used only by independent development differential tests for these production readers. Empirical claim/assertion universes, academic authority, full scientific worker/report/intake execution, ordinary six-stage batch execution, actual independent reviewer/provider billing, installed Node retirement and fresh H/M qualification are still open. Source-only component validation does not promote any canonical route decision or grant release/submission authority. All earlier real compile/lint/parity failures remain retained in this review packet.

## Held empirical claim manuscript universe v1

`native_research_empirical_claim::inspect_native_empirical_claim_universe_v1` derives the original empirical marker universe and canonical claim array from actual held manuscript/include bytes. Twenty-nine complete original Node universe and canonical-array pairs cover valid declarations, include order/cycles, ids, JSON and marker errors, UTF-8 bodies, macro blockers, missing paths, original Number/String coercion and negative-zero inputs. Source, corpus, universe, claim identity and receipt hashes are computed by the existing native record owner; caller projections do not establish acceptance. The same request cancellation, absolute deadline and fixed shared 4 MiB context are reused through the crate-visible composition API. Per-file 1 MiB, 128 files, bounded include depth/paths, record and string budgets are enforced before retained output allocations. Actual tests establish changed-content refusal, expired/cancelled requests, oversized body refusal, aggregate overflow with sticky failure and a successful fresh retry. Existing Number/String/number-value helpers gain crate visibility only; their implementation and old wire hashes are preserved.

The independently qualified Node process is used only by development differential tests, with actual whole output, process-group cleanup and source/tool guards. This component reads manuscript claims; it does not verify experiments, assemble the empirical assertion/presentation universe, grant academic authority, complete the research adapter, execute the normal six-stage batch, qualify a reviewer account or measure provider billing. No canonical route state, release/submission authority, H/M qualification or installed Node-retirement claim is promoted. Original compile and lint failures remain retained with their exact source identities.

## Observed research contract context composition v1

`native_research_contract_context::build_native_research_contract_context_v1` composes the existing research contract bundle and claim registry owners. Eighteen complete original `buildResearchContractContext` Values cover evidence-reference ordering/deduplication and the 128-reference cut-off, native-worker-required facts, the three canonical blocked registries, claim/obligation/evidence/reproducibility records, proposal-seed warnings and ordinary String coercion. A borrowed shared 1 MiB request guard precedes every owned-kernel input clone; actual combined overflow, malformed list, cancellation, expired deadline and fresh retry tests retain these boundaries. The independently qualified original Node module is used only by development differential tests. No caller status or contract hash becomes worker, scientific or external authority.

This is the contract-context source component to be called by the held evidence/research adapter composition. It does not itself execute workers, verify an experiment, assemble the full capability/intake/quality report or qualify the ordinary batch route. Academic authority, actual independent reviewer/provider cost, H/M and installed Node retirement remain separate unaccepted boundaries. Its existing String owner depends on the empirical-claim packet's three visibility-only changes; that frozen dependency must be integrated first, preserving its exact implementation bytes. Shared library/document changes are minimal and append-only, preserving all peer exports and facts.

## Held empirical assertion/evidence and shared parser composition v1

`native_research_empirical_assertion::inspect_native_empirical_assertion_universe_v1` reads the actual manuscript/include tree and presentation artifact bytes through the existing held source owner. Thirty-six complete original Node values cover assertion/presentation declarations, body and corpus hashes, valid PDF artifacts and hash refusal, marker/JSON/prose/environment errors, include ordering/cycles, symlinks, Latin1/CRLF offsets and optional actual empirical claim derivation. Actual tests establish held manuscript and artifact mutation refusal, cancelled/expired requests, preclone body overflow, shared aggregate overflow, sticky failure and fresh retry. The existing inventory descriptor gains a symlink metadata flag only; the original observation kernel, no-follow reads, identity/hash guards, cancellation and deadline remain in force.

`native_research_evidence` now composes the actual empirical claim/assertion owners for the original empirical quality profile. Seven complete original Node evidence values cover a positive repository-contained source/artifact layout, both quality-profile forms, missing or invalid manuscript declarations, includes and original observed-claim replacement. This version requires source, log and empirical roots inside the repository root; the original normal default sibling runtime/empirical-analysis layout remains unimplemented in this component and must not be treated as installed coverage. Per-file 1 MiB and one shared 4 MiB read aggregate, included file count/depth/path bounds and the existing record/string preclone budget are retained. Presentation artifact size is bounded to 1 MiB in this version, narrower than the original Node artifact domain.

Formal, empirical claim and empirical assertion phases now borrow one `Rc<LatexSyntaxControlV1>` from the existing per-request read context. Actual tests exhaust the shared 16,384-match parser limit across alternating phases, retain sticky refusal, cancellation and the same absolute deadline, and establish an independent fresh retry. The fixed 256 MiB parser work bound and 4 MiB physical read aggregate are not reset by phase changes. Existing formal/empirical claim public APIs and original output/hash contracts remain. The zero-input controlled comment-mask call observes the existing parser's sticky state; it grants no new budget or authority.

The original Node modules are development differential inputs only. Verified declaration/universe and artifact-integrity values do not confer experiment/scientific/academic/release/submission authority. Null-authority support extractors remain limited to their exact empty-support/blocker domain. The full research adapter, default external runtime input domain, capability/intake/quality report, normal six-stage batch execution, authenticated independent reviewer, measured provider cost and installed Node retirement remain unaccepted. All original draft and lint failures are retained. No canonical route decision or H/M/target-host acceptance is promoted by this private source package.

## Fixed ordinary runtime evidence roots v2

`native_research_evidence::inspect_native_research_evidence_for_current_runtime_v2` derives the actual runtime through the existing ordinary frontend `current_native_command_runtime_root_v1` owner. Its closed request accepts repository/source roots and the bounded paper task; it accepts no caller-selected empirical directory, runtime override field or trusted result projection. The runtime selector's existing environment/layout behavior remains the sole path source. Only `runtime/empirical-analysis/<paperId>` is read outside the repository, with one validated paper-id component; the log scope is exactly `ROOT/logs/paperctl/<paperId>`. These paths select data, never academic/release/submission authority.

One independent instance of the existing held `SourceObservation` binds the actual fixed runtime members or the first genuinely missing edge and its parent namespace. Every read uses normal held-relative members; original display paths containing `../` are output data, and a sealed observed-member map associates each such display with the actual descriptor-owned path. The original repository and runtime observations share the same request context, 4 MiB unique-member aggregate, cancellation, absolute deadline and fixed parser work limit. Each file retains the original 1 MiB versioned limit. No new filesystem observer, path-selection kernel, recovery store or parser budget is introduced.

Four actual whole original Node values exercise its real `defaultPaperRuntimeRoot()` sibling layout without a runtime environment override: positive external evidence, an empirical manuscript, absent runtime paper directory and ordinary logs. The normal native selector and original Node default produce the same actual runtime path. Actual tests also reject named replacement, later creation of the observed missing paper directory, cancelled/expired requests, unsafe paper-id traversal and unknown caller path fields; five individually valid 900 KiB files across both roots exceed the shared 4 MiB before the next read, remain refused on the same context after shrinking input, and succeed on a fresh request. Existing repository-contained evidence and formal/empirical compositions are freshly rechecked. Earlier compiler and noncanonical test-working-directory failures remain retained.

This closes the fixed default runtime input domain of the held evidence reader, not the complete research adapter, scientific verifier, normal batch execution or installed acceptance. Empirical declarations and observed file hashes confer no experiment/academic/external authority. Actual independent reviewer/provider billing, H/M, host canary and Node retirement remain separate unaccepted boundaries; all 57 canonical decisions remain unchanged. The v1 public API keeps its repository-contained scope and old output contract.

## Pure evidence consumption policy v1

`native_evidence_consumption::evaluate_native_evidence_consumption_v1` computes reference validity, dependency freshness and the original evidence consumption policy over borrowed JSON facts. It reuses the existing JSON boundary, String/Number coercion, canonical UTC instant and record-hash owners. The public input is an object with the original policy fields. Creation timestamps use canonical UTC instants or missing values; other legal Node Date.parse spellings and non-array dependency iterables remain explicit versioned domain refusals. A ready result grants no execution, academic, release or submission authority.

The existing shared record limits remain 1 MiB, 20,000 values, depth 64 and 64 KiB per string, with at most 128 dependency nodes and 1024 visited edges. Derived record copies and blocker text reserve their bounds before allocation, including a cyclic trail that would exceed one string limit. Cancellation and the absolute deadline apply throughout each call; a refused call does not poison a fresh invocation. The exact tests in `native_evidence_consumption/tests.rs` compare complete original Node values and exercise actual legal-input derived overflow, long-cycle output, cancellation, expiry and fresh retry. The original Node closure remains a development differential oracle. Normal research adapter integration, broader parameter domains and current signed head/merge acceptance remain required before route acceptance.

## Actual safe artifact-integrity verifier v1

`native_research_evidence::verify_native_evidence_artifacts_v1` computes actual held file hashes and original `ScopedFileReadReceipt` / `EvidenceArtifactVerificationReceipt` record hashes. Thirteen complete original Node values cover positive regular-file integrity, hash/provenance/source-snapshot mismatch, a supplied attestation with no authority verifier, genuine missing files, absent source root, relative paths and primitive/structured wire fields, a 9007199254740993 evidence id and nested large-number provenance. The new actual Node cases first reproduced returned-Value disagreement despite identical record hashes; the existing reader JSON boundary now normalizes admitted numeric payloads before any field copies. It retains the original borrowed aggregate input and derived-output admission rather than adding a numerical kernel. A declared expected hash is compared to actual bytes; it does not establish scientific, academic or external acceptance. This version supports canonical ordinary scope roots and bounded normal regular members or held genuine absence; symlink/hardlink/escape/special-file domains fail closed rather than claiming every original Node refusal-receipt domain is represented.

The existing held `SourceObservation`, unique-member read context and artifact record/hash helper own all reads and identity observations. Per-file 1 MiB, shared read 4 MiB, input/output record 1 MiB, at most 128 artifacts and the same cancellation/absolute deadline are retained. A borrowed complete output reservation precedes each receipt clone. Actual tests first establish sixteen 65,000-byte provenance fields as a legal input under the existing input budget, then reject the accumulated output before its next clone, retain sticky refusal and establish fresh retry. Changed held bytes, later creation of an observed missing member, cancellation, deadline, aliases/hardlinks, oversized files and over-count refusal without namespace creation are exercised. The ordinary API takes time from the existing `SystemMutationClockV1` and canonical `iso` owner; a private clock callback allows deterministic whole-value differential tests.

Missing academic verification remains a blocked receipt; no caller attestation/status/hash grants authority. The component is to be called by the normal held research adapter composition. Full candidate/intake/capability/quality and worker/report assembly, normal batch execution, real independent reviewer/provider cost, H/M, installed canary and Node retirement remain unaccepted. The fixed runtime predecessor must be integrated first, preserving all peer source exports and existing budgets; development Node is differential-only.

## Shared observed research inputs and non-attested intake v1

`native_research_evidence::inspect_native_research_observed_inputs_v1` composes the actual held complete source snapshot, fixed ordinary sibling-runtime evidence reader, original candidate path/hash filtering, opaque actual file verifier, and existing native consumption policy into the non-attested evidence intake. The observation retains all source/evidence/verifier witnesses and rechecks them before admission. Six complete original Node outputs cover ordinary artifacts, empty evidence, JSON data including an oversized integer id, outside runtime results, empirical manuscript declarations, and an actual absolute local artifact whose integrity consumption is ready. Twenty-five complete candidate values cover path filtering/normalization, omitted ids, false/null fields and numeric JSON boundaries. This computes local integrity data, never scientific acceptance.

The source walk charges each included actual member before the existing archive read against the same unique 4 MiB context used by manuscript, runtime and verifier phases. Three 900 KiB source members plus two runtime members are refused; after shrinking, the failed context remains refused and a fresh request succeeds with four unique members charged once across all repeated phases. Existing per-file 1 MiB evidence reads, 1 MiB record input/output policy, 128 artifact/intake items, parser control, cancellation and the same absolute deadline remain fixed. Snapshot included records retain their original 4096 bound, while the existing auxiliary namespace enumeration retains its 16384 bound including excluded entries. Namespace/bytes replacements, cancellation, expiration and fresh retry are actual tests.

Intake accepts an opaque held verification observation, preserving the original last-by-primitive-id receipt lookup and undefined-id omission. It never accepts caller academic eligibility or authorizing receipts. Existing JSON/ECMAScript String/record-hash owners supply conversion and hashes; conservative borrowed allocation projection refuses oversized derived claim strings or id-prefixed blockers before allocation. Primitive evidence ids, canonical UTC timing, bounded representable JSON values and normal safe regular artifact members define this v1 domain; object/array id identity, attested academic intake and unsupported arbitrary coercion/filesystem domains remain unaccepted. Whole-value tests use the same actual canonical time; a prior fixture's differing now-millis constant was recorded and corrected before the final fresh checks.

The public API prepares observed inputs for the existing research pipeline. Actual plan-backed workers, academic verification, capability/quality/report composition, ordinary complete batch role execution, independent reviewer/provider billing, final commit ACK, H/M, installed canary and Node retirement are separate remaining acceptance obligations. No trust/ready/release/submission authority is minted. Normal consumer wiring must derive its task/scope from actual inventory and retain these witnesses; no manually assembled job or queued receipt replaces the ordinary role chain.

## Actual normal workspace data-plan producer v1

`native_research_source_plan` now derives the existing three data job types from the actual normal `PaperTask`, its held source workspace and the fixed `RESEARCH_WORKER_PLAN.json`. An opaque source observation supplies only internally listed members, exact original size/hash and the existing 4 MiB shared read proof. It cannot be deserialized or constructed from a caller hash/path/charged flag. Plan bytes remain bounded to 256 KiB, workers to 16, each input list to 64, and unique members to 128; a member accessor permits at most 129 actual reads, refuses excluded members and retains failed-read refusal. The same request cancellation flag and absolute deadline must match the opaque normal runtime.

The complete task subject, including title, quality, source workspace and creation fields, is internally bound by the existing Node-compatible production record hash after the existing borrowed 1 MiB request budget. Keeping the same paper/task IDs does not permit substituting another task. Actual named source bytes, plan bindings and the original typed job producer are verified before idempotent CAS insertion; identical digests are deduplicated before extra writes. Cancellation after insertion leaves real objects for honest retry.

`open_native_research_source_data_runtime_v1` derives the actual default sibling runtime through the shared native workspace selector and canonical original paper ID. It opens the fixed `research-workers/<paperId>/native-inputs.v1` private CAS leaf using existing held nofollow Directory/ObjectStore owners, with `native-data-workflow.v1` as the only workflow destination. Construction precedes held input capture, so intentional runtime namespace creation is not advertised as unchanged source. Existing ordinary Node parent directories with modes 0755 and 0775 retain mode, UID and inode; their group-write data mode grants no authority. The existing private CAS/workflow policy remains unchanged, and no existing directory is chmodded. Actual original Node filesystem artifact and persistent receipt-ledger producers are exercised. The old artifact retains observed bytes, identity, timestamps and hash; the complete old ledger namespace has not been independently rehashed. No old completed state is adopted. This proves coexistence in a shared data parent, never Node/native writer fencing or retirement.

Three fresh original Node fixtures use the actual `createPaperTask`, default runtime selector, original worker computations and real filesystem artifact/receipt ledger. Native derived artifact-integrity, CSV statistics and JSON assertions match all original result wire values. The existing LocalWorkflow/service/CAS/sequencer performs three durable commits and source-tariff settlement, and absolute response-loss retry performs no extra execution. An actual started attempt after corrupted input remains unknown after bytes are restored; retry cannot execute it again. A preexisting caller-claimed completed workflow is retained and rejected. Same-ID task drift, wrong digest/path/task/workspace, oversized plan, excluded/unlisted/replaced files, cancellation, expiration, stale controls, arbitrary output overrides and fresh retry are tested. Prior failures (held source/output overlap, absent runtime parents, request expiration and a guard-placement compile error) remain recorded.

This is the source-backed data subworkflow required by the research adapter. It does not compute the complete original worker-runtime receipt/engine or academic attestation, full capability/quality/experiment/formal report, the ordinary six-node batch DAG, author/reviewer/revision chain, measured provider billing or final commit-bound broker ACK. Normal batch caller composition, all parameter domains, research authority, H/M qualification, installed canary, writer fencing and Node retirement remain separate acceptance obligations. The API grants no publication/submission authority.

## Claim-contract readiness policy v1

`native_research_claims::evaluate_native_claim_contract_readiness_v1` computes the original claim-contract readiness record over bounded observed registry JSON. It reuses the existing truthiness, String/whitespace/JSON-number boundary, borrowed record budget and Node-compatible record hash owners. Sixty-eight original Node inputs and three actual original registry→readiness compositions match complete values and hashes, including oversized JSON integers, scalar/object/array coercion, original whitespace, proof obligations and duplicate blocker order. This is a policy calculation, never claim evidence verification or academic/execution authority.

The existing 1 MiB shared record projection is reserved before derived identifiers, blockers and the second nullable `claimRegistryHash` copy. A legal 14×64 KiB hash array produces an original Node input of 917610 bytes and output of 917841 bytes, each below 1 MiB, but requires two simultaneous projected occurrences above the fixed shared budget. The original draft returned success and a meaningful regression actually failed; the fix now refuses this v1 resource domain before cloning. The original Node complete output is observed under the existing bounded process owner. Cancellation, the same absolute deadline, null-claim/custom String refusal, repeated identifiers, combined projection and a fresh independent retry have actual tests. No limits or checker were loosened.

This component is a dependency of the remaining normal research capability/report assembly. Full evidence quality, experiment/formal closure, gap/promotion/replay and ordinary author/reviewer/revision/commit/provider settlement/ACK acceptance still require their actual owners and normal caller composition. No route status, host/profile trust, H/M qualification, publication/submission authority or Node retirement is promoted by this calculation.

## Actual inventory research assessment preview v1

`native_research_assessment::inspect_native_research_assessment_for_inventory_row_v1` borrows an opaque held ordinary inventory observation, derives the real row/task/source root, and keeps the actual source, evidence-artifact integrity, consumption and intake witnesses through the final output check. The returned `NativeResearchAssessmentObservationV1` is not deserializable. Its `assessment()` JSON is an observation and cannot grant execution or academic authority. This source-preview domain sets `scientificAcceptanceGranted`, `academicAuthorityGranted` and `trustedExecutionBranchesAccepted` to false.

The actual original ordinary inventory→evidence reader→verification candidates→artifact verifier→consumption/intake→contract context→quality gate→gap planner composition matches complete values and hashes for two actual local paper fixtures, with and without an evidence requirement. Each fixture contains a real source file, structured claim input and a real artifact with an independently checked SHA256; no caller receipt replaces artifact reads. Each original Node verifier receipt gets its corresponding native observed clock value for deterministic comparison. Source mutation, same held-owner recheck, cancellation, expiration, missing row and a fresh independent retry are tested. The existing 4 MiB shared source budget and 1 MiB record projection budget remain in force before allocation.

The private quality owner computes the original nonattested `EvidenceQualityGate` record over opaque verified artifact intake; 39 complete original Node values/hashes match, including original Set insertion order for duplicate/unregistered claim coverage. Its v1 verification-kind coercion domain is primitive ASCII; non-ASCII lowercase and object/array receiver domains explicitly refuse. Verified formal, empirical and native-worker authority branches remain open. `native_research_gap_plan::build_native_research_gap_plan_v1` computes the original bounded gap policy, with 42 complete Node values/hashes and seven original TypeError cases observed. It preserves the existing String/Number boundary, production collation and record hashing. Mixed multi-job nonfinite priority sorting and over-64 KiB joined priority String domains explicitly refuse before derived allocation. Persistence and job execution stay with the existing owners.

All six private validation stages passed with unchanged complete source and qualified tool bytes/metadata. Earlier compile, per-receipt-clock and invalid auto-evidence fixture failures remain in the review packet. This package does not close `runResearchVerifyAdapter`, normal batch execution, trusted scientific/formal/academic acceptance, the full author/reviewer/revision chain, actual provider settlement, commit-bound broker ACK, host/profile canary, H/M qualification or Node retirement. A production caller must consume the opaque source through the existing CAS/service/sequencer owners; CAS JSON paths are not filesystem scope authorization. No canonical route decision is promoted by these source-preview calculations.

## Bounded structural promotion records

`native_research_promotion` reproduces `buildPromotionInputSnapshot`, `buildResearchGapClosureReceipt`, and `buildResearchChangeProposal` through the existing JSON coercion, production collation and record hash owners. The three native APIs take the same cancellation flag and absolute deadline, and reserve the shared 1 MiB input-plus-projection budget before cloning or deriving keys. Forty-two complete original Node values and hashes match; the executable test owner also covers seven original null/type errors, the original legal large patch payload refused by the native shared budget, cancellation, expiration and fresh retry. The original final `jobId: null` fallback is preserved as `String(null)`.

These APIs calculate structural records only. Supplied completed-job receipts and patch hashes remain unverified data; `research_gap_closure_verified` does not establish scientific verification or commit authority. Non-array iterable patch/revision inputs and custom String receivers are outside this v1 domain. Job execution, authenticated receipt intake, durable commit, broker ACK, provider settlement and release/submission authority remain with their existing owners. Current composed H/M and installed acceptance are required separately.

## Captured-source CAS assessment and original durable service v1

`native_research_assessment::prepare_native_research_cas_assessment_for_inventory_row_v1` borrows an actual ordinary inventory observation and the existing opaque default research-worker runtime. It binds the full observed task, actual source snapshot and every captured source member to the immutable CAS manifest. It retains the held inventory, source and artifact witnesses through initialization and service execution. All present inventory source/database/staging observations must use the identical cancellation owner and identical absolute deadline; an absent deadline is refused in this new branch. CAS request JSON contains only version 1 and a manifest digest. It cannot authorize filesystem paths, reset controls or supply scientific trust.

The new `ResearchObservedAssessmentFromCasV1` job uses the existing CAP-EVD-VERIFY worker, service, prepared-result store and commit sequencer. The CAS consumer independently re-hashes the manifest and every raw object, recomputes structured records and verification candidates, and reuses the existing contract context, consumption, intake, quality and gap calculations. Its private `NativeCasArtifactObservationV1` is not deserializable. CAS integrity receipts have their own receipt kind and `currentFilesystemVerified: false`; they do not reuse old filesystem receipt hashes. Academic, scientific and external authority remain false. The supported source-only domain explicitly refuses nonempty proposal-seed evidence and structured input that cannot be recomputed from the captured source members. Manifest bytes are limited to 256 KiB, at most 128 files and 96 records, with the original shared 4 MiB raw-input and 1 MiB record projection limits. Every projection is reserved before cloning.

The actual private tests execute a real positive opaque inventory→capture→existing service→prepared result→one durable commit, charge the admitted local source tariff once (100→99), and replay the original artifact without a second commit or charge. That tariff is not measured provider billing. They prove actual raw integrity after the original source namespace is removed, forged task/path/receipt refusal, missing objects, identical control binding, cancellation and expiration. A source mutation at the real prepared-result commit clock prevents commit; the original attempt records remain, and a fresh independent subject succeeds. A missing inherited deadline after the original worker started intent remains an unknown attempt and does not re-execute on retry. Generic recovery of the immutable captured result is distinct from verifying current source files and cannot grant filesystem or scientific authority.

Initialization retains the existing absent-directory kernel: it persists the workflow definition before copying CAS inputs. A cancellation and two actual processes terminated by TERM/KILL at that real window leave unknown initialization. Fresh initialization refuses the existing definition; it does not delete it, dispatch a job, adopt missing CAS inputs or claim successful recovery. A read-only target-CAS preflight prevents known missing inputs from producing a new started intent. The original status operation may update SQLite bytes and create WAL/SHM sidecars; tests record those actual effects while proving definition/CAS and other original namespace members remain. Unknown initialization recovery is still open. The window hook exists only in cfg(test), uses the actual initializer and current compiled ELF, and has no public request field.

The final private ten-stage validation passed format, seven real new owners (two CAS, two initialization and three service tests), the original assessment/reader/quality/gap groups, the complete 27-test service integration suite, and strict all-target/production lint. The extra initializer child helper is not a separately accepted owner. Both signal children use the existing 30-second bounded process owner with exact current ELF bytes and process cleanup observations. Earlier compiler, mixed-control and incomplete-initialization failures remain in the review packet. Production implementation identity binds the actual source, parser/hash/record/readonly owners and existing workflow/service/control-plane dependencies; it does not accept caller dependency summaries. Root composition and new H/M checks remain required after guarded integration.

This source-preview composition does not complete runResearchVerifyAdapter, ordinary batch execution, the six-role author/reviewer/revision chain, actual provider settlement, commit-bound broker ACK, formal/academic scientific acceptance, installed canary, writer fencing or Node retirement. Canonical route decisions remain unchanged. The actual accounts and trusted signing materials are still unavailable; this local component does not create them or grant release/submission authority.
