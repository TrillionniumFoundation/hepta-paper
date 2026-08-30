# Codex durable pre-exec gate V1

## Purpose

The gate closes the `spawn() -> journal commit` ambiguity. The provider target
cannot execute until the broker has durably persisted its process identity and
release authorization.

## Launch protocol

```text
validate request/runtime/gate/target/state root
  -> write and fsync private launch envelope
  -> spawn qualified gate in a fresh session/process group
  -> gate closes non-stdio FDs and SIGSTOPs before reading envelope
  -> broker observes exact /proc identity
  -> BEGIN IMMEDIATE
       insert operation_processes identity
       append process_spawned
       update operation projection
     COMMIT
  -> BEGIN IMMEDIATE
       mark release authorized
     COMMIT
  -> SIGCONT exact process group
  -> gate verifies envelope and opened target FD
  -> target executes from /proc/self/fd/<bound-fd>
  -> bounded stdout/stderr/deadline/group cleanup
  -> terminal/process/workspace validation
  -> prepared result
```

No ordinary file, environment variable or timing assumption is treated as the
release authority. The envelope is private input data; the kernel stopped state
and exact process identity form the execution boundary.

## Process identity

`PreExecGateIdentityV1` binds:

```text
version
pid
processGroupId
sessionId
startTimeTicks
uid
bootIdHash
gateExecutableIdentity
targetExecutableIdentity
launchEnvelopeIdentity
identityHash
```

A PID alone is never sufficient. Startup recovery revalidates boot ID, start
time, session, process group, UID and executable/session evidence before
signaling. Identity mismatch is a fail-closed manual-recovery condition.

## Target-object binding

After release the gate:

1. resolves a canonical target path;
2. opens it once;
3. compares path and opened-object metadata;
4. hashes the opened file and compares the full expected identity;
5. clears close-on-exec only for that exact descriptor;
6. executes `/proc/self/fd/<fd>` while preserving the original path as `argv[0]`.

Replacing the pathname after durable linkage cannot redirect execution to a
different object.

## Descriptor and credential boundary

Before stopping, the gate enumerates `/proc/self/fd` and closes every descriptor
above stderr. Broker sockets, database handles, provider tokens, release
capabilities and unrelated pipes therefore cannot leak into the target through
FD inheritance.

The target environment is rebuilt from the already-qualified restricted
environment; it does not inherit the broker process environment.

## Durable state

The broker database stores:

```text
operationId
identityHash
serialized exact process identity
releaseState: blocked | authorized | terminated
linkedAt
releaseAuthorizedAt
terminatedAt
reconciliationDisposition
```

Identity linkage and `process_spawned` are atomic. Release authorization is
independently durable. Fault injection verifies rollback after identity insert,
transition insert, projection update and release authorization.

## Recovery table

| Observation | Durable release | Action | Journal result | Retry |
|---|---|---|---|---|
| exact blocked gate | no | terminate group | `failed_after_spawn` | new operation in same attempt only under policy |
| exact blocked gate | yes | terminate group | `result_ambiguous` | new campaign attempt |
| released/running | yes | terminate group | `result_ambiguous` | new campaign attempt |
| orphaned exact session/group | yes or uncertain | terminate group | `result_ambiguous` | new campaign attempt |
| process absent | no | record absence | `failed_after_spawn` | policy-controlled new operation |
| process absent | yes | record ambiguity | `result_ambiguous` | new campaign attempt |
| identity mismatch/PID reuse | any | do not signal | readiness blocked | manual recovery |

The service executes this reconciliation before `BrokerListenerV1::mark_ready`.
The run summary reports the number of reconciled launches.

## Source qualification tests

Required deterministic tests cover:

- target cannot execute before durable release;
- failed durable link prevents target execution;
- release-authorization rollback remains blocked;
- target pathname replacement is rejected;
- inherited non-stdio socket descriptors are absent;
- tampered persisted identity cannot signal a live process;
- blocked, authorized, released, absent and orphaned process groups reconcile;
- ambiguous outcomes produce `StartNewAttempt`;
- same-owner production gate authority is rejected;
- listener readiness is blocked on manual identity mismatch.

## Non-claims

Passing source tests does not qualify:

- a particular installed gate path or filesystem mount;
- root/deployment ownership, ACLs or systemd service isolation;
- a Codex credential or provider account;
- a successful live model response;
- author/reviewer organizational independence;
- release, KMS, WORM, portal or submission authority.
