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
