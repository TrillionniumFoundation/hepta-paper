# External evidence ingestion runbook

## Preconditions

- candidate Git commit and tree are immutable and independently identified;
- the selected package payload passes its JSON Schema and package-specific
  semantic checks;
- the external signer domain and key are present in the separately administered
  qualification trust store;
- implementation-author, repository-admin and GitHub-hosted CI domains are on
  the forbidden-authority list;
- the signed envelope is installed as a canonical, single-link, authority-owned
  read-only file below ancestors that the consumer principal cannot modify.

## Verification sequence

1. Open the envelope with no-follow and close-on-exec semantics.
2. Recheck path and descriptor device, inode, owner, mode, link count and size.
3. Require canonical JSON and the closed V1 field vocabulary.
4. Bind repository, package, exact commit, exact tree and payload hash.
5. Check issue/expiry times and the bounded validity window.
6. Reject forbidden or unknown authority domains and keys.
7. Verify the domain-separated Ed25519 message.
8. Check the nonce against the persistent replay ledger.
9. Persist a qualification-acceptance candidate referencing the immutable
   payload; do not copy external private material.
10. Require an independent governance decision before changing an external gap
    to `externally_accepted`.

## Failure handling

A path change, noncanonical encoding, stale record, subject mismatch, signature
failure, replay, forbidden domain, trust rollback or ambiguous trust refresh
rejects the entire record. Partial validation grants no retained authority.

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
