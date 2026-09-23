# Frozen raw-byte observation contract

`frozen_observation_compat_v1` preserves the distinct earlier Rust diagnostic API
from `codex/global-plan-v1.1-source-closure-20260910`, source blob
`2da20018c57dca72db106966f832be5384c921db`. The existing request-bound production
JSON adapter remains the default exported API; the earlier names are accessible
only inside their explicit compatibility namespace.

The earlier wire hashes arbitrary output bytes, retains the caller's runtime,
entrypoint, planning and parity-policy identities, and binds the complete
prepared receipt to a stable **operation** identity. Reuse with another attempt
or changed claimed evidence is a conflict. Caller-supplied time must lie inside
the observed/expiry interval; its length may be exactly 24 hours. Validation
precedes replay lookup, so an expired exact replay fails. Four observed authority
flags must all be false; all three prepared authority fields remain false.
The original 16 MiB output and 1,024 artifact ceilings are retained.

This is a diagnostic data contract. Runtime/parity identities and the caller's
clock are not independently authenticated. The module never executes Node,
opens files, dispatches providers, or commits state. Its replay map is in memory
and has no independent total-operation quota: callers must bound instance
lifetime and own persistent replay storage. Deserializing a prepared receipt
does not verify or authorize it.

`tests/frozen_observation_compat.rs` compares the full receipt against frozen
outputs produced by executing the original blob. The fixture includes non-UTF-8,
non-JSON bytes. Regressions cover operation replay, runtime/evidence bindings,
exact 24-hour/expiry boundaries, each authority flag, tampered output, size and
artifact-order failures. `tests/fixtures/frozen-observation-compat-v1.json` is the
frozen vector. This validates historical Rust wire preservation, not Node parity
or independent replacement acceptance.
