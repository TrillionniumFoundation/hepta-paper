# Architecture hardening v4

Version 0.4 keeps the v3 strangler architecture and tightens the boundaries
that previously allowed technical conformance to look like operational proof.

- Capability implementation requires a persisted execution receipt containing
  the passing test hash and current target hashes. `operationally_proven` is a
  separate production-evidence axis.
- `ArtifactRepository` is a mandatory-ledger CAS with immutable manifests,
  atomic logical materialization, retention metadata and garbage collection.
- Formal commands run with source mounted read-only, an ephemeral work copy,
  a separate output root, kernel network/resource isolation, and source Merkle
  verification.
- Claim transitions preserve optimistic versions and emit hash-bound receipts;
  gap plans bind to persistent job, lease and attempt records.
- The batch composition root delegates service construction, state projection,
  reporting and diagnostic rounds to dedicated application modules.
- Submission persistence validates provider-receipt bytes/hashes and is tested
  for restart recovery, duplicate-response conflict, dead-lettering and
  release-lock contention. The provider executor remains outside this repo.

The first real-paper pilot executes only a source-integrity worker. It stops
at the missing academic-evidence authority, independent referee and dual live
authorization gates. This is the intended fail-closed result, not a completed
submission trial.
