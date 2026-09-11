# Provider idempotency and reconciliation contract

Status: normative contract; no production provider is authorized

## Scope

This contract applies to any future provider adapter capable of an irreversible or externally visible action. The credential-free sandbox companion performs no such action and therefore cannot satisfy this contract by returning `externalActionPerformed:false`.

## Canonical operation identity

The caller derives one idempotency key from the canonical tuple:

```text
protocol version
provider and account identity
paper identity
package hash
dispatch-authorization hash
operation kind
exact provider implementation commit/tree/entrypoint hash
credential generation
target environment generation
```

The key is a lowercase SHA-256 identity over canonical bytes. The complete canonical request bytes are durably stored before transmission. Reuse of a key with non-identical request bytes, subject identity, provider account, method or authority generation is rejected as `provider_idempotency_conflict` before an external call.

## Durable state machine

```text
absent
  -> prepared
  -> dispatching
  -> accepted | rejected | ambiguous
ambiguous
  -> reconciled_accepted | reconciled_rejected | recovery_required
accepted | reconciled_accepted
  -> revoked | settled
```

Every transition is append-only, hash chained, timestamped and fenced by the active writer/provider generation. A timeout, transport reset, process death, response parse failure or lost local acknowledgement after dispatch yields `ambiguous`; it never becomes `rejected`, retryable absence or success by assumption.

## Retry rules

- Before `dispatching`, an exact duplicate may return the existing prepared record.
- During or after `dispatching`, the same key must not create a second blind submission.
- A retry first performs authoritative remote lookup using the same provider account and idempotency key or provider-supported correlation identity.
- A new key is required when package bytes, dispatch authorization, provider/account, method, source subject, credential generation or environment generation changes.
- Automatic retries are bounded by configured attempt count, elapsed time and reconciliation budget. Exhaustion yields `recovery_required`.
- Client-side HTTP status alone is not proof of remote non-execution.

## Authoritative reconciliation

Reconciliation queries the provider's authoritative system and returns one of:

```text
not_found
accepted(remoteSubmissionId, immutableReceipt)
rejected(providerReason)
multiple_matches
unavailable
```

`not_found` is accepted as non-execution only when the provider owner has independently documented and tested the lookup's completeness window and the observation occurs after that window. `multiple_matches` and `unavailable` remain ambiguous.

An accepted reconciliation receipt binds:

```text
idempotency key
canonical request hash
provider/account identity
remote submission identity
provider receipt hash
query method and endpoint identity
credential generation
implementation and runtime identity
observation time and validity window
prior ambiguous record hash
```

The receipt is independently verified before campaign or release state changes. Local database presence, a sandbox self-declaration, log text, a screenshot or a mutable portal page is insufficient.

## Concurrency and fencing

Only one active provider generation may dispatch a given operation identity. Admission requires a durable lease with monotonically increasing fencing token. Stale processes may read but cannot dispatch, reconcile, revoke or settle. Writer/provider generation transfer is atomic with respect to the idempotency ledger.

## Retention and audit

Prepared requests, all attempts, raw bounded responses, remote receipts, reconciliation queries, revocations and settlement records are retained under the applicable immutable evidence policy. Redaction removes secret bytes but preserves hashes, identities, timestamps, dispositions and chain continuity. Evidence is never deleted merely because rollback succeeds.

## Failure codes

At minimum the implementation exposes typed, bounded failures for:

```text
provider_idempotency_conflict
provider_dispatch_ambiguous
provider_reconciliation_not_found_unqualified
provider_reconciliation_multiple_matches
provider_reconciliation_unavailable
provider_fence_stale
provider_receipt_invalid
provider_recovery_required
```

## Acceptance

Positive qualification must exercise duplicate exact requests, conflicting reuse, timeout before and after remote acceptance, process death, delayed provider visibility, duplicate remote matches, credential rotation, stale-fence attempts and recovery after restart. Tests require an actual provider-owned sandbox and authoritative lookup path; repository fixtures cannot close this contract.
