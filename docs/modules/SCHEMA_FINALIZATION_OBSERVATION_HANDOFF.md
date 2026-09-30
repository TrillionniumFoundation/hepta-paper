# Rust schema finalization and observation

The existing request builders and pinned receipt verifier remain the protocol
owners. Finalization is an external authority operation, not a runtime activation,
release, submission, scientific acceptance or Node-retirement permission.

## Durable v1 finalization after real installation

`prepare_schema_transition_finalization_v1` consumes the actual
`InstalledSchemaMaintenanceV1`. It retains the same root-inode maintenance lock
while closing the installation SQLite transactions and observing their committed
post-state. All business rows are compared with the deterministic target derived
from the original signed normalized preimages; schema hashes and serialized
installation flags alone are insufficient. The root owner outlives the database
and private expected-state owners.

Preparation writes one closed version-1 `finalizationProgress` record through the
existing `NORMALIZATION.native.v1.json` CAS repository. It includes the exact
finalize request, its domain-separated hash and a null receipt. This operation
performs no authority RPC. Its opaque return object is neither deserializable nor
mutable through a public projection. The caller must independently retain
`request_hash()` before invoking `finalize_prepared_schema_transition_v1`.

The completing call rechecks the current authority, actual post-state and exact
journal preimage, then sends the original request. It persists only a verified
signed finalization receipt. A transport failure or interruption between RPC and
publication retains the request with an unknown result; it does not erase the
intent, select another completion timestamp, renew a lease or rerun SQL work.
After durable receipt publication, an error does not undo the recorded result.

`resume_schema_transition_finalization_v1` requires independently retained
transition, plan and request hashes. Malformed pins fail before source access.
Missing intent, unknown record fields, changed requests, installations, private
preimages, business rows, pinned authority or historical signatures fail closed.
It reconstructs the original post-state proof by replaying the existing SQL in
private memory copies, without live installation writes or a new reservation. Installation recovery refuses to re-enter once a finalization
intent exists. A recorded receipt replays without RPC or a new clock demand.

For an unknown response, only the identical selected finalize request can be
retried. The incumbent authority protocol handles this idempotently, including
returning an already stored result after lease expiry. A returned receipt must
still prove finalization within the original reservation; no retry extends it.
External service linearizability, current trust distribution and real installed
principal qualification are separate requirements, not supplied by this journal.
An operator who lost the independent request pin cannot silently adopt a pin from
the untrusted progress file through the recovery API.

## Observation, final receipt and activation remain distinct

`build_schema_transition_finalize_request_v1` and
`build_schema_transition_observe_request_v1` retain the exact Node protocol
bindings. `observe_schema_transition_post_state_v1` checks actual inventory and
schema bindings, recomputing the v2 pristine hash where applicable. Durable v1
finalization additionally verifies full business post-state from signed
preimages; the passive schema observer alone is not that proof.

The new durable finalization boundary does not persist observation intents or
publish `FINAL.json`. The existing [final-receipt publication contract](SCHEMA_FINAL_RECEIPT_PUBLICATION_HANDOFF.md)
continues to require the independent observation and all historical signatures.
The observation nonce must be persisted before an external call. V2 remains
explicitly target-configuration-restart-required; no source-config receipt or
caller boolean supplies the missing restart proof.

The ordinary schema execute CLI still requires the installed owner. This is a
source-level continuation of its existing installation/finalization owners, not
an alternate product launcher or a claim of installed migration/canary/rollback,
old-Node-writer fencing, independent role/billing acceptance or full route parity.

## Executable verification

The canonical source producer binds these implementations and the nested
`schema_installation_parity::finalization_recovery` regressions. They use the
normal planner, signed reservation, normalization and actual ten-database
installer before finalization. The Node completion contract and ephemeral
signature fixtures are explicit local peers, not independently installed service
principals. Tests exercise request preservation, uncertain replies, durable
receipt errors, real client process exit, altered pins/journals/business rows,
no reinstall, and offline replay after the original lease expires.

```sh
cargo test --manifest-path rust/Cargo.toml --locked --all-features -p hepta-paper-service --test schema_installation_parity
cargo test --manifest-path rust/Cargo.toml --locked --all-features -p hepta-paper-service --test online_schema_transition_parity --test finalization_publication
```

The positive live-clock installation fixture requests its authority's existing
300000 ms maximum rather than implicitly imposing a 60000 ms performance target
on a shared builder. Production defaults and commit margins are unchanged;
explicit expiry/clock-failure regressions retain the narrower original window.
No timing result or local test constitutes target-host performance acceptance.
