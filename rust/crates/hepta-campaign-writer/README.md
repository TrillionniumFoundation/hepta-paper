# Campaign writer and durable control journal

`CampaignWriterStoreV1` is the exclusive, generation-fenced SQLite owner. Its
database is a separate Rust writer format (`application_id=0x48504357`,
`user_version=1`). It must not be confused with the Node migration ledger or
treated as an in-place schema upgrade of a Node database.

The legacy Rust writer API remains available: campaign creation/state changes,
node claims and heartbeats, prepared-result storage, exactly-once settlement,
event-chain validation, checkpoint, backup and restore. The control integration
adds an optional two-table journal without changing those base tables.

## Authorization and database identity

`open_for_cutover` still requires `VerifiedWriterCutoverV1`, bound to the exact
database preimage, repository/build/runtime subject and initial writer lease.
The public API does not manufacture a permit, disable Node, or decide that a
rollout is production-qualified. Initial lease binding, exclusive SQLite access
and generation/token checks remain required.

For executable development/service tests, `create_local(path, policy)` reserves
an absent destination with exclusive file creation and mode 0600. It creates a
private database and commits the `local_writer_identity_v1` marker. `open_local`
requires that marker on a valid existing writer database. It rejects existing
unmarked writer databases, Node databases, malformed schemas and leaf symlinks.
The marker is rechecked under the exclusive writer connection. The local path
sets no production activation authority. A crash before marker commit leaves an
unmarked database which the local API refuses to adopt automatically.

`CampaignWriterPolicyV1` controls owner UID, bounded busy timeout and maximum
database size. Files/directories undergo the existing ownership, permissions,
identity and no-symlink checks. Opening validates the exact trusted schema:
unknown tables/indexes/triggers, altered declarations and incomplete optional
groups are rejected. Public schema constants let independent read-only tools
recognize the same format without weakening validation.

## Tables

| Group | Table | Responsibility |
|---|---|---|
| Base | `writer_lease` | One generation/token/expiry fencing record |
| Base | `campaigns` | Revision, lifecycle state, remaining money and CPU/GPU capacities |
| Base | `nodes` | Claimed/prepared/integrated legacy writer node lifecycle |
| Base | `campaign_events` | Monotonic, chained audit events |
| Optional control group | `control_streams_v1` | Campaign-bound immutable initial state/verifier hashes and next commit sequence |
| Optional control group | `control_results_v1` | Ordered full prepared-result JSON, immutable receipt JSON, plan/attempt/result identities, actual cost and writer generation |
| Optional local group | `local_writer_identity_v1` | Durable `local_only` purpose marker |

`CAMPAIGN_WRITER_SCHEMA_V1`, `CONTROL_STREAM_SCHEMA_V1` and
`LOCAL_WRITER_SCHEMA_V1` export the actual DDL. The control group is installed
atomically only when `open_control_log` receives a live writer lease and existing
campaign. A stream's initial-state and authorized-verifier hashes cannot be
changed by reopening it. `load_control_log` is a read-only inspection/export API.

The results table has three identities per campaign: primary key `(campaign_id,
sequence)`, unique `(campaign_id,result_hash)` and unique `(campaign_id,attempt_id)`.
Thus two different results cannot silently settle one execution attempt.

## Batch transaction

`append_control_batch(writer, campaign_id, expected_next_sequence, entries, now)`
is the storage boundary used by the sealed control sequencer. This low-level API
does not mint verification capabilities; the control layer independently checks
the immutable capability, all hashes and accepted verifier provenance first.

The writer performs the following operations in one `BEGIN IMMEDIATE`:

1. Check the persisted writer generation, token and expiry; load campaign and
   stream; match the caller's expected next sequence.
2. Reject empty/oversized batches, duplicate results or attempts, invalid IDs,
   oversized serialized bodies, and mixed plan hashes.
3. For an existing result hash, compare every stored entry field byte-for-byte.
   An exact retry performs no new write, cost charge or event insertion.
4. For a new result, require a running campaign and the next monotonic sequence;
   check cumulative cost against the persisted remaining budget; insert the
   complete prepared body and original receipt; append the audit event.
5. Debit cumulative actual cost, increment campaign revision once per new result,
   and update next sequence. Validate the database size before committing.
6. Commit once. Any preceding failure drops/rolls back the whole transaction.

The batch bound is 4096 entries; each result or receipt body is bounded to 4 MiB.
Integer conversions/additions are checked. CPU/GPU/memory/token measurements live
in each full prepared result; the control allocator admits and releases their
capacity in memory. Durable campaign money is consumed, while CPU/GPU capacities
are not double-debited by this journal. The legacy node-claim reservation API
continues to manage its own reservations independently.

WAL uses `synchronous=FULL`. The implementation performs all fallible size checks
before COMMIT, avoiding a false failed response caused by an optional post-commit
check. A process loss during an open transaction is recovered by SQLite. A loss
after COMMIT is resolved by replaying the immutable result/receipt identity.

## Recovery, backup and rollout boundary

`validate_integrity` checks schema, SQLite integrity/foreign keys and event-chain
integrity. The control sequencer separately replays every result and receipt
cryptographically and rejects a mismatched sequence/verifier/state binding.
`checkpoint` syncs the main database; `create_backup` uses `VACUUM INTO`, validates
the destination and syncs it; `restore_backup` validates before creating its new
destination. Optional control/local tables are included in backups.

The local reopen path can recover an interrupted local WAL. Production reopen
retains the signed preimage/sidecar rules; operators must complete the existing
recovery procedure and obtain authorization for the actual recovered preimage.
Do not bypass those rules by calling the local APIs on an authoritative database.

This writer alone does not fence a Node process writing a separate native store.
The rollout coordinator must hold its enrolled writer fence around the entire
synchronous authoritative commit, and Node must honor its corresponding fence.
Neither a stored receipt nor this module turns a shadow/canary run into a signed
production takeover. Node→Rust data transformation and semantic parity are
separate acceptance items.

## Tests and diagnostic contract

```sh
cargo test --locked -p hepta-campaign-writer -p hepta-control-plane
```

Tests cover signed initial lease binding, stale generations/revisions, duplicate
integration, reservation settlement, backup/restore, real control batches and
reopen. The crash test starts the Rust test executable as a child, commits an
initial campaign, changes it inside an open transaction, and exits directly
without destructors. The parent opens the remaining WAL and verifies that the
uncommitted budget/revision change and partial event effects did not survive.

`NotLocalDatabase` means the required local marker was absent; it is not a prompt
to adopt or modify that database. `ControlLogConflict` means immutable binding,
identity, sequence or exact retry content disagreed. Existing detailed lease,
budget, filesystem, schema and SQLite error variants remain available.
