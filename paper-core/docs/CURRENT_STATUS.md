# hepta-paper current status

This is the normative status for the unreleased v0.21.0 development candidate. Older remediation,
phase and retirement documents are archived under `docs/history/`; they are historical records and
do not override this document.

## Architecture

- `paper-domain` owns contracts and workflow vocabulary.
- `paper-application` owns execution context, workflow orchestration, use cases
  and pure report projections; it does not import concrete adapters.
- `paper-composition` owns concrete bootstrap, batch, report-persistence and
  pilot wiring.
- `paper-ports` owns infrastructure boundaries.
- `paper-adapters` owns persistence, providers, automation executors and other
  infrastructure implementations.
- `workflow-kernel` owns domain-neutral transition, hashing and runtime
  utilities.
- `paper-core` owns CLI composition, verification entrypoints and compatibility
  re-exports. Adapter and application production modules may not import it.
- `core/` is a baseline-bound vendored reference package; the production graph
  may not import `core/src`.

The supported command surface is `npm run hepta-paper -- <operator|verify|retirement> <command>`.
Remaining npm scripts are classified verification, maintenance, retirement,
compatibility, experimental or internal plumbing rather than a second
production operator API.
The declarative command registry drives both routing and classification;
unregistered scripts default to internal/blocked rather than operator. Forwarded
arguments require an explicit `--` separator.

Contract implementations live only in `paper-domain/contracts`. One hash-bound
`paper-core/src/contracts/workflow-contracts.mjs` retirement facade remains for
the frozen migration manifest; the other obsolete contract re-exports are gone.
Historical legacy-cleanup code lives only in the read-only
`migration/retirement` namespace; it is not a production batch mode.
Hash-bound compatibility exceptions are explicitly classified in
`migration/compatibility-support.v1.json` and cannot be moved by cleanup.

## Trust and evidence

Trusted ledger writers are minted by the private issuer-policy registry. A
caller cannot become trusted by supplying a boolean or its own kind/stream
allowlist. Original receipt rows are append-only; corrections use replacement
receipts and qualification/supersession records.
Only the composition broker may import the mint function; architecture tests
enforce that boundary. Formal and experiment evidence is promotion-eligible
only when its execution, artifact and reproducibility receipts resolve through
the trusted effective-ledger projection; unsafe or incomplete execution stays
blocked.

This mint/broker boundary is an in-process integrity convention, not a security
boundary against arbitrary code already executing inside the trusted Node.js
process or another process with direct write access to the production SQLite
file. Production composition therefore admits only repository-owned, reviewed
modules; untrusted plugins must run out of process, and every OS principal that
can write the database is part of the trusted computing base. Canonical issuer
policy verification detects self-declared or drifted issuer metadata, but is
not described as cryptographic issuer authentication. The verifier exposes
this distinction and offers a fail-closed external-attestation requirement. If
the threat model includes a same-UID direct database writer, deployment must
move trusted receipt issuance behind a separately authenticated process or
signature service whose signing key is unavailable to the application and
database-writer principal; the current in-process mode must not be used as that
security boundary.

Runtime hygiene is idempotent for already-qualified receipts, and store status
reports raw historical classifications separately from unresolved current
classification debt.

- Local-admin-delegated owner acceptance: 249/249 across 19 families.
- Independent external-owner acceptance: 0/249.
- Production-source-bound conformance replay: 14/14 after a release-bound
  replay is run.
- Independent production operational proof: 0/14 until distinct external
  owner and observer signatures are ingested.

Local conformance is intentionally not labeled production operational history.
The code-release gate has three explicit layers: implementation verification
and release-bound conformance are blocking; independent production operational
proof is reported separately and cannot be synthesized by, or substituted
with, a local replay. Disaster-recovery readiness and external trust readiness
are likewise separate from `code_release_evidence_ready`.

## Legacy retirement

`/data/home-data/paper_factory` has been physically removed. The permanent
recovery/audit set is `/data/home-data/hepta-paper-legacy-reference`, including
the immutable source snapshot
`retirement-source-snapshot-2026-07-13`. Regeneration commands cannot overwrite
the frozen salvage manifest, and the old online legacy-cleanup/archive write
entrypoints are retired.

## Runtime

The default native store is
`/data/home-data/hepta-paper-runtime/native-runtime/hepta-paper.sqlite` at
schema 23. The asset workspace and every mutable runtime/report/store root are
required to remain physically disjoint after symlink resolution; mutating
bootstraps reject an overlapping layout before the first write. Receipt rows and
qualification rows are protected by update/delete-deny triggers. Startup
reconciliation is explicit, idempotent and transactional. Migration 021 adds
job lease generations; 022 adds campaign attempt/generation/revision fencing
and recoverable prepared results; 023 makes workspace retention qualification
depend on persisted restore proof and commits workflow projection with its
ledger receipt.

Workspace retention requires registered lineage, a hash-bound snapshot and a
successful restore verification before deletion. Backup retention also
requires trusted backup/restore-drill ledger evidence, keeps at least two
recoverable generations, rechecks content hashes at apply time and converges
through durable intent/tombstone records.

The default ledger read path is the fail-closed `effective_receipt_ledger`
projection. Qualified invalid/tombstoned receipts are never returned as usable;
raw receipt access is explicitly audit-only.

The 2026-07-13 reconciliation requeued 12 expired nodes, removed 4 expired
resource leases and 8 expired waiters. Workspace backfill registered 11
workspaces, restore-verified 7 snapshots, protected 4 incomplete workspaces and
released about 1.64 GB through the receipt-backed retention path.
The liveness reconciliation introduced by migration 020 additionally pauses no-progress campaigns
and transactionally closes queued children of terminal campaigns without
starting workers or discarding recoverable workspace state.
Batch reports are campaign-first: they record plans, queued/replayed state,
plan hashes and node kinds, and do not manufacture retired stage results.
Legacy stage metrics exist only on the explicit non-authoritative compatibility
projection. Reports store a bounded summary plus a content-hash-bound detail
object, instead of embedding full results repeatedly. SQLite backup databases and their
receipt companions are retained and removed as one verified unit; protected
latest artifacts are never selected by the size/age retention policy.

Campaign DAG state is the sole automation authority. Every running attempt is
fenced, prepared results survive recovery, and a stale or cancelled worker
cannot commit. A formal package node emits a typed campaign release bundle;
submission consumes it only after independently verifying campaign, source,
package and immutable-output lineage. Automation and submission use separate
capability-scoped bootstrap roots.
The obsolete direct workflow executor, typed stage pipeline, stage handlers and
local diagnostic loop have been removed. The explicit compatibility projection
projects campaign authority into legacy `workflow_states`; it does not revive or
execute the retired stage workflow.

Dry-run/planning opens no writable store, creates no database and performs no
migration unless the caller explicitly requests a report-writing surface.
Cancellation reaches the complete child
process group through `AbortSignal`, with fenced integration rejecting late
results. TaskFlow remains experimental and absent from production roots.

## Research automation closure

The v0.21 candidate implements a bounded, unattended end-to-end research path
rather than a claim of universal autonomous science. Once independent runtime
principals, a dataset authority and an external qualification service are
provisioned, the research campaign itself has no human checkpoint:

- Scientific input has two explicit authority modes: operator-signed proposal
  claims and machine-proposed claims authorized only by the bounded autonomous
  policy. The latter never claims operator approval. Both modes bind the exact
  claim text, scientific claim key, assumptions, quantifiers, negative
  boundaries and proof obligations into the theorem specification. A field
  change is lineage drift and fails closed. Empirical-protocol claims are never
  projected into Lean; only `formal_kernel` support claims enter the formal
  path.
- Natural-language proof obligations receive stable hash-derived obligation
  ids and an explicit obligation-to-Lean-declaration mapping. Lake verification
  generates system-owned `#check` and `#print axioms` probes for every mapped
  declaration and replay verifies the same mapping. Display text or a theorem
  name alone cannot satisfy obligation coverage.
- Formal candidates are authored, semantically reviewed and checked in an
  isolated candidate workspace. Lean/Lake verification, system-generated axiom
  inspection and fresh replay must all pass before the candidate is integrated.
  Failed candidates can enter a bounded diagnostics-driven repair round without
  first contaminating the source workspace.
- Academic empirical runs use an externally authorized dataset/harness and
  signed `AnalysisProtocol`. Each scheduled cell is bound to exactly one
  approved Python or R runtime profile, runs in a supervised container process,
  and receives an isolated deterministic rerun. All
  original and replay cells share one absolute campaign deadline; CPU/GPU jobs,
  process count, CPU seconds, memory and PID limits are charged per process, so
  a multi-cell run cannot hide behind one node-level budget. Dataset access
  requires a positive-byte read observation; zero-byte, EOF and resealed trace
  forgeries fail closed.
- Repository-owned evaluators compute paired bootstrap intervals, sign-flip
  tests, Holm-Bonferroni multiplicity, power and sensitivity checks. Agent
  aggregates are never statistical authority. A separately implemented
  verification TCB reads the raw artifacts and recomputes every cell fixture,
  response, metric, event count and aggregate residual for all five built-in
  analysis families and all three arms. It does not import the producer-side
  challenge builder, arm evaluator, statistical evaluator or aggregator; its
  implementation hash and independence contract are carried through registry,
  capsule and qualification. Manuscript tables, figures, captions and result
  markers are accepted only when a typed presentation authority binds them to
  the accepted experiment registry, trusted ledger, assertion universe and
  matching original plus replay lineage. Agents cannot write the system-owned
  `automation-results/` tree. Unsupported convergence, condition-number or
  method-specific claims still block promotion.
- Original and replay receipts bind source, dataset, runtime, resource limits,
  hardware, package closure, determinism policy and a normalized Environment
  BOM. Academic, GPU, nondeterministic and unknown modes bypass the generic
  cache. A same-host independent-process replay is not described as independent
  hardware or independent-implementation replication.
- Provider call count, configured maximum cost per call, total cost ceiling and
  wall time form the production hard-stop envelope. Codex/OpenClaw token counts
  are recorded after a response and the prompt carries a remaining-token hint,
  but those backends do not expose a hard per-turn token meter; `maxTokenCount`
  is therefore reported as advisory for them and is never represented as the
  independent safety boundary.
- The immutable release includes a self-contained evidence capsule with raw
  events, JSON/CSV results, Environment BOMs, public authority material and
  original/replay lineage. Academic capsules require an Ed25519 signature over
  the capsule manifest and execution lineage from an operator-provisioned
  `research_execution_release_attestor`; offline verification requires a caller
  supplied release trust root that is not carried inside the package. Private
  signing material and host paths are forbidden from status, receipts and the
  capsule. This attests the manifest and recorded lineage only; it is not an
  independent execution witness, trusted timestamp or proof of execution
  authenticity.
- Production release signing no longer requires the main process to load a
  private-key file. Version-2 attestor configuration pins an active plus
  retiring Ed25519 public-key trust set and delegates digest signing to an
  external KMS/HSM command port. Production readiness requires a fresh,
  independently signed backend challenge proving the exact backend/key tuple is
  reachable, hardware protected and non-exportable, plus a fresh domain-separated
  signature challenge executed by the active release key and verified against
  its configured public key. The version-1 file signer
  is retained as an explicit Golden/test/local degradation and is blocked by
  the `production-run` gate.
- Release packaging independently rebuilds the manuscript PDF from the bound
  read-only LaTeX source in a fresh supervised sandbox. The typed receipt binds
  both source manifests, command/tool identity, worker/process evidence,
  resource budget and authoritative/rebuilt PDF hashes. This establishes a
  source-level rebuild, not byte-for-byte PDF reproducibility; release fails
  closed when the typed rebuild verifier is absent or inconsistent.
- `hepta-paper operator autonomous-research` can machine-select a versioned
  bounded agenda, materialize a conflict-detecting source workspace, launch a
  persisted full campaign, report status and resume paused/stopped work. Its DAG
  includes hypothesis/proposal, writer, kernel formalization, empirical original
  and replay, initial review, revision, revalidation, fresh post-revision
  referees, convergence, research verification and packaging. Repeated launch is
  idempotent, completed external actions are not replayed, and qualification is
  requested from an injected external signer/verifier and cached by release
  hash. The application never self-signs qualification.
- The canonical foreground `autonomous-supervisor` adds durable cold-start
  autonomy around that campaign path. A version-2 machine-intake configuration
  binds a repository-owned topic-producer implementation, exact provider
  configuration, registered research profiles, immutable dataset sources and
  per-day topic, canary and cost ceilings. Generation, admission, campaign
  enqueue, lifecycle attempts/cost and resident ownership all use SQLite
  transactions and generation fences. A crash can be taken over after lease
  expiry without refunding cost or resetting a high-water mark. Replacing the
  configuration, producer profile, implementation or dataset path withdraws
  readiness before another dispatch; none of those authorities is inferred or
  downloaded by the resident process. Machine dispatch authorization is
  one-shot across production readiness and Golden KMS verification, and failed
  readiness/provider attempts retain hash-verified partial side-effect receipts.
  Explicit operator pauses remain stopped; only an execution-admitted initial
  pause or a supervisor-owned recovery reason is resumed automatically.

Runtime availability and scientific validity remain separate. The status probe
reports ordinary automation, academic empirical readiness, provider
configuration preflight, live selected-model canaries and release-attestor
readiness independently. `fullAutomaticResearchWritingReady` is true only when
the store is healthy, the registered runtimes are ready, a research-author
provider and a distinct formal-review provider pass live canaries, and the
release attestor is currently valid. It additionally requires
`HEPTA_FULL_RESEARCH_QUALIFICATION_RECEIPT` to name a fresh (at most 24 hours),
hash-bound golden micro-campaign qualification. The receipt is verified against
the exact current worktree, author/reviewer capability receipts, schema gate,
runtime image digests, both live canaries and a current completed formal plus
academic-empirical release from the trusted store. Its release and qualification
signatures use the configured research-execution release attestor. The signed
qualification also binds an externally attested bounded prior-art review
reference. The repository does not validate search completeness, and this
evidence does not prove universal scientific novelty. Separate
provider accounts require either account identities in the capability receipts
or a separately signed principal-independence attestation; distinct credential
  directories alone are insufficient. These externally provisioned capabilities
  and receipts may be supplied by machine-operated KMS/attestation services, so
  no research-time human action is required, but they are never fabricated or
  self-signed by this process.

`fullyAutonomousResearchSystemReady` is the stricter deployment claim. It
requires `fullAutomaticResearchWritingReady`, a current machine-intake authority
that can produce and enqueue a registered topic from an empty campaign queue,
and a healthy fenced resident whose startup and intake reconciliation receipts
match that current authority. `automation-status --require-fully-autonomous`
returns exit code 4 until all three conditions are true. This is a bounded
unattended execution claim for registered profiles, not a claim of universal
scientific validity, exhaustive prior-art search, or self-created independent
trust.

Store readiness is schema-authoritative rather than query-based: status verifies
the exact migration identities for versions 21--23. A readable older database
is reported as `automation_plane_store_blocked` until an offline migration is
completed.

Lean proves the generated Lean statement. Natural-language-to-Lean equivalence
remains a separated semantic-review attestation, not a kernel theorem. Runtime
image identities are digest pinned, but bitwise image rebuild reproducibility is
reported false until all transitive source/artifact hashes are available.

## Verification surface

Use these commands for current status and release verification:

```bash
npm test
npm run reference:integrity
npm run safety:all
npm run paper:architecture-selftest
npm run coverage:architecture
npm run coverage:critical-modules
npm run coverage:repository
npm run coverage:system
npm run migration:retirement-status
npm run owner:status
npm run operational:status
npm run automation:status
npm run automation:research-status
npm run store:logical-integrity
```

The critical-module coverage gate reports and enforces line/function coverage
plus a bounded uncovered-branch-block budget for each contracts, issuer/ledger,
recovery and executor-boundary module rather than relying only on a
repository-wide aggregate.
