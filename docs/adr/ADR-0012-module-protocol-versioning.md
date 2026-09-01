# ADR-0012: version module protocols with explicit N/N-1 declarations

Status: **accepted as the current target decision; implementation and qualification remain gated**

## Context

Dozens of independently delivered modules require compatibility without
silently accepting unknown semantics or supporting every historical version
forever.

## Decision

Every protocol object has an explicit schema version, kind, bounded canonical
encoding, and unknown-field policy. The registry declares each module's minimum
and maximum supported protocol versions. N/N-1 compatibility is required only
where the capability rollout policy declares it; breaking behavior creates a
new version, migration plan, golden vectors, and retirement gate.

Historical canonical V1 encodings remain immutable. Transport changes do not
change semantic object hashes.

## Consequences

Rolling upgrades are possible without indefinite compatibility. Unsupported
version combinations fail before execution. Generated Rust, TypeScript, and
Python bindings are checked against shared vectors.

## Adoption gates

Schema compatibility, mixed-version canary, rollback, unknown-field, and stale
version tests must pass before multi-version deployment.
