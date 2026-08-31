# Rust control-plane operations runbook

This runbook covers source qualification, installed qualification and
production-shaped operational preparation. It does not authorize real provider,
writer, release or submission use.

## 1. Candidate discipline

Use one convergence branch and one integration PR.

```text
candidate branch  codex/rust-plan-v4-rc1-20260831
static truth      docs/rust/current-status.v1.json
required checks   docs/rust/qualification/source-required-checks.v1.json
effective result  effective-status.v1.json workflow artifact
```

Do not combine evidence from different heads. Any push invalidates prior
effective status and latest-push review.

## 2. Source qualification

For the exact candidate head:

1. Verify the PR head and tree.
2. Run `python3 docs/rust/tools/validate-program-truth.py`.
3. Let all canonical required contexts start.
4. Reject any `action_required`, zero-job, missing, skipped, cancelled or failed
   required context.
5. Let `rust-effective-source-qualification` bind the latest successful check
   run for every context.
6. Retain:
   - preflight and postflight exact-head evidence;
   - the complete check-run snapshot;
   - `effective-status.v1.json`;
   - its SHA-256;
   - workflow/run/attempt identity.
7. Confirm the artifact authority fields remain false.
8. Obtain independent latest-push review.

A source artifact is invalid when its head, tree, static-truth digest,
required-check manifest or any bound file changes.

## 3. Merge preparation

Before integrating the RC into the product branch:

```text
all required contexts completed/success
effective artifact matches live RC head/tree
no unresolved review conversation
no active request-changes decision
no competing P0 PR
rollback is deletion/revert of the exact RC commit
productionActivation=false
```

After product-branch integration, rerun the full matrix for the updated product
head. Do not reuse the RC PR's check runs for the product integration PR.

## 4. Broker preflight

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

## 5. Broker startup order

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

## 6. Writer cutover preparation

Repository tests may use fixture keys, but production activation requires a
separately issued permit.

Before opening the Rust writer:

1. stop and prove the Node writer is disabled;
2. checkpoint and close the legacy database;
3. prove no unresolved WAL/SHM/journal sidecar exists;
4. inspect the exact absent/existing database preimage;
5. bind repository, commit, tree, binary, configuration, host and service
   identity;
6. bind the exact first writer lease generation/token/expiry;
7. obtain a short-lived independently signed Ed25519 permit;
8. acquire the exclusive activation lock;
9. reopen and compare the preimage;
10. acquire only the signed first lease;
11. retain activation, writer and database evidence.

Any mismatch closes the store and leaves production writer authority absent.

## 7. Normal shutdown

```text
set stopping state
stop accepting new connections
drain bounded queue
join workers and surface panic/error
close listener fd
verify and remove only the same socket object
fsync listener parent
write stopped generation marker
checkpoint/audit journal and writer stores
emit shutdown evidence
```

A worker panic, journal failure, identity mismatch or listener replacement is an
incident, not a graceful shutdown.

## 8. Trust rotation

1. stop admission and drain workers;
2. independently verify next generation/signature/previous hash;
3. archive current public verification material;
4. install the new authority-owned bundle atomically;
5. run source/host preflight;
6. increment listener generation;
7. restart and publish a new qualification hash;
8. verify revoked and rolled-back keys cannot admit.

A rejected refresh disables new admission; stale acceptance authority must not
continue silently.

## 9. Workspace incident

On a replacement, symlink, hard-link, cross-device, in-place mutation,
inventory instability or partial-copy detection:

1. stop publication and integration;
2. preserve the exact descriptor-bound observation;
3. delete a partial file only when the public path still identifies that exact
   owned object;
4. quarantine an uncertain directory rather than recursively deleting an
   unproven pathname;
5. retain before/after identities, hashes and error code;
6. create a fresh attempt after the source tree is stable;
7. never reuse the failed attempt as canonical input.

## 10. Journal or writer incident

On integrity, event-chain, WAL, sidecar, permission or identity failure:

1. disable admission and writer activity;
2. do not mutate the suspect database further;
3. copy the exact database/WAL/SHM set into immutable incident evidence;
4. record object identities and hashes;
5. classify every pending operation conservatively;
6. restore only to an absent destination from a qualified snapshot;
7. run schema, integrity, foreign-key and event/journal replay validation;
8. resume only after independent operator acceptance.

Never repair production state with ad-hoc SQL.

## 11. Process identity mismatch

Do not signal the PID or process group. Block readiness, preserve evidence and
require manual reconciliation. A guessed cleanup can kill an unrelated reused
process.

## 12. Listener incident

- live predecessor: refuse startup;
- unrecorded stale socket: refuse startup;
- marker/socket identity mismatch: refuse unlink and escalate;
- permission widening or ancestor replacement: stop admission;
- authorized client cannot connect: verify access-group membership and exact
  directory/socket mode; do not widen `other` permissions;
- unauthorized client connects: emergency stop, preserve peer/capability
  evidence, rotate affected trust keys and investigate group/ACL drift.

## 13. Capacity and telemetry

Minimum non-sensitive telemetry:

```text
listener generation and qualification hash
role and trust generation/hash
worker active/failed/panicked counts
queue depth and busy responses
admission rejection codes
journal/write latency and conflicts
integrity failures
reconciliation dispositions
prepared/acknowledged/integrated counts
containment cleanup failures
source qualification invalidations
shutdown reason
```

Prompts, manuscript contents, credential bytes, raw provider streams and
authority secrets are excluded.

## 14. External blocker execution

### Governance — issue #25

Retain active policy export/hash, exact required contexts, all seven denial
outcomes and an independent exact-candidate signed decision.

### Legacy replay — issue #28

Run the private companion workflow with its pinned workflow/tree/policy and
archive credentials. Retain the 263/263 receipt, artifact index, network
isolation and cleanup proof, then obtain independent acknowledgement.

### Target host and storage — issues #17 and #12

Run real UID/GID, listener, systemd, cgroup, reboot, WAL, disk-full, corruption,
restore and 72-hour topology drills on separately controlled infrastructure.

### Key and Codex — issues #14 and #21

Run independent key rotation/revocation/compromise drills and separate
authenticated author/reviewer Codex canaries without credential leakage.

### Release and submission — issue #22

Collect real KMS/HSM, WORM, release, portal and single-use submission receipts.
Model and broker principals retain zero external-authority secret.

## 15. Upgrade and rollback

An upgrade uses a new exact binary/configuration identity, source artifact and
listener generation. Before activation:

- back up and restore-drill journals and writer state;
- verify schema compatibility;
- stop the old service completely;
- confirm no old contained process remains;
- install create-only or atomic immutable objects;
- start a bounded canary;
- retain the previous binary/configuration for tested rollback.

Rollback never reopens terminal state, reduces generation or causes a second
provider/submission action.
