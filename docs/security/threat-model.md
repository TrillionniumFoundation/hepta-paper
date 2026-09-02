# Threat model

Status: normative

## Scope

This model covers repository source, campaign state, research artifacts, datasets, runtime images, receipts, keys, release packages, submission handoffs, provider actions, and the hosts or principals that can mutate them.

## Assets and security goals

Critical assets are policy source, canonical schemas, campaign and lease state, immutable artifacts, trusted ledgers, authority trust stores, signing keys, runtime and dataset identities, release packages, remote submission accounts, and audit history.

The primary goals are integrity, provenance, least authority, replay resistance, recoverability, confidentiality of credentials and restricted data, and accurate reporting of the strongest evidence actually established.

## Trust boundaries

- untrusted paper, dataset, archive, model, tool, and provider inputs;
- repository-owned Node process versus out-of-process workers;
- application process versus SQLite and filesystem principals;
- host runtime versus container runtime;
- local administrator versus independent external authorities;
- campaign automation versus release authority;
- release handoff versus provider mutation;
- provider adapter versus remote portal;
- active source versus reference and retirement trees.

In-process issuer policy is an integrity convention, not protection from arbitrary code in the same trusted process. Any principal able to write the production database, runtime, package, archive, lease, or trust root is part of the trusted computing base unless a separately authenticated broker removes that access.

## Threats and controls

### Path and artifact substitution

Threats include traversal, symlinks, hard links, inode replacement, TOCTOU, archive escapes, no-clobber races, and malicious cleanup. Controls include real-path separation, no-follow opens, descriptor/inode/link-count checks, exclusive creation, exact inventory hashes, sealed modes, quarantine on ambiguity, and fail-closed recovery.

### Identity, signature, and replay confusion

Threats include non-canonical JSON, unsigned fields, cross-protocol signatures, stale trust epochs, revoked keys, duplicate receipts, replay across campaign/package/provider identities, and self-declared authority. Controls include exact schemas, canonical hashing, domain-separated signed payloads, purpose-scoped keys, current trust lookup, nonce/challenge and expiry, uniqueness, supersession records, and exact identity binding.

### Worker and tool abuse

Threats include command injection, network exfiltration, resource exhaustion, malicious output, prompt/tool injection, unsupported sandboxing, and runtime drift. Controls include fixed argv, allowlists, network isolation, CPU/memory/PID/deadline limits, digest-pinned images, verified snapshots, bounded output, declared artifact export, and untrusted plugins out of process.

### Remote mutation ambiguity

Threats include duplicate submission, timeout after successful remote action, account confusion, provider redirect, stale authorization, and blind retry. Controls include durable outbox, single-use exact authorization, account/provider/venue binding, pre-action challenge, idempotency where supported, remote reconciliation, and no live action from a local handoff alone.

### Supply chain and secret exposure

Threats include mutable actions/images, compromised dependencies, committed credentials, weak hashes, and altered submodules. Controls include commit-pinned actions, digest-pinned bases, lockfile SBOM, strict npm audit, tracked-file secret scan, bounded SAST, HTTPS pinned submodules, reference baseline verification, and separate deployment qualification.

## Fail-closed requirements

Missing, malformed, expired, ambiguous, duplicated, legacy-only, self-signed, or mismatched authority evidence blocks promotion. A stronger test name cannot upgrade evidence class. Local fixtures, real-runtime fixtures, live models, and external trust remain distinct.

## Residual risks

The repository cannot defend against a hostile process with the same unrestricted OS principal and write access to all protected roots. Deployments with that threat model require separate UIDs, mount namespaces, immutable storage, authenticated brokers, or external signing services whose keys are inaccessible to the application/database principal.

Scientific correctness, exhaustive prior-art search, semantic equivalence between prose and formal statements, provider availability, and venue acceptance are not security properties guaranteed by this system.
