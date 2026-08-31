# Legacy 263-file matrix reference publication and replay closure

Issue #28 tracks the confidential historical input required for full
Node-to-Rust migration verification.

The public migration matrix binds:

```text
archive name    paper-factory-control-plane-reference.tar.gz
archive bytes   22,506,525
archive sha256  e431c4c7a51a15d64866b17a07c09dd17c15c32c8dddaccf1a769b1a5942cb9d
matrix entries  263
matrix sha256   59446f5e96cc5f086b27266f0fb0604d4f7f0e5bf1f62cb1a90933208a0f162a
release id      379268751
asset id        536563599
```

The opaque archive is retained in the private companion
`TrillionniumFoundation/hepta-paper-legacy-reference`. It is not copied into
the public repository because it contains historical SQLite/bytecode content
and absolute symlink members. The verifier extracts only the 263 allowlisted
regular files after auditing member type and path safety.

## Plan v4 status

Artifact availability and local digest verification exist. Full migration
qualification remains blocked as `LEGACY-REPLAY-001` because the current public
release candidate has not yet received a retained secret-gated hosted replay
receipt/index and independent acknowledgement.

The private companion workflow is
`.github/workflows/legacy-matrix-reference-verification.yml`. Before each run,
its policy and workflow pins must be updated to the exact public candidate
commit/tree and then independently protected. A stale allowlist cannot qualify
a newer candidate.

The private companion's branch protection, administrator gate, workflow
identity secrets and read credentials are external operational facts. Public
source cannot manufacture or self-attest them.

## Required workflow behavior

The private workflow:

1. runs only from `workflow_dispatch` on the protected private default branch;
2. requires an explicit administrator gate;
3. verifies its own commit, tree, workflow and policy identity;
4. verifies the exact public candidate commit/tree;
5. installs public dependencies before private archive materialization;
6. verifies the private release API asset ID, size and digest;
7. verifies archive structure and all 263 source hashes;
8. destroys the archive and companion manifest before target execution;
9. runs the matrix integrity and deterministic differentials in a no-network
   bubblewrap sandbox;
10. proves candidate and trusted-tool worktrees remain clean;
11. retains a receipt and artifact index containing only non-secret evidence;
12. removes extracted private material and temporary logs.

A workflow that is skipped, lacks required credentials, changes AppArmor/user
namespace policy without recording it, fails to create the network namespace,
or leaves private material behind produces failure evidence only.

## Public closure schema

The accepted independent closure record must validate against:

`qualification/legacy-matrix-replay-closure-v1.schema.json`

It binds:

```text
exact public candidate commit/tree/source snapshot digest
exact private verifier commit/tree/workflow/policy digests
archive digest, byte count, release and asset IDs
263/263 matrix result
zero P0 findings
deterministic differential parity
network-isolation proof
archive destruction before target execution
final cleanup and clean-worktree proof
receipt and artifact-index digests
distinct operator and reviewer domains
independent signature
non-activation authority fields
```

The closure schema fixes all production, release, submission and external
authority flags to `false`. The replay is compatibility evidence only.

## Public metadata verification

Repository-local metadata verification may check the publication locator,
archive/matrix constants and private workflow contract without materializing
the archive. This is useful source evidence but does not close issue #28.

The public minimal differential fixture remains a separate small regression
corpus. It cannot be relabelled as the full 263-file replay.

## Closure rule

Close `LEGACY-REPLAY-001` only after:

1. the private workflow is bound to the exact final public candidate;
2. private branch protection and workflow identity gates are active;
3. the secret-bearing hosted run completes successfully;
4. the retained receipt and artifact index validate and are content hashed;
5. the archive is destroyed before untrusted target execution and cleanup is
   complete;
6. an independent reviewer signs the closure record.

Archive existence, local replay, mutable release metadata without per-run
digest verification, repository-admin prose or implementation-author
self-acceptance is insufficient.
