# Evidence and qualification model

## Purpose

Prevent committed implementation state, hosted-runner observations,
target-host facts and external-authority decisions from being confused.
Evidence is accepted only for its exact subject, tier and validity window.

Plan v4 distinguishes:

```text
static source truth  -> current-status.v1.json
effective source     -> effective-status.v1.json workflow artifact
external qualification -> independently signed package
```

Static source never self-asserts `source_qualified`.

## Evidence tiers

### Design

Binds a reviewed contract, threat boundary and acceptance criteria. It does not
establish executable behavior.

### Source

Binds exact repository commit/tree, static truth digest, lockfile, toolchain,
workflow definitions, required check-run identities, commands and test results.
It establishes implementation behavior in the workflow environment only.

A source qualification is valid only when every required context comes from its
manifest-bound workflow ID/path/blob/digest, the exact pull-request event and
subject, and the newest run/attempt contains one exact non-empty successful job
with non-empty successful execution steps. Context-name/App-ID matching alone is
not authentication. Zero-job, collision, `action_required`, skipped, missing,
stale or dirty-postflight runs are invalid.

### Hosted installed

Adds disposable real Unix users, groups, installed paths and negative
permissions on a hosted runner. It does not establish a production host,
long-lived custody or an independent operator.

### Target host

Binds a named host, kernel, boot, filesystem, mount, service manager, installed
binary/configuration identity and destructive drill results. It must be
collected on separately controlled infrastructure.

### External authority

Binds an active protected-repository policy, real key owner, provider account,
KMS/HSM, WORM custodian, release attestor or submission authority. Repository
source and GitHub-hosted workflow execution cannot manufacture this tier.

For repository governance, the configuring administrator and independent
reviewer remain distinct, and the evidence includes denial tests rather than
only a settings snapshot.

## Static implementation record

The committed static record may contain:

```text
source_implemented
blocked_external
retired
```

`target_host_qualified` or `external_authority_qualified` may be committed only
when the row includes a durable accepted evidence reference that can be
reverified. `source_qualified` and `hosted_installed_qualified` are derived
evidence states and are not committed as implementation assertions.

## Effective source evidence

The effective artifact is generated from the exact static source plus the
canonical required-context manifest. It includes:

```json
{
  "schemaVersion": 1,
  "kind": "HeptaRustEffectiveSourceStatusV1",
  "status": "exact_head_source_qualified",
  "repository": "TrillionniumFoundation/hepta-paper",
  "source": {
    "commit": "...",
    "tree": "...",
    "staticTruthSha256": "sha256:...",
    "requiredChecksSha256": "sha256:...",
    "producerManifestSha256": "sha256:...",
    "capabilityEvidenceSha256": "sha256:...",
    "checkEvidenceSchemaSha256": "sha256:...",
    "effectiveSchemaSha256": "sha256:...",
    "boundFiles": {}
  },
  "workflow": {
    "name": "...",
    "runId": 1,
    "runAttempt": 1
  },
  "requiredContexts": [],
  "observedChecks": [],
  "effective": {},
  "invalidation": {},
  "authority": {
    "productionAuthorized": false,
    "externalAuthorityClaimed": false
  }
}
```

The effective artifact promotes only `source_implemented` rows having a
non-empty capability-specific mapping whose contexts and declared dependencies
are qualified in the same normalized producer snapshot. It leaves
`blocked_external` and `retired` unchanged. Both the normalized check evidence
and the final artifact undergo complete committed-schema validation before
publication.

The artifact is deliberately ephemeral evidence. A newer run or rerun from any
bound producer changes the current snapshot identity. Even a newer success
requires regeneration; a newer non-success immediately demotes. The
`source-qualification-current` workflow performs this live check and is excluded
from the matrix it observes.

## Mandatory external evidence envelope

Every target-host or external-authority bundle includes at least:

```json
{
  "schemaVersion": 1,
  "tier": "target_host|external_authority",
  "repository": "TrillionniumFoundation/hepta-paper",
  "headCommit": "...",
  "headTree": "...",
  "baseCommit": "...",
  "testedCommit": "...",
  "testedTree": "...",
  "workflowPath": "...",
  "workflowSha256": "sha256:...",
  "runnerOrHostIdentity": {},
  "toolchain": {},
  "lockfileSha256": "sha256:...",
  "binarySha256": {},
  "configurationSha256": {},
  "testManifestSha256": "sha256:...",
  "results": [],
  "createdAt": "...",
  "expiresAt": "...",
  "review": {
    "status": "pending|approved|rejected",
    "authority": "..."
  }
}
```

For head qualification, `headTree == testedTree` is mandatory. A merge ref may
be recorded separately but never substitutes for head-tree evidence.

## Confidential legacy replay

The 263-file legacy control-plane archive is held by a private companion
workflow. Its replay proves historical migration compatibility, not production
authority.

Accepted closure evidence for `LEGACY-REPLAY-001` binds:

```text
exact public candidate commit/tree
exact private workflow commit/tree and policy digest
archive digest and byte count
263-entry matrix digest
263/263 replay result
network-isolation and cleanup results
receipt and artifact-index digests
independent acknowledgement
```

The public minimal fixture, local-only replay or archive existence alone is not
full-matrix evidence.

## Retention

Release-blocking evidence is retained for at least the supported release life
plus the audit period. Short CI artifacts are diagnostic unless the plan names
them as retained evidence.

Copying evidence to immutable storage does not upgrade its tier. The copy must
retain the original subject, digest, issuer and review status.

## Independence

The implementation author may produce source and hosted-installed evidence.
They may not self-approve:

- protected-main policy, bypass or denial evidence;
- target-host Linux primitive and storage facts;
- external key-owner custody;
- provider-account authentication;
- KMS/HSM/WORM custody;
- live release or submission permission;
- confidential legacy replay acceptance when they operate the verifier.

The administrator who configures a protected policy may produce its exported
configuration and denial observations but cannot be the sole independent
reviewer accepting it.

## Expiry, invalidation and revocation

A source head, required check set, producer workflow definition, capability
mapping, schema, dependency, artifact, review or static-truth digest change
invalidates effective source qualification. Any newer producer run/attempt also
invalidates the old artifact until successful regeneration and live
revalidation.

A ruleset, bypass actor, host, key, binary, configuration, trust generation,
mount, service unit or provider change invalidates affected external evidence.
Revoked evidence remains archived but cannot satisfy current status.

## Workflow contract

Qualification workflows:

1. explicitly checkout the intended head;
2. derive and record its tree;
3. bind static truth, lockfile, producer workflow IDs/paths/Git blobs/SHA-256,
   capability mappings and complete schema digests;
4. run with minimal permissions and pinned actions;
5. emit a machine envelope even on failure where feasible;
6. fail on context collisions, zero jobs/steps, missing contexts, skipped
   required jobs, wrong PR/event/ref/run attempt or stale heads;
7. use exact non-secret subject identities;
8. avoid prompts, manuscripts, credentials and raw provider payloads;
9. fail when required evidence files are absent;
10. preserve logs long enough for independent review;
11. never set independent approval fields themselves;
12. leave the source worktree byte-clean;
13. validate normalized evidence and the final artifact against their complete
    committed schemas;
14. revalidate currentness after every producer workflow completion without
    making the revalidator part of its own source matrix.
