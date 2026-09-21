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
overwriting rename. Copy failure attempts to remove its staging tree; later
sync/publication failures can leave staging for controlled recovery.

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

After a successful rename, parent sync, root opening or inventory can still
fail. The current `WorkspaceError` does not encode a committed/unknown publication
disposition. An error therefore does not prove that the final name is absent;
inspect the owned namespace and retained evidence before retry or cleanup. Do
not delete a published attempt merely because the caller received an error.

`recover_incomplete_attempts` has no live-writer lease, generation fence or process
stop barrier. The caller must first exclude concurrent materializers. The name
pattern and UID checks are not proof that an actively copied staging directory
is abandoned. It leaves published names alone, but does not select retention
policy or authorize deletion of completed evidence.

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
