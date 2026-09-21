# Durable resource ledger persistence boundary

`DurableResourceLeaseLedgerV1` remains a standalone JSONL lease journal. Its
source tests do not establish installed scheduling, hierarchical dispatch,
physical resource reclamation or independent reconciliation authority.

## Open and recovery

The actual leaf is opened with `O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC`, required
to be a regular file, and retained under the existing exclusive file lock.
Reading is bounded by 256 MiB plus one detection byte, independently of the
initial metadata length. These checks do not pin every ancestor or exclude
uncooperating same-UID writers, hard-link aliases or replacement of the path.
The lock protects cooperating users of the same inode, not the entire namespace.

All complete events, their sequence/hash chain and lease transitions are
validated before an incomplete trailing fragment is removed. Corrupt complete
prefixes and a torn file with no preceding newline are refused without
truncation. Existing blank-line compatibility is preserved. A valid
prefix followed by a torn fragment is retained, truncated and synced before a
usable owner is returned. If truncation or its sync fails, opening returns an
error and may already have removed that validated incomplete suffix; it never
returns an owner claiming recovery succeeded.

## Append failure

Encoding, transition checks, byte limits and next-sequence overflow are checked
before persistence. Immediately before writing, the owner is marked as requiring
inspection. It becomes usable again only after the actual complete event,
newline and `sync_all` succeed and the in-memory state has advanced. Any I/O
error or unwind after persistence begins leaves the owner in that state.
The failure does not prove that zero bytes, a partial event or a complete event
were written. No automatic retry, release, truncation or compensation occurs.

While inspection is required, **all** state reads and mutation methods refuse
with `ResourcePersistenceRequiresInspection`, including otherwise idempotent
calls. `path()` and `inspection_required()` remain available for diagnostics.
The retained file lock remains held. Drop the owner, then reopen and replay the
actual journal to recover its persisted disposition. Reopening proves the parsed
journal state, not the outcome of external work or resource release. A finalized
lease remains charged and expiry moves it to uncertain; it does not refund it.

`active_charges()` now returns `Result<Vec<DurableResourceLeaseV1>,
ControlPlaneError>`: a cached empty list after a possibly persisted prepare
would be unsafe. Existing repository callers were updated. This is an explicit
source API change; callers must propagate refusal rather than default to an
empty list. The new error variant also affects exhaustive error matches.
Successful lease records, hashes, transitions and JSONL bytes are unchanged.

## Authority and durability limits

`reconcile_and_release` still accepts a caller-supplied hash. Its caller must
establish trusted terminal disposition separately; the ledger does not verify
signatures or prove capacity is reclaimable. `validate_integrity` checks cached
lease hashes and usability, not ongoing integrity of the disk namespace.
File sync is the existing persistence boundary; this patch does not qualify
power-loss behavior, parent-directory durability or target-host storage.
The control-plane runtime and this journal are not yet one durable owning gate.

## Verification

The regression suite uses actual files for valid-prefix torn recovery, corrupt
prefix preservation, no-follow/special-file rejection and exact read bounds.
Private persistence-boundary tests write real partial or complete events before
injecting an error; a separate read-only descriptor causes a real write error.
They prove that all subsequent calls refuse without changing bytes, the lock
remains held, and reopening distinguishes complete from torn events. A complete
finalization followed by a failed acknowledgement remains charged across replay
and expiry. These injected acknowledgement failures are not a target-filesystem
fsync fault campaign or a process-crash durability qualification.
