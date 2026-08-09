# Release process

Version 0.21.0 is an unreleased automation-first research-production candidate.
It combines the native WAL/dispatcher and evidence hardening from 0.17 with explicit
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

During development the three normative marker lines remain in the
`development` profile. After all source changes are complete, change those
three lines once to the tag-neutral finalized profile shown below and include
that change in the exact clean source commit:

- `Release state: finalized v0.21.0 source.` in `CURRENT_STATUS.md`;
- `Version 0.21.0 is finalized from this exact source commit.` in this file;
- `## 0.21.0 (finalized source)` in `CHANGELOG.md`.

That untagged commit is `release_ready`. The same immutable source becomes
`released` when `v0.21.0` points at it; tagging must not be followed by another
documentation edit. Historic tag-specific release markers remain valid only
when their matching tag points at `HEAD`. Partial, duplicated, substring-only,
mixed, reused-tag, and inconsistent tag snapshots fail closed.

Freeze the exact source commit and ensure its worktree is clean. From that same
untagged `release_ready` commit, run the following sequence without changing any
source, index, untracked file, release marker or tag between steps:

The release environment must explicitly set
`ELAN_HOME=/opt/hepta-paper/elan`. That path is the reviewed root-owned,
non-group/other-writable sealed Lean distribution with no ACLs or extended
attributes; release verification never
executes an ambient Elan launcher to discover it. A user-owned `~/.elan`, an
implicit `HOME` fallback or a toolchain whose complete Merkle differs from the
code-pinned sealed root fails closed.

On a production host, release and restore operations must enter through the
sealed entrypoint itself:

```bash
/usr/libexec/hepta-paper/hepta-paper-release-env --help
/usr/libexec/hepta-paper/hepta-paper-release-env release:state-gate
```

`npm run release:env -- <action>` resolves to that installed launcher when the
package root is the `/opt/hepta-paper` mount. Production automation must invoke
the installed launcher directly; npm is itself a Node process and therefore is
not the pre-Node security boundary. Except for side-effect-free `--help`, the
JavaScript CLI requires the launcher's marker and inherited deployment-lock
descriptor, so a direct `node release-env.mjs <action>` fails closed. The
entrypoint refuses to run from a source checkout or candidate directory. It requires the exact
`/opt/hepta-paper` realpath to be a root-owned `ro,nosuid,nodev` bind mount of
`/opt/hepta-paper-releases/<clean-HEAD>`, rejects nested mounts and external
symlinks, and verifies the Git provenance, release state, dependency-tree
contract and hashed deployment closure before dispatch. The state, formal,
verification, trust, restore, cold-volume and WORM gates may run
on an exact sealed `development` tree so their own fail-closed blockers remain
observable; the preflight always reports the inspected release state, and
`release:verify` independently enforces `release_ready` before its isolated
release run.

The root-owned installed launcher verifies and opens the deployment authority,
then executes `/usr/bin/env -i` and drops to the `hepta-paper` primary identity
with `NoNewPrivileges=yes` before starting Node. Ambient `NODE_OPTIONS`,
`NODE_PATH`, provider credentials and arbitrary configuration therefore cannot
run or influence an import first. Only `formal:gate` and `release:verify` receive
the host's exact Docker group because their sealed tests require the local
daemon; every other action has no supplementary groups. The JavaScript
entrypoint then rebuilds the child environment again as a second defense. It
fixes `ELAN_HOME=/opt/hepta-paper/elan`, the production asset/runtime roots, Git safe
directories, locale and private scratch locations; it does not inherit provider
credentials, provider environment files, shell startup configuration,
`NODE_OPTIONS`, `LD_PRELOAD`, proxy variables or arbitrary `HEPTA_*` values.
Only the actions printed by `--help` are accepted, with no command passthrough.
The sole forwarded value is an absolute `--manifest` beneath the configured
WORM target for `offhost:worm-restore-drill`.

The sealed `offhost:worm-status` action is not the permissive same-host status
probe: its fixed command includes `--require-custody`. It exits nonzero until
the contract declares external/offsite custody **and** the verifier validates
the current typed evidence. A static `offHostOrOffsiteCustodyQualified=true`
does not pass. The immutable receipt and independently signed Ed25519
attestation must be fresh, trust-store/key pinned, and bound to the current
findmnt UUID/PARTUUID storage identity, selected snapshot manifest hash, and
verified immutable object-set hash. Old evidence, a replacement disk, or a
changed manifest/object blocks.
The unqualified `npm run offhost:worm-status` command is diagnostic only and
cannot support a production-exit claim.

The release environment fixes the same production roots as the installed
systemd profile: `/srv/hepta-paper/assets` and `/var/lib/hepta-paper/runtime`.
It does not fall back to migration/operator state under `/data/home-data`.
Credential-bearing conformance replay, capability refresh and release
attestation are deliberately outside this launcher: each requires its own
reviewed operator identity, key path and mutation transaction. The closed
`release:verify` action may read the already-provisioned local release-integrity
key and publish its owner-bound isolated-verification receipt; it cannot
provision, repair or rotate that key. The launcher does not inherit or
manufacture any authority.

Membership in the Docker group is root-equivalent. The two Docker-dependent
actions are therefore qualified only on a dedicated trusted verification host;
this launcher is not a sandbox against malicious sealed test code. Their
JavaScript preflight rechecks the root-owned mode-0660 Unix socket, the exact
action-scoped group set and `NoNewPrivs: 1` before dispatch.

`env -i` cannot undo code already loaded by the dynamic loader into the
launcher's initial `/bin/sh`. A production invocation therefore must originate
from the systemd manager or an independently verified clean root execution
context with `LD_PRELOAD`, `LD_LIBRARY_PATH` and loader audit variables absent.
Do not treat the npm alias, an inherited operator shell, or this launcher as
protection against hostile host root. The launcher protects the Node import and
child boundaries; host-root and pre-launch dynamic-loader compromise remain
outside this release evidence claim.

Before sanitizing and starting Node, the launcher opens the existing
root-owned, single-link, mode `0600` regular file beneath the preserved,
root-owned mode-0711 directory
`/run/hepta-paper-deployment/deployment.lock`, verifies the parent and opened
descriptor identities, and holds a nonblocking shared lock for the entire Node process and
its synchronous gate child. Candidate build and cutover tooling must hold the
same inode exclusively. A missing, replaced, weakly owned, multiply linked or
exclusively locked file fails closed, so verification cannot race a mount
cutover. The launcher never creates or repairs this deployment authority file.

`store:restore-drill` never restores over or migrates the production database:
it copies a qualified backup into a temporary database for integrity checks.
It does, however, publish the restore receipt (and creates a qualified backup
when none exists) and records administrative receipt-ledger evidence, so it is
an explicit evidence write rather than a byte-for-byte read-only database
operation.

Cold-volume and WORM paths must be traversable and readable by the reduced
`hepta-paper` principal at dedicated root-owned mount points. A user-home media
mount or operator-only ACL is an explicit production provisioning blocker; the
launcher never retains root merely to bypass unqualified custody permissions.

Production hold changes, release tagging, release-key provisioning, WORM
snapshot writes and every live submission action are intentionally absent.
They require their separately authorized operator paths. In particular, using
the release environment never enables the supervisor, dispatcher, strict
acceptance timer or the final submission commit.

1. Provision the bounded local release-integrity key once with
   `node paper-core/bin/release-integrity-key.mjs --action provision --execute`.
   Provisioning is explicit, refuses an existing partial or mismatched pair, and
   never repairs, replaces or rotates a key. This host-resident exportable key is
   only a build/archive-integrity credential; it is not an external KMS/HSM or
   production authority.
2. Run `npm run conformance:replay` to produce the exact production-source-bound
   replay chain for the frozen commit.
3. Run
   `node migration/bin/refresh-production-capability-verification.mjs --execute`
   to refresh implementation evidence against that replay chain.
4. Run `npm run release:verify`. The authoritative runner itself requires
   `release_ready`, executes `release:inner` from an independent read-only exact
   checkout, and publishes the signed isolated-verification receipt plus the
   signed current pointer to its immutable capability manifest. This repository's
   release profile is the sealed `systemd-host` deployment, so the source gate
   keeps the Kubernetes template explicitly non-deployable without claiming
   Kubernetes qualification; a Kubernetes release must instead pass the separate
   `--deployment-profile=kubernetes` gate after a qualified site overlay replaces
   every placeholder. The sealed release command also reruns the high-severity
   npm advisory audit; an unavailable advisory service or qualifying finding
   blocks the release instead of reusing a source-only or stale local result.
5. Run `npm run release:attest`. It reruns the pure deletion/restore verification,
   publishes its current signed receipt, reselects all current evidence, and then
   publishes the signed release bundle and pointer.
6. Require the attest result to be `code_release_evidence_ready`, recheck the
   unchanged clean `HEAD`, and only then create `v0.21.0` on that same commit.

The replay and refresh reject tracked, indexed, or untracked drift and reject an
inherited `HEPTA_RELEASE_COMMIT` unless it exactly equals the real repository
`HEAD`. Every receipt and manifest binds the clean commit, commit tree, tags,
repository content, index, worktree identity and evidence classification. All
generated evidence is written under the physically decoupled external runtime,
not the Git tree, so the sequence has no commit-hash recursion. Any later source
or tag change invalidates the chain and requires replay, refresh, verification
and attestation again. Package wrappers are only UX: the underlying verification
and attestation entrypoints independently enforce release state and provenance.
Verification uses disposable SQLite/CAS/ledger state, proves that production database byte
and logical hashes are unchanged, and restores the 263-row source audit from the
ext4-immutable archive. Neither the matrix audit nor the two Python-to-JavaScript
differentials require the live legacy working directory.
The gate requires the full local selftest, architecture coverage, one
deduplicated repository-wide full-system coverage run, and a strict operational
Docker gate that executes both pinned Python and R academic dataset harnesses
through original and replay runs. It also runs the unified formal operational
gate across the dynamic kernel, campaign release, both proof-search paths and
the typed dependency graph, requiring a complete terminal TAP summary with
22/22 passing and zero skipped tests. It also requires the cold-volume contract,
both differentials, physical workspace separation, read-only native-store
health and logical integrity, an isolated verification runtime, a backup/restore
drill, the immutable archive and a deletion/restore drill. The
release evidence bundle binds the
commit, verification receipt, capability manifest, migration matrix, legacy
tree and database hashes. Its local signature proves build/archive integrity
only; it is not owner, academic, referee, operator, or executor authority.
The deletion/restore drill inside isolated verification is pure: it does not read
a signing key or leave a production attestation receipt. Only the explicit,
non-isolated exact-commit `release:attest` flow may publish that receipt.

A release tag may be created only from a clean worktree after that gate passes.
The cold-volume CAS and external-disk WORM contracts are recorded in the signed
bundle. The WORM target is the distinct ext4 device mounted at
`/media/qian-qi/TOSHIBA_CLEAN3`; qualifying snapshots require inode-immutable
objects and a hash/immutability restore drill. This is same-host external-disk
protection only, not an off-host/offsite custody claim. The latter additionally
requires a continuously verifiable Object Lock receipt plus independent custody
attestation. A historical offline-detachment receipt cannot establish current
offsite custody after that device is reattached. The unrelated cold-data volume
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
