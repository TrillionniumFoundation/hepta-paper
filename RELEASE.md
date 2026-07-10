# Release process

Version 0.6.0 is a recoverability, governance-intake and immutable-reference checkpoint,
not a live-submission release.

Run `npm run release:verify` in the workspace with the frozen legacy source
available for the read-only retirement audit. The two Python-to-JavaScript
differentials themselves replay from the tracked minimal immutable fixture.
The gate requires the full local selftest, architecture and repository-wide
coverage, the cold-volume contract, both differentials, physical workspace
separation, native-store health, an isolated verification runtime, a
backup/restore drill, the immutable archive and a deletion/restore drill. The
release evidence bundle binds the
commit, verification receipt, capability manifest, migration matrix, legacy
tree and database hashes. Its local signature proves build/archive integrity
only; it is not owner, academic, referee, operator, or executor authority.

A release tag may be created only from a clean worktree after that gate passes.

The repository remains fail-closed. A tag does not authorize external actions,
academic acceptance, destructive deletion, or functional-parity retirement of
the frozen legacy archive.
