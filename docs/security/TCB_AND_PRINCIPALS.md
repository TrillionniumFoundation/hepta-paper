# Trusted computing base and principal topology

## 1. Principle

The TCB includes every principal, process, file, key, database writer, runtime,
or dependency capable of violating a claimed invariant. Documentation does not
shrink the TCB; OS and cryptographic boundaries do.

## 2. Trust tiers

| Tier | Examples | Authority |
|---|---|---|
| T0 external authority | governance, KMS/HSM, WORM, release, portal/submission owners | specific independently administered effects |
| T1 state authority | campaign commit sequencer/writer, qualification ledger writer | authoritative local state |
| T2 validators | policy, compatibility, evidence, result verifiers | accept/reject only; no production effect |
| T3 control/execution plumbing | scheduler, allocator, brokers, workspace service | plan/reserve/dispatch/prepare within capability |
| T4 untrusted execution | model, generated code, language tools, candidate modules | no trusted state or external authority |

## 3. Principal separation

Production distinguishes:

```text
control-plane service
campaign writer
role-specific brokers
author/reviewer/formal/repair clients
schema/gate/trust authorities
workspace/artifact owners
qualification ingestion
release signer/KMS authority
storage/WORM custodian
portal/submission dispatcher
independent reviewers/operators
```

Shared UID operation is a weaker cooperative integrity mode and must be labeled
accordingly.

## 4. Credential boundary

Credential/private-key bytes never enter:

- campaign state;
- planning candidates or plans;
- prompts or model workspaces beyond the specific credential-owning runtime;
- logs, telemetry, receipts, hashes, CI artifacts, or source;
- central scheduler or campaign writer;
- release/submission principals unrelated to that credential.

The broker may inspect credential-root metadata but does not serialize contents.
External signer protocols keep private keys outside the main process.

## 5. Filesystem authority

Authority-bearing files and parents are canonical, regular, single-link,
owner/mode bound, non-writable by untrusted principals, opened no-follow, and
revalidated through retained descriptors where needed.

Path checks without parent/mount/descriptor authority are insufficient.

## 6. Module security

An untrusted or independently developed module runs out of process unless it is
reviewed into the in-process TCB. Registration does not trust it. Runtime
capabilities are audience-bound, expiring, least-privilege, and exact-subject.

A module cannot read another module's home/journal/workspace or inherit central
writer/release descriptors.

## 7. Logs and artifacts

All observability and evidence objects use strict schemas, bounded fields,
redaction scans, and confidentiality/retention classification. A content hash is
not permission to publish the underlying private content.

## 8. Review independence

Implementation author, repository administrator, host operator, credential/key
owner, scientific verifier, release/submission authority, and final reviewer are
not assumed equivalent. Where independence is required, the evidence package
binds distinct identities and authority domains.
