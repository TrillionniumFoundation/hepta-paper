# Module lifecycle

## 1. Lifecycle states

```text
registered
  -> contract_ready
  -> source_implemented
  -> conformance_qualified
  -> shadow
  -> canary
  -> authoritative
  -> retiring
  -> retired
```

A module can also be `blocked` or `revoked` from any active state.

Implementation, qualification, activation, and operational health remain
separate fields. The lifecycle above is a deployment decision, not a substitute
for evidence tiers.

## 2. Registration

Registration requires a stable module ID, capability mapping, ownership,
authority class, protocol range, resource/SLO skeleton, and proposed rollback.
No executable is admitted.

## 3. Contract ready

The module has reviewed schemas, semantics, failure/recovery dispositions,
compatibility rules, tests, and acceptance criteria. Implementation may still be
absent.

## 4. Source implemented

Source and deterministic tests exist. This state does not imply exact-head,
installed, target-host, credential, or external-authority qualification.

## 5. Conformance qualified

The exact implementation subject passes:

- schema/golden-vector tests;
- unknown/oversize/malformed input rejection;
- idempotency and replay tests;
- cancellation and crash tests;
- resource envelope tests;
- secret/redaction tests;
- compatibility tests;
- module-specific performance floor;
- ownership/review requirements.

## 6. Shadow

Shadow execution uses copied/read-only inputs and cannot commit central or
external effects. It records comparable outputs, usage, latency, errors, and
quality evidence against the authoritative implementation.

Shadow data is not allowed to alter training/calibration without an explicit
observation policy and data-governance review.

## 7. Canary

A canary has bounded scope:

```text
capability and campaign set
maximum executions/effects/cost
start/end time
module version and deployment generation
monitoring and stop thresholds
rollback version
operator and reviewer authorization
```

A writer/external-effect canary requires atomic mutual-exclusion fencing. A
canary failure stops further admission before rollback/reconciliation.

## 8. Authoritative

Authoritative status requires:

- all prerequisite evidence tiers;
- successful shadow and canary;
- exercised rollback;
- current owner and on-call coverage;
- current SLO/error budget;
- no conflicting authoritative implementation;
- exact registry/deployment/qualification subject;
- central control-plane acceptance.

## 9. Upgrade

Compatible upgrades may use rolling shadow/canary. State/protocol/authority
changes require a migration plan with forward and backward readers, data
preflight, rollback point, and exact disposition for prepared/in-flight work.

A module upgrade cannot reinterpret an already prepared result under new
semantics unless the result explicitly permits that version and is reverified.

## 10. Rollback

Rollback is a first-class transition, not “deploy an old binary.” It binds:

- trigger and decision authority;
- exact current and target versions;
- state/protocol compatibility;
- in-flight command disposition;
- prepared-result handling;
- external-effect reconciliation;
- resource and queue transfer;
- post-rollback verification.

## 11. Retirement

Retirement requires:

- replacement or explicit capability removal;
- no production graph reachability;
- no remaining write/external authority;
- migration/parity evidence;
- retained verification for historical artifacts;
- configuration, credential, service, and queue removal;
- rollback expiry decision.

“Unused” is not retired.
