# Workspace implementation selection and recovery

Two Rust crates export types named `WorkspaceRootV1`, `MutationPolicyV1` and
`PreparedWorkspaceResultV1`. They have distinct contracts and are not interchangeable.
Use qualified crate paths when selecting a consumer or discussing evidence.

The current repository has no cross-crate consumer of `hepta-workspace`: its
materialization API is exercised by its own unit tests. The actual
[`local_slice` integration fixture](../../rust/crates/hepta-local-vertical/tests/local_slice.rs)
uses `hepta-workspace-authority`, as declared in its
[`Cargo.toml`](../../rust/crates/hepta-local-vertical/Cargo.toml). That fixture does
not validate `hepta-workspace` materialization or wire either API into a complete
production writer. Keep this distinction when reporting migration progress.

| Boundary | `hepta-workspace` | `hepta-workspace-authority` |
|---|---|---|
| Implementation | [`src/lib.rs`](../../rust/crates/hepta-workspace/src/lib.rs) | [`src/lib.rs`](../../rust/crates/hepta-workspace-authority/src/lib.rs), [`bound.rs`](../../rust/crates/hepta-workspace-authority/src/bound.rs) |
| Root open | Requires an expected owner UID and an absolute canonical root without group/other write bits; retains the root descriptor and object identity. | Accepts `Option<u32>` for expected UID; `None` omits the owner comparison. Still requires a canonical directory without group/other write bits and retains its descriptor. |
| Resolution/inventory | `resolve_existing` verifies root identity, path containment and link components; `inventory` produces typed `TreeInventoryV1`. | `anchored_path` validates relative syntax/root identity; actual child opening and inventory use descriptor-bound objects. The path string alone is not an opened-child capability. |
| File bound | 512 MiB per successful regular-file copy/hash; actual stream reads stop after at most one extra byte used to detect growth beyond the limit. | 1 GiB per regular file. |
| Tree bound | Copy and inventory each reserve from one shared 100,000-entry budget while enumerating, before collecting/sorting or processing each child. Files and directories each count once; the root does not count. Copy rejection precedes publication. | Both copy and inventory count at most 100,000 entries. Child opens reject cross-device objects and hard-linked regular files. |
| Attempt name | Private staging `.attempt-<id>-<nonce>-<sequence>.creating`, final `attempt-<id>`. | Creates the final `<id>` directory exclusively before copying. |
| Publication | Linux `renameat2(RENAME_NOREPLACE)` followed by parent sync; no replacement fallback. | No staging rename: a failed copy can leave the exclusively created attempt directory. |
| Mutation accounting | Typed before/after records and changed after-image file bytes; additional 1 GiB mutation ceiling. | Added/changed/removed path sets and changed after-image bytes; policy supplies path/byte ceilings. |
| Policy differences | Required component-boundary prefix plus exact case-sensitive extension; no separate deletion switch. | Component-boundary prefix, explicit `allow_deletion`; a nonempty extension allowlist checks lower-case extensions when a path has an extension. |
| Recovery | `recover_incomplete_attempts` removes owner-matching staging directories with its reserved name pattern. | No attempt-directory recovery API. Copy verification can remove a failed individual destination file only while its binding is still known. |

## Actual inputs and evidence flow

For `hepta-workspace`, keep the root owner through source inventory and
`materialize_attempt`. The returned `AttemptWorkspaceV1` carries its initial
inventory and final path. Reopen that actual attempt under the expected UID,
inventory after execution, compute `MutationManifestV1::between`, validate the
role policy and construct `PreparedWorkspaceResultV1` from those exact values.
Reviewer policy permits no mutations. A writable policy is an explicit set of
prefixes/extensions and changed-entry/byte limits; absence is not blanket access.

For `hepta-workspace-authority`, open actual source/attempt roots, materialize,
collect both inventories, use `compare_inventories_v1`, validate the exact role
policy and call `prepare_workspace_result_v1`. Descriptor-bound copy rechecks
source metadata, source hash and destination hash before success. Its stronger
child observation does not supply a durable attempt recovery owner.

Inventory, mutation and prepared-result records contain public fields; several
are also deserializable. Their constructors accept supplied records and do not
independently re-read all bytes or prove that every passed hash came from those
same roots. They are not an opaque scientific verification or campaign-write
grant. The concrete prepared-result verifier must independently bind actual
workspace/artifact bytes, plan/attempt/policy identity and currentness before
the campaign writer consumes the result. A matching hash-shaped string does not
establish that flow.

The crates use different inventory and mutation hash bodies. In particular the
first includes typed ownership/link metadata; the second inventory records
path/kind/mode/size/content digest. Recomputing a hash using the other crate does
not establish byte or semantic compatibility. Keep the producer's actual type
and hash contract with its consumer.

## Publication failures and cleanup

In `hepta-workspace`, a target created after the initial existence check causes
the atomic publication step to fail with `AttemptAlreadyExists`. An existing
empty directory, regular file or dangling link is preserved, as is the
unpublished staging tree. No unsupported-kernel fallback performs an ordinary
overwriting rename. Copy, staging-inventory or staging-sync failure attempts to
remove only the staging directory whose current metadata still matches its held
directory descriptor. Failed cleanup or a publication collision can leave staging
for controlled recovery. The current materializer also holds the shared parent
directory lock described below until error cleanup finishes.

Copy and inventory use the same tree-counting rules with a fresh budget for each
walk. Pending siblings consume budget before recursion, so separate subtrees
cannot each obtain a new 100,000-entry allowance and directory collection is
bounded before sorting. Successful trees retain their existing ordering and
inventory hash contract. An over-limit tree is rejected during copying and the
staging cleanup runs before any final-name publication.

The regular-file metadata check remains, and both copying and hashing additionally
limit actual input to `MAXIMUM_FILE_BYTES + 1`. Reading the extra byte returns
`FileByteLimitExceeded`; a failed copy may have written that one extra byte only
inside its unpublished staging tree. This handles growth after the initial size
check without claiming a concurrent filesystem snapshot or an aggregate tree
byte budget. The separate 1 GiB mutation ceiling is not a materialization quota.

The same bounded inventory now completes inside staging before the no-replace
rename. Invalid inventory inputs, including non-UTF-8 child names, are rejected
before a final name can be published. Inventory entries are relative to the tree
root, so successful inputs retain their existing inventory and hash contract.
After publication the producer repeats that bounded inventory, compares the
complete value with the staging observation, and revalidates the final root.
Changed file contents or metadata return `InventoryChanged`; newly invalid
entries retain their specific error, such as `NonUtf8Path`. The two observations
preserve the published-tree checking boundary but are not a consistent snapshot
against non-cooperating concurrent modification.

After a successful rename, parent sync, final-root opening/revalidation or the
published inventory can still fail. These errors return
`WorkspaceError::PublishedAttemptRequiresInspection` with `final_path`,
`AttemptPublicationPhaseV1` (`ParentDirectorySync`, `PublishedRootOpen`,
`PublishedRootValidation` or `PublishedInventoryValidation`),
`parent_sync_completed` and the original boxed
`WorkspaceError` cause. Final-root validation binds the actual published
directory to the retained staging inode and identity, separately from the
published content comparison. A false sync flag means durability remains unconfirmed,
not that the rename was undone. A true flag records only that this call's parent
directory sync completed, not that later namespace or content changes are safe.
The producer neither removes an already-published directory nor retries. Inspect
the namespace and original cause before recovery; retrying the same existing
final name still fails with `AttemptAlreadyExists`.

The function signatures remain unchanged. Adding public error variants can
require changes to external exhaustive `WorkspaceError` matches; it is not
source compatible with every possible external match expression.

`materialize_attempt` retains a shared nonblocking `flock` on the actual parent
directory from before staging creation through publication, validation or error
cleanup. `recover_incomplete_attempts` retains an exclusive nonblocking lock on
that same directory before enumeration and deletion. Lock conflicts return
`AttemptParentBusy` without waiting or changing the tree. Different cooperating
materializers can run together; changing the parent's link count by creating
sibling directories does not count as an identity change. The sole lock-owning
descriptor is close-on-exec, is never duplicated and releases its lock on drop
or process death. This contract uses the pinned Rust standard library's Linux
`File::try_lock_shared` / `try_lock` implementation.

Both operations open the canonical owner-only parent with
`O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC` and bind its device/inode, ownership and
mode. Target-child IO, enumeration, cleanup and no-replace rename resolve through
the retained `/proc/self/fd/<fd>` parent; parent sync uses that descriptor directly.
Private staging/final root observers keep this anchor for all their IO and are
dropped before their parent. No descriptor path escapes in the returned attempt.
The private `open_attempt_child` constructor currently reuses `WorkspaceRootV1`
only for inventory, identity comparison and revalidation; its `/proc` IO path
does not satisfy public `resolve_existing` canonical-path semantics. These
internal roots must not escape or be used as public root capabilities.
Canonical caller-path revalidation reports `AttemptParentChanged`; it does not
prevent a namespace race by itself. Descriptor anchoring prevents a parent
pathname replacement from redirecting deletion or publication into the
replacement directory. Rebinding observed before publication prevents the
rename and attempts cleanup in the original parent. An observed rebind after
rename uses the existing published-inspection error. Its `final_path` records
the caller's original name; inspect the displaced parent as well, since that
name can now refer to another object. Recovery can remove original staging
before noticing a concurrent parent rebind and returning an error.

Exclusion applies only to cooperating updated binaries using this lock protocol.
Arbitrary same-UID actors and older materializers can ignore it; callers must
exclude those writers separately before recovery. The lock is not a workspace
snapshot, generation fence or external process stop barrier. Name/UID checks
alone still do not prove abandonment. Recovery leaves published names alone and
does not choose their retention policy or authorize deleting completed evidence.

In `hepta-workspace-authority`, copy failure can leave a partly populated final
attempt directory. Exclusive creation then prevents silently retrying the same
name. The owning recovery workflow must inspect/quarantine it under the original
attempt identity. A verified partial-file removal is not removal of the whole
attempt and does not make an external operation safe to replay.

Root descriptors and path checks do not create an OS sandbox or exclude all
same-principal concurrent mutation. The first crate's path-based copy/inventory
does not have the second crate's repeated per-file snapshot checks. Unifying
these APIs needs an explicit choice of ownership, input limits, publication and
recovery semantics with concurrent mutation tests; a shared short type name is
insufficient.

## Development and acceptance

From `rust`:

```sh
cargo test -p hepta-workspace -p hepta-workspace-authority --locked
```

The first crate covers isolated materialization, policy/links, controlled staging
cleanup and a destination collision created between the initial check and actual
publication. The collision cases verify original device/inode/content and
retained unpublished bytes. The second covers actual isolated copies, hard-link
rejection, in-place source changes between verification passes and identity-bound
partial-file removal. These source tests do not establish target-host sandbox
qualification, a live recovery barrier, artifact scientific correctness or
production writer admission. The filesystem prepared-result and commit suites
exercise the separate downstream boundaries.

Additional first-crate tests run the complete materialization kernel with private
small budgets: exact-boundary trees publish, enumeration/recursive overflow leaves
no final directory, and staging cleanup preserves the source. A lightweight
counter test exercises the fixed production entry ceiling without creating
100,000 files. Real files grown after metadata observation test copy/hash stream
offsets and rejection at the small byte limit plus one; the exact byte boundary
still copies and hashes unchanged bytes. These tests do not claim a full-scale
100,000-file or 512 MiB performance run. Public APIs expose no limit override.

Publication tests also use a real non-UTF-8 source name to verify rejection and
staging cleanup before any final name exists. Private phase hooks run only after
the real rename, then inject parent-sync or final-root-open errors, or change the
actual root mode to trigger real revalidation. They check the preserved phase,
sync flag and original cause, retained final bytes and no overwrite on a same-ID
retry. A real final-directory replacement is rejected against the retained
staging identity and neither directory is reclaimed. Injected failures exercise
the error protocol. Further post-rename hooks really rewrite a regular file
without changing its length or add a non-UTF-8 regular-file name; directory
identity remains unchanged while published inventory validation rejects them.
Their final bytes survive both the error and a same-ID retry. These tests do not
simulate or qualify physical storage durability.

Independent Rust child processes pause inside actual materialization or recovery
while holding their respective locks. Tests verify shared sibling publication,
immediate conflicting-operation refusal, unchanged staging on refusal and lock
release after killing and reaping the holder. Real parent-directory rebinds
exercise prepublication cleanup, classified postpublication failure and a rebind
after recovery's last pathname check: only the original anchored staging is
removed, while replacement staging and published sentinels remain. These tests
do not establish protection against non-cooperating child-entry replacement or
mount/namespace adversaries.
