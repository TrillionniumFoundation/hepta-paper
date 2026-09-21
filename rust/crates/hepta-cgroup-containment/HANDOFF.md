# Cgroup containment implementation contract

This crate owns one operation directory in a delegated Linux cgroup-v2
hierarchy. The actual broker dispatch creates it before spawning a blocked
pre-exec child, binds a durable recovery record, attaches that child before
release, and requires cleanup before successful result classification. It does
not install a service, grant delegation, change UID or independently qualify a
host.

## API and ownership

`CgroupV2PolicyV1` selects a canonical absolute root, owner UID, authority mode,
PID/memory/CPU limits and cleanup timing. `production_eligible` is an observation
of that policy and hierarchy, not a retained permission grant. The operation
factory independently captures its actual hierarchy.

`CgroupV2OperationV1::create` retains the root and operation directory handles.
Limits are installed before the object can attach a PID. Control I/O uses fixed
source-owned leaf names relative to the retained operation; root-relative
creation/removal uses the retained hierarchy. The public `path()` is a display
and binding label, not an I/O authority.

`root_directory_identity()` and `directory_identity()` derive identities from
the retained objects and refuse observed namespace drift. The broker's
`bind_containment` consumes these actual identities, rather than independently
reopening the root pathname. The V1 recovery record keeps its existing root
device/inode and operation device/inode/change-time fields.

`recover_existing_with_root_identity` checks the expected root device/inode
against the captured hierarchy before interpreting an absent operation or
arming cleanup of a present operation. The actual broker recovery path uses
this factory. The older `recover_existing` signature remains for callers that
have no persisted root identity; it provides no claim of that additional
historical root binding. Both factories check the expected operation identity
when it exists.

Root link counts and change times may legitimately change when sibling
operations are created or removed; they are not fixed root identity. The
recorded operation change time remains a conservative restart check.

## Filesystem and control boundaries

Production selection checks `fstatfs` on the held hierarchy for
`CGROUP2_SUPER_MAGIC`. A path prefix, files with cgroup-like names or support
listed in `/proc/filesystems` cannot substitute for this check. The configured
production location remains under `/sys/fs/cgroup`.

Control opens use descriptor-relative `openat2` with beneath, no-symlink and
no-mount-crossing resolution. Unsupported kernel or security-policy results
are errors; there is no weaker pathname fallback. Control values retain their
existing 128-byte bound, and fixture process-set writes retain their 8 KiB bound.
Event reads stop at 4 KiB plus one overflow byte and reject duplicate keys,
missing/malformed populated fields and values other than 0 or 1. Cleanup checks
events before its first kill write and uses checked monotonic deadline arithmetic.

The LocalFixture mode operates only on owned ordinary files. Controls must be
regular, singly linked and appropriately owned/protected before any truncation.
Nonblocking opens prevent a substituted FIFO from blocking a fixture reader;
symlinks and hardlink aliases are refused. Production pseudo-files are never
treated as truncatable fixture files. LocalFixture is always ineligible for
production.

## Failure and cleanup

Observed hierarchy/operation replacement or loss of authority makes the owner
terminal. It cannot capture a replacement as a new baseline. A failed call may
already have affected the original object before a later observation fails;
failure is not a no-effect or rollback receipt.

Explicit cleanup is attempted once. An error does not trigger an implicit
second cleanup in Drop. A still-live, unused owner may perform its existing
best-effort cleanup on Drop, subject to the same identity and authority checks.
The broker retains the durable recovery record on cleanup failure and treats
ambiguous released execution conservatively; it never clears the record merely
because a replacement hierarchy lacks the original operation name.

Retaining an O_PATH reference does not keep a cgroup online, preserve permission,
or prevent an authorized manager from removing an empty group. If control
access to the original object fails, the operation refuses; it does not retry
against the current pathname.

## Namespace ownership and remaining races

Creation uses mkdir followed by opening the new child, and removal ultimately
uses a parent descriptor plus a leaf name. Linux provides no atomic
expected-inode check with either of these operations. Descriptor retention
prevents later control I/O from following a replacement ancestor/operation, and
observed replacements are refused, but a check followed by unlinkat is not
atomic deletion of a retained inode.

Successful creation and final name removal therefore require a cooperating
namespace owner that prevents simultaneous replacement by another manager.
The broker's dispatch/recovery lock coordinates its own callers; it does not
enforce exclusion against arbitrary same-UID or privileged actors. This source
change does not close that deployment contract or claim arbitrary concurrent
leaf replacement is safe. Partial creation failures are not an excuse to
blindly delete an unbound path.

Linux cgroup v2 does not support directory rename. Ordinary-filesystem rename
tests exercise pathname safety only. The kernel case is empty-group removal
followed by same-name recreation while the old reference still exists.
See the [Linux cgroup implementation](https://github.com/torvalds/linux/blob/v6.12/kernel/cgroup/cgroup.c)
and [cgroup-v2 interface documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html).

## Verification and qualification

The added public error variants `NamespaceChanged`, `OwnerRequiresInspection`
and `InvalidControlFile` require downstream exhaustive matches to be updated.
The new root-identity getter and root-bound recovery factory are additive APIs;
the existing V1 record format is unchanged.

Run from the Rust workspace:

```sh
cargo test -p hepta-cgroup-containment -p hepta-codex-broker --all-features --locked
```

Source regressions use actual owned ordinary files and the actual factories.
Broker recovery fixtures create the operation and durable record in a child
process that exits without Rust destructors; the kernel closes its descriptors.
The parent bounds completion and owns kill/wait cleanup. This exercises
process-loss recovery without leaking a live owner through mem::forget.

A disposable delegated cgroup2 subtree is still required for real controller
availability, blocked-child attachment, escaped descendants, kill/populated
observation, dead-object behavior, permission revocation, and removal/recreation
tests. An unrelated sibling must remain unaffected. Those host results and the
independent signed package remain separate from fixture success; neither this
document nor the public production API proves an installed Rust broker or Node
retirement.
