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

`NativeJobV1` supports actual artifact inventory and immutable Node-database
inspection. Database inspection binds expected database bytes and uses the actual
Node logical hash contract; it does not translate Node business tables into the
new campaign schema. These jobs are small native migration building blocks, not
claims that authoring, review, empirical analysis or packaging have been ported.

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
