# Codex broker service v1

## Scope

This document specifies the long-running local service around the Rust broker
admission and operation journal. V1 is qualified only for fake/local executable
work. Real Codex credentials, provider calls and production composition remain
blocked by Issue #17 and installed-host qualification.

## One service per role

Production-shaped topology uses separate service instances and principals:

```text
hepta-codex-author-broker
hepta-codex-reviewer-broker
hepta-codex-formal-reviewer-broker
hepta-codex-repairer-broker
```

Each instance owns exactly one:

```text
Unix socket pathname
listener generation marker
role policy
runtime identity
capability trust bundle generation
broker SQLite journal
bounded worker pool
```

A service must not multiplex author and reviewer roles through one listener,
credential home or journal.

## Readiness sequence

```text
validate deployment policy
inspect private listener parent
recover only a recorded stale predecessor
bind listener socket
set exact socket permissions and backlog
open and validate broker journal
validate active role trust bundle
bind runtime/trust/journal hashes into listener qualification
publish Ready marker
start accepting
```

Failure at any stage leaves the service non-ready. A rejected trust refresh or
expired bundle disables new admission.

## Listener layout

Example:

```text
/run/hepta-paper/codex-author/
  broker.sock
  broker.sock.listener.json
```

Required properties:

- parent path is absolute and canonical;
- parent is a real directory with exact configured owner/group/mode;
- parent is not group/world writable;
- socket is a real Unix socket owned by the service principal;
- socket mode grants no `other` access;
- marker is a private, single-link regular file;
- socket and marker identity are rechecked before removal or readiness.

### Restart recovery

A live predecessor is never unlinked. An unreachable socket is removed only when
an older generation marker exists and its recorded socket object identity equals
the observed path. An unrecorded stale socket is an operator incident.

V1 requires monotonically increasing listener generation. Restart with the same
or lower generation fails closed.

## Request lifecycle

```text
accept connection
  -> bounded queue admission
  -> SO_PEERCRED inspection
  -> role/peer policy
  -> active trust-bundle snapshot
  -> HEPTACX1 frame decode
  -> request semantic validation
  -> Ed25519 capability verification
  -> SQLite reservation/idempotency/nonce transaction
  -> HEPTARX1 response
```

The service does not launch Codex in this slice. Successful admission returns
`Reserved` or `Existing` with operation identity and current state.

## Backpressure

V1 has hard maxima for:

```text
worker threads
queued connections
listener backlog
connection count per run
accept polling interval
response write timeout
```

Queue overflow returns:

```json
{
  "version": 1,
  "kind": "busy",
  "retryAfterMs": 100,
  "errorCode": "queue_full"
}
```

No new worker thread is created for overload. The service never blocks the
accept loop waiting for queue capacity.

## Response protocol

Responses use:

```text
magic: HEPTARX1
payload length: unsigned 64-bit big endian
payload: canonical UTF-8 JSON
```

Kinds:

```text
reserved
existing
busy
rejected
prepared
acknowledged
```

Machine codes are stable and bounded. Ordinary responses do not include raw
internal errors, paths, prompts, credentials or manuscript content.

## Trust bundle lifecycle

A role trust bundle contains:

```text
generation
issuer
validity interval
minimum accepted generation
previous bundle hash
role-scoped Ed25519 request keys
explicit revocations
external authority signature
```

Rules:

- initial bundle is self-consistent bootstrap generation;
- subsequent generation is exactly previous + 1;
- `previousBundleHash` must match the accepted checkpoint;
- minimum accepted generation never decreases;
- key and revocation ordering is canonical;
- every key is decoded and checked for weak-key rejection;
- role, key validity and revocation are evaluated at admission time;
- a rejected refresh disables new admission until explicit recovery;
- listener readiness pins one bundle hash.

V1 rotation procedure:

1. obtain and independently verify the next signed bundle;
2. stop accepting new connections;
3. drain workers;
4. stop the listener and persist its stopped generation;
5. install the new bundle checkpoint;
6. increment listener generation;
7. restart and publish a new readiness qualification.

## Fake execution linkage

The fake bridge accepts an already reserved operation and a caller-supplied local
executable. It can advance:

```text
reserved
  -> request_bound
  -> process_spawned
  -> event_stream_started
  -> terminal_event_observed
  -> final_output_captured
  -> schema_validated
  -> workspace_snapshotted
  -> mutation_validated
  -> result_prepared
```

`event_stream_started` carries no completion evidence; the exact raw JSONL hash
is attached to `terminal_event_observed`. Failure transitions use bounded reason
codes. Journal-transition fault injection proves transaction rollback.

The post-spawn hook kills and reaps the group when journal linkage fails, but it
is not sufficient for live Codex atomicity. Issue #17 requires an OS-level
pre-exec gate before real provider execution.

## Prepared-result acknowledgement

A separately trusted campaign-writer key signs:

```text
operation ID
request hash
prepared receipt hash
campaign ID
node ID
attempt ID
campaign revision
lease generation
acknowledgement time
signer key ID
```

The broker verifies the signature and exact prepared journal subject before
appending `Acknowledged`. The broker cannot generate this authority itself.

## Recovery candidates

Operator recovery lists non-acknowledged operations with the normative Rust
recovery disposition:

```text
resume_same_operation
start_new_operation_same_attempt
resume_local_processing
start_new_attempt
integrate_prepared_result
```

The API is bounded, ordered and preceded by a full journal-integrity check.

## Backup and restore

Backup procedure:

1. validate live journal integrity;
2. complete a `wal_checkpoint(FULL)`;
3. create a new database using `VACUUM INTO`;
4. set private file mode;
5. establish WAL/FULL/trusted-schema settings;
6. checkpoint and sync the backup;
7. validate schema, integrity and foreign keys;
8. hash the complete file and issue a backup receipt.

Restore procedure is create-only:

1. validate backup file and database contract;
2. copy to a private temporary inode;
3. fsync the file;
4. atomically rename into an absent destination;
5. fsync the parent;
6. open through the normal journal adapter;
7. run full integrity validation.

Overwrite or in-place restore is forbidden.

## Shutdown

Graceful shutdown:

```text
set shutdown flag
stop accepting
close queue sender
drain worker-owned connections
join all worker threads
close listener fd
verify same socket object
remove socket
fsync parent
publish Stopped marker
```

A worker panic or journal-integrity failure is a service failure, not a
successful shutdown.

## Observability

Minimum counters/fields:

```text
listener generation and qualification hash
role and trust-bundle generation/hash
accepted, queued and busy connections
admission rejection code counts
journal reservation conflicts
worker failures/panics
recovery-candidate counts by disposition
backup/restore receipt hashes
prepared and acknowledged counts
shutdown reason
```

Prompts, raw manuscripts, auth material and provider tokens are excluded from
ordinary telemetry.

## Production blockers

Real Codex remains disabled until all are satisfied:

- Issue #17 pre-exec durable launch gate;
- installed Codex binary/version/help/JSONL qualification;
- credential and role-principal isolation;
- schema authority, parent ACL and mount qualification;
- campaign prepared-result integration protocol on the real writer;
- host restart/reboot and backup/restore drill;
- exact protected CI and release evidence.
