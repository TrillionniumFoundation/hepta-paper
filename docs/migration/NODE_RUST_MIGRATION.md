# Node-to-Rust capability migration

## 1. Strategy

Migrate capability-by-capability behind stable module contracts. Do not treat the
repository as one indivisible rewrite and do not run two authoritative writers
for the same effect.

The current Node architecture remains the behavior/authority source until a
specific capability completes its cutover gate. Rust source presence or global
merge does not transfer authority.

## 2. Per-capability states

```text
node_authoritative
  -> rust_contract_ready
  -> rust_source_implemented
  -> rust_source_qualified
  -> rust_shadow
  -> rust_canary
  -> rust_authoritative
  -> node_retiring
  -> node_retired
```

An external/evaluation capability may require target-host or external-authority
evidence between source qualification and shadow/canary.

## 3. Capability record

Each migration record contains:

```text
capabilityId
Node entrypoints and authority paths
Rust module/crates
parity class: exact/semantic/evaluation/retire
known Node defects and approved correction decision
state/schema/protocol dependencies
shadow comparator or evaluator
cutover prerequisites
writer/external-effect mutual-exclusion group
rollback implementation/version
retirement evidence
```

## 4. Parity classes

### Exact

Bytes, hashes, statuses, rows, and accept/reject decisions match. Use golden and
adversarial corpora.

### Semantic

Representation may differ, but approved invariants, state transitions, and
effect class match. Use normalized projections and transition tables.

### Evaluation

Model-generated prose/code/reviews are not byte-compared. Bind inputs,
permissions, metrics, downstream deterministic checks, and independent quality
review.

### Retire

No Rust target. Prove the behavior is unreachable, authority is removed, and
historical artifacts remain verifiable.

## 5. Strangler adapters

The first module registry may point to Node legacy adapters. An adapter:

- receives the common versioned command;
- translates to the existing Node capability;
- preserves attempt/lease/idempotency/resource identity;
- returns the common prepared-result envelope;
- cannot add authority beyond the existing path;
- emits differential evidence for Rust shadow comparison.

### Current bounded observation primitive

`rust/crates/hepta-legacy-compatibility/src/node_adapter.rs` now implements
`NodeLegacyObservationAdapterV1`. It accepts only an already-produced incumbent
Node observation and an exact bounded request, reuses the qualified production
Node record-hash implementation, enforces sorted unique artifact hashes and
byte/count ceilings, rejects any observation for which an external action may
have started, and fences conflicting reuse of an attempt identity. The returned
prepared result always records `authority_granted=false` and
`central_state_committed=false`.

This is a migration observation primitive, not the complete strangler adapter
described above. It never launches Node, translates a common command, owns a
durable campaign journal, performs provider work, commits campaign state,
proves production shadow/canary parity, transfers writer authority, or retires a
Node path. The separate `rust/crates/hepta-module-platform/src/legacy_adapter/` implements
a bounded protocol adapter beyond this observation primitive. Current implementation states
come from `docs/system/truth/work-items.v2.json`, not this historical description.
A `source_implemented` migration item does not establish production parity,
writer transfer, or retirement. The [full replacement acceptance contract](FULL_REPLACEMENT_ACCEPTANCE.md)
requires command/mode and capability-specific evidence before those transitions.

The generated [Node/Rust command compatibility map](node-rust-command-map.v2.json)
is the **single migration ledger**. It keeps every registered command route and,
where a command has a multi-action surface, its reviewed argument-mode rows
bound to either a Rust candidate or an explicit unmapped decision. No second
campaign/command migration matrix is authoritative. Its `partial_local_source`
rows are source call-chain candidates only; they do not grant parity, production
activation or Node retirement. The map is checked by
`docs/tools/audit-node-rust-coverage.mjs`, which verifies live command/action
inventory coverage plus the declared Rust function and executable-test symbols.
Source symbol existence is not call-graph verification or evidence that tests passed.

Encoding version 2 stores each canonical source path and `(path, symbol)` binding
once in sorted index tables; route and argument-mode rows refer to those indexes.
The auditor fail-closes on missing, duplicate, out-of-range, unsorted, or unused
table entries, expands the indexes before applying the unchanged route/mode and
source/test checks, and exposes only the expanded contract to report consumers.
This removes repeated evidence text without removing a route, test, source,
remaining gap, or authority boundary. The generated Markdown remains the human
projection; it is not a second source of truth.
The [command gap closure ledger](NODE_RUST_GAP_CLOSURE.md) retains every route,
including partial candidates, with its Node entrypoint, remaining implementation
work and required acceptance evidence;
it is generated by `docs/tools/generate-node-rust-gap-report.mjs` and is not an
acceptance receipt.

The `operator/store-migrate` candidate is the bounded local command
`hepta-paper-rust store-migrate NODE_DB [TARGET_VERSION]`. It embeds the original
25 migration descriptors and requires a canonical private DELETE-mode database
in a current-UID private directory. Every pre-existing WAL, SHM or rollback-journal directory
entry is refused before SQLite observation, including dangling links and empty
journals. A WAL header without sidecars is also refused; this command does not
recover a hot journal, change journal mode or erase crash residue.

The same owner now holds one EXCLUSIVE transaction for the complete requested
range. Migration hashes, history and lease-bearing state are checked after
acquiring that lock, including no-op replay and version-zero foreign tables.
DDL failure rolls back the whole requested range, not just its final migration;
this is an explicit stricter native failure contract rather than Node per-step
failure parity. Final history, quick-check and foreign-key checks precede COMMIT.
EXCLUSIVE locking mode retains the physical SQLite exclusion through the receipt
hash. The bounded streaming hash uses the already retained database descriptor;
opening/closing a second descriptor while SQLite owns POSIX locks is avoided.
SQLite closes before the retained descriptor on normal and error exits.

Pre-COMMIT identity failure rolls back. COMMIT errors or post-COMMIT identity/hash
failure report `OutcomeUnknown`, retain all source evidence, and never claim that
nothing was applied. With unchanged valid source identity and no sidecars, the
ordinary retry resolves the original migration history without duplicate DDL.
Actual process-death tests keep the original crash files unchanged and inspect
only an isolated copy to distinguish old history from committed history; they
do not authorize automatic recovery or adoption of the original residue.

The actual Node and Rust entrypoints are compared for the supported offline
upgrade's schema, migration identities and retained business results. Different
SQLite engines and the stronger atomic range contract do not imply identical raw
file bytes, global Node command parity, administrative receipt publication or
submission-handoff activation. The returned hash describes the actual native
committed bytes; the receipt keeps `productionActivation=false` and
`nodeRetirementVerified=false`. These snapshot checks do not atomically fence another process between source
observation and SQLite open, and they are not a hostile same-UID VFS. Offline
quiescence is still a precondition; after lock release another writer can change
the database. Installed
writer custody/fencing, explicit crash recovery, migration/canary/rollback and
Node retirement remain separately required before live cutover.


Adapters are temporary and have retirement work items.

## 6. Duplicate crate resolution

Adjacent Rust responsibilities now have explicit product-owner decisions:

- `hepta-workspace` is the selected durable workspace product owner.
  `hepta-workspace-authority` remains a standalone compatibility/reference
  implementation and is absent from the registered product module and product
  crate dependency graph.
- `hepta-readonly-control` owns schema/format validation while
  `hepta-readonly-store` owns physical immutable SQLite inspection and depends
  on that control contract. This is a layered capability split, not competing
  read owners.
- `hepta-legacy-compatibility` owns production Node byte/JSON compatibility.
  `hepta-compatibility` remains a Rust-draft/reference CLI surface and is not
  selected by the compatibility product module or product control/service
  crates.
- `hepta-orchestration-kernel` remains a standalone compatibility/experimental
  crate. Snapshot, candidate routing, scheduling/resource, observability and
  performance product ownership is selected in `hepta-control-plane`; the
  standalone crate is not re-exported by the product control plane.

The architecture gate enforces these selections. Compatibility crates may remain
buildable for differential testing, but “both remain available and callers
choose” is not an allowed product composition.

## 7. Data migration

Data/state changes use:

1. read-only preflight and normalized projection;
2. schema/version compatibility proof;
3. backup and exact restore canary;
4. shadow replay on production-shaped copies;
5. writer quiescence and preimage binding;
6. atomic migration/cutover transaction;
7. post-cutover read-back and event audit;
8. rollback before the irreversible threshold or forward recovery after it.

## 8. Cutover

Authority transfer binds exact source, binaries, configurations, host/service,
state preimage, active leases, external evidence, and first new writer/effect
identity. Node authority is disabled mechanically, not merely unused.

## 9. Retirement

Node retirement requires:

- no production entrypoint/import reachability;
- no active service, credential, queue, cron, or writer lease;
- compatibility reader/verifier retained where historical artifacts require it;
- migration and rollback window decision;
- documentation and module registry updated;
- no fallback silently reactivates Node authority.
