# Release process

Version 0.4.0 is an operational-proof and runtime-boundary hardening
checkpoint, not a live-submission release.

Run `npm run release:verify` in the workspace with the frozen legacy source
available at the parent `paper_factory` root. The gate requires the full local
selftest, architecture coverage, both Python-to-JavaScript differential tests,
physical workspace separation, native-store health, and a backup/restore drill.
A release tag may be created only from a clean worktree after that gate passes.

The repository remains fail-closed. A tag does not authorize external actions,
academic acceptance, or retirement of the frozen legacy archive.
