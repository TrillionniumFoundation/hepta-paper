# Release process

Version 0.2.0 is an architecture checkpoint, not a live-submission release.

Run `npm run release:verify` in the workspace with the frozen legacy source
available at the parent `paper_factory` root. The gate requires the full local
selftest, architecture coverage, and both Python-to-JavaScript differential
tests. A release tag may be created only from a clean worktree after that gate
passes.

The repository remains fail-closed. A tag does not authorize external actions,
academic acceptance, or retirement of the frozen legacy archive.
