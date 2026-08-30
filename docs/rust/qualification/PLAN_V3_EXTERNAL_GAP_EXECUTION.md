# Plan v3 external gap execution protocol

Status: normative qualification procedure; no repository or hosted-CI authority.

## Purpose

Repository source can implement validators, schemas, harnesses and fail-closed
composition. It cannot manufacture facts controlled by a repository ruleset,
production host, independent reviewer, capability key owner, Codex account
owner, KMS/HSM, immutable-storage custodian, restore operator or submission
provider.

Each package below therefore has two distinct states:

1. `package_ready`: source, schema and negative validation are present;
2. `externally_accepted`: a separately controlled authority executed the exact
   package and signed evidence bound to the exact commit, tree, binary, host and
   configuration.

`package_ready` never implies `externally_accepted` or production activation.
The machine mapping from external gaps to package IDs and schemas is
`external-package-map.v1.json`; an external gap without a mapped package is a
source-governance failure.

## Common evidence envelope

Every external record must bind:

```text
schema version
repository
Git commit and Git tree
source archive hash
Cargo.lock hash
binary hashes
configuration hashes
qualification package ID and hash
host or external authority domain
started/completed timestamps
raw evidence manifest hash
result: approved | rejected | inconclusive
reviewer/authority key ID
signature and trust-bundle generation
```

The implementation author, repository administrator and GitHub-hosted runner
must not act as the sole external reviewer or authority owner.

## EXT-GOV-MAIN-001 — protected main merge boundary

A repository administrator distinct from the implementation change activates a
ruleset targeting `refs/heads/main`. The active ruleset must require pull
requests, current-head status checks, CODEOWNER review, stale-approval dismissal,
last-push approval, resolved conversations, no force push, no branch deletion and
no bypass actor. Signed commits or a verified GitHub merge-commit policy and the
chosen history policy must be explicit.

Evidence conforms to `protected-main-ruleset-evidence-v1.schema.json` and binds
repository ID `1349108143`, the exact source commit/tree under review, the ruleset
ID and exported ruleset hash, all required check contexts and separate
administrator/reviewer authority domains.

The following denial tests are mandatory and must each retain content-hashed
raw evidence:

```text
direct push
stale approval after a new head
missing required check
failed required check
force push
main deletion
administrator bypass
```

A CODEOWNERS file, post-push workflow, prose policy or screenshot without an
exported ruleset and denial evidence cannot satisfy this package. Acceptance does
not merge a pull request automatically.

## EXT-HOST-CGROUP-001 — Linux process containment

Run `hepta-cgroup-v2-target-host-qualification.sh` as root against a dedicated,
non-production delegated cgroup-v2 subtree. The harness must prove that a
stopped initial child is attached before release, then remains contained after
`setsid`, double-fork and process-group escape. `cgroup.kill` must remove the
entire process set and `cgroup.events` must reach `populated 0` within the hard
deadline.

Required supplementary evidence:

- kernel and cgroup-v2 mount identity;
- systemd delegation and unit hardening;
- cgroup subtree owner/mode and controller availability;
- PID, session, process-group and cgroup membership observations;
- reboot and service-crash recovery;
- independent low-level review record conforming to
  `independent-linux-review-v1.schema.json`.

## EXT-HOST-STORAGE-001 — journal and filesystem failure matrix

Use the existing broker host qualification v2 harness on a dedicated test mount.
Execute SIGKILL, reboot, disk-full, quota, read-only remount, WAL/SHM truncation,
main-page corruption, stale sidecar, backup and restore cases. Production data
must never be used as the destructive target.

Acceptance requires byte/object identities, exact failure point, post-restart
classification, no duplicate provider eligibility and an independent observer.

## EXT-KEY-OWNER-001 — capability authority lifecycle

The external key owner executes the package described by
`external-key-owner-drill-v1.schema.json`:

- overlap rotation;
- active-key revocation;
- validly signed generation rollback;
- interrupted publication;
- signer compromise;
- bundle-signing-key compromise;
- removal of all active request keys;
- emergency admission stop and recovery.

The broker must never receive the private request or bundle-signing key.

## EXT-CODEX-ROLE-001 — authenticated role canaries

The Codex account/runtime owner executes one bounded author canary and one
bounded reviewer canary under distinct service UIDs, private homes, sockets,
journals, capability audiences and schema roots. Evidence conforms to
`authenticated-codex-role-canary-v1.schema.json`.

The canary must prove authentication, bounded completion, environment and FD
non-disclosure, no cross-role home access, no campaign-database access and no
release/submission credential access. Prompt or manuscript content is excluded
from the qualification record.

## EXT-CUTOVER-SOAK-001 — production-shaped writer cutover

Evidence conforms to `production-cutover-soak-v1.schema.json` and requires:

- exact schema-25 source database snapshot;
- independently verified backup and restore;
- Node/Rust normalized logical parity;
- old workers stopped and all old leases cleared;
- one authoritative writer at every instant;
- rollback before activation and terminal-resume recovery after ambiguity;
- at least 10,000 deterministic campaign/node operations;
- a continuous 72-hour production-shaped soak;
- zero stale commits, duplicate integration, unexplained budget settlement or
  unclassified recovery residue.

This record still does not authorize production activation. Activation is a
separate externally signed decision for the exact release and deployment.

## EXT-AUTHORITY-SET-001 — release and irreversible actions

Evidence conforms to `external-authority-set-v1.schema.json`. Release signing,
WORM custody, backup/restore and submission dispatch must come from four
separately administered authority domains. Each receipt binds one exact request,
subject, nonce, deadline, result and current trust generation.

No fixture, repository key, local admin delegation or shared authority domain
can satisfy this package.

## Acceptance and ingestion

External evidence is staged read-only, schema-validated, signature-verified and
bound to the current candidate. Ingestion may change an external gap from
`blocked_external` to `externally_accepted`; it must not modify source status,
merge a PR, enable credentials or activate production automatically.

A stale, expired, mismatched, self-signed, aliased or incomplete record is
rejected without retaining partial authority.
