# External authority qualification

## 1. Boundary

Repository source may define schemas, request/receipt ports, cryptographic
verification, replay protection, idempotency, and fail-closed activation. It
cannot manufacture independently controlled host, credential, key, storage,
release, portal, or submission facts.

## 2. Required packages

| Package | Gap | Active schema | Authority |
|---|---|---|---|
| EXT-HOST-CGROUP-001 | GAP-HOST-001 | `independent-linux-review-v1.schema.json` | target-host operator plus independent Linux reviewer |
| EXT-HOST-STORAGE-001 | GAP-HOST-002 | `external-host-storage-package-v1.schema.json` | destructive storage/host operator plus independent reviewer |
| EXT-KEY-OWNER-001 | GAP-KEY-001 | `external-key-owner-drill-v1.schema.json` | capability key owner plus independent reviewer |
| EXT-CODEX-ROLE-001 | GAP-CODEX-001 | `authenticated-codex-role-canary-v1.schema.json` | credential owner, target-host operator, and role reviewer |
| EXT-CUTOVER-SOAK-001 | GAP-REL-001 | `production-cutover-soak-v1.schema.json` | production writer/operator plus independent reviewer |
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

The [Rust implementation handoff](../../rust/crates/hepta-qualification-ingest/HANDOFF.md)
defines the file boundaries, resource limits and durable replay behavior. The
current V2 CLI supplies the actual six operational envelopes and payloads to
`verify_external_qualification_closure_v2` before opening its replay ledger.
Cgroup/storage host identity and storage/cutover database identity must agree;
individual package validity alone does not establish complete qualification.
The existing report JSON and its digest remain distinct from the opaque
`VerifiedExternalQualificationClosureV1` and cannot recreate that value.

### Historical compatibility

`EXT-GOV-MAIN-001` / `GAP-GOV-003` and
`protected-main-ruleset-evidence-v1.schema.json` are retained only for explicit
V1 historical verification. They are not current package-map requirements and
cannot block single-maintainer development. V1 receipt hashes and seven-package
validation remain unchanged; selecting V2 requires an explicit request version 2.
V2 has six exact package IDs and four operational authority groups, with no
repository-review group. Missing a real operational package still fails.

Current [request V2](../rust/qualification/external-qualification-closure-request-v2.schema.json)
and [receipt V2](../rust/qualification/external-qualification-closure-receipt-v2.schema.json)
keep strict payload checks, signatures, time windows, host/database binding and
durable replay rules. Their version/kind is included in the receipt hash; they
are not relabelled V1 evidence. A PR merge is neither a runtime grant nor proof
that an external operation occurred.

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
5. verify package-specific semantics, independence and cross-package identities;
6. atomically check replay/nonce/clock/trust state;
7. append accepted receipt and derived non-activating status;
8. require a separate activation/cutover decision.

## 6. Revocation and expiry

An expired, revoked, superseded, forked, replayed, or unavailable package demotes
the affected capability and stops new authority use. Previously committed
historical effects remain auditable; no new effect is authorized.
