# External qualification closure verifier

Status: **repository-local verifier; never an external authority or activation permit**

`hepta-qualification-closure` closes the repository-side aggregation gap between
individually signed qualification envelopes and one exact-subject closure receipt.
It does not manufacture any target-host, credential, key-custody, release,
storage, portal or submission fact.

## Inputs

The executable accepts one request matching
`external-qualification-closure-request-v1.schema.json`:

```text
hepta-qualification-closure /absolute/or/local/request.json
```

The request binds one exact repository commit/tree, the effective consumer UID,
one separately owned canonical trust-store file, and exactly one separately
owned canonical envelope file for each package:

```text
EXT-GOV-MAIN-001
EXT-HOST-CGROUP-001
EXT-HOST-STORAGE-001
EXT-KEY-OWNER-001
EXT-CODEX-ROLE-001
EXT-CUTOVER-SOAK-001
EXT-AUTHORITY-SET-001
```

The trust store and envelopes must be canonical JSON regular files owned by an
authority UID distinct from the verifier, single-linked, read-only (`0400` or
`0440`), opened with `O_NOFOLLOW|O_CLOEXEC`, and unchanged across descriptor and
path revalidation. The trust store must explicitly forbid at least
`implementation-author` and `repository-admin` authority domains.

Each envelope remains subject to its package-specific schema and external
execution procedure before publication. The closure verifier rechecks exact
repository/commit/tree/package binding, freshness, Ed25519 signature and signed
payload hash identity.

## Atomic set rules

The verifier fails closed unless:

1. all seven package IDs occur exactly once;
2. every package signature verifies against the separately owned trust store;
3. every nonce is unique;
4. every signed payload hash is unique;
5. one authority domain is not reused across independent governance,
   target-host, key-owner, Codex-account, and release/cutover groups;
6. the request consumer UID equals the running process effective UID.

Host containment and storage packages may use different reviewers within the
same target-host group. Cutover and irreversible-authority packages may use
different reviewers within the same release/cutover group. A signer domain may
not cross those group boundaries.

## Output

Success emits a compact JSON object matching
`external-qualification-closure-receipt-v1.schema.json`. Its deterministic
`receiptHash` binds the ordered package receipts and authority-group partition.
The receipt always states:

```text
allPackagesVerified=true
automaticActivation=false
productionActivation=false
sourceStatusUnchanged=true
```

This receipt proves only that the complete externally produced package set was
cryptographically verified for one exact candidate. A separate, independently
authorized transition is still required to change canonical external-gap status,
merge source, provision credentials, cut over a writer, release an artifact or
submit a paper.

## Failure and recovery

Missing, duplicated, stale, mismatched, self-authorized, authority-collapsed,
aliased, writable or replaced inputs exit nonzero and emit no receipt. Correct
the external package or trust publication and run again; never reuse a rejected
record as partial authority.
