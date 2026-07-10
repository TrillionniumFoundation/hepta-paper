# Changelog

## 0.7.0 - 2026-07-10

- Made every test, status and governance workflow either disposable-runtime or
  read-only by default. Standalone selftests now reject a production runtime,
  and release verification binds both the SQLite byte hash and a canonical
  logical database hash.
- Added a one-time, auditable repair for the duplicate historical pilot receipt
  that had an invalid ledger key; no historical evidence is promoted by the
  repair.
- Replaced the 263-row migration audit's live `paper_factory` dependency with
  selective restoration from the ext4-immutable archive and a tracked
  hash/symbol manifest.
- Added fail-closed cold-volume CAS import/restore and off-host WORM
  snapshot/restore contracts. Neither is reported complete while the external
  cold volume and distinct WORM device are absent.
- Raised the whole-repository coverage gate to 25% lines and 30% functions,
  while retaining the 50% branch and stricter architecture gates. Split the
  paper-contract facade into bounded proposal, research, workflow, venue and
  product modules and extracted blocker-family reporting from batch summary.
- Added final-commit-bound packets for four externally separated authority
  roles, 13 owner families, 14 operational proofs, one real-paper production
  chain, and off-host WORM onboarding. Internal key generation and inferred
  acceptance remain forbidden.

This release remains production `No-Go`: external trust roles, owner
acceptance and operational proof are still absent; the cold volume and off-host
WORM target are not mounted; no live provider action is authorized.

## 0.6.0 - 2026-07-10

- Added a verified cold-volume mount contract for all 15 unavailable
  `NDU_Nature_work` data links. Code verification accepts the exact contract;
  operational replay remains blocked until the declared volume and content
  manifest are mounted.
- Replaced 249 per-file owner placeholders with 13 hash-bound capability-family
  acceptance packets. Expansion to matrix rows requires an external
  `capability_owner` signature over the exact family manifest.
- Added signed, production-bound operational-proof intake for all 14 native
  capabilities. Proof must bind real inputs, execution/result/replay hashes,
  the release commit and current target hashes; technical conformance cannot be
  promoted automatically.
- Replaced the remaining production `paperctl merge-queue` string with a
  hepta-native, plan-only safe-apply command contract. The 58-case differential
  now proves semantic parity across the explicit command-contract migration.
- Added a repository-wide coverage inventory/gate while retaining the stricter
  architecture coverage gate.
- Extracted the only three Python files required by the two differentials into
  a hash-bound minimal immutable fixture so differential replay no longer reads
  the full legacy working tree.
- Added an ext4 inode-immutable legacy reference snapshot receipt and made
  immutable archive state part of deletion/restore and signed-release evidence.

This release remains production `No-Go`: owner acceptance is 0/249,
`operationally_proven` is 0/161, the cold volume is not mounted, four real trust
roles remain unprovisioned, and external actions remain zero.

## 0.5.0 - 2026-07-10

- Isolated test/CI/release verification into disposable SQLite, CAS and ledger
  roots, with a hard assertion that the production database hash is unchanged.
- Added schema v3 evidence classification for verification, administrative,
  pilot, operational and owner evidence; legacy records are reclassified but
  never promoted automatically.
- Replaced mutable, stale `latest` reports with commit/version/hash/expiry-bound
  pointers and added a quarantine pass for unbound or expired legacy reports.
- Added signed release-integrity evidence bundles and external authority/owner
  intake packets; local signing is explicitly non-authoritative for academic,
  owner, operator or executor decisions.
- Added an external, no-network provider sandbox that exercises durable
  outbox/inbox, duplicate response, receipt validation, reconciliation and
  release without performing a live external action.
- Snapshotted the legacy control plane as a hash-bound cold reference archive,
  made active control files POSIX read-only, and added a deletion/restore drill
  that preserves the archive while owner and operational gates remain open.

This release remains production `No-Go`: owner acceptance is 0/249,
`operationally_proven` is 0/161, four real trust roles remain unprovisioned, and
external actions remain zero.

## 0.4.0 - 2026-07-10

- Replaced file-presence capability completion with executed, ledger-backed
  verification receipts that bind the test result and current target hashes;
  added a separate `operationally_proven` axis that remains false without
  production-bound receipts.
- Hardened the OS sandbox with read-only source mounts, isolated ephemeral
  work/output roots, no host `/etc` mount, and before/after source Merkle
  verification.
- Upgraded artifact storage to content-addressed immutable objects and
  manifests with atomic materialization, retention policy, garbage collection,
  and mandatory persistent receipt-ledger injection.
- Preserved Claim versions, added hash-bound transition receipts, and bound
  research gap plans to persistent idempotent jobs, leases, and attempts.
- Added full repair apply/rollback proof and submission restart, duplicate
  response, provider-receipt, dead-letter, and concurrent release-lock tests.
- Split batch service bootstrap, state projection, report writing, and local
  diagnostic round execution into dedicated application modules; paper-domain
  now hashes only through the workflow kernel.
- Ran a real-paper pilot for `A_Theory_of__Expectations`: the native source
  integrity worker passed and generated replayable receipts; the chain then
  correctly stopped at missing real academic evidence, independent referee,
  and dual live authorization. No provider executor or external action exists.

This release remains production `No-Go`: owner acceptance is 0/249,
`operationally_proven` is 0/161, and the real pilot lacks external authority
materials.

## 0.3.0 - 2026-07-10

- Split capability state into decision, contract, implementation and owner
  acceptance axes; added independent conformance suites for all 14 capability
  families.
- Moved batch stage handlers and the local diagnostic review loop into
  application use cases and made ExecutionContext the dependency boundary.
- Added the persistent receipt/job ledger, idempotent lease/attempt/failure
  jobs, persistent submission delivery state, release locks and schema v2.
- Added byte/hash/provenance evidence verification, ClaimGraph invariants,
  experiment aggregates, Lake certificate/replay verification and a real
  fail-closed OS sandbox backend.
- Replaced paper-runtime dependence on the full vendored core with a small
  workflow kernel; the vendored core remains a hash-bound reference fork.
- Physically separated the hepta repository, paper assets, native runtime/store
  and frozen legacy archive, and removed runtime scanning of the legacy worker
  catalog.
- Recorded all seven retirement waves plus freeze, quarantine and active
  control-plane removal receipts. Legacy source was not destructively deleted.

This release remains production `No-Go`: owner acceptance is 0/249, real trust
and evidence material are absent, and no provider executor is implemented.

## 0.2.0 - 2026-07-10

- Added capability matrix v3 for all 249 explicitly retired legacy surfaces.
- Replaced conditional batch orchestration with an execution context,
  declarative mode registry, workflow engine, and stage receipts.
- Added Store and ArtifactRepository ports and migrated production SQLite
  calls to the SQLite adapter.
- Split research claim, evidence, experiment, gap planning, formal verifier,
  and change proposal capabilities into bounded contexts.
- Added submission delivery contracts for dispatch authorization, response
  intake, redrive, reconciliation, and release locking without adding a live
  executor.
- Renamed the deterministic review path to local diagnostic review loop; it no
  longer produces or implies academic acceptance.
- Moved 97 journal profiles to a versioned, schema-validated dataset.
- Added portable CI, architecture contract tests, coverage thresholds, and
  release verification commands.

This release remains production `No-Go`: runtime trust keys, real evidence,
independent review authority, dual live authorization, and an external provider
executor are absent.
