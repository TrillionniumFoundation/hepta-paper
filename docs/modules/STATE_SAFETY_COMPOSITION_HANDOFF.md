# Passive state-safety composition handoff

This module implements the passive `inspectAutonomousResearchStateSafety` composition in `paper-composition/automation/autonomous-research-state-safety-inspection.mjs`. It is a native observation pipeline, not a supervisor activation or permission API.

## Entry point and actual inputs

`state_recoverability::safety_inspection::inspect_autonomous_research_state_safety_v1(&StateSafetyInspectionOptionsV1) -> Result<Value>` takes workspace, runtime and working-directory paths, an explicit canonical millisecond instant, and an environment string map. Only these three environment entries are read:

- `HEPTA_AUTONOMOUS_RESEARCH_STATE_BACKUP_AUTHORITY_CONFIG`
- `HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_PROCESS_CONFIG`
- `HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_CONFIG`

They select files; their values never carry JSON readiness, signatures, cached authority objects or injectable coordinators. Empty values preserve the incumbent's unconfigured behavior. Relative paths resolve lexically against the supplied working directory; safe file readers independently reject symlinks and changed identities.

The state-database manifest is read from the actual selected workspace at `paper-core/config/autonomous-research-state-databases.v1.json`. The shared source-manifest reader accepts the existing public checkout mode while refusing aliases, devices, hardlinks, duplicate JSON keys, oversize input and replacement during reading. Actual inventory returns a descriptive blocked report for incomplete state; only a second opaque `ObservedStateDatabaseInventoryV1`, checked equal to the original observation, can reach authority and coordinator composition.

The backup configuration is opened and held before its exact raw-byte pin is computed. Its pinned public key, executable, and version-two embedded online trust are loaded through the existing cryptographic clients and retained for rechecks. No environment hash substitutes for the observed file. Version-one configuration supports passive signed snapshot inspection; this does not expand the separate CLI's stricter write policy.

## Observation pipeline and failure projection

1. Compose the actual backup reader, then inspect real inventory. Composition/read exceptions preserve the original `autonomous_research_state_database_inventory_inspection_failed:` prefix and report shape.
2. If backup trust is absent, retain the original `autonomous_research_state_restore_authority_trust_configuration_required` override. The original source resolver returns before backup filesystem IO in this case. When configured, enumerate the actual backup namespace, sort candidates by mtime and the production collator, inspect manifest and restore receipt bytes, verify backup signatures and bindings, and read/hash/inspect all stored SQLite databases. Ordinary no-bundle and no-valid-candidate reports preserve the original blocked-source shape and candidate count. Unexpected errors preserve `autonomous_research_state_latest_restore_drill_inspection_failed:`. The reader never creates backup directories or publishes a receipt.
3. With a ready opaque inventory and a selected process configuration, validate its complete process schema, executable and exact dependency pins. Compose the fixed original 134-operation/486-statement registry through `compose_configured_online_mutation_coordinator_v1`. Retain only its genuine configured status. The root-owned wrapper exposes no executable coordinator. Native and original configured status remain blocked on runtime activation.
4. With a ready opaque inventory and a selected public authority configuration, read the actual cache, scan actual source through Oxc, load and pin the actual public key, verify all three current-head/challenge/broker-scope signatures and their requests, source provenance and database scope. A no-follow actual absence observation preserves the original cache-missing diagnostic before source/configuration loading. Present unsafe paths retain the native reader's refusal.
5. Evaluate the existing diagnostic state-safety contract and append `restoreAuthorityConfigured`, `restoreAuthorityConfigurationHash`, and `onlineMutationCoordinatorStatus`. Coordinator and online-inspection failures preserve their original prefix, blocker sorting/deduplication and fallback metadata.

Both native authority transports reject every attempted invocation with `autonomous_research_state_safety_passive_rpc_forbidden`. The configured-process executable is validated but never spawned. No mutation, startup repair, schema migration, renewal, active challenge, resident journal write, cache write, bundle publication or external process call occurs in this API. Cache generation and backup creation in tests are separate, explicitly active fixture preparation.

## Security and compatibility boundaries

A returned `Value` is a point-in-time diagnostic report. It cannot create a recoverability epoch, runtime activation capability or mutation permit. File identities and signatures are rechecked at the consuming observation boundaries; this is not an atomic distributed snapshot across all files and the external authority.

The native source verifier intentionally retains stronger checks already shipped by the preceding batches: safe private file modes and bounded input, exact database namespace, actual SQLite schema/integrity, live inventory binding, and restore age. Some old Node historical-source or unsafe-input edge cases therefore refuse earlier or with a native leaf error while keeping the original composition-level prefix and metadata. No error translation converts a refused path into a ready result. Full behavioral equivalence for every legacy unsafe/malformed input is not claimed.

This closes the passive state-safety composition gap only. Other readiness observers and the complete resident/supervisor/activation composition remain separate work. This library entry point is not yet a production daemon route and does not claim the entire project is Rust-only.

## Integration

The public entry point is
`state_recoverability::safety_inspection::inspect_autonomous_research_state_safety_v1`.
Its private source selector is `safety_inspection/sources.rs`; it shares the
scoped, file-safe `cli/inputs.rs` helpers with the backup command. It consumes the
fixed online mutation composition and retains its authority/process observations.
The Node oracle is `rust/oracle/state-safety-composition-v1.mjs`, used only by
`tests/state_safety_composition_parity.rs`. This library adds no production
process invocation or activation route.

## Validation

All three real-file original-Node differential groups passed in 2,080.67 seconds with zero failures and process exit zero in the isolated `work/backup-cli/check-safety` workspace (`/tmp/hepta-safety-final.log`). The fixture copies actual repository scan/import/migration sources, uses ten SQLite files and test-only Ed25519 authorities, generates cache evidence through three real authority subprocess invocations, and creates a real signed backup and isolated restore drill. It compares full passive report structures and checks that subsequent native/original passive calls append nothing to either authority process log.

The passing groups cover absent/configured backup and process/public authority configuration, actual missing databases, real configured coordinator metadata, complete Oxc scan, valid signed backup/drill and all three signed cache receipts, missing process configuration, ignored forged environment readiness JSON, independent tampering of each signature, expiry, corrupted stored database bytes, and an unregistered real writer source. Malformed selected configurations, duplicate JSON, unsafe modes/aliases, unsafe cache parents, and passive version-one backup trust are also covered. No production keys or authority endpoints are used. Strict Clippy for the library and this integration target passed (7.97 seconds, `/tmp/hepta-safety-final-clippy.log`), and the Node oracle passed ESLint (`/tmp/hepta-safety-eslint.log`).

The baseline uses the original repeated full-AST currentness implementation plus the separately validated fixed-literal regex changes. Its complete successful native inspections took 343–361 seconds; the observed Node report comparison took roughly two additional seconds. A complete-input proof optimization is maintained and validated as a separate slice, with separate source hashes and consumer-combination logs. The baseline result above is not substituted for validation of that optimized composition.
