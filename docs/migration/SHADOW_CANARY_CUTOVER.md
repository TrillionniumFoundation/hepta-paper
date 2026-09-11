# Shadow, canary, cutover, and retirement

## 1. Shadow

Shadow implementations receive the same immutable input subject as the
authoritative implementation but cannot:

- reserve production external effects unless explicitly read-only;
- write campaign state;
- publish release artifacts;
- affect scheduler calibration until accepted;
- alter the authoritative result.

Comparison binds exact module versions, inputs, resource envelopes, and output
classifications.

## 2. Shadow acceptance

Required by parity class:

| Class | Acceptance |
|---|---|
| exact | zero unexplained byte/hash/state/decision drift |
| semantic | normalized invariant/effect equality; approved representation differences |
| evaluation | metric thresholds and independent review under fixed inputs |
| retire | proof old behavior is unnecessary/unreachable and historical data remains readable |

Performance comparison is separate from correctness and authority.

## 3. Canary

A canary authorization fixes:

```text
module/capability/version
campaign/input scope
maximum actions and cost
start/end/expiry
authority and writer generation
monitoring thresholds
stop and rollback conditions
reviewer/operator identities
```

Canary state is durable. A process restart cannot reset action count, cost, or
expiry.

## 4. Cutover preconditions

- source/host/external evidence current for the exact subject;
- shadow and canary accepted;
- no unresolved P0 risk or active request-changes review;
- exact state/database/workspace preimage;
- old authority quiesced and mechanically fenced;
- new first lease/effect bound to cutover permit;
- backup and restore verified;
- rollback exercised within its valid window;
- observability and on-call ready.

## 5. Cutover transaction

```text
freeze admissions
reconcile all in-flight work
verify old authority stopped
capture exact preimage and registry snapshot
issue short-lived cutover permit
activate new implementation/generation
run bounded read/write or external-action canary
verify state/event/resource/evidence receipts
publish activation record
resume admissions
```

Any identity drift aborts before activation. Ambiguous post-activation outcomes
follow the recovery contract rather than blindly restoring the old authority.

## 6. Rollback

Rollback distinguishes:

- pre-activation: abandon candidate;
- post-activation before irreversible state migration: restore prior version and
  generation through an exact permit;
- post-migration: execute a tested reverse migration or continue forward recovery;
- post-external effect: reconcile externally; never repeat or erase the effect.

Rollback cannot create dual writers.

## 7. Retirement

After the observation window:

- revoke old capabilities and credentials;
- stop/delete old services and schedules;
- remove production imports and configuration;
- retain only approved historical readers/verifiers;
- update module registry, capabilities, risks, and runbooks;
- verify no reactivation path remains.
