# Native authority installation binding

Status: **installation owner design only, 2026-09-21**. The supplied-key Rust
authority and its real business integration are implemented. They do not yet
establish a qualified installed authority process. The new direct socket
transport is a separate continuity prerequisite; no object described below is
currently a production installation constructor.

## Concrete missing edge

`activation::construct` loads three online process transports and one backup
process transport, checks their retained files, and then enters
`PreparedSchemaInputV1::load`, which can perform the first RPC. The existing
`assert_native_process_command_v1` methods are not wired there. Even wiring them
would prove only the checked command's ELF format and exact installed bytes.
They cannot identify the daemon behind its Unix socket or establish Rust
provenance. A renamed interpreter is also an ELF file.

`ProductionDeploymentManifestV1` has exactly eight closed roles. The authority
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

A future V2 deployment contract needs one additional independent authority
daemon role, with the actual dedicated principal, fixed daemon executable,
closed argv, retained full configuration pin, state/key/socket namespace and
manager unit inventory. Direct in-process RPC code is already part of the
control executable; the standalone client can remain an offline tool rather
than an invented independent service. This is a protocol extension requiring
its own validation and compatibility tests, not another optional V1 field.

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
native D-Bus adapter remains missing. Do not convert shell output or a diagnostic
JSON report into an opaque installation proof.

## Owning integration and tests

Establish the real installed endpoint before `PreparedSchemaInputV1::load`,
then enforce its currentness on every RPC and before commit. Loading pins and
regular-file scopes must precede SQLite. During SQLite ownership, recheck only
held regular descriptors and namespace metadata; do not reopen aliases of the
main/WAL/SHM files. Close SQLite before dropping those scopes on every path.

The backup generic verifier currently still captures a process command from
its configuration. A direct socket backup route needs an explicit versioned
configuration and constructor; silently ignoring those existing command pins
would weaken its declared contract. The complete preparation/recoverability
composition also currently fixes concrete process types. Refactor it only with
actual direct transport consumers and full retained-scope tests.

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
