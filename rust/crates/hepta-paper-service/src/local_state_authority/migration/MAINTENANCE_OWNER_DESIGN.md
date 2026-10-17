# Authority journal maintenance owner: executable design

Status: **design only, 2026-09-21**. No maintenance producer, service stop,
restart exclusion capability, live journal rewrite, or production permission is
implemented by this document. The existing offline inspection/image CLI remains
an independent artifact operation. This review used read-only queries only; it
did not stop, reload, enable, disable, mask, or modify any service.

## Actual installation and local test feasibility

Read-only `systemctl show hepta-paper-state-authority.service` on this host found
the real system-manager unit **loaded, enabled, active/running**. Its loaded
fragment is `/etc/systemd/system/hepta-paper-state-authority.service`, with no
drop-ins and `NeedDaemonReload=no`. Relevant observed properties were:

| Property | Observed value |
|---|---|
| `ExecStart` | `/usr/bin/node paper-core/bin/hepta-paper-state-authority-daemon.mjs --configuration /etc/hepta-paper/state-authority/daemon-config.json` |
| `WorkingDirectory` | `/opt/hepta-paper` |
| `User` / `Group` | `hepta-state-authority` / `hepta-paper` |
| `Restart` | `always` |
| `KillMode` / `SendSIGKILL` | `control-group` / `yes` |
| `Delegate` / `ProtectControlGroups` | `no` / `yes` |
| `DynamicUser` / `PrivateUsers` | `no` / `no` |
| `RootDirectory` / `RootImage` | empty / empty |
| `ControlGroup` | `/system.slice/hepta-paper-state-authority.service` |
| kernel `cgroup.events` | `populated 1`, `frozen 0` |

The repository unit at [`paper-core/deploy/hepta-paper-state-authority.service`](../../../../../../paper-core/deploy/hepta-paper-state-authority.service)
has the same relevant declaration. The host installer explicitly stops and
later restarts this service; an installer/deployment operation must therefore
respect a new maintenance barrier, not merely share its unit name.

PID 1 is systemd 255.4; `/sys/fs/cgroup` is real cgroup2. Both system and current
user managers answered D-Bus name-owner and property queries. The current user
manager has an actual delegated user subtree and readable cgroup controls.
Consequently, uniquely named **isolated user-unit** integration tests appear
feasible. No such units were created in this review. A successful user-manager
test would prove the exercised manager/cgroup mechanism only: it cannot mint a
system-manager maintenance capability or authorize changes to the real service.

The current process is unprivileged. Reading the real authority configuration
directory was denied; its configuration, private key, database content, and
private/public-key relationship were **not** inspected. No privilege escalation
was attempted. System-manager mutation authorization and a real privileged
installation test remain external requirements.

## Existing code that can and cannot be reused

* [`../storage.rs`](../storage.rs) supplies retained `Snapshot`, complete
  `Ancestors` checks, private-key decoding/zeroization, and namespace checks.
  `Inputs::load` requires key and state-directory ownership to equal the current
  effective UID. It must not be weakened to make a root maintenance process
  impersonate the service account.
* [`history.rs`](history.rs) loads pinned daemon/online/public-key inputs without
  signing. Its held-file currentness and complete signed-history observer can
  be reused once the maintenance owner actually binds the installation.
* [`../../state_access.rs`](../../state_access.rs) and
  [`../../maintenance.rs`](../../maintenance.rs) explicitly provide cooperative
  native service/file-lock exclusion. The incumbent authority does not honor
  those locks. They cannot stop or retire it.
* [`../../../../hepta-cgroup-containment/src/lib.rs`](../../../../hepta-cgroup-containment/src/lib.rs)
  distinguishes fixture versus real cgroups and demonstrates bounded control
  parsing, descendant cleanup, and directory identity. Its operation owner
  **kills/removes its cgroup on Drop** and creates/adopts operation cgroups;
  it must not be reused as an RAII owner of the existing systemd service group.
  Implement a separate read-only retained observation of the manager-selected
  cgroup, with a real cgroup2 filesystem-type check.
* `hepta-cutover::VerifiedLegacyNodeFreezeV1` observes a different schema-25
  business database. It is not an authority-service stop proof. Existing
  deployment roles also do not yet define this authority's installed unit.

The Rust workspace currently has no systemd D-Bus client, `zbus`/`dbus`
dependency, or pidfd-based service-maintenance owner. These are real missing
implementation pieces, not imports from a completed module.

## Choose typed D-Bus operations, not a command's exit status

The proposed owner uses a small concrete Rust D-Bus adapter with only the
required system-manager operations: name-owner/authentication checks, property
reads, subscription, reload, and exact-unit `StopUnit`. A pinned, reviewed Rust
D-Bus dependency would be new. No generic caller-supplied bus address, unit,
method, arbitrary command, or production `StartUnit` interface is needed.

Authenticate the fixed system bus and bind the actual
`org.freedesktop.systemd1` owner, Unix credentials, manager process identity,
boot identity and connection. Subscribe before requesting jobs. A stop request
returns a job identity; await its matching `JobRemoved` result using an absolute
monotonic deadline, then obtain fresh unit properties. `done` alone is not a
descendant-exit or restart-exclusion proof. Disconnect, owner change, wrong job,
timeout or an unrecognized result invalidates the in-memory operation. The
actual API and subscription/job semantics are documented in the
[systemd 255 D-Bus contract](https://raw.githubusercontent.com/systemd/systemd/v255/man/org.freedesktop.systemd1.xml).

Invoking an independently pinned `/usr/bin/systemctl` directly with fixed argv,
sanitized environment and bounded output could drive real manager operations;
it is not inherently a mock. However, a parsed `is-active`/`show` result or
successful `stop` process does not retain manager/job/cgroup identity. Adding
those checks and event handling through command output is a less direct path.
Do not introduce a shell-script certificate or turn returned JSON into a
maintenance constructor. Prefer D-Bus for the first closed implementation.

## Persistent restart barrier for this particular unit

`systemctl stop` suppresses the restart caused by that stop, but does not block
a later activation through dependencies or another manager request. This is
distinct from changing `Restart=always` to `Restart=no`.
[systemd 255 service semantics](https://raw.githubusercontent.com/systemd/systemd/v255/man/systemd.service.xml)
document this behavior.

Do not assume a mask can be installed harmlessly here: the actual unit is a
regular file in `/etc/systemd/system`. A persistent mask normally needs that
same name; the documented mask operation fails when its destination already
exists. A runtime mask also does not provide a persistent reboot barrier, and
unit lookup precedence must be checked rather than inferred from its creation.
Do not move/delete the original unit to make masking succeed.
[systemd 255 mask contract](https://raw.githubusercontent.com/systemd/systemd/v255/man/systemctl.xml)
describes these restrictions.

For this installed profile, use a fresh, source-owned persistent drop-in plus a
separate root-owned durable marker. For example, a fixed drop-in under the exact
unit's `.service.d` directory can add:

```ini
[Unit]
AssertPathExists=!/var/lib/hepta-authority-maintenance/authority-journal-v1/held

[Service]
Restart=no
```

The marker's directory belongs to root, is private and is **outside** the
service-owned authority state directory. The service principal must not be able
to remove/rename the marker, override the drop-in, reload unit configuration,
or escape into a different service group. The assertion is non-triggering and
is combined with the other effective assertions; inspect the manager's actual
loaded `Asserts` and resolved service properties. A later drop-in can reset a
list or override `Restart`, so merely hashing the new file is insufficient.
Negation and list-reset behavior are defined in the
[systemd 255 unit contract](https://raw.githubusercontent.com/systemd/systemd/v255/man/systemd.unit.xml).

Install marker and drop-in with exclusive creation/retained directory handles,
checked ownership and ancestors, fsync, and no overwrite. Persist the marker
first. Reload the real manager and verify the exact loaded barrier before
requesting the stop. The on-disk assertion and existing marker also block
activation after reboot; `Restart=no` by itself would not. A runtime-only file
does not satisfy this property.

Every error and Drop leaves these artifacts in place. There is no automatic
unmask, drop-in deletion, marker deletion or old-service restart. Crash before
the manager has loaded the barrier grants no maintenance capability and cannot
reach journal mutation. Recovery must inspect actual disk and manager state;
it cannot deserialize a prior report into authority. Fresh-only acquisition
should refuse foreign/existing markers initially rather than silently adopt
them. A separately reviewed recovery path can be added later.

## Exact installation and private-key binding

The producer first captures the fixed unit's fragment and complete drop-in
set, their safe directory identities, actual effective properties, source
executable/script bytes and working directory. Follow actual `ExecStart`
resolution, including the relative script in the current unit. Reject unknown
exec hooks, aliases/templates, unexpected namespace/root-image mappings,
delegation, dynamic users, or command changes outside the closed admitted
profile. Hold all regular-file observations before opening SQLite.

Read the daemon configuration at the path derived from that effective argv,
verify its independent expected file pin and the pinned online/public-key
configuration, and obtain database/key/socket paths only from it. Cross-bind
the full authority/key/scope/writer/lease configuration and actual principal.
Numeric IDs are allocated locally by the repository's sysusers declaration;
do not invent a fixed UID or equate `Group=hepta-paper` to the account's primary
group without resolving and checking the actual identity.

The privileged manager owner and service identity are different. Add a small
private installation-key observer whose expected UID/GID originates from the
actual closed manager/principal observation. It may reuse the existing safe
snapshot and PKCS#8 decoding implementation, but must compare the decoded
Ed25519 verifying key to the actual independently pinned public key and retain
file identity/hash. Clear encoded secret bytes; never place private bytes in
reports. Do not call `open_database` during this observation, and do not expose
a public caller-controlled `skip_owner_check` or arbitrary expected-UID bypass.
An alternative privilege-separated worker needs authenticated parent/child
IPC and descriptor ownership; it is not a smaller first slice.

This key/installation check establishes the observed relationship, not key
custody, HSM qualification, native deployment acceptance or host attestation.

## Loaded-state sequence and descendant proof

1. Acquire a root-owned installation-operation lock and capture the concrete
   system manager, unit, namespace, inputs and live invocation. The existing
   host installer must be made to honor this same operation/barrier; an
   unrelated advisory lock is not evidence that it does.
2. Capture the manager-selected cgroup directory/control identities on real
   cgroup2. Record the original invocation and main/control process identities;
   require pidfds in the admitted Linux profile, plus start identity checks,
   instead of trusting reusable numeric PIDs. Bind actual executable/argv/
   principal to the unit; unsupported pidfd operation fails closed.
3. Durably install the barrier, reload, and verify the effective loaded
   assertion, marker identity, `Restart=no`, unchanged principal/argv/profile,
   `KillMode=control-group`, `SendSIGKILL=yes`, `Delegate=no`, and no stale reload.
4. Request the exact stop after subscription. Await the matching successful
   stop job, not any historical `JobRemoved` with the same unit name. Preserve
   the barrier on cancellation, timeout, signal, bus failure or partial result.
5. Require fresh inactive/settled unit state, no job, main/control PID zero and
   no live original pidfd. Check the **whole original cgroup subtree**, not just
   the direct `cgroup.procs` list. `cgroup.events` `populated=0` covers live
   descendants, including processes that detached their session.
   [The kernel cgroup2 contract](https://docs.kernel.org/admin-guide/cgroup-v2.html#un-populated-notification)
   defines the recursive observation. If systemd removes an emptied group,
   admit that only through a separately tested original-inode removal proof on
   real cgroup2; never treat arbitrary path absence/replacement as equivalent.
6. Recheck the manager owner, barrier, complete loaded profile, invocation/job
   state and installation inputs. Only then construct the opaque held owner.
   `assert_current` repeats these checks before subsequent dangerous steps and
   the final commit. All regular-file checks while SQLite exists must use held
   descriptors plus namespace metadata; no reopening/closing an alias of its
   main/WAL/SHM files. Declare/drop owners so all SQLite connections close first.

Pidfds fence PID reuse; they do not fence future activation or enumerate
descendants. A stopped manager job is historical once completed; it has no
invented lease expiry. The ongoing guarantee comes from the actual persistent
barrier and current manager/kernel observations. Reboot or manager replacement
invalidates the in-memory capability even when the persistent barrier remains.

## Proposed bounded implementation slice

Implement a **one-way acquire-and-retain service maintenance owner**, with no
SQL mutation, archive publication, native start, or barrier-release method:

```rust
// Proposed private APIs, not existing code.
struct ObservedAuthorityInstallationV1 { /* real manager + retained inputs */ }
struct HeldSystemAuthorityMaintenanceV1 { /* no Clone/Deserialize */ }

fn observe_system_authority_installation_v1(
    pins: &AuthorityInstallationPinsV1,
) -> Result<ObservedAuthorityInstallationV1>;

fn acquire_system_authority_maintenance_v1(
    installation: ObservedAuthorityInstallationV1,
) -> Result<HeldSystemAuthorityMaintenanceV1>;

impl HeldSystemAuthorityMaintenanceV1 {
    fn assert_current(&self) -> Result<()>;
    fn diagnostic_report(&self) -> Value; // observation only, cannot restore owner
}
```

Suggested new files: `migration/maintenance_owner.rs`, its concrete
`systemd.rs`, `installation.rs`, `barrier.rs`, `cgroup.rs`, and integration
tests. Keep the fixed production unit/path profile closed. An internal
user-manager fixture driver must yield a distinct test-only result, never the
system-maintenance type. Expected hashes are optimistic identity constraints;
they are not independently trusted declarations that a service has stopped.

Meaningful real isolated tests must demonstrate:

* An actual `Restart=always` fixture restarts before acquisition, then cannot be
  started manually or through a dependent unit while the loaded marker
  assertion holds, including after manager reload.
* A detached child/descendant survives its parent's ordinary exit but is gone
  after the actual control-group stop; check the same original group and
  pidfds rather than `/proc` name searches.
* Panic/child-process crash after barrier installation leaves an inspectable
  barrier and no automatic restart; failure before stop returns no held owner.
* Unit/drop-in/marker/ancestor replacement, wrong key/config/principal,
  manager-owner change, stale/wrong job identity, timeout, busy/live subtree and
  unknown states refuse. Foreign preexisting barrier artifacts are untouched.
* The production entry refuses user-manager and unprivileged substitutions;
  no test constructor or serialized report grants production maintenance.

Local user-manager tests cannot validate a real reboot of this host or root
policy. Persistent file layout/reload tests plus the documented boot lookup
semantics are useful source evidence; a disposable privileged VM can test
reboot/recovery and the real root/service-UID separation without touching the
running authority. Do not advertise the VM acceptance as already performed.

## Explicit authority and permission boundary

A unit barrier applies to that exact unit. It cannot prevent privileged
operators from deleting it, running another unit with the same key, or starting
a manual process under the authority UID. The deployment policy must therefore
give this unit exclusive service-principal/key/database access and serialize
all privileged installation changes. Root remains trusted; neither D-Bus nor
SQLite provides an exclusive lease against another authorized root operator.
If that installed policy is not established, this owner must not be described
as universal writer retirement.

The first implementation should retain a sealed owner and report these
limitations, with the eventual migrator still unavailable until archive,
uncertain-commit recovery, and native deployment handoff are implemented. Only
that independently authorized handoff may remove the marker after the actual
loaded unit names the verified Rust daemon and the intended configuration.
