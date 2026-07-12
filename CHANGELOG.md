# Changelog

## 0.16.0 - 2026-07-12

- Added explicit budget amendments for stopped campaigns. Resume now requires
  the exhausted budget to be raised above recorded usage, preserves completed
  nodes, reopens only nodes skipped by that budget stop, recomputes the plan
  hash and records the amendment in the campaign event stream.
- Added in-place referee-round extension for campaigns that correctly stop
  without convergence. The operation preserves prior review and execution
  evidence, supersedes the blocked package, appends only a new
  review/revise/revalidation/re-review round and keeps packaging fail-closed.
- Completed three real production-store recovery campaigns. Replay converged
  in round two at mean score 0.910 with zero critical findings; Stochastic
  Optimization required the new third round and converged at mean score 0.933,
  100% acceptance and zero critical findings. All three campaigns now have a
  completed package and no external action was performed.

## 0.15.0 - 2026-07-11

- Added `OpenClawAgentExecutor` and a dedicated unbound
  `hepta-paper-worker`. Every writer, coder, referee and reviser receives a
  separate child session; session/run identifiers and token usage return to the
  native campaign ledger. OpenClaw is the default backend, structured Ollama is
  the circuit-breaker fallback, and authenticated Codex CLI remains optional.
- Added reflink/copy-on-write node workspaces with conflict-detecting merge.
  Successful workspaces are removed after their changed paths are merged;
  failed workspaces are retained for diagnosis. Three independent referees no
  longer share model context or a mutable source tree.
- Added a process-wide resource governor and per-campaign limits for agent,
  CPU, GPU and memory slots. Wall-time, agent-call, CPU-job, GPU-job, token and
  cost budgets are persisted and
  enforced, running leases receive heartbeats, and pause, cooperative cancel,
  resume and failed-node retry are exposed through `paper:campaign` actions.
- Upgraded the campaign plan so revision acceptance is based only on
  independent reviews bound to the revised manuscript hash. Revision now
  triggers impact-selected code, empirical, compile, citation and table/figure
  checks before a second referee wave. Exhausting the final round without
  convergence stops the campaign and never manufactures a package.
- Added locked Python/R runtime image definitions, read-only named dataset
  mounts, deterministic seed and kernel resource contracts, result artifact
  materialization, a source/runtime/data-bound empirical cache with verified
  artifact replay, a native CUDA worker smoke and an actual legacy R helper
  reproduction smoke. R lock restoration retries transient archive downloads
  without relaxing any pinned version. Julia remains explicitly on demand.
- Added campaign dashboard, status/event/log surfaces, persisted usage and stop
  reasons, TaskFlow child-session linking, a shared-governor ten-campaign chaos
  gate, a three-real-paper OpenClaw smoke, and a minimum-two-round strict
  re-review smoke that operate only on filtered copies of real paper sources.

This release defines local automated research readiness independently from the
optional submission/archive plane. Public keys, owner signatures and WORM
custody do not block writing, coding, empirical execution, review or revision.

## 0.11.0 - 2026-07-11

- Reoriented the product around a signature-free Automation Plane. Persistent
  `PaperCampaign` DAGs now coordinate research planning, parallel writer/coder
  work, isolated empirical execution, manuscript integration, compilation,
  multi-referee review, automatic revision, affected-artifact revalidation and
  convergence. Live submission remains a separate optional plane.
- Added schema v4 campaign, node and event storage with dependency-ready
  claims, leases, bounded retries, crash recovery, idempotent completion and
  concurrent execution across papers. A ten-campaign fault benchmark covers
  injected failures, replay, early convergence and expired-lease recovery.
- Added real agent adapters for authenticated Codex and local Ollama. Ollama
  output is constrained by a JSON Schema, per-role output budgets, workspace
  containment and atomic edits; model execution never performs external
  submission actions.
- Added kernel-isolated empirical workers for Python, Node, R, Julia, Lean and
  LaTeX with honest runtime discovery, network isolation, resource limits,
  declared outputs and optional GPU access. Generated code and LaTeX failures
  feed real diagnostics into bounded repair and fresh execution.
- Added deterministic generated-LaTeX sanitation for common serialization
  defects, multiple independent referee scores, automatic revise rounds and
  mandatory parallel code/experiment/compile revalidation.
- Added an optional TaskFlow campaign mirror for cross-session coordination.
  Native SQLite campaign state remains the DAG source of truth and TaskFlow
  does not own research, referee, execution or submission decisions.
- Added `automation:status`, disposable real-agent and end-to-end campaign
  smokes, `paper:campaign`, and an Automation Plane guide. Automation readiness
  is now reported independently from live-submission readiness.

This release does not claim that every optional language runtime is installed
or that live submission is enabled. Those are reported separately and do not
block unrelated local campaigns.

## 0.10.0 - 2026-07-11

- Split proposal generation/materialization and referee repair planning from
  their orchestration entry points. The proposal entry is now 237 lines and
  the referee-revise entry is 272 lines; the extracted bounded services remain
  covered by the existing size and import architecture gates.
- Activated the previously unused `workflow_states` schema through a native,
  hash-bound `WorkflowStatePort`. Executed batch workflows may persist a
  derived projection and its ledger receipt; read-only planning never writes,
  and receipt/state hash mismatch fails closed.
- Added a feature-flagged OpenClaw TaskFlow pilot for the
  `A_Theory_of__Expectations` reviewed-submission attempt. It keeps only
  coordination state and hashes, revalidates hepta-native state on every
  resume, and cannot grant authority, unlock a release, validate evidence, or
  own provider credentials. The pilot is disabled by default.
- Added revision-conflict, child-task failure, state-tamper and unregistered
  paper tests. Architecture checks prevent the TaskFlow adapter from entering
  the domain core or becoming a second business source of truth.
- Rebound the 263-row legacy matrix reference to the refactored proposal
  target. Its classification remains 14 behavioral replacements and 249
  explicit retirements, with no unmapped or partial entry.
- Fixed WORM release selection to order semantic versions numerically, so
  `0.10.0` cannot be mistaken as older than `0.9.0`; a regression test now
  protects the final evidence snapshot boundary.

This release remains production `No-Go`: TaskFlow only improves coordination.
No external keys or signatures have been supplied, owner acceptance is 0/249,
operational proof is 0/14 native capabilities (covering 161 legacy
requirements), the 15 cold-data entries and sentinel are absent, and no live
provider executor is installed or authorized.

## 0.9.0 - 2026-07-11

- Split the empirical, journal, legacy-cleanup, referee-revision and batch
  reporting adapters into bounded modules. Every high-risk split module is now
  limited to 700 lines and its orchestration entry point to 400 lines by an
  architecture test; this is a real responsibility split rather than a facade
  rename.
- Added a full-system coverage gate that executes the end-to-end selftest and
  enforces 80/50/80 for lines/branches/functions. The measured result is
  88.25/53.90/84.38; the faster repository gate remains separately enforced.
- Added fillable public-key-only templates for four separated authority roles,
  the owner trust store, all 13 owner families and all 14 production-bound
  operational receipts. A read-only staging verifier now checks Ed25519 role
  separation, owner-family hashes, current-commit target bindings and authority
  document envelopes without installing evidence or authorizing any action.
- Corrected the WORM custody claim: `TOSHIBA_CLEAN3` is a distinct ext4 external
  disk on the same host. Snapshots remain hash-bound and inode-immutable, but
  off-host/offsite custody stays explicitly blocked until an offline-detachment
  or Object Lock receipt and independent custody attestation exist.

This release remains production `No-Go`: no external keys or signatures have
been supplied, owner acceptance is 0/249, operational proof is 0/14 native
capabilities (covering 161 legacy requirements), the 15 cold-data entries and
sentinel are absent, and no live provider action is authorized.

## 0.8.0 - 2026-07-11

- Bound off-host WORM storage to the renamed, physically distinct ext4 volume
  `TOSHIBA_CLEAN3` and completed a real six-object snapshot plus restore drill.
  All objects and the manifest are inode-immutable; the cold-data volume is
  still treated separately and remains unavailable.
- Hardened WORM idempotency and integrity: already-immutable objects are now
  detected correctly, pre-existing hash conflicts fail closed, and restore
  drills verify both content hashes and current filesystem immutability.
- Raised whole-repository coverage gates from 25/50/30 to 30/54/50 for
  lines/branches/functions. Added regression coverage for empty and sparse
  batch summaries and canonical table rendering.
- Reduced `batch-summary.mjs` from 866 lines to a 38-line compatibility facade;
  result aggregation now lives in a bounded reporting module.
- Regenerated final-commit-bound external intake for four authority roles, 13
  owner families, 14 operational proofs, and the
  `A_Theory_of__Expectations` production chain. No acceptance or authority is
  inferred from those requests.

This release remains production `No-Go`: the 15-entry cold-data source and its
sentinel are absent, externally controlled trust/owner signatures have not
been supplied, production operational proof remains pending, and no live
provider action is authorized.

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
