# Command surface

`npm run scripts:surface` groups all package commands into seven explicit
surfaces:

- `operator`: only the canonical `hepta-paper` npm entrypoint;
- `verification`: tests, coverage, CI and release gates;
- `maintenance`: explicit repository-evidence writes, including accepting a
  vendored-reference baseline or refreshing migration hashes/receipts;
- `retirement`: legacy/migration verification, historical differential checks,
  and immutable-reference status commands;
- `compatibility`: explicit non-authoritative compatibility commands that are
  excluded from the production graph;
- `experimental`: pilots and experimental verification that do not belong to
  the supported operator graph;
- `internal`: implementation details invoked by wrapper commands.

The registry lives in `paper-core/src/command-registry.mjs` and is the sole
metadata source for the `hepta-paper` router, npm classification, retained npm
gate aliases, help output, CI command matrix, and surface tests. Run
`npm run scripts:check` to reject alias/classification drift or
`npm run hepta-paper -- maintenance command-surface-sync` to regenerate the
retained gate aliases and remove retired route aliases. `command-surface.mjs`
emits the generated aliases, help, and CI matrix with `--npm-aliases`,
`--help-artifact`, and `--ci-matrix`. A package script that is not registered
defaults to `internal` and is reported in the top-level `blocked` list; it can
never fall through into `operator`. Forwarded command
arguments require the explicit separator, for example
`npm run hepta-paper -- operator batch -- --help`.
The batch registry records `journal-manage`, `venue-resolve`, and `source-adapt`
as unsupported production vocabulary. Both preview and execution through the
production batch command fail closed because no campaign node executor exists;
legacy projection work must choose the explicit compatibility entrypoint.

The managed-Codex, local state-authority, local release-attestor and immutable
release deployment entrypoints are deliberately not npm or `hepta-paper
operator` commands. The first three are machine-protocol executables; the last
is a root-only, plan-hash-confirmed host transaction. They remain absent from
the registry so raw mutation/signing JSON, protocol stdout and privileged host
deployment cannot be widened into the general operator surface. Their
root-owned deployment launchers, strict help/failure behavior and bounded trust
profiles are defined in
[`operational-process-entrypoints.md`](operational-process-entrypoints.md).

Historical retirement commands are not production paper modes. In particular,
there is no `paper:legacy-cleanup`, `store:migrate-legacy`, or
`store:snapshot-legacy-history` command. The production legacy surface is
limited to immutable-reference verification and migration-matrix audit. An
explicit non-production `compat:legacy-workflow-projection` command remains for
bounded compatibility work and is not reachable from `paper-production-core`.

The canonical reference-package commands use the `reference:*` prefix. The
deprecated `core:*` aliases have been removed. `reference:baseline:accept` is
a maintenance command, not verification: it rewrites accepted repository
evidence and must never be included in a routine verification inventory.
`conformance:replay` is maintenance rather than verification because its
explicit execute mode reads a private signing key and writes signed production
evidence. `store:restore-drill` remains an operational verification gate with
intentional, scoped backup and restore-receipt writes rather than a read-only
status command. Its current `HeptaStoreRestoreDrillReceipt` v3 contract records
the causal claims `restoreDrillBusinessWritePerformed=false` and
`restoreDrillAdministrativeWritePerformed=true`. It also records
`writerQuiescenceAttested=false`,
`businessProjectionComparisonPerformed=false`, and
`concurrentBusinessStateChangesAttested=false`; therefore it makes no claim
that global production business state stayed unchanged while the command ran.
The trusted `administrative_ledger_subject` binds the before hash of a
consistent SQLite online-backup image and the restore-check result to the exact
`store-admin` ledger receipt id and hash. The after image hash exists only as
`diagnosticLiveDatabaseSha256After` in the companion `completion` record, with
`diagnosticAfterHashAssurance=completion_self_hash_only` and
`diagnosticAfterHashLedgerAuthenticated=false`. Retention does not treat that
diagnostic as ledger-authenticated evidence or as byte-for-byte stability
proof. Exact legacy v2 receipts remain readable for retention compatibility,
but their former `productionStoreMutated=false` field is not emitted by v3 and
is not reinterpreted as proof of either business or administrative immutability.
`runtime:permissions` is also maintenance-only and is read-only unless the
caller explicitly forwards both `--execute` and the cooperative-writer fencing
assertion `--writer-quiesced`. It is not routed by `hepta-paper` and
therefore cannot be mistaken for a supported operator command.
`hepta-paper operator automation` emits JSON by default and accepts an explicit `--json` for
machine callers. It keeps release-attestor inspection passive by default: a
configured production backend is described, but no KMS/backend probe or
active-key signature challenge is attempted. The explicit
`--live-release-attestor` flag opts into those actions. The registered
`hepta-paper operator research-readiness` supplies that flag together with
`--live-provider-canary`, so its author/reviewer canaries, independent backend
probe, and fresh active-key challenge are all explicit external actions. Its
external-action, network, and credential effects are classified accordingly in
the command registry.
`hepta-paper operator external-authority-intake -- <arguments>` is the short
path for the first production dependency only. It reads the external author
identity configuration and release-attestor v3 configuration, verifies their
current signed authority material, compares both out-of-band pins, and returns
the observed semantic hashes and exact blockers. It does not inspect assets,
replay, numerical plugins, state, or submission; it cannot start a service,
probe a KMS, or request a signature. A successful result means only that the
four external-authority inputs are ready for one explicit live author/KMS
verification. It never reports full production readiness.
`hepta-paper operator full-production-readiness -- <arguments>` is the outer
production gate. It combines fully autonomous research readiness with a fresh
package-retention recovery challenge, off-host WORM custody, independently
signed external owner acceptance, and release-bound independent operational
proofs. The package-recovery command path and SHA-256 are mandatory; the
command is opened once, checked as a root-owned non-writable executable, and
invoked through its pinned `/proc/self/fd` descriptor. The explicit
`--live-provider-canary` and `--live-release-attestor` flags retain their
network, credential, external-action and possible-cost classification.
`--require-full-production` returns exit code 2 only for a complete semantic
not-ready report; malformed evidence or an infrastructure failure returns 1.
The host installer supplies a manifest-bound stock package-recovery wrapper so
the reference is executable and hashable, but that stock campaign composition
deliberately reports recovery authority unavailable. A separately qualified
launcher must inject the complete recovery authority set and be pinned by its
own independently delivered hash before this gate can become ready.
`hepta-paper operator automation -- --handoff` remains the complete read-only
dependency view and is accepted by the canonical router.
`hepta-paper operator generic-domain-capability-evidence -- <arguments>` is the
canonical generic-domain evidence surface. `status` is read-only. `converge`
revalidates the persisted Agenda, prior-art, experiment and pinned venue
authorities, runs the five-domain Mathlib qualification only when the current
formal authority is not already covered, obtains a dedicated strong external
replay and a separately signed independent reviewer verdict for those five
diagnostics, and compare-and-swap publishes the aggregate evidence. The
`converge` action therefore has network, credential, external-action and possible
provider-cost effects. It cannot create reviewer, replay, registry, KMS, or
formal-runtime authority; missing or drifting configured authority fails before
publication.
`safety:p0`, `safety:p1`, `safety:p2` and `safety:all` are the architecture
hardening gates used by CI/test; `test` is the single root selftest entry.

`hepta-paper operator submission-handoff` is the read-only production bridge between the two
runtime planes. It requires an explicit completed `--campaign-id`, opens the
submission composition independently, verifies the current fenced release and
its immutable package bytes, and emits a typed `CampaignReleaseSubmissionInput`.
It does not dispatch a provider request or authorize a live submission.
The same route is available as
`npm run hepta-paper -- operator submission-handoff -- <arguments>`.

`hepta-paper operator journal-connector-coverage -- <arguments>` is the
read-only target-onboarding surface. `--kind journal|conference` and
`--venue <id>` select a bounded view. `--require-family-prototype` proves only
that a reusable candidate-family prototype exists; the stronger profile,
target-adapter, sandbox, production and live gates are separate and
fail-closed. A qualification registry may promote at most two targets only when
both its semantic hash and trust store are pinned and repository inspection has
validated the registry plus every typed evidence-attestation signature; raw or
unpinned registry objects have no promotion path. It never promotes
`liveSubmissionReady`. The command never probes a portal or uses credentials.

`hepta-paper operator portal-target-qualification -- <arguments>` verifies and
locally imports that registry. `--action status` and `--action import-plan` are
read-only. `--action import-execute --execute --plan-hash sha256:...` replays
the same pinned plan under a lock and atomically installs one generation. The
registry is limited to at most two targets, expires within seven days, requires
owner and independent-observer signatures (plus a production authorizer for
production entries) whose subject, organization, and canonical Ed25519 SPKI are
all independent, and accepts only typed, non-fixture, independently signed
evidence attestations within their per-type age and lifetime limits. Signed
successor and revocation hashes prevent silent downgrade or rollback. It cannot
create or consume a live-commit permit; final commit still requires the separate
human-reviewed single-use authorization.

`hepta-paper operator autonomous-supervisor -- <arguments>` is the canonical
foreground resident controller for persisted autonomous-research campaigns.
The route is explicitly provider-costing and locally mutating; its immutable
lifecycle caps, signal behavior, SQLite lease/CAS recovery, and systemd/Kubernetes
hosting contract are documented in
`paper-core/docs/autonomous-research-supervisor.md`.

`hepta-paper operator nested-runtime-platform-qualification -- <arguments>` is
the read-only Kubernetes startup gate for the nested worker boundary. It
verifies an independently signed exact-platform qualification bundle and a
separately signed current-Pod conformance bundle. The latter binds the Pod UID,
deployment plan, profile, fixed-digest worker, shared-bind uid/gid behavior,
`network=none`, nested CPU/memory/PID controls and parent Pod ceiling. The
command never generates or signs evidence and exits non-zero for missing,
placeholder, stale, hash-mismatched, replayed, or same-authority receipts.

`hepta-paper operator strict-full-auto-acceptance -- <arguments>` is the
single production deployment-convergence gate. `plan` validates and hash-binds
the complete external reference inventory without writing state; `execute`
requires both `--execute` and that exact plan hash. `converge` performs the same
complete preflight and binds its in-memory plan hash directly to execution, so
an unattended deployment has no operator hash-copy checkpoint. It checkpoints the fixed
migration, state, trust, runtime, qualification, restore and dispatcher order,
resumes by verification after a crash, never repeats completed writes, and
rejects every skipped operational check. Durable state and receipts are local
checkpoints only; `status` reports acceptance only after a fresh live replay of
all fifteen verify commands in a bounded parallel window followed by a second
plan/reference identity check. If a crash leaves an action outcome ambiguous,
the gate never repeats it unless the child command consumes the same durable
plan/transition ID; other steps remain verify-only and fail as
`outcome_uncertain`. Opaque KMS/signer/token references are
identity-bound with file metadata but are never opened or read. The example
configuration is
`paper-core/deploy/strict-full-auto-acceptance.config.example.json`.
Its dataset root is a fourth, independent read-only plan binding
(`/srv/hepta-paper/datasets` for systemd), never a writable child of the asset
root. State provisioning is verified with a read-only online-transition plan
whose transition ID is bound to the next execute step; complete inventory and
anti-rollback readiness are both verified after that transition.
Plan-bound verifiers reserve exit code `2` for a complete semantic
`not-ready` observation; exit code `1`, malformed/partial JSON, diagnostic
error objects, timeouts and truncation are infrastructure failures and can
never authorize a mutating renewal.
The production-campaign step requires Agenda/prior-art, Experiment IR, venue,
external replay, and independent formal review inspections to resolve to one
explicit non-golden paper before the paper-bound generic-domain convergence
step may run.

`hepta-paper operator local-golden-dataset-provision -- <arguments>` is the
only supported surface for preparing a generic operator dataset harness for an
isolated local golden campaign. It requires a read-only complete dataset
manifest, explicit non-test split assignments, a host-hidden harness, a
power-valid analysis protocol, research semantics and an Ed25519 operator key.
Plan is read-only; execution requires both `--execute` and the exact current
plan ID. Its signed authority is permanently marked
`local_operator_dataset_authority`, `academicPromotionEligible=false` and
`externalTrustClaimed=false`, and is bound to one canonical runtime root.
Production and configured native roots are rejected. See
`paper-core/docs/local-golden-dataset-provisioning.md`.

`hepta-paper operator autonomous-state-backup -- <arguments>` is the canonical
closed-inventory backup and restore-drill surface for autonomous trust state.
It requires an independently administered authority-head client for both
backup and restore validation; no local flag or hash-only receipt can satisfy
that boundary. Its database scope and protocol are documented in
`paper-core/docs/autonomous-research-state-backup.md`.

`hepta-paper maintenance autonomous-online-schema-transition -- <arguments>`
is the one-time, externally fenced schema installer for the closed autonomous
state inventory. It defaults to a read-only plan. Mutation requires both
`--action execute` and `--execute`, plus the stable transition ID emitted by the
current plan and a pinned authority process configuration. Ordinary status,
readiness, and supervisor commands never invoke it. The protocol and recovery
contract are documented in
`paper-core/docs/autonomous-research-online-schema-transition.md`.
