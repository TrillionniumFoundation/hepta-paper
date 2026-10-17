# State backup authority and stored restore-source verification

Status: native authority and stored-source verification library; the `operator/autonomous-state-backup` route remains partial. The surrounding backup/restore/renewal service and CLI are documented separately in [state recoverability](STATE_RECOVERABILITY_HANDOFF.md) and the [backup command](STATE_BACKUP_CLI_HANDOFF.md). This module alone does not establish runtime activation or a recoverability epoch.

## Original sources

- `paper-adapters/automation/autonomous-research-state-backup-authority.mjs`: pinned v1/v2 process configuration and four signed authority contracts.
- `paper-adapters/automation/autonomous-research-state-restore-receipt-validation.mjs`: stored restore receipt, snapshot binding and finalized mutation journal continuity.
- `paper-adapters/automation/autonomous-research-state-backup-source-operations.mjs` and `autonomous-research-state-backup-source-inspection.mjs`: actual database source files and source inspection shape.
- `paper-adapters/automation/autonomous-research-state-backup-repository.mjs`: bundle/content/source identity validation.
- `paper-domain/automation/autonomous-research-state-backup-contract.mjs`: database manifest and scope hashes.
- `paper-domain/automation/autonomous-research-state-safety-contract.mjs`: current inventory binding and the 24-hour stored drill freshness limit.
- `paper-application/automation/autonomous-research-state-recoverability-controller.mjs`: the remaining controller dependency; a stored drill alone cannot issue its epoch permit.

## Native API and ownership

Implementation: `rust/crates/hepta-paper-service/src/state_backup_authority.rs` and `state_backup_authority/`.

`PinnedStateBackupAuthorityV1<T>::load(configuration_path, configuration_file_hash, transport)` requires an independently supplied raw SHA-256 configuration pin. `load_process` builds the bounded local process transport. `trust()` and `configuration_hash()` expose public identities. No private key is loaded by production controller code.

`PinnedStateBackupAuthorityV1<LocalStateAuthoritySocketTransportV1>::load_socket_v1`
constructs the concrete direct transport from a separate, strictly pinned Socket
Configuration V1. It requires matching backup/online signing keys, identities
and lease limits, binds all operations to the pinned online scope, and retains
both public-key snapshots. Process V1/V2 still require their command pins. The
[socket profile contract](../../rust/crates/hepta-paper-service/src/state_backup_authority/socket/HANDOFF.md)
describes fields, pure verification, RPC uncertainty and the remaining owning
composition boundary.

The raw `StateBackupAuthorityTransportV1::invoke` interface returns untrusted JSON. `verify_reservation`, `verify_finalization`, `verify_current_head`, and `verify_journal_range` apply exact contracts and real Ed25519 verification before creating `VerifiedBackupAuthorityReceiptV1`. Process operations `reserve_snapshot`, `finalize_snapshot`, `observe_current_head`, and `read_finalized_mutation_journal` perform the same validation on returned bytes. Verified fields and constructors are private; the values have no `Deserialize` implementation or mutable accessor. Finalization requires a reservation verified under the same complete configuration identity.

A signed journal envelope does not authenticate every nested mutation by itself. `verify_finalized_journal_chain` requires the online trust supplied by Process V2 or Socket V1, verifies every online reservation and finalization using the independently pinned mutation verifier, binds authority/key/scope/manifest, and checks global and per-database continuity plus terminal signed database heads. Its `VerifiedFinalizedJournalEvidenceV1` is journal evidence, not proof that a SQLite replay has run.

`restore_source::verify_stored_restore_source_v1` takes `StoredRestoreSourceOptionsV1`: an absolute selected bundle directory, raw pins for `AUTONOMOUS_RESEARCH_STATE_BACKUP.json` and `RESTORE_DRILL_RECEIPT.json`, a validated state database manifest, an expected current inventory, and observed time. It returns `VerifiedStoredRestoreSourceV1` only after stored receipt/authority/journal checks, actual snapshot hashes and SQLite inspections succeed. `inspection()` exposes the Node-compatible source projection. `assert_current(inventory, now)` rechecks the selected source snapshots, database directory membership, exact inventory claim and freshness.

This reader handles one selected bundle. It does not implement candidate-directory ranking or skipped-candidate audit generation. Its `skippedCandidates` projection is empty.

## Authority and source bindings

The signed payload is the UTF-8 `sha256:...` string from the original `AutonomousResearchStateBackupAuthoritySignedPayload` record hash. It is not the raw digest or an immutable-bundle signature domain. Receipt subject, status, request hash, snapshot/scope, head, protocol, fence assertions, times and lease limits are validated. Signature values retain Node's optional padding and unused-tail-bit tolerance; public-key PEM parsing remains strict standard Ed25519 SPKI.

V2 configuration additionally pins the online mutation authority configuration. Journal evidence cannot change online authority/key, scope or writer manifest. The restore reader binds the signed journal range to the exact backup reservation, database scope and snapshot content, in addition to its starting and ending heads. This rejects another validly signed snapshot's range with an otherwise identical head interval.

The stored restore receipt's self-hash is only a corruption/binding check. It cannot create authority. Backup reservation/finalization/current-head signatures, nested mutation signatures for journal recovery, bundle content and actual database file hashes must also verify. Restored heads are compared from the pinned raw JSON with the original JavaScript object-member-order semantics; ordinary `serde_json::Value` equality is not used to claim that raw order was preserved.

The current inventory is an input claim whose exact structure, hash, manifest, scope, instance set and journal schema bindings are checked. This function does not observe the live runtime files underlying that claim. Runtime activation must obtain the inventory independently from its observed database adapter and recheck those live identities. Passing this function a caller-generated inventory cannot by itself activate a coordinator.

## Files, resources and races

Configuration, public documents, commands and selected source files use the existing descriptor-based snapshot helper. It walks parent components without following links, rejects hard-linked/non-regular/group-or-other-writable inputs, accepts only root/current-user ownership, bounds reads, checks byte pins, and compares file identity/metadata before and after use. Raw JSON duplicate fields are rejected before ordered parsing. The helper is shared through crate-private APIs; it is not compiled twice.

The process transport has no shell, accepts only empty configured arguments, and supplies only `PATH=/usr/bin:/bin`, `LANG=C`, and `LC_ALL=C`. It executes the verified command through a retained file descriptor. Input, output and error streams each have a 256 MiB limit, and the configured deadline is 1–120 seconds. Nonblocking pipe loops terminate when the process is stopped, including when a descendant creates another session and holds protocol pipes open. A process group is not a sandbox and this code does not claim to prevent all escaped descendants from executing.

The source reader limits one bundle JSON to 64 MiB, one restore receipt to 256 MiB, one database to 256 MiB, a source set to 256 databases and declared aggregate database bytes to 1 GiB. Checked arithmetic rejects overflow before database reads. Directory enumeration stops after one entry beyond the expected set. Actual lengths must match the signed content and directory membership is checked again when asserting the snapshot is unchanged.

The reader copies each database from its already pinned `Snapshot.bytes()` into a random private 0700 directory and a 0600 file, then opens that copy read-only with SQLite immutable mode. SQLite therefore never reopens the source pathname during inspection. Source and private-copy identities are checked around use, sidecars are forbidden, and cleanup removes only paths still naming the owned temporary files. A same-user attacker’s future changes remain outside an exclusion-lease claim. The reader runs `quick_check` and foreign-key checking, recomputes the Node schema hash, and verifies user/application versions and required schema objects against actual SQLite metadata. The legacy `NOT LIKE 'sqlite_%'` schema hash is preserved for compatibility, while a separate `NOT GLOB 'sqlite_*'` inspection covers actual user-object names for required-object checks.

These checks are bounded observations, not an exclusion lease against every future same-user filesystem modification after the last check. They neither mutate production databases nor claim a distributed atomic transaction.

## Compatibility boundary

Production protocol producers use canonical UTC millisecond timestamps. This implementation accepts that explicit timestamp domain; it does not emulate every ambiguous `Date.parse` alias. Reserve database instance identifiers must be safe strings rather than JavaScript join-coercible null/object/embedded-NUL values. Duplicate JSON keys, unsafe aliases/permissions, aggregate resource excess and mismatched journal snapshot bindings fail closed even where the Node adapter was more permissive.

## Validation

`tests/state_backup_authority_parity.rs` and `rust/oracle/state-backup-authority-v1.mjs` use pinned Node 22.23.1 and synthetic isolated authorities. The authority suite covers all four real signature contracts, v1/v2 actual subprocesses, signature/subject/request/time/lease failures, nested journal signatures and causal continuity, unsafe public inputs, changed dependencies, timeout, duplicate output and escaped-session pipe holders. Ephemeral signing keys remain in the Node fixture process; only public documents and signed synthetic receipts reach disk.

The authority suite passes 5 tests and the stored-source suite passes 6 tests under Rust 1.98.0 and Node 22.23.1. Two private-copy unit regressions also pass: an actual source-parent directory ABA leaves the pinned source checks valid while SQLite continues inspecting the original copied bytes; a replaced private-copy path fails closed and cleanup preserves the competing file. The ABA test validates the copied-byte identity boundary; it does not claim to reproduce a race inside SQLite’s pathname resolution. The source oracle creates ten real isolated SQLite files and compares the complete native source projection with Node for snapshot and journal recovery. It covers a real signed Session changeset, actual nested reservation/finalization signatures, raw nested-member reordering, unchanged canonical hashes, changed source bytes/permissions/aliases/directory membership, inventory and time mismatches, integral floating-point byte counts, and aggregate resource limits.

Two intentionally stricter cases retain valid signatures and recompute every local binding: a journal from a different signed snapshot/reservation with the same head interval, and SQLite content whose signed claims conceal garbage or missing required objects. The original source reader accepts those claims; native validation rejects them after checking the selected subject and actual database. The member-order case is independently rejected by both implementations. These are security-boundary tests, not fixtures that merely corrupt signatures.

No fixture signature is production authority, and no successful local test is a production backup, restore drill, external linearizability proof, live commit permit or runtime activation.

## Remaining route work

Actual SQLite backup creation, snapshot publication and candidate selection,
private restore/replay, renewal, pending reconciliation, resident lease checks,
and the concrete epoch controller are now implemented by the adjacent
[recoverability service](STATE_RECOVERABILITY_HANDOFF.md). The existing
[five-action CLI](STATE_BACKUP_CLI_HANDOFF.md) composes its pinned process
transports. These implementations do not close native authority installation,
the owning production activation chain, independent command acceptance or Node
retirement. A direct socket verifier must also be connected to the actual
service/fence composition under a versioned installed-host identity; its library
constructor cannot replace those facts with `ready` or
`externalAuthorityVerified` booleans.
