# Native autonomous state backup command

## Original route and current scope

The native `hepta-state-backup` binary composes the original `operator/autonomous-state-backup` route. The reference sources are `paper-core/bin/autonomous-research-state-backup.mjs` and `paper-composition/bootstrap/autonomous-research-state-backup-composition.mjs`. The five actions are `status`, `backup`, `restore-drill`, `renew`, and `reconcile-and-renew`. Production Rust code executes the configured, pinned authority processes; it does not invoke Node or load a fixture authority implementation.

This command implements the five actions within the source checkout. The executable currently derives its workspace from the compile-time `CARGO_MANIFEST_DIR`; copying it to a host without that checkout does not relocate the manifest lookup. A safe installation-layout or explicit deployment-root contract and relocated-binary tests remain required. The migration route remains partial until this deployment gap, its complete required acceptance evidence, and intentional compatibility differences are adjudicated. No test creates a production authority, deployment permit, or Node retirement permit.

## Arguments, defaults, and exit behavior

`state_recoverability::cli::state_backup_cli_v1` receives command tokens, an explicit workspace/current directory/environment context, and a clock. The executable supplies its real current directory and system clock. There is no CLI flag for overriding time, trusted receipts, or a ready result.

The parser preserves the original strict options and `--name=value` spelling. It rejects positional arguments, the `--` separator, unknown options, duplicates, empty values, and values on `--help`. Every token is validated before help is returned; help then precedes action-specific checks. The action defaults to `status`. Restore drill requires `--bundle`; reconcile-and-renew requires both authority configuration paths.

Relative paths use POSIX lexical resolution against the actual working directory. `--runtime-root` wins over a nonempty `HEPTA_PAPER_RUNTIME_ROOT`, followed by the workspace sibling `hepta-paper-runtime/native-runtime`. The only environment value the binary imports is this runtime-root override. Missing runtime directories remain errors and are never created by inspection. Existing incomplete runtimes return the actual blocked inventory.

Help and completed reports exit 0. Blocked operation reports exit 2. Invalid arguments or composition/configuration failures exit 1. JSON reports are pretty-printed; stderr exposes the concrete error code without fabricating a JavaScript stack trace.

## Configuration and source data

The state database manifest is read from the actual workspace `paper-core/config/autonomous-research-state-databases.v1.json`. `ManifestFile` opens held ancestor directories without following symbolic links, opens the leaf nonblocking, rejects nonregular/multiply linked files, limits the file to 4 MiB, parses strict UTF-8 JSON without duplicate members, and retains/rechecks its identity before and after the operation. Public repository source may be group writable, as in a shared checkout; this is distinct from authority configuration trust.

Authority files use the existing stricter observed-file and pinned authority loaders: root/current-user ownership, no group/other write permission, one regular link, bounded bytes, duplicate-member rejection, retained descriptors, and before/after identity checks. Selecting the configuration path is an operator trust decision. Its initially observed raw-byte hash pins that invocation; a hash computed from the selected file is not represented as an independently supplied external trust pin. Referenced public keys, authority configuration, executable bytes and every signed response are checked by the concrete process clients.

`cli/writer-manifest.v1.json` ports the incumbent's fixed writer-operation manifest data. It is checked against the live original export by the parity test and validated at load time. Its presence is not proof of dynamic writer coverage. Authority configuration binds its canonical hash independently during reconciliation.

## Actual execution and ownership

Status observes the actual complete inventory. Backup reserves externally, validates actual finalized local heads or genesis under the pinned verifier, copies private SQLite snapshots, finalizes the exact resulting content, and publishes the bundle without replacement. Restore drill verifies historical bundle signatures and a fresh authority head, executes the authenticated journal on private SQLite copies if needed, and publishes the actual drill receipt.

Backup, restore-drill, and renew obtain their online signature verifier from the exact configuration/hash embedded in the backup authority's v2 configuration. Its transport explicitly rejects every invocation. These actions cannot accidentally perform startup reconciliation through an optional online process setting. If an online process setting is supplied it is still validated, matching original composition behavior.

Independent `BackupRecoveryServiceV1::renew` performs backup, drills the exact returned bundle, checks manifest/content/path bindings, and durably publishes `RENEWAL_RECEIPT.json`. It does not call pending reconciliation. A failed drill can leave a valid historical backup while the renewal report is blocked; it never turns that historical backup into a current recoverability permit.

Reconcile-and-renew invokes the actual pinned online authority process for all ten registered databases through the existing startup reconciler. It checks the resulting opaque inventory, then runs the same exact-bundle renewal. Its report binds the actual reconciliation summaries, pending inspections, scope, writer manifest, and renewal hash. Startup recovery does not replay business DML. A serialized CLI report cannot construct an active controller epoch.

## Failure, concurrency, and limits

Backup and drill retain their existing durable publication, no-replace bundle, compare-and-swap receipt, bounded private SQLite, and retained file-identity guarantees described in `STATE_RECOVERABILITY_HANDOFF.md`. A lost finalization reply remains uncertain evidence with a preserved staging path; the CLI must not report it as ready. The underlying `recover_backup` API resumes the exact signed transaction; the incumbent five-action CLI has no additional recovery action.

Authority process execution is descriptor-pinned, timeout bounded, isolated from ambient environment, and bounded on input/output. The command itself does not introduce a shell, arbitrary SQL, or caller-provided readiness fields. Resource bounds and deliberately stronger alias/FIFO/JSON checks are inherited from the service and input readers.

## Deliberate differences and remaining acceptance

The original backup authority v1 configuration can omit its online mutation verifier, causing Node to skip local finalized-head verification. The native write/drill path requires the v2 pinned verifier and refuses this weaker legacy configuration; it does not silently manufacture a verifier or bypass that check. A valid v1 configuration can still be loaded for read-only status, which performs no authority RPC. This difference must be accepted explicitly in migration qualification before universal input parity is claimed.

SQLite backups contain the version field of the engine that actually wrote them. The native implementation retains and hashes its own bytes. Backup header bytes 96–99 can differ from Node, and the resulting content hashes, bundle paths, signatures and chained receipt hashes consequently differ. Tests compare all remaining bytes and test that the original Node CLI accepts and drills the native bundle. No hash or engine header is rewritten to make a comparison pass.

Native rejection can be stronger for unsafe filesystem inputs and malformed receipt structures. Such rejections remain failures, never acceptance evidence. Independent target-host behavior, external authority linearizability/custody, crash/soak deployment qualification, full activation assembly and operator cutover remain separate requirements.

## Verification

The test oracle executes an unchanged copy of the original CLI entrypoint against an isolated fixture workspace and real ten-database runtime. Authority commands are actual subprocesses using fixture-only Ed25519 keys. Synthetic clock replacement is confined to the test oracle; production paths have no time override.

The targeted suite covers strict argument/help/default behavior, real inventory output and exit classes, missing authority, signed backup creation, native-to-original restore drill interoperability, independent renewal without online RPC, all-ten-database online reconciliation, durable receipt/hash bindings, invalid signatures and wrong-scope re-signed responses. Unsafe-input and v1-policy negatives are explicitly separate from accepted original behavior. Exact test results belong to the current test log/CI head, not this descriptive document.

A separate process test invokes the actual compiled binary and original Node entrypoint with the canonical workspace manifest, comparing help, environment defaults, blocked reports, and exit classes. Reconciliation failure tests retain the actual initial scope and already completed database summaries; restore failures retain observed manifest and verified head identities while leaving the previous receipt intact. These diagnostic fields do not confer readiness or authority.

```bash
cargo test --manifest-path rust/Cargo.toml -p hepta-paper-service --test state_backup_cli_parity
cargo clippy --manifest-path rust/Cargo.toml -p hepta-paper-service --lib --bins -- -D warnings
```
