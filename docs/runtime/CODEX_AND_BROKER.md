# Codex execution and broker contract

This document replaces the former fragmented Codex broker, admission, runtime,
role, journal, CLI, and durable-gate notes. The Rust source and tests remain the
final implementation reference.

## 1. Authority boundary

Codex is an untrusted, cost-bearing execution backend. It does not own campaign
state, trusted evidence, release signing, immutable storage, portal credentials,
or submission authority.

Each role uses a separate Unix principal, listener, `CODEX_HOME`, journal,
workspace, capability audience, and runtime identity unless an independently
reviewed deployment proves equivalent isolation.

## 2. Execution surface

The accepted V1 surface is a fresh noninteractive `codex exec` invocation with:

- exact executable and CLI/version qualification;
- ephemeral session;
- JSONL event stream;
- strict output schema;
- explicit model and sandbox;
- no approval prompt or interactive continuation;
- network disabled unless a separately authorized profile permits it;
- an empty/default-deny child environment;
- bounded stdin, stdout, stderr, events, duration, processes, and descendants.

OpenClaw is historical Node behavior and is not a Rust runtime dependency or
compatibility target.

## 3. Runtime identity

The broker binds:

```text
canonical executable path/object/content
owner/group/mode/link count/size
qualified CODEX_HOME root object
exact config path/object/content
credential-root metadata without reading credential bytes
model selector
environment policy hash
transport/sandbox profile
output schema identity
final-output identity
host/service/cgroup identity where applicable
```

The home root excludes volatile cache timestamps/size but replacement,
ownership, or mode drift fails. Exact configuration and known credential objects
remain independently bound.

## 4. Admission protocol

Admission order:

1. accept one bounded Unix connection;
2. read kernel peer PID/UID/GID;
3. decode the bounded canonical frame;
4. validate request role/task/sandbox/deadline;
5. verify an expiring peer- and request-bound Ed25519 capability;
6. reserve operation/idempotency/nonce in the broker journal;
7. return `reserved`, `existing`, `busy`, or bounded rejection.

Authentication completes before state is allocated. Socket permissions alone are
not authentication.

## 5. Listener lifecycle

A role listener has a canonical private parent and binds path, device, inode,
type, owner, group, mode, broker instance, role, peer policy, trust bundle,
journal, runtime, gate, and containment identity.

It rejects symlink, hardlink, regular file, FIFO, foreign socket, live old
instance, parent replacement, widened permissions, ambiguous stale object, and
unbounded connection behavior.

Readiness is marked only after startup journal/process reconciliation and all
identity checks. Shutdown stops admission before journal/runtime teardown.

## 6. Broker journal

The private broker SQLite journal is separate from the campaign database. It
owns operation reservation, nonce consumption, append-only transitions,
provider-release facts, prepared-result acknowledgement, and conservative
recovery.

Exact duplicate admission returns the existing operation without changing its
first-observed time or adding a transition. Conflicting operation,
idempotency, nonce, request, or peer identity rejects.

Existing/foreign databases are inspected read-only before persistent pragmas or
DDL. Partial initialization and unknown schema objects fail closed.

## 7. Durable pre-exec gate

The provider target cannot execute before durable linkage:

1. start only the separately owned gate in a new identified process group/session;
2. gate blocks before target execution;
3. broker captures PID/start/boot/group/session and exact gate/target/envelope identities;
4. commit `process_spawned` and identity;
5. commit a separate release authorization;
6. continue the gate;
7. classify any crash before/after release conservatively.

A shell wrapper, environment flag, model-visible file, timing assumption, or
post-spawn callback is not equivalent.

## 8. Containment

Production requires qualified cgroup-v2 process-set containment capable of
handling `setsid`, double fork, descendant escape, timeout, output overflow, and
broker death. Process-group-only containment remains fixture/development mode.

No signal is sent until pid/start/boot/session/cgroup identity is proven.

## 9. Event and result handling

The JSONL decoder enforces byte, line, event, ordering, terminal, and unknown
event rules. Unknown nonterminal events may be preserved; unknown terminal-like
events fail closed.

A successful result requires:

- qualified runtime unchanged pre/post;
- bounded terminal stream;
- schema-valid output;
- exact workspace/artifact inventory;
- usage/cost classification;
- provider-action ambiguity classification;
- durable prepared result and acknowledgement.

## 10. Recovery

```text
nonterminal local state           resume same operation
terminal pre-provider failure     new operation, same campaign attempt if workspace unchanged
provider may have started         new campaign attempt or external reconciliation
prepared result exists            integrate without provider rerun
terminal committed                complete/idempotent receipt
identity mismatch                 manual fail-closed recovery
```

## 11. Backpressure

The broker uses bounded workers, queue, frame size, deadlines, connections, and
write timeout. Overload returns a machine-readable busy result. The future
control-plane implementation should separate admission, reservation, launch,
event ingestion, verification, and acknowledgement through bounded stages while
retaining the same durable semantics.

## 12. Production prerequisites

Real Codex execution remains blocked until target-host listener/schema/gate/
containment evidence, independent key lifecycle evidence, and separated
credential-bearing author/reviewer canaries are accepted.
