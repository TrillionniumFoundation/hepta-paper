# External evidence ingestion runbook

## Preconditions

- candidate Git commit and tree are immutable and independently identified;
- each package payload is canonical JSON matching its closed root schema;
- the package decision is `approved` and every mandatory drill/result field is in
  its success state;
- the independently reviewing authority named in the payload exactly matches the
  signed outer envelope, and is distinct from the operator/owner domains required
  by that package;
- every immutable payload file hashes exactly to the signed envelope `payloadHash`;
- the external signer domain/key is present in a canonical trust store matching
  `qualification-trust-store-v1.schema.json`;
- trust generation is current and chained to the previously accepted trust-store hash;
- implementation-author, repository-admin and GitHub-hosted CI domains are forbidden;
- envelope, payload and trust files are canonical, single-link, authority-owned and
  read-only below ancestors the verifier principal cannot modify;
- the request and replay ledger reside in a verifier-owned private `0700` directory.

## Verification sequence

1. Read the private request with no-follow, close-on-exec and bounded exact-length checks.
2. Obtain current time from the verifier operating system, never from request input.
3. Open trust, envelope and payload files with no-follow and close-on-exec semantics.
4. Recheck path/descriptor device, inode, owner, mode, link count, size and timestamps.
5. Require canonical JSON and each package's exact closed field vocabulary.
6. Bind repository, package, exact commit, exact tree and exact payload bytes/hash.
7. Reject non-approved decisions, failed/inconclusive drills, open findings, missing
   mandatory evidence, duplicate authority kinds/roles and reviewer/operator collapse.
8. Check evidence and trust issue/expiry times and bounded validity windows.
9. Reject forbidden/unknown domains, duplicate public-key aliases and bad signatures.
10. Under one private SQLite `BEGIN IMMEDIATE` transaction, verify the complete
    ledger DDL fingerprint, reject system-clock rollback, reject partial/conflicting
    nonce replay, enforce trust generation/hash chaining, and persist all seven nonce
    reservations plus the canonical aggregate receipt.
11. Emit the receipt only after durable commit; exact retries are idempotent.
12. Require an independent governance decision before changing an external gap to
    `externally_accepted`.

## Failure handling

A path change, noncanonical encoding, schema/subject mismatch, non-approved decision,
failed mandatory drill, authority collapse, stale record, payload mismatch, signature
failure, clock rollback, partial/conflicting replay, trust rollback, trust fork or
ledger-schema drift rejects the entire operation. Partial validation grants no
retained authority and the SQLite transaction rolls back.

Evidence acceptance never performs any of the following automatically:

```text
merge a pull request
change main
load Codex credentials
start a live provider call
transfer campaign-writer ownership
sign or publish a release
write WORM custody state
mutate a portal
submit a paper
```
