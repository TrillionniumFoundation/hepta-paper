# Release process

Version 0.21.0 is an unreleased automation-first research-production candidate. It combines
the native WAL/dispatcher and evidence hardening from 0.17 with explicit
multi-language empirical DAGs, licensed content-addressed datasets, repeated
metric/artifact verification, persistent fair resource admission, bounded
runtime retention, operational SLOs and tighter domain/application/adapter
boundaries. It retains safe in-place recovery, append-only referee-round
extension, strict reviewer identity and honest unknown-cost accounting.
It is not a live-submission release and must not be tagged while the worktree,
sandbox soak, workspace recovery, SLO or exact-commit release evidence is incomplete.

The candidate includes a post-action submission evidence and redrive contract,
but still contains no in-process live provider executor. A submitted outcome is
releasable only after an atomically consumed single-use authorization, a
provider-scoped receipt, exact uploaded-artifact hashes, an identity-bound
signed executor response and a live venue-state proof reconcile. Missing or
ambiguous responses remain in a wait/review state until their deadline and a
reviewed venue-side non-submission proof; retrying then requires a new
authorization and dispatch cycle. Invalid boundary payloads are stored only as
hashes and failure codes in quarantine. The bundled sandbox's incomplete
"submitted" fixture is therefore quarantined rather than promoted to a fake
full-lifecycle receipt.

The live authorization subject additionally binds a signed, ledger/CAS-backed
venue observation, its observer and purpose, the exact portal route/provider
capability receipt and any redrive decision/prior dispatch cycle. Evidence
receipts are accepted only from their expected trusted issuer class, and CAS
verification re-reads stable regular manifest/object/materialized bytes rather
than trusting ledger membership alone. A future provider executor must present
a signed provider/account/route capability attestation before atomically
claiming an expiring outbox lease. Migration 017 atomically couples response
state with its ledger receipt and adds an anchor-scoped, gap-free monotonic
response-consumption cursor.

Experiment promotion additionally requires a registered immutable profile and
a ledger-verified execution contract across experiment/run identity,
dataset/code/result, fixed output paths and roles, named CAS artifacts, worker
output manifest and reproducibility receipt. Coq and Isabelle entries describe
fail-closed adapter and certificate contracts only; their trusted execution
receipt binds command, toolchain, runner, exit code, output hashes, certificate
receipt, source manifest and claim/obligation manifest. Executable presence
does not claim operational support.

Run `npm run release:verify` from a clean commit. Verification uses disposable
SQLite/CAS/ledger state, proves that production database byte and logical hashes
are unchanged, and restores the 263-row source audit from the ext4-immutable
archive. Neither the matrix audit nor the two Python-to-JavaScript differentials
require the live legacy working directory.
The gate requires the full local selftest, architecture coverage, one
deduplicated repository-wide full-system coverage run, and a strict operational
Docker gate that executes both pinned Python and R academic dataset harnesses
through original and replay runs. It also requires the cold-volume contract,
both differentials, physical workspace separation, read-only native-store
health and logical integrity, an isolated verification runtime, a backup/restore
drill, the immutable archive and a deletion/restore drill. The
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

Automation validation is separate from submission governance. The deployment
must run `automation:status`, `automation:selftest`,
`automation:runtime-smoke`, and the explicitly requested
`automation:openclaw-multipaper-smoke`. A runtime smoke is valid only when
Python CPU, native CUDA GPU and the actual R asset helper each execute twice in
the sandbox with matching artifact hashes. A multi-paper smoke is valid only
when the three source asset trees remain byte-identical and the global resource
peak stays within its declared slots.

`automation:strict-rereview-smoke` is the environment-bound acceptance for the
quality loop. It requires at least two completed revise/revalidation/re-review
rounds and permits a third when real critical findings remain,
at least one real critical finding in the initial review wave, one revised
manuscript hash per independent re-review wave, and final convergence. It runs
only on a filtered disposable copy and never enables submission.

The v0.15 acceptance ran three real-paper OpenClaw campaigns to 18/18 completed
nodes with a global agent peak of three, rebuilt the locked R image from its
lockfile, replayed Python CPU, CuPy GPU, native CUDA and a real NDU R helper
twice with stable artifact hashes, and completed a 33-node strict paper run.
That run rejected round one at mean score 0.793 with three remaining critical
findings, then accepted round two at mean score 0.927 with zero critical
findings. Both re-review waves were bound to one revised manuscript hash per
round; the source asset tree remained unchanged and no external action ran.

The v0.16 production acceptance preserved and completed three recovery
campaigns in the native production store instead of replaying them from
scratch. `DQL_Exploration_Convergence` converged in round one at mean score
0.917; `DQL_Replay_Convergence` converged in round two at 0.910; and
`DQL_Stochastic_Optimization` moved from four critical findings in round one
to one in round two and zero in an appended round three, with final mean score
0.933 and 100% acceptance. The final Stochastic package is a 17-page PDF with
SHA-256 `a385ce47437f1af3027eb49b280412405d2e64051a5ab8cdc92d129254dc2ba8`.
All runs used the OpenClaw backend, remained inside the declared global slots,
and performed no external submission action.
