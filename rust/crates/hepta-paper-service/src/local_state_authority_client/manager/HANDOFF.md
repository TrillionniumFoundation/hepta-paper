# Static socket-origin system-manager observation

`LocalStateAuthoritySocketTransportV1::observe_system_manager_v1(&self)` performs
real read-only D-Bus calls for the transport's original kernel-observed peer.
It returns `ObservedSocketPeerManagerAssociationV1`, whose only public accessor
is `report()`. The value has no deserializer, caller-data constructor, `current`
method or activation method. It records completed observations; it does not
match a V2 installation or prove Rust executable provenance.

## Entry and trust chain

1. The transport must already hold the actual socket-origin `SO_PEERPIDFD` and
   `SO_PEERCRED`, captured by its existing empty probe. The manager call borrows
   that exact pidfd; it never opens a new pidfd from a numeric PID.
2. Check original-peer liveness, retain/read the current kernel boot ID, and
   observe its process-leader numeric credentials/groups through real procfs.
3. Connect to the literal `/run/dbus/system_bus_socket`, bypassing environment
   bus addresses. Require actual connected peer UID 0 and a positive PID.
4. Use D-Bus EXTERNAL authentication and resolve the systemd well-known name to
   its actual unique owner. Ask the bus for that owner's UID/PID; require UID 0
   and PID 1. No expected-owner override is accepted.
5. Send the original borrowed pidfd through the typed Unix-FD D-Bus argument to
   `GetUnitByPIDFD`, addressing the verified unique owner. This returns the actual
   object path, unit ID and nonzero 16-byte invocation ID.
6. Read individual Unit properties and the concrete Service or Scope interface's
   `ControlGroup`. This closed observation profile accepts `.service` and
   `.scope` associations only; other unit types are refused. A `.service` also
   supplies the Service properties below. Require matching unit ID/invocation.
   Repeat the original pidfd association, manager principal and unique-name
   checks at the end.
7. Close/destroy all bus resources, repeat the kernel credential observation
   and require it to equal the first, then recheck boot identity and original
   peer liveness before constructing the observation value.

Every successful reply must be a method return from the exact requested sender,
fit the complete-message limit and carry no file descriptors before typed body
decoding. There is no shell-output parser, numeric-PID reopening, proxy property
cache, signal subscription or ObjectServer. The systemd method is defined in
the [versioned systemd 255 D-Bus contract](https://raw.githubusercontent.com/systemd/systemd/v255/man/org.freedesktop.systemd1.xml).

## Fields and limits

Unit observations include `Id`, `LoadState`, `ActiveState`, `SubState`,
`FragmentPath`, `NeedDaemonReload`, `InvocationID` and `DropInPaths`.
`ControlGroup` is recorded alongside them but is read from Service/Scope, not
the generic Unit interface. Service observations additionally include `MainPID`, `ControlPID`,
`UID`, `GID`, `Type`, `User`, `Group`, `DynamicUser`, `SupplementaryGroups` and the
typed `ExecStart` tuples. The observation does not read Environment or private
key files. Treat captured argv and host paths as host inventory, not public
telemetry.

`kernelCredentials` separately records the real/effective/saved/filesystem
UIDs/GIDs, numeric supplementary GID list and namespace PID list observed for
the original socket peer's process leader. It is distinct from systemd's
configured `SupplementaryGroups` names. The kernel list is retained exactly,
including an entry equal to the primary GID or repeated IDs; it is not normalized
into the V2 declaration. This general observer accepts up to 65,536 groups,
whereas Deployment V2 permits at most 32 declared supplementary groups.

The private producer opens only fixed `/proc` with no-follow, directory and
close-on-exec flags, and checks `PROC_SUPER_MAGIC` using `fstatfs`. Inside that
verified filesystem it reads the fixed `self` magic link, requires a positive
bounded numeric leaf, and opens that actual process's `fdinfo` directory without
following links. It reads the fdinfo entry for the borrowed **original** peer
pidfd, never a reopened numeric-PID pidfd. Kernel fdinfo identifies that pidfd's
subject in the procfs mount's PID namespace. Its positive `Pid` must equal the
socket-origin PID and the first `NSpid` element; missing, zero, negative or
incompatible namespace observations refuse.

Only then does descriptor-relative no-follow opening reach that numeric peer
directory and `status` in the same procfs instance. The status `Pid`/`Tgid` must
equal the peer PID, its complete `NSpid` list must equal the pidfd fdinfo list,
and effective UID/GID must equal the original `SO_PEERCRED`. Every opened
component has the same procfs device and filesystem type. Original pidfd liveness
and a second fdinfo read bracket the status read. This avoids treating a
coincidentally equal numeric PID in another proc mount as the original process.
The binding follows the [kernel pidfd fdinfo implementation](https://github.com/torvalds/linux/blob/v6.12/fs/pidfs.c)
and [proc status field semantics](https://www.man7.org/linux/man-pages/man5/proc_pid_status.5.html).

Status reads are limited to 1 MiB plus one detection byte; pidfd fdinfo to
4 KiB plus one. Parsing requires newline-terminated records, unique field names,
all required identity fields, exact UID/GID cardinality, bounded unsigned decimal
values, at most 256 fields and 32 namespace PIDs. All proc/status/fdinfo
descriptors close before each observation returns, including failures.
The two complete credential observations bracket the manager exchange and any
difference refuses. They do not exclude a change and restoration between reads.
Linux can have different per-thread credentials: these are the process leader's
actual groups, not proof of every handler thread's groups or the groups at the
historical instant of socket creation. No credentials are changed by the observer.

| Limit | Meaning |
|---|---|
| `min(transport timeout, 5 seconds)` | One absolute monotonic deadline for socket connect, authentication, send/receive, protocol and asynchronous close. It is not a new timeout for each RPC. |
| 4 MiB received / 1 MiB sent | Cumulative wire budgets for the whole connection, including authentication. |
| 16 KiB | Maximum receive chunk passed to the underlying nonblocking reader. |
| 64 KiB | Complete successful reply including its headers, checked before typed decoding. |
| 128 MiB | zbus protocol frame allocation ceiling before the smaller reply check; the 4 MiB receive budget does not reduce that allocation ceiling or cap total process RSS. |
| At most 27 explicit RPCs | Includes the repeated owner/principal/association checks; zbus also performs the initial bus Hello. Scope units need fewer property reads. |
| 4,096 bytes | Maximum property string/path/argument, with a 255-byte unit ID and 4,096-byte object-path limit. |
| 64 drop-ins / 32 supplementary groups | Count bounds after typed decoding, also constrained by the reply byte ceiling. |
| 32 ExecStart entries / 128 arguments each | Bound the typed command vector; the reply byte ceiling usually constrains it further. |

The boot ID read is fixed-size and retained for recheck. The deadline is checked
around operations; this is a userspace protocol budget, not a hard real-time
guarantee against host scheduling stalls or synchronous kernel I/O stalls.
The 64 KiB reply ceiling applies to each D-Bus message, not the returned combined
report, which also contains the separately bounded procfs group list.

## Connection and descriptor lifetime

The producer uses the pinned zbus codec/authenticator with a custom bounded
socket. Internal executor threads are disabled. A local executor is driven only
inside the observation scope. Peer credentials are read directly with safe
`SO_PEERCRED`; the adapter does not delegate to an NSS/spawn-blocking credential
lookup which could survive cancellation.

The fixed EXTERNAL plus Unix-FD client expects two textual server responses
before the binary Hello reply. A small boundary check requires CRLF for those
two lines, including when split across reads, then stops inspecting binary
bytes. It prevents the pinned zbus 5.19 text parser's bare-LF index-underflow
path. All authentication content and binary message parsing still use zbus;
the boundary check grants no authentication of its own.

Cleanup first shuts down the original local socket without awaiting a zbus
mutex, then applies the same deadline to asynchronous close. The local executor
and connection are dropped. A witness which owns only a Weak reference requires
the read/write resource owners to be gone before a successful result can escape.
Authentication, protocol, timeout and unexpected-descriptor failures must also
release these resources; tests inspect actual EOF, including sentinel socket
endpoints with 1 or 64 transferred descriptor aliases.

**Call this producer before opening any SQLite connection.** Unix D-Bus peers
can send unexpected SCM_RIGHTS descriptors. The adapter rejects and closes them;
closing an alias of a SQLite file can affect process-level locks. A background
D-Bus reader must therefore never be smuggled into an owning SQLite transaction.
This producer closes its bus before return and provides no in-transaction
revalidation API. A future live owner needs a reviewed process-isolation or
descriptor-lifetime design before querying the bus while SQLite is owned.

## What the report means

Properties are individual reads bracketed by peer association, not an atomic
snapshot. They may change between reads or after return. MainPID is a reported
field; this producer does not assert that it equals the socket origin. It also
does not require a Hepta unit name, loaded/active status, a particular command,
static user, installed file hash or declared group topology. A valid observation
can describe an unrelated service or scope; the future typed installation binder
must compare actual facts with the independently qualified expected installation.

The retained socket origin describes the listener/connect origin, not the code
which handled every byte after fork, exec or descriptor passing. Manager
association does not establish no-proxy custody, actual executable mapping,
Rust build/source provenance or absence of Node. It cannot replace the existing
transport's fresh same-origin checks on every authority RPC.

Returned diagnostic JSON cannot reconstruct this observation or authorize a
writer. Failure annotations saying authority request bytes were not sent refer
to the business-authority protocol; read-only D-Bus calls may already have run.
No service is started/stopped, no authority request is issued and no automatic
retry is introduced by this method.

## Validation and remaining integration

From `rust`, the default source cases run with:

```sh
cargo test -p hepta-paper-service --lib local_state_authority_client::manager --locked
```

The internal process helper is ignored by default and is launched only by its
parent fixture. The actual fixed-system-bus observation test is also explicitly
ignored and must be selected by its exact name on a suitable host. Do not run all
ignored helpers as though they were independent acceptance tests, or count an
unselected host test as passed.

Private socketpair fixtures exercise stalled/unterminated authentication, bare
LF rejection and split CRLF followed by unchanged binary bytes, the
cumulative receive limit, oversized writes, unexpected actual descriptors,
reply sender/type/byte validation and a dead original process. They cannot mint
the public observation through an alternate production bus or owner override.
A successful actual-system-bus fixture proves this observer path on that host;
it is not a qualified nine-role Hepta installation.

Kernel identity tests use actual socket-origin pidfds for the unchanged test
process and an independently spawned Rust child, comparing numeric groups with
that process's `getgroups` and effective IDs. The owned child also checks its
actual descriptor table before and after repeated observations, and its parent
verifies refusal after exit. Private parser tests cover duplicate/missing/malformed
fields, pidfd/status subject mismatches and exact byte/group/namespace limits.
These do not change process credentials or supply a cross-principal installation,
handler-thread custody proof, namespace-remount qualification or SQLite-live
manager observation. No test-provided proc path or credential override reaches
the public producer.

The [installation design](../../online_mutation_composition/activation/AUTHORITY_INSTALLATION_DESIGN.md)
still requires V2 expectation matching, independently qualified executable and
principal custody, retained writable integration, exact host/cutover binding and
safe currentness throughout the SQLite lifetime. This static observer is one
implemented prerequisite for those owners.
