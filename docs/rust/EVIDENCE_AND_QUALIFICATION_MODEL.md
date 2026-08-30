# Evidence and qualification model

## Purpose

Prevent source, hosted-runner and external-authority evidence from being
confused. Evidence is accepted only for its exact subject and tier.

## Evidence tiers

### Source

Binds exact repository commit/tree, lockfile, toolchain, workflow definition,
commands and test results. It can establish implementation behavior in the
workflow environment.

### Hosted installed

Adds disposable real Unix users, groups, installed paths and negative
permissions on a hosted runner. It does not establish a production host,
long-lived custody or an independent operator.

### Target host

Binds a named host, kernel, boot, filesystem, mount, service manager, installed
binary/configuration identity and destructive drill results. It must be
collected on separately controlled infrastructure.

### External authority

Binds a real key owner, provider account, KMS/HSM, WORM custodian, release
attestor or submission authority. Repository code cannot manufacture this tier.

## Mandatory evidence envelope

Every evidence bundle must include:

```json
{
  "schemaVersion": 1,
  "tier": "source|hosted_installed|target_host|external_authority",
  "repository": "TrillionniumFoundation/hepta-paper",
  "headCommit": "...",
  "headTree": "...",
  "baseCommit": "...",
  "testedCommit": "...",
  "testedTree": "...",
  "workflowPath": "...",
  "workflowSha256": "...",
  "runnerOrHostIdentity": {},
  "toolchain": {},
  "lockfileSha256": "...",
  "binarySha256": {},
  "configurationSha256": {},
  "testManifestSha256": "...",
  "results": [],
  "createdAt": "...",
  "expiresAt": "...",
  "review": {"status": "pending|approved|rejected", "authority": "..."}
}
```

For source/head qualification, `headTree == testedTree` is mandatory. If a PR
merge ref is also tested, it is recorded separately; merge-ref success never
silently substitutes for head-tree evidence.

## Retention

Release-blocking evidence is retained for at least the supported release life
plus the audit period. One-day and seven-day CI artifacts are diagnostic only.
Long-lived evidence must be copied into immutable storage with a signed
manifest; copying does not upgrade its tier.

## Independence

The implementation author may produce source and hosted-installed evidence.
They may not self-approve:

- low-level Linux primitive review;
- target-host ownership/ACL/mount/systemd facts;
- external key-owner custody;
- provider account authentication;
- KMS/HSM/WORM custody;
- live release or submission permission.

## Evidence expiry and revocation

Target-host and external evidence carries an expiry or review deadline. A host,
key, binary, configuration, trust generation, mount, service unit or provider
change invalidates the affected evidence immediately. Revoked evidence remains
archived but cannot satisfy current status.

## Workflow contract

Qualification workflows must:

1. explicitly checkout the intended head commit;
2. derive and record its tree;
3. hash the workflow file and lockfile;
4. run with minimal permissions and pinned actions;
5. emit a complete machine envelope even on failure;
6. use exact non-secret subject identities;
7. avoid prompts, manuscripts, credentials and raw provider payloads;
8. fail when evidence files are missing;
9. preserve diagnostic logs long enough for review;
10. never set independent approval fields themselves.
