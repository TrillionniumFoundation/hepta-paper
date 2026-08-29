# Rust broker and rewrite operations runbook

This runbook covers source/qualification operation. It does not authorize real
provider, release or submission use.

## Preflight

Before starting a role broker, verify:

1. exact release commit/tree and binary hashes;
2. target-host qualification is current;
3. role broker, Codex, trust owner and schema owner UIDs are distinct;
4. listener access mode matches the intended client topology;
5. trust bundle is canonical, current and not revoked;
6. output schema and gate are authority-owned and non-replaceable;
7. journal parent/file/sidecars pass no-follow identity checks;
8. containment mode is production eligible;
9. startup reconciliation returns no manual identity mismatch;
10. no real credential is enabled unless all upstream gates are accepted.

## Startup order

```text
validate configuration and program-truth version
validate principal/path/mount/service identity
load and verify trust bundle
open and audit broker journal
reconcile pending contained processes
bind role listener
prove listener owner/mode/access policy
publish Ready with exact dependency hashes
accept requests
```

Ready is never published before journal and process reconciliation.

## Normal shutdown

```text
set stopping state
stop accepting new connections
drain bounded queue
join workers and surface any panic/error
close listener fd
verify and remove only the same socket object
fsync listener parent
write stopped generation marker
checkpoint/audit journal where policy requires
emit shutdown evidence
```

A worker panic, journal failure, identity mismatch or listener replacement is a
failed shutdown and an incident, not “graceful”.

## Trust rotation

1. stop admission and drain workers;
2. independently verify next generation/signature/previous hash;
3. archive current public verification material;
4. install new authority-owned bundle atomically;
5. re-run source/host preflight;
6. increment listener generation;
7. restart and publish a new qualification hash;
8. verify revoked/rolled-back keys cannot admit.

A rejected refresh disables new admission; the broker must not keep stale
acceptance authority silently.

## Journal incident

On integrity, WAL, sidecar, permission or identity failure:

1. disable admission;
2. do not mutate the suspect database further;
3. copy the exact database/WAL/SHM set into immutable incident evidence;
4. record object identities and hashes;
5. classify every pending operation conservatively;
6. restore only to an absent destination from a qualified snapshot;
7. run full schema, integrity, foreign-key and journal replay validation;
8. resume only after independent operator acceptance.

Never “repair” production state with ad-hoc SQL.

## Process identity mismatch

Do not signal the PID or process group. Block readiness, preserve evidence and
require manual reconciliation. A guessed cleanup can kill an unrelated reused
process.

## Listener incident

- live predecessor: refuse startup;
- unrecorded stale socket: refuse startup;
- marker/socket identity mismatch: refuse unlink and escalate;
- permission widening or ancestor replacement: stop admission;
- authorized client cannot connect: verify access-group membership and exact
  directory/socket mode; do not weaken `other` permissions;
- unauthorized client connects: emergency stop, preserve peer/capability
  evidence, rotate affected trust keys and investigate group/ACL drift.

## Capacity and telemetry

Minimum non-sensitive telemetry:

```text
listener generation/qualification hash
role and trust generation/hash
worker active/failed/panicked counts
queue depth and busy responses
admission rejection codes
journal latency/conflicts/integrity failures
reconciliation dispositions
prepared/acknowledged counts
containment cleanup failures
shutdown reason
```

Prompts, manuscript contents, credential bytes, raw provider streams and
authority secrets are excluded.

## Upgrade and rollback

An upgrade uses a new exact binary/configuration identity and listener
generation. Before activation:

- back up and restore-drill the journal;
- verify schema compatibility;
- stop the old service completely;
- confirm no old contained process remains;
- install create-only or atomic immutable objects;
- start a bounded canary;
- retain the previous binary/configuration for a tested rollback.

Rollback never reopens a terminal journal or causes a second provider action.
