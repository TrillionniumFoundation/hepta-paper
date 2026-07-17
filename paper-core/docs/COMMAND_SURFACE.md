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

The registry lives in `paper-core/src/command-registry.mjs` and drives the
`hepta-paper` router, npm classification, and surface tests. A package script
that is not registered defaults to `internal` and is reported in the top-level
`blocked` list; it can never fall through into `operator`. Forwarded command
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
deprecated `core:*` aliases remain temporarily and print an explicit warning.
`reference:baseline:accept` and its deprecated `core:baseline` alias are
maintenance commands, not verification: both rewrite accepted repository
evidence and must never be included in a routine verification inventory.
`conformance:replay` is maintenance rather than verification because its
explicit execute mode reads a private signing key and writes signed production
evidence. `store:restore-drill` remains an operational verification gate with
intentional, scoped backup and restore-receipt writes rather than a read-only
status command.
`runtime:permissions` is also maintenance-only and is read-only unless the
caller explicitly forwards `--execute`. It is not routed by `hepta-paper` and
therefore cannot be mistaken for a supported operator command.
`automation:status` never mutates local state, but when a production release
attestor is configured it performs the configured independent backend probe
and a fresh active-key signature challenge. Its external-action, network, and
credential effects are therefore configuration-dependent in the command
registry. `automation:research-status` additionally performs the explicitly
requested author and formal-review provider canaries.
`safety:p0`, `safety:p1`, `safety:p2` and `safety:all` are the architecture
hardening gates used by CI/test; `test` is the single root selftest entry.

`paper:submission-handoff` is the read-only production bridge between the two
runtime planes. It requires an explicit completed `--campaign-id`, opens the
submission composition independently, verifies the current fenced release and
its immutable package bytes, and emits a typed `CampaignReleaseSubmissionInput`.
It does not dispatch a provider request or authorize a live submission.
The same route is available as
`npm run hepta-paper -- operator submission-handoff -- <arguments>`.

`hepta-paper operator autonomous-supervisor -- <arguments>` is the canonical
foreground resident controller for persisted autonomous-research campaigns.
Its registered npm alias is `automation:autonomous-research-supervisor`. The
route is explicitly provider-costing and locally mutating; its immutable
lifecycle caps, signal behavior, SQLite lease/CAS recovery, and systemd/Kubernetes
hosting contract are documented in
`paper-core/docs/autonomous-research-supervisor.md`.
