# External qualification closure verifier

Status: **repository-local verifier; never an external authority or activation permit**

`hepta-qualification-closure` closes the repository-side aggregation gap between
individually signed qualification envelopes, their immutable payload bytes and one
exact-subject closure receipt. It does not manufacture any target-host, credential,
key-custody, release, storage, portal or submission fact.

## Inputs

The executable accepts a private request matching
`external-qualification-closure-request-v1.schema.json`:

```text
hepta-qualification-closure /absolute/private/closure-request.json
```

The request file must be a canonical, single-link `0400` or `0600` regular file
owned by the verifier UID inside an immediate verifier-owned `0700` directory.
The verifier uses its operating-system clock; request-controlled timestamps cannot
revive expired evidence.

The request binds one exact repository commit/tree, the effective consumer UID,
one separately owned canonical trust store, one private durable replay ledger and
exactly one envelope plus immutable payload file for every package:

```text
EXT-GOV-MAIN-001
EXT-HOST-CGROUP-001
EXT-HOST-STORAGE-001
EXT-KEY-OWNER-001
EXT-CODEX-ROLE-001
EXT-CUTOVER-SOAK-001
EXT-AUTHORITY-SET-001
```

The trust store and external files must be canonical regular files owned outside
the verifier UID, single-linked, read-only (`0400` or `0440`), opened with
`O_NOFOLLOW|O_CLOEXEC`, bounded before and during reads, and unchanged across
full descriptor/path metadata revalidation. Every payload byte sequence is hashed
and must equal the signed envelope `payloadHash`; package-specific schema and
semantic validation remains the responsibility of the named external executor.

The trust store matches `qualification-trust-store-v1.schema.json`, has a bounded
validity interval, and carries a monotonically chained generation. Generation 1
has no predecessor; every later generation names the exact SHA-256 hash of the
previous canonical trust store. It must forbid at least `implementation-author`,
`repository-admin` and `github-hosted-ci`. Identical Ed25519 public-key material
cannot be aliased under multiple authority domains.

## Atomic set and replay rules

The verifier fails closed unless:

1. all seven package IDs occur exactly once;
2. every package signature verifies for the exact repository, commit, tree and package;
3. every immutable payload matches its signed hash;
4. every nonce and signed payload hash is unique within the set;
5. one authority domain or public key is not reused across independent governance,
   target-host, key-owner, Codex-account and release/cutover groups;
6. the request consumer UID equals the running process effective UID;
7. the private replay ledger is a canonical single-link `0600` SQLite file in a
   verifier-owned `0700` directory;
8. trust-store generation/hash chaining and all seven nonce reservations commit
   together under `BEGIN IMMEDIATE`, `journal_mode=DELETE` and `synchronous=FULL`;
9. the ledger rejects verifier-clock regression below the last durable acceptance.

An exact retry of the same seven-package receipt is idempotent and returns the
same deterministic receipt. A partial overlap, nonce reuse with different content,
trust rollback, generation skip or same-generation trust fork is rejected and
commits no state.

## Output

Success emits a compact JSON object matching
`external-qualification-closure-receipt-v1.schema.json`. Its deterministic
`receiptHash` binds the ordered package receipts, authority-group partition,
trust-store generation/hash and the durable replay contract. It always states:

```text
allPackagesVerified=true
automaticActivation=false
productionActivation=false
sourceStatusUnchanged=true
replayProtection=durable_sqlite_v1
replayLedgerCommitted=true
```

The receipt proves only that the complete externally produced package set and its
payload bytes were cryptographically verified and durably replay-fenced for one
exact candidate. A separate, independently authorized transition is still required
to change canonical gap status, merge source, provision credentials, cut over a
writer, release an artifact or submit a paper.

## Failure and recovery

Missing, duplicated, expired, mismatched, self-authorized, authority-collapsed,
aliased, writable, replaced, partially replayed or trust-rollback inputs exit
nonzero and emit no receipt. Correct the external publication and run again.
Only an exact already-committed retry is recoverable without fresh nonces.
