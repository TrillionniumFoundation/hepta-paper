# Runnable Rust campaign service

This crate composes the typed module registry, policy, bounded planner, resource
allocator, executor, content verifier and SQLite commit sequencer. It executes
real bytes, persists dispatch/prepared-result state and survives process restart.
The executable remains non-activating by default: source implementation is not a
production authority grant.

## Build and local execution

Use the repository-pinned Rust toolchain:

```sh
cargo build --manifest-path rust/Cargo.toml --locked -p hepta-paper-service
cargo run --manifest-path rust/Cargo.toml --locked -p hepta-paper-service \
  --example local_service_drill -- /absolute/new/disposable-state
cargo run --manifest-path rust/Cargo.toml --locked -p hepta-paper-service \
  --bin hepta-paper-rust -- run /absolute/new/disposable-state/run.json
```

The local drill writes actual content-addressed objects, plans and executes a
bounded job, independently verifies produced bytes, commits through the durable
sequencer, closes/reopens the state and proves exact replay. Local execution does
not load real provider/release/submission credentials and cannot self-promote to
production.

## Command surface

`hepta-paper-rust` provides:

| Command | Contract |
|---|---|
| `native-identity` | Print the linked Rust native-worker source identity. |
| `put STATE FILE` | Insert bounded actual bytes into the content-addressed store. |
| `run CONFIG` | Execute one closed `ServiceRunV1` request and emit its receipt. |
| `serve` | Process bounded line-delimited service requests until EOF. |
| `inspect-db IMMUTABLE_DB` | Validate a real Node migration-ledger database and emit the production-compatible logical report. |

`ServiceRunV1` rejects unknown fields and binds the exact registry JSON, policies,
snapshot, frontier, verifier, initial state, writer lease, clock and worker table.
No missing worker silently falls back to Node or a fixture.

## Durable state and replay

The state directory and its object/attempt records use private permissions,
exclusive creation and fsync. Object reads recompute content hashes. Symlinks,
unsafe modes, hard links, replaced files and corrupt content fail closed.

Dispatch intent is persisted before a worker starts. A complete prepared result
is persisted before integration. Exact prepared attempts replay their original
content; a started attempt without a complete prepared record is ambiguous and is
not automatically re-executed. The sequencer commits prepared body, receipt,
campaign revision, accounting and audit event atomically in SQLite.

## Rust-native business capabilities

`NativeJobV1::Business` executes the first-party `NativeBusinessJobV1` kernel
without invoking the legacy Node runtime. The current closed protocol includes:

- `author_draft` — deterministic bounded manuscript assembly;
- `reviewer_assessment` — deterministic structural review against a closed policy;
- `formal_certificate` — bounded propositional proof-certificate checking;
- `empirical_aggregate` — finite deterministic descriptive statistics;
- `numerical_linear_solve` — bounded deterministic linear solve with singularity checks;
- `build_package` — deterministic manifest and binary bundle construction;
- `submission_package` — deterministic submission-envelope preparation with artifact hashes and metadata.

Every native business result has **prepared-result authority only**. In
particular `submission_package` does not open a portal, send a network request,
load credentials, release an artifact or submit a paper. Its evidence explicitly
records `externalActionMayHaveStarted=false` and requires a separately authorized
submission port for any irreversible external action.

`native_business_implementation_hash_v1()` binds the native dispatcher, every
capability source file and the process-worker entry point. The in-process service
stores output artifacts in CAS and independently binds their hashes into the
prepared result.

`NativeJobV1::ArtifactInventory` and `NativeJobV1::InspectNodeDatabase` remain
available for migration and compatibility work. Immutable Node database
inspection validates the actual migration ledger and production logical-hash
contract; it never mutates the legacy database.

## Pinned process workers

`WorkerBindingV1::Process` supports explicitly registered trusted local workers.
The registry binds executable bytes, fixed arguments, working directory,
implementation language, timeout, network declaration and source-file closure.
Interpreted code must bind the script/source files as well as the interpreter.
The runner receives a closed JSON stdin envelope and returns a bounded response.
Malformed, truncated, failed, oversized or externally ambiguous responses cannot
commit.

A Node bridge is always labelled as a Node bridge and never counts as native Rust
parity. The process runner is supervision, not a security sandbox. Real provider
execution remains behind the broker authority/gate/cgroup contract and separately
controlled deployment evidence.

## Migration and retirement model

The replacement path is forward-only after Rust authority activation:

1. inspect and replay the incumbent Node state under exact compatibility rules;
2. drain legacy runtime work and prove schema-25 quiescence;
3. retain the exact Node database as an immutable historical archive;
4. activate the qualified Rust writer under an atomic mutually exclusive writer fence;
5. before the first Rust authoritative commit, rollback may restore the incumbent owner;
6. after the first Rust commit, recovery proceeds forward from Rust state rather than overwriting it with a stale Node database.

This removes an unnecessary requirement that a retired Node runtime be able to
understand every future Rust-only business state. What is still required is exact
pre-cutover capability/state parity, immutable archive readability, accepted
shadow/canary evidence, rollback before activation, forward recovery after
activation, and proof that no Node writer/entry point remains authoritative.

## Verification boundary

Repository-local source closure is exercised by the Rust workspace tests,
module/conformance validators, compatibility corpus, service replay tests and
cutover/retirement tests. A successful source test can establish only source
facts for its exact commit/tree.

Production still requires independently controlled evidence for the target host,
real provider credentials/canaries, protected-main/governance decisions, key
custody, release/portal/submission authority, production-shaped shadow/canary and
final writer transfer. None of those facts is manufactured by this crate or by a
repository administrator statement.
