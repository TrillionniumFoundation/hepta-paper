# Rust trusted computing base boundary

## Purpose

This document defines which components may establish hepta-paper state,
evidence and external authority. It prevents the Rust rewrite from converting a
model executor into an accidental trusted core.

## Principals

| Principal | May hold | Must not hold |
|---|---|---|
| Campaign core | campaign state capability, policy, prepared-result integrator | Codex auth, portal credentials, KMS private material |
| Author broker | author Codex home, author workspace capability, broker journal | campaign DB writer, reviewer home, release/submission authority |
| Reviewer broker | reviewer Codex home, immutable review bundle | author workspace write, author session/home, campaign DB writer |
| Formal reviewer broker | formal-review home, immutable evidence bundle, scratch | author/reviewer homes, canonical source write, release authority |
| Release attestor | release inputs, attestation command capability | Codex auth, mutable campaign execution workspace |
| Submission dispatcher | single-use submission permit and portal/API credential | Codex auth, general campaign write authority |
| Backup/restore authority | encrypted state backup capability | model execution credentials, submission permits |

## Trust tiers

### Tier 0 — externally authoritative

KMS/HSM, WORM custody, submission portal/API and independent signing services.
Rust calls them through narrow command ports. Their successful receipts are
external evidence; local Rust code cannot manufacture their authority.

### Tier 1 — state authoritative

The Rust campaign writer, migration coordinator and trusted ledger writer. These
components may change business state and therefore require single-writer
fencing, durable transactions and restore qualification.

### Tier 2 — evidence validating

Canonical hash verifier, mutation verifier, formal/empirical verifier,
release-package verifier and policy engine. A verifier may reject evidence but
must not silently grant a higher assurance level than its contract establishes.

### Tier 3 — execution plumbing

Codex brokers, process supervisors, compilers and external scientific runtime
adapters. They produce observations and candidate artifacts. They do not decide
scientific truth, release readiness or submission eligibility.

### Tier 4 — untrusted execution

Codex, generated code, repository-provided commands and model-authored content.
All output is data until bounded, parsed, schema-checked and independently
validated.

## Codex broker TCB

The broker is trusted only for these claims:

- it verified a specific local request capability;
- it launched a specific executable identity under a specific role profile;
- it observed a bounded sequence of exact stdout/stderr bytes;
- it recorded crash-stable operation state;
- it generated a receipt bound to those observations.

The broker is not trusted to claim:

- generated content is correct or novel;
- citations exist or support a claim;
- a reviewer is institutionally independent;
- a proof or experiment is valid without an independent verifier;
- an artifact is releasable or a submission is authorized.

## Process separation

Production topology uses separate Unix users and sockets:

```text
hepta-core       -> /run/hepta/codex-author.sock
                 -> /run/hepta/codex-reviewer.sock
                 -> /run/hepta/codex-formal-reviewer.sock

codex-author     owns author CODEX_HOME and author journal
codex-reviewer   owns reviewer CODEX_HOME and reviewer journal
codex-formal     owns formal reviewer CODEX_HOME and journal
```

Socket directories and files are owner/group restricted. The broker validates
peer credentials and an expiring signed request capability. A valid socket peer
without a valid capability is rejected; a copied capability from a different
operation, role, generation or deadline is rejected.

## Credential boundary

The campaign core never reads Codex auth files. The broker binds non-secret
filesystem identity and config hashes but does not serialize token bytes. The
Codex parent process receives the minimum credential environment required by the
qualified authentication mode.

Commands executed by Codex receive an independently scrubbed environment:

```text
inherit = none
allow: PATH, LANG, LC_ALL, HOME(scratch), TMPDIR, SOURCE_DATE_EPOCH,
       explicitly qualified toolchain variables
block: OPENAI_*, CODEX_*, *_KEY, *_TOKEN, *_SECRET, AWS_*, GITHUB_*, KMS_*,
       PORTAL_*, SUBMISSION_*, backup and WORM variables
```

Qualification must attempt to read parent environment, role-peer homes,
`auth.json`, process environment and known authority paths. Any successful
credential disclosure blocks production qualification.

## Filesystem authority

The broker receives a capability for one already-created attempt root. It may
not resolve arbitrary host paths. The workspace layer opens the root without
following links and supplies descriptor-relative operations. The author profile
uses a versioned allowlist. Reviewer profiles are read-only, with an optional
separate scratch root whose contents cannot enter canonical state without an
explicit verifier.

Actual before/after inventory is authoritative. Agent-reported `checksRun`,
`edits` or `changedPaths` are advisory data only.

## Database authority

A Codex broker owns only its minimal operation journal database. It cannot open
the campaign database. The campaign writer integrates a prepared result only
after verifying:

- operation/request/receipt hashes;
- campaign ID, node ID and attempt ID;
- campaign revision and lease generation;
- runtime and role identity;
- output schema and mutation policy;
- current writer ownership and budget settlement.

## Network authority

V1 Codex role profiles use no provider-side workspace network and no model tool
network. Prior-art retrieval is a separate, snapshot-bound service. App Server,
MCP, plugins, web search and `danger-full-access` are outside the qualified V1
boundary.

## External authority separation

Codex principals cannot read or invoke:

- KMS/HSM signer credentials;
- WORM or custody write credentials;
- backup/restore authority;
- journal portal credentials;
- submission permits or dispatch credentials;
- release-promotion capability.

A model may propose a release or submission action. Only deterministic policy
and a separately authorized principal can execute it.

## OpenClaw disposition

OpenClaw is legacy Node behavior. It is not a Rust port, compatibility adapter,
feature flag, crate, broker profile or test dependency. Historical receipts may
remain read-verifiable, but no Rust runtime path may execute or dynamically load
OpenClaw.

## TCB change rule

Any change that adds a secret, write path, network path, resume path, provider
feature or external authority to a principal requires:

1. threat-model update;
2. ADR;
3. negative qualification tests;
4. rollback plan;
5. explicit approval before merge.
