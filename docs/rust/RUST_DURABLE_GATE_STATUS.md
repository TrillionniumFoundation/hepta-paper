# Rust durable pre-exec gate status

Status: source implementation complete; independent and installed-host
qualification pending.

## Implemented

- stopped Rust gate in a fresh Linux session/process group;
- exact gate, target, envelope, process-start and boot identity;
- atomic SQLite process linkage plus `process_spawned` projection;
- separate durable release authorization;
- exact target-object execution through an opened file descriptor;
- inherited non-stdio descriptor closure;
- bounded termination and process-group cleanup;
- startup reconciliation before listener Ready;
- ambiguity-to-new-attempt retry classification;
- local-fixture and separate-owner production authority modes;
- schema-v2 integrity checks and fault injection.

## Deterministic evidence

The source suite covers pre-release non-execution, commit/release transaction
faults, replacement resistance, blocked/released/absent/orphaned recovery,
identity mismatch, FD leakage and new-attempt recovery disposition.

The exact qualification commit and workflow run IDs must be added after the
branch is pushed and all protected checks complete.

## Remaining qualification gates

- independent review of the low-level Linux process primitive;
- root/deployment-controlled gate and schema owners distinct from broker UID;
- ACL, mount, immutable deployment and service-manager evidence;
- host restart and broker-crash drill against the installed service;
- authenticated Codex provider completion under separate author/reviewer homes;
- external release/submission authorities where applicable.

Until those records exist, the implementation remains unavailable to real
provider composition even when all source checks are green.
