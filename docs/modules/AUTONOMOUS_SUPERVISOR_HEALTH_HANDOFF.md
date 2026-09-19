# Autonomous supervisor health handoff

## Scope

`hepta-autonomous-supervisor-health` is a read-only native Rust replacement for the incumbent resident supervisor liveness command's first three modes:

- base liveness (`healthy`);
- `--require-startup-reconciliation` (`startupReady`);
- `--require-machine-intake-reconciliation` (`ready`, matching the incumbent's status gate).

The command inspects only `autonomous-research/supervisor/resident-instance.sqlite` below the selected runtime root. It never probes a process, sends a signal, opens the live source through SQLite, or writes runtime state.

## Snapshot and race boundary

The implementation delegates path traversal and source observation to `state_database_inventory`: every ancestor and database sidecar is opened with descriptor and no-follow checks, and file identity, permissions, size, and SHA-256 are rechecked after the read. The health query runs against a private mode-0600 copy in a mode-0700 random temporary directory. The incumbent opens the resident database read-only without WAL recovery; therefore the native health query copies the main file while pinning and rechecking `-wal`, `-shm`, and `-journal` sidecars. A sidecar that violates the native private-file policy blocks the inspection.

A missing database or empty resident table reports the incumbent missing-instance blocker. A stopped or malformed row remains unhealthy. Lease timing, receipt/hash pairings, currentness, and the 30-second future-heartbeat tolerance are checked against canonical ECMAScript ISO instants; no caller-supplied JSON can create a status row.

## CLI contract and open work

Help JSON, strict option errors, default runtime-root resolution, report status and exit classes match the incumbent for the three supported modes. `--require-current-machine-intake`, `--require-strict-machine-intake-reconciliation`, and `--require-fully-autonomous` are explicitly rejected as unsupported until their dependent Rust evidence chains are complete; they must not be represented by a synthetic `ready: false` result.

The differential test uses a real Node-created SQLite row with a fixed lease token and covers startup/machine transitions, stopped and empty states, safe and malformed WAL sidecars, unsafe permissions, invalid timing, and CLI parse errors. Host-level process probes and independent production qualification remain outside this module.
