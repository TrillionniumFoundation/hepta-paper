# External companion revocation and rollback

Status: normative runbook; external execution evidence required

## Revocation triggers

Immediately revoke an accepted external companion subject when any of the following is observed:

- repository, commit, tree, release asset, entrypoint, dependency lock or runtime-image identity changes;
- credential exposure, unexpected credential access, cloud-metadata access or agent-socket access;
- network activity outside the accepted sandbox profile;
- request/response schema drift, unknown fields, duplicate-key acceptance or conformance-vector failure;
- provider account, authority generation, target host, kernel policy or filesystem boundary changes;
- timeout, process death, ambiguous external outcome, duplicate remote result or reconciliation disagreement;
- a newer failed run, failed rerun, expired receipt, revoked signer or evidence-retention failure;
- independent reviewer or provider owner withdraws acceptance.

## Immediate containment

1. Disable new dispatch admission for the affected provider/account/source/credential generation.
2. Increment the durable provider fencing generation before stopping processes.
3. Quarantine all prepared, dispatching and ambiguous records; do not release campaign or submission locks.
4. Remove credential mounts, agent sockets and metadata/network access from the revoked subject.
5. Capture source, process, host, ledger and network evidence before cleanup.
6. Record an append-only `ProviderCompanionRevocationReceipt` binding the trigger and last accepted subject.

A repository label, issue closure, process exit or deleted credential file is not a revocation receipt.

## Ambiguous external effects

Every operation that reached `dispatching` is reconciled under `IDEMPOTENCY_AND_RECONCILIATION.md`. Never resend merely because the local response is absent. `multiple_matches`, unavailable lookup, incomplete provider visibility and invalid remote receipts remain `recovery_required` until independently resolved.

## Rollback target

A rollback target is accepted only when its exact repository, commit, tree, release asset, entrypoint, dependency lock, runtime image, host profile, credential generation and evidence packet are still current and unrevoked. Source equivalence, a matching tag name or an older successful CI run is insufficient.

Rollback order:

```text
fence revoked generation
stop new admission
quarantine unsettled work
reconcile possible external effects
verify rollback source and host subject
install without reusing revoked writable state
run credential-free conformance
run target-host and operational gates
obtain provider-owner and independent acceptance
atomically activate the new generation
prove the revoked generation cannot re-enter
```

If no accepted rollback target exists, remain stopped. Availability pressure does not authorize an unqualified provider.

## Credential response

Credential compromise requires provider-side revocation, local custody revocation, rotation to a new generation, stale-generation denial probes and independent confirmation. Rotated credentials are never injected into the credential-free sandbox qualification. Secret values are not written to repository evidence; only approved opaque identities and lifecycle receipts are retained.

## Recovery evidence

The retained recovery packet includes:

- revocation trigger and timestamp;
- exact old and new source/host/credential generations;
- fencing transition and stale-generation denial results;
- complete affected operation inventory;
- authoritative reconciliation receipts;
- cleanup and residual-process checks;
- credential/provider-side revocation confirmation;
- rollback conformance, target-host and operational results;
- provider-owner and independent reviewer signatures;
- evidence retention location and digest.

## Roll-forward

A repaired release is a new subject. It reruns the complete acceptance kit and may not inherit a prior source review, host receipt, provider-owner decision, credential approval, reconciliation result or production authorization.

## Prohibited shortcuts

Do not:

- turn a missing external companion into a skipped success;
- substitute the repository portable companion for the authoritative sibling;
- classify a no-effect technical response as provider acceptance;
- delete ambiguous ledger rows or rewrite them as rejected;
- reuse a revoked credential or fencing generation;
- restore an old writer/provider generation without fresh acceptance;
- use administrator permission, fixture signatures or local tests as independent evidence;
- claim release, submission or production authority from this runbook.
