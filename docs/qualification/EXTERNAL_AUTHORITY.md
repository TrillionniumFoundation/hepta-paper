# External authority qualification

## 1. Boundary

Repository source may define schemas, request/receipt ports, cryptographic
verification, replay protection, idempotency, and fail-closed activation. It
cannot manufacture independently controlled host, credential, key, storage,
release, portal, or submission facts.

## 2. Required packages

| Package | Gap | Active schema | Authority |
|---|---|---|---|
| EXT-GOV-MAIN-001 | GAP-GOV-003 | `protected-main-ruleset-evidence-v1.schema.json` | repository governance administrator plus independent reviewer |
| EXT-HOST-CGROUP-001 | GAP-HOST-001 | `independent-linux-review-v1.schema.json` | target-host operator plus independent Linux reviewer |
| EXT-HOST-STORAGE-001 | GAP-HOST-002 | `external-host-storage-package-v1.schema.json` | destructive storage/host operator plus independent reviewer |
| EXT-KEY-OWNER-001 | GAP-KEY-001 | `external-key-owner-drill-v1.schema.json` | capability key owner plus independent reviewer |
| EXT-CODEX-ROLE-001 | GAP-CODEX-001 | `authenticated-codex-role-canary-v1.schema.json` | credential owner, target-host operator, and role reviewer |
| EXT-CUTOVER-SOAK-001 | GAP-HOST-002 | `production-cutover-soak-v1.schema.json` | production writer/operator plus independent reviewer |
| EXT-AUTHORITY-SET-001 | GAP-REL-001 | `external-authority-set-v1.schema.json` | release/KMS/HSM/WORM/portal/submission authorities and set reviewer |
| LEGACY-REPLAY-001 | LEGACY-REPLAY-001 | `legacy-matrix-replay-closure-v1.schema.json` | private archive/replay operator plus independent reviewer; no production authority |

## 2.1 Active ingestion semantics

The active Rust closure contract uses:

```text
payload semantics          strict_package_v1
replay protection          durable_sqlite_v2
automaticActivation        false
productionActivation       false
source status mutation     false
```

The package map remains machine-owned at
`docs/rust/qualification/external-package-map.v1.json`; this document is its
current human protocol/index projection. A schema or map change updates both in
the same review.

## 3. Common envelope

Every package binds:

```text
schema/package version
repository/base/head/merge source subject
binary/configuration/deployment/host identity
request, idempotency, nonce, and expiry
producer authority identity and generation
raw artifact/log hashes with redaction report
outcome and reconciliation disposition
previous receipt/trust generation where applicable
signature/attestation
independent reviewer decision
```

## 4. Separation

Implementation author, repository automation, broker, campaign writer, model
role, release signer, storage custodian, portal operator, and reviewer are
separate where the package requires independence.

Fixture keys, self-signed records, screenshots, prose assertions, and hosted CI
do not close external packages.

## 5. Ingestion

Ingestion is non-activating by default:

1. open authority files through canonical no-follow boundaries;
2. validate complete strict schema;
3. recompute payload/subject hashes;
4. verify trust generation, key role, signature, validity, and revocation;
5. verify package-specific semantics and independence;
6. atomically check replay/nonce/clock/trust state;
7. append accepted receipt and derived non-activating status;
8. require a separate activation/cutover decision.

## 6. Revocation and expiry

An expired, revoked, superseded, forked, replayed, or unavailable package demotes
the affected capability and stops new authority use. Previously committed
historical effects remain auditable; no new effect is authorized.
