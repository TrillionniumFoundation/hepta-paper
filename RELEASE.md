# Release process

Version 0.5.0 is an evidence-isolation and cold-archive retirement checkpoint,
not a live-submission release.

Run `npm run release:verify` in the workspace with the frozen legacy source
available at the parent `paper_factory` root. The gate requires the full local
selftest, architecture coverage, both Python-to-JavaScript differential tests,
physical workspace separation, native-store health, an isolated verification
runtime, and a backup/restore drill. The release evidence bundle binds the
commit, verification receipt, capability manifest, migration matrix, legacy
tree and database hashes. Its local signature proves build/archive integrity
only; it is not owner, academic, referee, operator, or executor authority.

A release tag may be created only from a clean worktree after that gate passes.

The repository remains fail-closed. A tag does not authorize external actions,
academic acceptance, destructive deletion, or functional-parity retirement of
the frozen legacy archive.
