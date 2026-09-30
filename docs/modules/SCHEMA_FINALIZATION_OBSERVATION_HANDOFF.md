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

## Durable v1 observation after finalization

`prepare_schema_transition_observation_v1` consumes the existing prepared
finalization owner only after its signed receipt is durably present. It keeps the
same root-inode maintenance lock, re-verifies the reservation/finalization and
actual ten-database post-state, generates a fresh bounded nonce, and writes one
closed `observationProgress` record to the same normalization CAS journal before
any authority RPC. Version 2 remains fail-closed at the independently owned
target-configuration restart boundary.

The caller independently retains both finalization and observation request
hashes. `observe_prepared_schema_transition_v1` may send only the persisted exact
request. An interruption after RPC leaves a null receipt and therefore an unknown
result, not permission to choose another nonce/time or reconstruct the request.
A retry sends the identical request. Only a receipt verified by the pinned
observation contract can fill the durable slot; an error after publication does
not erase it.

`resume_schema_transition_observation_v1` requires transition, plan,
finalization-request and observation-request pins. The observation pin is checked
before filesystem access. Recovery rebuilds the installed post-state from the
original signed preimages, verifies the historical finalization and current
configuration, and rejects missing/extra progress fields, substituted requests,
forged receipts, changed installations/business rows or journal CAS drift. A
recorded observation replays without RPC or a clock. That replay is historical
evidence and is never presented as a fresh unexpired readiness observation.

## Durable v2 target-configuration restart boundary

A version-2 finalization cannot reuse the source authority as proof that the
target configuration is active. `prepare_schema_target_configuration_restart_v2`
therefore retains the same root lock and verified ten-database post-state, checks
the signed finalization's distinct target-configuration hash, and persists one
closed `targetRestartObservationProgress` record in the existing normalization
CAS journal before any external restart or authority RPC. The request/hash,
source and target configuration hashes, finalization receipt and plan are all
cross-bound. Preparation does not control a service manager.

The installed restart owner may stop/start the authority only outside this
module. After that action, `observe_restarted_schema_transition_v2` accepts a
separately pinned target authority only when authority/key/scope/database/writer
identity still agrees with the source history and the exact target configuration
selected by finalization. It sends the durable observation request and requires a
signed `authorityConfigurationActivated=true` receipt. A transport loss does not
repeat stop/start or mint a new request: recovery reopens the exact retained
intent and retries only the idempotent observation. A recorded receipt replays
without RPC, clock or SQL installation.

`resume_schema_target_configuration_restart_v2` requires independently retained
transition, plan, finalization-request and target-observation-request hashes.
Substituted target configuration, source drift, altered journal bytes, changed
business state, wrong trust, malformed receipt and missing pins fail before a
target RPC. Real process-exit regression coverage proves the intent survives a
client death before that RPC.

`publish_restarted_schema_transition_observation_v2` builds the audit from the
held source history and target-signed observation, drops the live owner,
re-observes all ten databases and publishes the existing historical `FINAL.json`.
The Node audit has a fixed `databaseGenesis` property order; the final-receipt CAS
owner now accepts only caller-retained bytes that parse exactly to the verified
closed value, writes those exact bytes under its existing lock/no-clobber policy,
and checks exact byte/digest readback. This preserves the incumbent signed wire
identity without allowing raw bytes to choose another receipt.

This boundary proves only the recorded target authority observation. It does not
supply service-manager credentials, install the ordinary execute entry, run a
canary, prove rollback, fence a live legacy Node writer or authorize release,
submission, production activation or retirement.

## Final receipt and activation remain distinct

`build_schema_transition_finalize_request_v1` and
`build_schema_transition_observe_request_v1` remain the exact Node protocol
builders. `observe_schema_transition_post_state_v1` checks actual inventory and
schema bindings, recomputing the v2 pristine hash where applicable. The durable
v1 finalization/observation owners additionally retain full business post-state
and request identity; passive schema inspection alone is not that proof.

`publish_prepared_schema_transition_observation_v1` now feeds the existing
[final-receipt publication contract](SCHEMA_FINAL_RECEIPT_PUBLICATION_HANDOFF.md)
directly from the durable owner. Callers supply only the independently retained
plan hash, manifests and optional previous-file hash; they cannot splice raw
reservation/finalization/observation JSON. The function verifies the complete
historical audit while holding the original root owner, releases that owner,
re-observes all ten databases, then uses the existing no-clobber `FINAL.json`
repository. Exact replay returns the already-published file without another RPC.
This historical publication still does not activate a runtime or create a fresh
readiness receipt. V2 uses the durable target-configuration observation owner
above; no source-config receipt, manager report or caller Boolean substitutes for
the target authority's signed observation.

The ordinary schema execute CLI still requires the installed owner. These are
source-level continuations of the existing installation/finalization owners, not
an alternate product launcher. The actual installed service-manager transaction,
writer transfer, canary, rollback, old-Node-writer fencing and independent
acceptance remain open.

## Executable verification

The canonical source producer binds these implementations and the nested
`schema_installation_parity::finalization_recovery` regressions. They use the
normal planner, signed reservation, normalization and actual ten-database
installer before finalization. The Node completion contract and ephemeral
signature fixtures are explicit local peers, not independently installed service
principals. Tests exercise finalization and observation request preservation, uncertain
replies, durable receipt errors, real client process exit before source and target
RPCs, altered pins/journals/business rows/configurations, no reinstall or repeated
restart, exact-request retry, offline historical replay, direct audit assembly,
exact Node-wire CAS bytes and idempotent `FINAL.json` publication without
caller-provided signed records.

```sh
cargo test --manifest-path rust/Cargo.toml --locked --all-features -p hepta-paper-service --test schema_installation_parity
cargo test --manifest-path rust/Cargo.toml --locked --all-features -p hepta-paper-service --test online_schema_transition_parity --test finalization_publication
```

The positive live-clock installation fixture requests its authority's existing
300000 ms maximum rather than implicitly imposing a 60000 ms performance target
on a shared builder. Production defaults and commit margins are unchanged;
explicit expiry/clock-failure regressions retain the narrower original window.
No timing result or local test constitutes target-host performance acceptance.
