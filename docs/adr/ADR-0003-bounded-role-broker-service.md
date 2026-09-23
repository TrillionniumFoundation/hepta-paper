# ADR-0003: bounded role-specific broker service lifecycle

Status: accepted for fake/local service qualification  
Date: 2026-08-28

## Context

The admission and SQLite-state slices establish authenticated request
reservation but do not define a long-running service process. A deployable local
broker also needs a safe Unix listener, bounded concurrency, restart semantics,
key rotation, deterministic machine responses, state recovery, backup/restore,
and a campaign acknowledgement boundary.

The service must remain outside campaign, release and submission authority. It
must not turn a successful local source implementation into authorization for
real Codex credentials or provider calls.

## Decision

V1 uses one role-specific Linux service principal, one pathname Unix socket, one
private SQLite journal and one role-scoped capability trust bundle per service
instance.

The listener:

- binds only in a canonical private parent directory;
- requires exact owner/group/mode for parent and socket;
- persists a generation marker binding role, runtime, trust bundle and journal;
- rejects a live predecessor;
- removes a stale socket only when its recorded object identity matches;
- publishes readiness only after runtime, trust and journal integrity checks;
- removes only the same socket object during graceful shutdown.

The service loop:

- accepts in nonblocking mode;
- uses a fixed worker count and bounded synchronous queue;
- returns a canonical `Busy` response instead of unbounded allocation;
- opens one broker-journal connection per worker;
- pins the trust-bundle hash for the service instance;
- stops admission if the trust manager expires, rejects a refresh or changes
  generation during the instance;
- returns canonical machine responses and does not expose internal error text by
  default.

Capability signing keys are distributed through an externally signed,
role-scoped trust bundle. Bundles are generation chained, validity bounded,
canonically ordered and explicitly revocable. Rejected refresh disables new
admission. V1 applies a verified rotation through a graceful service restart;
it does not silently swap keys inside an already-qualified listener instance.

Prepared results are acknowledged only through an independently signed
acknowledgement binding operation, request hash, prepared receipt, campaign,
node, attempt, campaign revision and lease generation.

The fake execution bridge may launch only explicitly supplied local fake
executables. It records request binding, spawn observation, JSONL validation and
prepared result transitions. It is not a real-provider launch protocol.

## Recovery and backup

Startup and operator tooling expose deterministic recovery candidates derived
from the normative Rust journal state machine. SQLite backup uses a completed
WAL checkpoint plus `VACUUM INTO`, re-establishes the production WAL/FULL
contract, validates integrity and foreign keys, and produces a content-hashed
receipt. Restore is create-only, atomically published and re-opened through the
normal journal verifier.

## Security consequences

Positive:

- listener ownership is explicit and restart recovery cannot delete an
  unrecorded pathname;
- overload has bounded memory/thread behavior and a machine-readable response;
- key rotation has external authority, anti-rollback and revocation semantics;
- campaign acknowledgement cannot be forged by the broker itself;
- backup/restore preserves the same database contract used at startup;
- fake process failures are linked to durable operation state and cleanup.

Residual risks and hard gates:

- Issue #17 blocks real Codex because a spawned child can execute before the
  parent commits `process_spawned`; production requires an OS-enforced pre-exec
  gate;
- installed-host schema authority, executable/runtime, credential isolation,
  ACL/mount policy and real Codex protocol qualification remain separate gates;
- V1 trust rotation requires a coordinated restart because readiness pins a
  single bundle hash;
- ignored response-write errors are observability events, not state rollback;
- no campaign database or external authority is introduced.

## Rejected alternatives

### Unbounded thread-per-connection

Rejected because peers could exhaust memory, descriptors and scheduler capacity.

### Silently unlink any existing socket

Rejected because it can destroy a live or attacker-controlled pathname.

### Mutable in-process key map without signed generations

Rejected because rollback, key substitution and revocation would lack durable
external evidence.

### Broker-generated campaign acknowledgement

Rejected because it collapses broker execution and campaign integration
principals.

### Treat the post-spawn hook as real-provider atomicity

Rejected. It improves fake-executable failure handling but cannot prevent child
execution before journal commit. Issue #17 is the production gate.

## Follow-up

The next qualification slice must independently review the OS-enforced
pre-exec launch gate, complete installed-host startup
process reconciliation and installed-host qualification before enabling real
Codex. Workspace COW/mutation authority and read-only Rust control-plane work can
continue in parallel without provider credentials.
