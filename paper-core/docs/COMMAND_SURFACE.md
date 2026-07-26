# Command surface

`npm run scripts:surface` groups all package commands into seven explicit
surfaces:

- `operator`: only npm aliases backed by a route in the canonical
  `hepta-paper` registry;
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
metadata source for the `hepta-paper` router, npm classification, generated npm
route aliases, help output, CI command matrix, and surface tests. Run
`npm run scripts:check` to reject alias/classification drift or
`npm run scripts:sync` to regenerate routed aliases. `command-surface.mjs`
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
status command.
`runtime:permissions` is also maintenance-only and is read-only unless the
caller explicitly forwards `--execute`. It is not routed by `hepta-paper` and
therefore cannot be mistaken for a supported operator command.
`automation:status` emits JSON by default and accepts an explicit `--json` for
machine callers. It keeps release-attestor inspection passive by default: a
configured production backend is described, but no KMS/backend probe or
active-key signature challenge is attempted. The explicit
`--live-release-attestor` flag opts into those actions. The registered
`automation:research-status` route supplies that flag together with
`--live-provider-canary`, so its author/reviewer canaries, independent backend
probe, and fresh active-key challenge are all explicit external actions. Its
external-action, network, and credential effects are classified accordingly in
the command registry.
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

`paper:submission-handoff` is the read-only production bridge between the two
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
fail-closed. The command never probes a portal or uses credentials.

`hepta-paper operator autonomous-supervisor -- <arguments>` is the canonical
foreground resident controller for persisted autonomous-research campaigns.
Its registered npm alias is `automation:autonomous-research-supervisor`. The
route is explicitly provider-costing and locally mutating; its immutable
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
