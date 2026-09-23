# ADR-0004: durable pre-exec gate for provider process launch

Status: accepted for source implementation and local Linux qualification
Date: 2026-08-29

## Context

The first broker service implementation called a synchronous journal hook only
after `Command::spawn()` returned. On Unix, the target could execute between
child creation and the durable `process_spawned` commit. A broker crash in that
window could leave provider work unrecorded and make a duplicate retry appear
safe.

The launch boundary must therefore prevent the target executable from running
until the broker has persisted an exact process identity and separately
committed release authorization.

## Decision

V1 launches a small Rust gate executable instead of launching the provider
target directly.

The gate:

1. closes every inherited file descriptor except stdin/stdout/stderr;
2. creates a new session and process group with `setsid()`;
3. stops itself with `SIGSTOP` before reading the launch envelope or opening the
   target;
4. remains stopped while the broker inspects `/proc` and commits the exact gate
   identity together with `process_spawned`;
5. remains stopped while the broker commits a separate release authorization;
6. continues only after the broker sends `SIGCONT`;
7. opens and hashes the target executable once, executes it through the bound
   `/proc/self/fd/<fd>` object, and never trusts a later pathname lookup.

The durable identity binds:

- PID, process-group ID, session ID and `/proc` start-time ticks;
- effective UID and boot-ID hash;
- gate and target device/inode/mode/owner/link-count/size/content hashes;
- the private launch-envelope object and content hash;
- a self-hash over the complete identity.

The broker journal uses schema version 2 and persists one process record per
operation. Linking the process identity and appending `process_spawned` are one
SQLite transaction. Release authorization is a second durable transaction and
is never inferred from the live process alone.

## Authority modes

`LocalFixtureSameOwner` is permitted only for local deterministic tests.

`SeparateOwnerProduction` requires the gate executable and its immutable parent
path to be controlled by a principal distinct from the broker/state owner. The
broker principal must not be able to replace the gate or any parent component.
Source tests cannot establish ACL, mount, service-manager or host-owner facts;
those remain installed-host qualification requirements.

## Startup recovery

Before the listener publishes Ready, the service validates the journal and
reconciles every operation in `process_spawned` or `event_stream_started`.

- an exact blocked gate is terminated and recorded as pre-provider failure;
- an authorized or running target is terminated and recorded ambiguous;
- an orphaned descendant group in the exact fresh session is terminated and
  recorded ambiguous;
- an absent authorized process is recorded ambiguous;
- a PID/start/identity mismatch performs no signal and blocks readiness for
  manual recovery.

An ambiguous outcome always requires a new campaign attempt. A terminal journal
is never reopened and the provider operation is never silently repeated.

## Consequences

Positive:

- target instructions cannot execute before the durable link and release
  transactions;
- commit failure leaves a stopped gate that can be killed without provider work;
- target pathname replacement after linking is rejected;
- inherited broker/provider sockets are closed before the gate stops;
- startup recovery is deterministic and precedes service readiness;
- released or uncertain provider work is conservatively fenced from duplicate
  retry.

Costs and residual limits:

- the gate is Linux-specific and depends on `/proc`, process groups and sessions;
- the gate executable becomes a qualified component of the local TCB;
- production use requires independent low-level review and installed-host
  ownership/ACL/mount/service qualification;
- source qualification does not establish provider authentication, network,
  model quality, release authority or submission authority.

## Rejected alternatives

### Post-spawn journal hook

Rejected because the target can execute before the transaction commits.

### Shell wrapper or model-visible lock file

Rejected because the wrapper or file can be bypassed, replaced or inherited by
untrusted code and cannot establish an atomic kernel-enforced boundary.

### Treating every failed spawn as pre-provider

Rejected because a child or provider action may already have started. Ambiguous
post-release outcomes require a new attempt and conservative accounting.

## Acceptance boundary

The source implementation is accepted only after locked Rust 1.98 formatting,
Clippy, workspace tests and rustdoc pass, including crash/fault tests for link,
release, target replacement, FD inheritance, blocked/running/absent/orphaned
reconciliation and retry disposition.

Production enablement additionally requires an independent low-level review and
an installed-host qualification record. Until both exist, real Codex credentials
and provider execution remain disabled by composition policy.
