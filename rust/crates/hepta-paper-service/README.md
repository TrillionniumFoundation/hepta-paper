# Runnable Rust campaign service

This crate composes the real registry, policy, planner, resource allocator,
executor, content verifier and SQLite commit sequencer. It executes real bytes
and survives process restart. Its executable currently accepts **local/shadow
work only**. It cannot enable production with a boolean or issue its own host,
provider, scientific, external-effect or writer-cutover authorization.

## Build and first run

Use the repository-pinned Rust toolchain. Production compatibility checks also
require Node 22.23.1 with its pinned ICU/CLDR profile.

```sh
cargo build --manifest-path rust/Cargo.toml --locked -p hepta-paper-service
cargo run --manifest-path rust/Cargo.toml --locked -p hepta-paper-service \
  --example local_service_drill -- /absolute/new/disposable-state
cargo run --manifest-path rust/Cargo.toml --locked -p hepta-paper-service \
  --bin hepta-paper-rust -- run /absolute/new/disposable-state/run.json
```

The drill writes an actual manuscript object, schedules a native inventory job,
verifies its output bytes, commits through SQLite, closes and reopens the service,
and proves that exact replay returns the original commit without another debit.
The directory must be absent; the example cannot overwrite an existing campaign.
Its generated `run.json` is a complete runnable example, with a synthetic drill
clock and local writer token. It is not a deployment configuration.

## Command and configuration contracts

`hepta-paper-rust` implements:

| Command | Contract |
|---|---|
| `native-identity` | Print the linked native-worker source identity. |
| `put STATE FILE` | Insert up to 16 MiB of actual bytes and return their SHA-256. |
| `run CONFIG` | Decode one closed `ServiceRunV1` JSON document and emit its run receipt. |
| `serve` | Read one bounded JSON configuration per stdin line; emit one receipt per completed request. EOF shuts down. An invalid request exits nonzero. |
| `inspect-db IMMUTABLE_DB` | Validate a real Node migration database and print the production-compatible logical report. |
| `store-migrate NODE_DB [TARGET_VERSION]` | Apply the embedded Node schema migrations to a private local database, validating historical migration hashes and rejecting live leases/SQLite sidecars. Optional target is 1–25; this does not authorize a production write or retire Node. |
| `verify-legacy-freeze IMMUTABLE_DB REPOSITORY COMMIT TREE` | Read and validate an already drained immutable Node database against the exact source subject; print the freeze receipt. It does not drain the live database, activate a Rust writer, authorize rollback or retire Node. |
| `repository-assets ROOT MANIFEST [--handoff]` | Verify repository asset identities, pinned external references, restore-drill receipts and gitlink bindings; `--handoff` emits a non-authorizing migration handoff. |
| `command-surface ROOT [--write-package]` | Inspect or synchronize the local `package.json` command-script registry without invoking Node; `--write-package` performs the deterministic local rewrite. |
| `retirement-reference ROOT` | Verify retirement snapshot receipts and archive hashes without consulting or mutating a live legacy runtime. |
| `release-trust-gate REQUEST` | Evaluate the pure release trust-layer count gate from JSON input; it never creates external signatures or activates production. |
| `release-state REQUEST` | Evaluate the pure package/document/tag release-state contract from JSON input; composite release verification remains separate. |
| `retirement-status REQUEST` | Inspect the read-only legacy archive retirement status for explicit roots and version; destructive identity-bound execution remains disabled. |
| `runtime-r-source-cas REPOSITORY_ROOT` | Verify the R lock closure, source-CAS manifest, indexes and archive hashes without network acquisition; acquisition remains separate. |

Separate native binaries inspect operational proof, owner acceptance, nested
runtime qualification and journal connector coverage. Their inputs, signature
validation, failure behavior and parity boundaries are documented in the
[authority inspection handoff](../../../docs/modules/NATIVE_AUTHORITY_INSPECTION_HANDOFF.md).

`ServiceRunV1` uses camelCase, rejects unknown fields, and binds a version, state
directory, `registryJson`, hard policy, planner policy, frozen snapshot, frontier,
verifier hash, initial state hash, writer lease, explicit clock and worker table.
`registryJson` is a string containing the registry's **exact canonical JSON**;
decoding into a generic object and reordering fields would violate that protocol.
Snapshot, policy, manifest and frontier hashes are independently checked by the
existing control-plane contracts. The worker must match the registry execution
kind and identity; a missing worker never falls back to Node or a fixture.

The clock is explicit to support reproducible drills. It is not a live clock:
this executable must not be used as a production lease/timer supervisor. The
initial campaign snapshot uses revision one; later plans bind the recovered
state and the next revision. Exact historical replay remains a distinct case.

## Filesystem and SQLite state

The canonical absolute state directory and its `objects` and `attempts` children
are private mode 0700. Objects and records are mode 0600, created exclusively and
fsynced; parent directories are fsynced before the operation returns. Object
filenames are raw SHA-256 hex, but readers recompute the hash from actual bytes.
Symlinks, unsafe file modes, hard links and changed object identities fail closed.
Torn or corrupt objects are retained for investigation, never silently repaired.

`campaign.sqlite` uses the writer's explicit `local_only` identity marker. A local
service cannot open an unmarked production writer database or an existing Node
native store as though it were this format. The sequencer persists the full
prepared body, receipt, campaign revision, accounting and event in one transaction.
See [the writer contract](../hepta-campaign-writer/README.md) and
[the control-plane contract](../hepta-control-plane/README.md).

The executor fsyncs a dispatch intent before work and persists the complete
prepared result after writing artifacts. A committed or prepared exact attempt
can replay. A started attempt with no complete prepared record is ambiguous and
requires reconciliation; restart does not automatically run it again. Errors
return bounded categories without echoing worker stdout, prompts or credentials.

## Native work and gradual process migration

`NativeJobV1` supports artifact inventory, immutable Node-database inspection and
`Business` jobs. The latter dispatch seven Rust kernels: manuscript structuring,
structural review, propositional proof checking, descriptive aggregation, dense
linear solving, deterministic packaging and prepared submission. Each typed job
has exactly one capability ID, checked both in-process and at the native process
entry point. A mismatched job is rejected before a durable dispatch intent.
These bounded kernels are not a claim of complete legacy business equivalence,
model-generated research, general theorem proving or live external submission.
Database inspection remains read-only and does not itself translate all Node
business tables into the new campaign schema.

For a process worker, the registry binds executable bytes, fixed argument vector,
working directory, declared implementation language, timeout, network declaration
and source-file hash closure. Interpreted workers require explicit code files;
hashing only the Node/Python executable would leave script contents unbound.
The executable and declared code files are checked before and after execution.
The runner never parses shell commands or inherits ambient credential variables.

The worker receives one JSON stdin envelope containing `version`, `execution`
and `input`. It returns closed camelCase `WorkerResponseV1` JSON with version one,
1–256 base64 artifacts, evidence, and `externalActionMayHaveStarted: false`.
Output, stderr, stdin, deadlines and cleanup are bounded; truncated, malformed,
failed or ambiguous results cannot commit. All output bytes are independently
verified. Accounting conservatively charges the admitted resource/cost upper
bound; it does not pretend to provide operating-system resource metering.

This process path is for **trusted local workers**. It shares the invoking user's
filesystem and privileges. Network declarations and worker evidence are not
sandbox enforcement or proof that no external action occurred. Node bridges must
remain explicitly labelled `node_bridge`. Real provider dispatch uses the
[broker authority/gate/cgroup contract](../hepta-codex-broker/DISPATCH.md), which
requires independently verified deployment authority and has no permissive
production callback supplied by this executable.

## Verification and remaining production work

`cargo test -p hepta-paper-service` covers executable configuration, actual CAS
bytes, durable commit/replay, unsafe content rejection and authority refusal.
Run the local service and cutover drills independently: one proves campaign
orchestration; the other proves cooperative single-writer handoff. Their success
does not establish a complete Node-to-Rust data migration.

Production composition still needs a live clock and qualified runtime identity,
real immutable deployment/source closure, validated provider authority, actual
business workers and their capability replay corpora, Node schema translation
and reverse compatibility, and retained target-host shadow/canary evidence.
These conditions are tracked in the
[migration implementation report](../../../docs/rust/RUNTIME_MIGRATION_IMPLEMENTATION.md).

## Native bundle verification

`native_business::verify_native_build_bundle_v1(bytes, expected_sha256)` provides
Rust-native verification and decoding of `HEPTA-NATIVE-BUNDLE-V1`. The caller must
obtain the expected digest from an independently selected manifest or CAS record.
The decoder checks lengths before allocation, bounded entry counts, UTF-8, exact
end-of-input, canonical ordering, duplicate paths, unsafe path components and
file/directory prefix collisions. It returns in-memory `BuildEntryV1` values and
does not extract files, authorize publication or run embedded content. The encoder
uses the same path and collision rules.

The native numerical worker rejects non-finite products, partial sums and residuals
before reducing the infinity norm. A NaN cannot be hidden by `f64::max` and emitted
as a successful finite residual. Numerical V1's tolerance retains its existing
pivot semantics; this check does not certify a forward-error bound.

```sh
cargo test --locked -p hepta-paper-service --test native_bundle_and_binding
cargo test --locked -p hepta-paper-service --test native_business_service
```

The tests exercise all 49 job/capability combinations, parser truncations and
corruption, exact bundle round trips, both process and durable-service dispatch,
and rejection before dispatch-intent creation. Source tests grant no production
writer, provider, release or submission authority.

## Multi-step local workflow

`workflow` and the `hepta-local-workflow` executable add immutable output-bound
steps, SQLite-derived progress, absolute-target retries and between-step
pause/resume/cancel. See [the workflow engineering handoff](../../../docs/modules/LOCAL_WORKFLOW_HANDOFF.md).
This is local/shadow orchestration with real artifacts, not complete Node command
parity, live-model scientific acceptance or production activation.

## Actual scientific programs and manuscript compilation

`scientific_runtime` and `hepta-scientific-worker` add a first-party Rust adapter
for exact, operator-selected Python/R/Lean/pdfLaTeX programs. The existing service
owns reservation, durable dispatch/prepared replay and SQLite commit. Named
scientific output manifests support `ArtifactBindingV1.artifactName`, avoiding
reliance on CAS hash order when wiring an actual result into a later step.
See [the executable runtime handoff](../../../docs/modules/SCIENTIFIC_RUNTIME_HANDOFF.md)
for profiles, limits, error/recovery contracts, tests and the trusted-local ceiling.
External scientific tools remain external; this is not a Node bridge or full
business/runtime qualification. No production or retirement authority is added.


## Cooperative local byte backups

The [maintenance contract](MAINTENANCE.md) specifies shared service-state access,
exclusive maintenance sessions, bounded byte inventories, manifest-last backups
and independently digest-bound verification. `hepta-local-maintenance` exposes
`inspect`, `backup` and `verify` byte operations; recovery and quarantine commands
are specified separately below. No permanent GC-delete command is installed.
The seven lock tests and fifteen integration tests exercise actual files, SQLite
and the CLI. Byte identity never implies valid workflow recovery, fresh leases,
Node command parity, production qualification or Node retirement. Old binaries
and direct database writers must be drained before lock enrollment.

## Immutable local recovery and quarantine GC

The [maintenance contract](MAINTENANCE.md) now separates byte backups from immutable
semantic replay, absent original-path no-overwrite restoration and native-only
mark/quarantine GC. These paths reuse the existing service/writer and require
explicit quiescence, source identity and reconciliation. Quarantine does not purge
data or reclaim disk. Historical recovery reports do not qualify a runtime, renew
a lease or grant production/Node-retirement authority. Three former unmapped
maintenance modes now have partial local source mappings; `cancel-node` remains
unmapped. None is an accepted full Node parity decision.

## Native incumbent-function ports

`campaign_policy` and `campaign_slo` add a pure closed JSON command surface via
`hepta-campaign-policy`; no state writer, provider or Node process is invoked.
`NativeBusinessJobV1::EmpiricalInference` adds bounded paired-analysis statistics
under `CAP-EMPIRICAL` and the existing durable service pipeline. The seven original
jobs retain their meaning. See the [native parity handoff](../../../docs/modules/NATIVE_PARITY_HANDOFF.md)
for exact input domains, limits, Node source/profile oracles, errors, tests and
rollback exclusions. A dependency-set decision is not in-flight cancellation;
computed SLOs and p-values are not independently qualified observations.
