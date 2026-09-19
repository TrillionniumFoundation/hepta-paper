# Rust schema/genesis installation and commit recovery

This slice is an integrated native candidate, not accepted runtime activation. Its public
entry consumes the real `NormalizedSchemaMaintenanceV1`; the recovery entry
independently verifies the real pinned Ed25519 reservation, exact registered
scope, normalized source preimages, fixed target DDL and actual database state.
It never deserializes a normalized or active capability from progress JSON.

## Implementation and source

The Node source is
`paper-adapters/automation/autonomous-research-online-schema-transition-installation.mjs`.
Rust candidate entry is
`online_schema_execution::maintenance::normalization::installation::{install_schema_maintenance_v1,resume_schema_installation_v1}`.
The private `metadata::install` preserves all fifteen mutation authority metadata
fields, four resident journal metadata fields, signed genesis, v2 previous heads,
empty marker/finalization requirements, exact immutable trigger recreation and
single-row update postconditions. Fixed target DDL uses the existing real
`apply_schema_transition_statements_v1`, including handoff v1→v2 invariants.

`InstalledSchemaMaintenanceV1` has private fields and no constructor,
Deserialize, Clone, public raw connection or arbitrary database callback. It
retains the root-inode maintenance flock and ten real exclusive SQLite
transactions. Its observations are not external finalization or runtime ready.

## Real preimage and recovery proof

Before any installation write, ten normalized source byte images are published
no-clobber beneath the held private transition directory, using derived names
and durable file/directory fsync. Every artifact must hash to the actual signed
`expectedNormalizedSourceSha256`. Existing mismatched artifacts are rejected;
there is no repair/rotation/overwrite fallback.

Recovery never trusts `installations`, phase or completion flags as database
proof. It reconstructs each before-state from those signed byte images and
creates an independent expected after-state with fixed DDL and the real signed
genesis. For v2 both actual pristine pre-observations and the complete pre-runtime
hash are revalidated. Post-pristine hashes are computed from actual SQLite under
the caller-owned transaction for the installation state comparison. A separate
final inventory/pristine aggregation is still required at the runtime
activation boundary.

The exact comparison includes schema SQL and all persistent table cells, rowids,
generated columns, SQLite types, duplicate row multiplicities, SQLite system
bookkeeping, original JSON bytes and timestamps. There are no heartbeat-specific
field exclusions. `sqlite_sequence`, user_version, application_id and encoding
are included; physical rootpages and header write counters are excluded from
logical equality. Full integrity checking rejects inconsistent secondary indexes.
Unknown virtual/shadow surfaces and ambiguous inaccessible rowids fail closed.
The helper never commits or rolls back its caller's transaction and imposes
bounded identifiers, objects, rows, cells and aggregate bytes; SQLite's length
limit is reduced before reading values.

## Locks, time and durable progress

All ten databases are opened through private held-source wrappers and acquire
`BEGIN EXCLUSIVE` before the first install. Busy timeout is zero: a competing
SQLite writer cannot cause installation to wait past a signed lease. Registered
namespace, source inode/permissions/ownership, root identity, current journal CAS
hash and authority/key pins are repeatedly checked. A final memory-only clock
sample follows the last descriptor check before COMMIT. Clock regression,
expired lease or a remaining window below the explicit minimum commit margin
(at least 1000 ms) rejects the commit. An in-progress synchronous filesystem or
SQLite commit cannot be preempted by Rust; the margin is not a guarantee against
arbitrarily slow storage.

After each commit the executor exposes an observation-only checkpoint *before*
progress publication. It then reacquires EXCLUSIVE and compares the actual full
post-state before publishing the durable record. The SQLite gap between COMMIT
and reacquisition is covered by the real signed all-writer maintenance fence;
local reacquisition and full-state comparison detect intervening SQL mutation.
The root maintenance lock excludes cooperating native maintenance executors.
Uncommitted databases roll back on error; completed commits are never described
as rolled back. A new process can distinguish genuine post-state from partial,
foreign or tampered contents without relying on a published completed flag.

## Validation status

The final isolated candidate suite passed seven real installation/recovery tests
(`438.88 s`, `/tmp/hepta-installation-suite.log`): v1 and pristine-v2 ten-
database installation against complete Node records, wall-clock lease expiry,
real child-process crash recovery, durable-commit-before-progress recovery,
retained-lock rejection, and tamper/cross-role/expiry rejection. The exact
SQLite state comparator passed ten tests (`0.44 s`) covering all persistent
cells, generated values, duplicate/NULL-key rows, system bookkeeping, index
integrity and caller transaction ownership. The signed preimage private-copy ABA
regression passed (`/tmp/hepta-installation-preimage-aba.log`). Candidate
source-only rustfmt, all-target Clippy, strict library Clippy (`-Dunsafe-code`,
`-Dclippy::unwrap_used`, `-Dclippy::expect_used`, `-Dclippy::panic`) and the
Node oracle ESLint gate all passed (`/tmp/hepta-installation-gates2.exit`,
`/tmp/hepta-installation-candidate-fmt.log`). The same suite was rerun
against the integrated working tree before promotion; all 17 installation and
exact-state groups passed. The result is still a local implementation proof,
not production activation or external authority acceptance.

## Explicit remaining boundaries

External schema finalization, target authority configuration restart and final
runtime activation are not supplied by this capability. The qualified authority
service's fencing/linearizability remains an external trust obligation. Production
has no Node runtime dependency; Node 22.23.1 is used only by the differential oracle.

The signed normalized byte image is never rewritten to mimic a different SQLite
engine's header. Node 3.51.3 vs native 3.53.2 WAL normalization SHA differences
remain real and mismatched old-engine reservations fail before writes. Existing
v2 Node object insertion-order-only rejection differences remain documented in
the normalization handoff. The Node plan's plannedAt is local plan state rather
than a separately signed request field; recovery validates the real fixed plan
hash/request binding and plannedAt≤requestedAt but does not claim an independent
external signature on that timestamp.

Held-descriptor checks and SQLite NOFOLLOW bound observed paths, but the named
SQLite VFS is not descriptor-bound and does not eliminate every adversarial
same-user ABA window. No source-side sidecar cleanup or repair is added here.
A crash leaving a nonzero hot rollback journal remains fail-closed; the covered
recovery boundary is durable COMMIT before progress publication. Preimage
artifacts are retained as evidence, not recursively deleted by recovery.
