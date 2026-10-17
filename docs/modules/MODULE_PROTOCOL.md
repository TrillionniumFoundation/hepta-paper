# Module protocol V1

## 1. Design goals

The protocol supports independently implemented Rust, Node, Python, or external
modules while preserving bounded messages, exact identity, idempotency,
cancellation, resource accounting, and single-writer integration.

The protocol describes four phases:

```text
plan candidate
admit and execute
prepare and verify
commit or reconcile
```

A module may implement only the phases required by its capabilities.

## 2. Common envelope

Every protocol object contains:

```text
schemaVersion
kind
requestId
createdAt
expiresAt
repository/source subject where relevant
moduleId
moduleVersion
protocolVersion
traceId
```

Unknown fields fail by default. Size, collection, string, recursion, and time
bounds are enforced before allocation or trust.

## 3. Planning request

`PlanningRequestV1` binds:

```text
planningRequestId
stateSnapshotHash
capabilityId
goal and policy references
hardConstraintSetHash
objectiveVersion
resourcePriceSnapshotHash
candidateLimit
deadline
allowedSideEffectClasses
inputArtifact references
```

It contains no central-writer handle, provider credential, release credential,
or unbounded manuscript/log content.

## 4. Action candidate

`ActionCandidateV1` contains:

```text
candidateId
planningRequestId
stateSnapshotHash
module identity
capabilityId
preconditions
dependency effects
resource vector
expected duration with bounds
expected monetary/token cost with bounds
expected scientific value
expected evidence gain
failure probability and confidence
side-effect class and irreversible boundary
rollback class
candidate expiry
input/output schema references
candidate payload hash
```

### Candidate rules

- candidates must be feasible under their own declared local constraints;
- candidates must not assume central resources that are not declared;
- semantically duplicate candidates are canonicalized or rejected;
- candidate count and total bytes are hard bounded;
- dominated candidates may be removed by a deterministic Pareto reducer;
- module priority is not global priority;
- predicted value is not evidence of achieved value;
- a singleton response includes a reason such as `only_feasible_candidate` or
  `protocol_does_not_support_alternatives`.

## 5. Execution command

`ExecutionCommandV1` binds:

```text
executionId
planHash
selectedCandidateHash
stateSnapshotHash
campaign/node/attempt IDs
lease and writer generation
resourceReservationId and exact envelope
workspace/input/output identities
qualified module runtime identity
deadline and cancellation channel
authority capability audience
idempotency key
```

A module rejects execution when the command is expired, duplicated with a
conflicting identity, outside its protocol range, or inconsistent with the
candidate it produced.

## 6. Execution events

Events are bounded and ordered:

```text
accepted
started
progress
external_effect_intent_observed
external_effect_may_have_started
prepared
failed_pre_effect
failed_post_effect_ambiguous
cancelled_pre_effect
terminal
```

Unknown terminal-like events fail closed. Progress events are advisory and may
be sampled; terminal facts and hashes are durable.

## 7. Prepared result

`PreparedResultV1` contains:

```text
executionId and idempotency key
plan/candidate/snapshot identity
module runtime identity
attempt/lease/generation identity
terminal disposition
provider/external-effect classification
output schema and canonical payload hash
artifact/CAS inventory
workspace mutation inventory
usage and cost settlement
scientific/evidence references
verification requirements
integration command proposal
recovery metadata
```

It grants no central write or release authority. The verifier may reject it or
produce a separate `VerifiedPreparedResultV1`.

## 8. Verification result

`VerifiedPreparedResultV1` binds independent checks:

```text
schema verification
module identity and qualification
resource settlement
artifact and workspace inventory
policy and authority constraints
evidence class and producer independence
compatibility/differential result
staleness and plan-subject checks
verifier identity and version
```

The verifier cannot silently repair an untrusted result. Any normalization that
changes semantics creates a new versioned result and hash.

## 9. Commit command and receipt

Only the control plane may construct a `CommitPreparedResultV1`; only the commit
sequencer may accept it.

The command binds:

```text
verifiedPreparedResultHash
expected campaign revision
expected node attempt and lease generation
expected writer generation
resource settlement identity
plan hash and snapshot hash
policy/objective version
idempotency key
```

The receipt records whether the result was committed, already committed,
rejected as stale/conflicting, or left for manual reconciliation.

## 10. Cancellation and recovery

Cancellation is identity-bound and idempotent. A cancellation acknowledgement
must distinguish:

```text
cancelled_before_execution
cancelled_before_external_effect
external_effect_may_have_started
prepared_result_already_exists
terminal_already_committed
unknown_requires_reconciliation
```

A timeout is never proof that execution did not occur.

## 11. Transport profiles

V1 supports:

- in-process typed values for trusted deterministic components;
- bounded Unix-domain framed transport for local isolated services;
- file/CAS handoff for large immutable artifacts;
- externally signed request/receipt exchange for independent authorities.

The same semantic object and canonical hash must be transport-independent.

## 12. Compatibility

- Protocol objects carry explicit schema versions.
- Readers reject unknown required semantics.
- N/N-1 support is required only where declared in the module registry.
- A breaking change requires a new schema version and migration/retirement plan.
- Exact historical V1 encoding remains immutable.

Canonical schema paths:

- `docs/modules/schemas/module-manifest-v1.schema.json`
- `docs/modules/schemas/action-candidate-v1.schema.json`
- `docs/modules/schemas/prepared-result-v1.schema.json`
