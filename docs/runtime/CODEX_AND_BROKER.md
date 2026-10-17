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

## Opt-in one-shot read-only canary profile

The ordinary one-shot Node composition asks both research-author and formal-reviewer
identities to run an ephemeral, read-only model-availability probe. The original
native Author Draft/Revise profile permits only WorkspaceWrite. Relabeling a probe
as Draft or Review would not preserve that boundary.

The native signed request contract now has the closed `read_only_canary` task.
It requires Author or FormalReviewer, ReadOnly, the existing ephemeral-new-thread,
network-none and approval-never policies, and an exact `oneShotCanary` subject:
version 1, original one-shot attempt ID, `provider_started` phase, reservation hash
and marker event hash. Other roles, launch/completed phases, absent subject, and a
canary subject attached to a business task refuse. The original request also binds
child operation/attempt, campaign, lease generation, validity, runtime/model,
prompt/input/schema/workspace/mutation hashes and bounded resource commitments.
The capability signature covers all those existing fields plus the explicit
one-shot-canary purpose and subject. This serializable subject is **not** a live
journal or provider permit.

Admission requires a dedicated `one_shot_read_only_canary` installed purpose on
both the broker and operation publisher. Default Business author/formal instances
continue rejecting canaries; canary instances reject business tasks. The publisher
and dispatcher require the exact existing read-only mutation policy and an empty
workspace, retain original authority/source checks, and compare the complete
canary subject against the signed request. Live descriptor validity, original
runtime identity, immutable prompt/schema bytes, kernel peer identity, signature,
lease/deadline and process-containment checks remain in their existing owners.
Same-operation retries cannot cross purpose or replace the durable request.

`OneShotExternalActionMarkerV1::provider_canary_subject_v1` produces the subject
only after live currentness checks on the originating journal, exact expected
attempt and provider-started phase. A launch marker cannot produce it. Copying or
deserializing this subject never restores the marker. A sender must retain the
opaque owner and recheck it together with live configuration/runtime/lease/source
owners at physical handoff; a projected JSON subject alone is insufficient.

### Compatibility and remaining composition

This extends the V1 wire schema while preserving existing Business wire bytes.
The new Rust fields and enum variant are source-breaking for downstream struct
literals and exhaustive matches. Older closed decoders reject the new
task/subject/purpose; there is no downgrade
or fallback. Existing request and descriptor fields are unchanged, absent optional
canary subjects are not serialized, and default Business purpose is not serialized.
Existing Draft/Revise signing bytes and JSON wire bytes retain golden checks and
their original writable-only validation. Rust struct-literal callers must supply
`None` for the new subject and Business for the new installed purpose; legacy JSON
configuration files require no added fields.

The new profile does not establish model availability, OpenClaw managed-auth
compatibility, a completed provider canary pair, scientific acceptance or production
qualification. No installed configuration, principal, credential, cgroup or provider
was changed or invoked. Ordinary service payloads selecting this canary task still
refuse before signer, publisher or transport I/O until a retained one-shot runtime
composition exists; ordinary `--action execute` remains fail-closed. The remaining
consumer must bind the two concrete native workers and challenge/output contract,
retain the actual marker and runtime witnesses, sample current lease/time at each
handoff, and preserve unknown-outcome query-only recovery. Existing arbitrary
callbacks and serialized reports are not substitutes.

Scoped source tests cover role/purpose/sandbox matrices, old wire/signing goldens,
real signature tampering across purpose/parent attempt/marker/reservation/runtime/
lease, same-operation cross-purpose journal refusal, private empty-workspace and
source drift, and marker attempt/phase mismatches. They perform no provider call.

The original Node semantic references are pinned here for this scope:

- `paper-adapters/automation/codex-runtime-preflight.mjs`:
  `6e4315872f0a9db2a166e97a9552a1a78c758abfa1c9b473bba5b7235493ed8c`
- `paper-composition/automation/autonomous-research-provider-canary.mjs`:
  `533abfcd62384f04b18301be26efa6d0374ced5edb1af80ce4019cd1d36027ed`
- `paper-composition/automation/autonomous-research-one-shot-campaign-execution-fence.mjs`:
  `49c0dbebc332448d1246524d276ef17a934330c5a219f05d811f1a210bb85311`

### Retained installed-configuration checks

The installed canary composition now retains the original configuration file and
its parent directory as nonserializable open descriptors. Loader clones share a
permanently revocable owner. The file identity includes modification/change times,
content hash, inode/device, owner/group, mode, link count and size. The parent binds
stable identity and permissions, excluding volatile timestamps so unrelated sibling
activity does not revoke it. Reads use separately opened cursors; an observed
failure cannot be repaired by restoring bytes or by reloading another owner.

The actual composition privately couples this owner to the runtime and dispatcher
policies derived from that same configuration. The public resolved-configuration
constructor refuses Canary before filesystem access. Business construction remains
available; its installed startup preflight also benefits from stronger file/parent
identity checks without changing Business wire or task policy.

Canary checks occur before dispatch preparation, at all three existing provider
authorization boundaries, before result finalization, around prepared delivery and
before recovery readiness, including an empty journal. Recovery still cleans exact
persisted containment before configuration refusal. These are bounded currentness
checks, not a continuous watcher. A fresh process does not recover the previous
process's opaque owner: durable cross-restart native configuration binding remains
an explicit prerequisite. Ordinary one-shot execution is still closed.

Single-UID source tests exercise actual filesystem drift, restoration, shared-clone
revocation and parallel reads through private source-inspection helpers, and assert
that the public loader rejects the wrong principal. They do not establish a
successful separately installed broker or any physical provider execution.

The trusted dispatcher also exposes a read-only currentness check consumed by the
server. Product canaries use the same private retained configuration binding;
Business has no added lifetime check. Result queries call this after capability
and trust validation, before payload loading, again after loading, before the first
frame and before every bounded write and flush. Revocation interrupts delivery,
keeps the journal unchanged for a later explicitly authenticated query and does not
emit an acknowledgement or a second frame. It cannot retract bytes already sent.
The server repeats this same check after all startup cleanup, generic process
reconciliation, integrity checks and journal closing, immediately before readiness.
Source tests cover the actual Product denial hook and socketpair multi-chunk
transfer with signed capabilities and a synthetic revocable trusted dispatcher;
they do not claim successful installed authority or live provider execution.
