# Native authority installation binding

Status: **static deployment prerequisite plus installation-owner design**.
The supplied-key Rust authority, its real business integration, direct socket
transport, [nine-role static Deployment V2 producer](../../deployment/HANDOFF.md)
and [static system-manager observation](../../local_state_authority_client/manager/HANDOFF.md)
are implemented. They do not yet establish a qualified installed authority
process. Static file observations and socket-origin continuity remain separate
prerequisites; neither constructs production activation.

## Concrete missing edge

`activation::construct` loads three online process transports and one backup
process transport, checks their retained files, and then enters
`PreparedSchemaInputV1::load`, which can perform the first RPC. The existing
`assert_native_process_command_v1` methods are not wired there. Even wiring them
would prove only the checked command's ELF format and exact installed bytes.
They cannot identify the daemon behind its Unix socket or establish Rust
provenance. A renamed interpreter is also an ELF file.

`ProductionDeploymentManifestV1` has exactly eight closed role types and admits
8–32 service instances. The authority
daemon is not one of them. A client executable launched by the control plane
shares that principal; pretending it is another independently isolated service
would misrepresent the actual topology. Keep the existing V1 roles and digest
meaning unchanged.

The native admission configuration currently binds the online public and
process configuration hashes, backup configuration hash, control ELF, source
implementation, ten-database inventory and durable epoch. It has no qualified
daemon unit/configuration/socket/principal binding. A successful signature
proves the configured key accepted a request, not which implementation used it.

## Kernel continuity and its limits

The direct Rust transport can retain the actual connected socket's
`SO_PEERCRED` and `SO_PEERPIDFD` before any request bytes. Later calls must retain
the original pidfd, obtain the new connection's own credentials/pidfd, and
compare PID/UID/GID with liveness checks on both sides of that comparison.
Never substitute `pidfd_open` on a recycled numeric PID, or silently refresh the
original observation when the daemon restarts. Errors after bytes were sent
must preserve an unknown authority outcome for normal resolution/recovery.

These credentials describe the socket's connection/listen origin; they are not
a continuously measured executable or proof of which descendant handled each
byte. Descriptor passing, fork, exec and proxying remain installation concerns.
The [Linux Unix-socket contract](https://www.man7.org/linux/man-pages/man7/unix.7.html)
defines the credential snapshot. Continuity can also hold for a Node daemon
with the same configured key; a test must not turn that into a native claim.

Read-only inspection on this host found that the unprivileged control user
gets `EACCES` reading the actual authority PID's executable link. Linux applies
ptrace credential checks to this link, as documented by
[`proc_pid_exe`](https://www.man7.org/linux/man-pages/man5/proc_pid_exe.5.html).
Do not fall back to basename, command-line text or a caller's expected UID.
An isolated socketpair did supply a real close-on-exec peer pidfd on this host;
that observation is not a qualification of every target kernel.

## Versioned installation subject

The V2 static deployment contract adds an independent authority daemon role,
dedicated UID and IPC group, fixed daemon executable and argv, actual pinned
public configuration/key files and state/key/socket namespaces. It explicitly
binds each declared systemd unit. It checks static files and permission topology;
the manager inventory digest is still a commitment requiring independent
verification. Direct in-process RPC code belongs to the control executable;
the standalone client is an offline tool, not another isolated service role.

Public configuration and public-key documents must be root-owned and readable
by the dedicated IPC group. The daemon's private root stays `0700`; control
binds its configured private paths without opening the key or database. The
shared original service group may contain other roles and cannot prove exclusive
control/authority access. V2's declared group topology must later be checked
against actual installed principals and running processes.

The complete V2 topology identity must replace the old eight-role identity in
both the independent host qualification's `service_identity_hash` and the
cutover subject's `service_identity_hash`. Appending an unsigned companion
hash after verifying a V1 subject does not bind the additional service.

The stable, independently signed native configuration should include:

- The V2 topology identity, exact source commit/tree and control binary digest.
- The closed transport profile and socket path, daemon unit identity and full
  daemon configuration digest, and installed daemon principal from that actual
  verified inventory.
- The real online and backup public configuration identities, actual pinned
  public-key digest and equality of their authority/key/scope/lease bindings.
- Existing database, operation, recoverability, storage and durable-epoch facts.

Keep PID, invocation ID, nonce and authorization signature out of that stable
configuration digest. Those are fresh runtime observations or authorization
results, not stable installation inputs; putting the authorization hash in its
own signed subject would also create a circular dependency.

## Manager association

Use the actual socket pidfd to ask the authenticated system manager for its
unit, rather than resolving a numeric PID after it may have been reused.
Systemd 255 exposes `GetUnitByPIDFD`, returning the unit and invocation identity;
see the [versioned D-Bus contract](https://raw.githubusercontent.com/systemd/systemd/v255/man/org.freedesktop.systemd1.xml).
The owner must compare that result with the fixed installed daemon unit and
fresh loaded properties: main process, principal, closed argv, fragment/drop-in
pins, reload state and active invocation. Retain the bus connection, unique
manager owner and boot identity; changes invalidate the observation.

This is manager association, not a new claim that the control process read the
remote executable mapping. Independent installed-host evidence must cover that
mapping and the admitted no-delegation/no-proxy service profile. A concrete
live installation owner remains missing. The implemented pre-SQLite native
D-Bus observer borrows the actual socket-origin pidfd, authenticates the fixed
system bus and root PID 1 manager, checks typed replies and destroys its bus
resources before returning a static observation. It reads properties separately,
does not match them to a V2 deployment and cannot revalidate them during an owning
SQLite lifetime. Unexpected received FDs are rejected and closed; a future live
owner must first isolate that descriptor lifetime from SQLite locks. Do not
convert shell output or diagnostic JSON into an opaque installation proof.

## Owning integration and tests

Establish the real installed endpoint before `PreparedSchemaInputV1::load`,
then enforce its currentness on every RPC and before commit. Loading pins and
regular-file scopes must precede SQLite. During SQLite ownership, recheck only
held regular descriptors and namespace metadata; do not reopen aliases of the
main/WAL/SHM files. Close SQLite before dropping those scopes on every path.

The backup verifier now has a separate [Socket Configuration V1 constructor](../../state_backup_authority/socket/HANDOFF.md).
Its original Process V1/V2 profiles still capture and enforce their process
command pins. The direct constructor binds the actual online/backup public keys,
scope and limits, and sends no subprocess command. The concrete recovery
service's Socket V1 factory now consumes this profile with one original kernel
peer shared by its online and backup clients. Actual ten-database backup,
isolated restore and empty-pending reconciliation exercise that source path.
The backup CLI can now explicitly select the Socket service. Complete activation
preparation and the production recoverability fence still fix concrete process
types. Their integration requires a shared qualified
installation and full retained-scope tests; it cannot silently reinterpret the
old process configuration identity as the new socket installation subject.

Required source tests include real signed observe/reserve/finalize calls through
the new transport and existing verifier; original-listener exit with a child
still holding its socket; same-path daemon replacement; forged signatures from
the same peer; absolute deadlines; and peer SQLite writers remaining blocked
while the transport checks currentness. Unsupported kernel operations must
refuse without a PID-only fallback. Complete V2 tests additionally need genuine
independent qualification signatures and real manager association, plus
cross-principal installation on a suitable isolated host. Same-UID temporary
fixtures cannot supply that last production result.

This plan does not migrate a Node journal, stop a service, publish credentials,
grant a business writer, or retire Node. The authority journal's separate
[maintenance-owner design](../../local_state_authority/migration/MAINTENANCE_OWNER_DESIGN.md)
must still bind real shutdown/restart exclusion before live migration.
