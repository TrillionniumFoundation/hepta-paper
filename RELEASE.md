# Release process

Version 0.10.0 is a targeted-refactor, native-workflow-projection and optional
TaskFlow-coordination checkpoint, not a live-submission release.

Run `npm run release:verify` from a clean commit. Verification uses disposable
SQLite/CAS/ledger state, proves that production database byte and logical hashes
are unchanged, and restores the 263-row source audit from the ext4-immutable
archive. Neither the matrix audit nor the two Python-to-JavaScript differentials
require the live legacy working directory.
The gate requires the full local selftest, architecture, repository-wide and
full-system coverage, the cold-volume contract, both differentials, physical workspace
separation, read-only native-store health and logical integrity, an isolated
verification runtime, a backup/restore drill, the immutable archive and a
deletion/restore drill. The
release evidence bundle binds the
commit, verification receipt, capability manifest, migration matrix, legacy
tree and database hashes. Its local signature proves build/archive integrity
only; it is not owner, academic, referee, operator, or executor authority.

A release tag may be created only from a clean worktree after that gate passes.
The cold-volume CAS and external-disk WORM contracts are recorded in the signed
bundle. The WORM target is the distinct ext4 device mounted at
`/media/qian-qi/TOSHIBA_CLEAN3`; qualifying snapshots require inode-immutable
objects and a hash/immutability restore drill. This is same-host external-disk
protection only, not an off-host/offsite custody claim. The latter additionally
requires an offline-detachment or Object Lock receipt plus independent custody
attestation. The unrelated cold-data volume
remains an explicit blocker until its 15 entries and signed sentinel are
actually present.

The repository remains fail-closed. A tag does not authorize external actions,
academic acceptance, destructive deletion, or functional-parity retirement of
the frozen legacy archive.

The feature-flagged TaskFlow pilot is an outer OpenClaw coordination layer. It
stores only minimal identifiers, hashes, blocker codes, revisions and child
task links. Hepta SQLite plus verified receipts remain the sole business source
of truth; every resume must reread them and recompute the native gate. TaskFlow
cannot validate evidence, infer acceptance, unlock submission, hold provider
credentials, or turn a local release signature into external authority.
