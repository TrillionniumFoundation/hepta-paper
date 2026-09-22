# Autonomous supervisor health handoff

## Scope

`hepta-autonomous-supervisor-health` is a read-only native Rust replacement for the incumbent resident supervisor liveness command's first three modes:

- base liveness (`healthy`);
- `--require-startup-reconciliation` (`startupReady`);
- `--require-machine-intake-reconciliation` (`ready`, matching the incumbent's status gate).

Those base modes inspect `autonomous-research/supervisor/resident-instance.sqlite` below the selected runtime root. It never probes a process, sends a signal, opens the live source through SQLite, or writes runtime state.

## Snapshot and race boundary

The implementation delegates path traversal and source observation to `state_database_inventory`: every ancestor and database sidecar is opened with descriptor and no-follow checks, and file identity, permissions, size, and SHA-256 are rechecked after the read. The health query runs against a private mode-0600 copy in a mode-0700 random temporary directory. The incumbent opens the resident database read-only without WAL recovery; therefore the native health query copies the main file while pinning and rechecking `-wal`, `-shm`, and `-journal` sidecars. A sidecar that violates the native private-file policy blocks the inspection.

A missing database or empty resident table reports the incumbent missing-instance blocker. A stopped or malformed row remains unhealthy. Lease timing, receipt/hash pairings, currentness, and the 30-second future-heartbeat tolerance are checked against canonical ECMAScript ISO instants; no caller-supplied JSON can create a status row.

## CLI contract and open work

Help JSON, strict option errors, default runtime-root resolution, report status and exit classes match the incumbent for the three base modes. `--require-current-machine-intake` additionally observes the actual builtin V1 intake configuration/static files and private intake database, then compares the current configuration and dataset identity with the resident. Its [detailed implementation contract](../../rust/crates/hepta-paper-service/src/machine_intake/HANDOFF.md) specifies resource closure, hashes, ownership, size bounds, supported inputs and compatibility limits. V2/plugin/local-golden scoped intake evidence remains explicitly blocked; `--require-strict-machine-intake-reconciliation` now composes actual intake with the [native strict receipt reader](../../rust/crates/hepta-paper-service/src/strict_machine_intake_reconciliation/HANDOFF.md). It preserves the original strict exit criterion, including its distinction from resident readiness, but explicitly rejects the incumbent falsy-JSON false-ready cases. `--require-fully-autonomous` remains unsupported until its native prerequisite chain exists.

The differential test uses a real Node-created SQLite row with a fixed lease token and covers startup/machine transitions, stopped and empty states, safe and malformed WAL sidecars, unsafe permissions, invalid timing, and CLI parse errors. Host-level process probes and independent production qualification remain outside this module.

## External qualification configuration prerequisite

The native [V3 external qualification configuration reader](../../rust/crates/hepta-paper-service/src/external_qualification_configuration/HANDOFF.md) is a separately callable prerequisite producer. It observes actual configuration, executable/interpreter/argument files, filtered environment, bounded credential contents and independent public signer trust. Its complete original-format inspection is derived from that owned observation. It does not execute qualifier/verifier commands, publish qualification receipts, or make `--require-fully-autonomous` available. Configuration credential roots can contain sensitive bytes by the incumbent contract; tests use only private owned fixtures with nonsecret text and public keys. The separately callable [stored qualification readers](../../rust/crates/hepta-paper-service/src/qualification_stored_evidence/HANDOFF.md) now validate the actual pointer authority/mirror and V4 state data, including effective committed WAL. These are completed data observations, not current signed acceptance. The complete resident composition still needs to integrate these readers with current runtime-image/code observations and envelope checks, plus independently configured recovery-purpose trust. The original recovery adapter currently supplies a release-attestor V3 signer and a KeyObject to a contract requiring a distinct recovery role and PEM string; conversion or relabeling alone is not authority.
