# External provider revocation and rollback checklist

## Scope

This checklist governs an externally owned provider companion after source, host and sandbox-account qualification. It is not an authorization to deploy, hold credentials, submit a paper, release an artifact or perform a portal action. Every checked item must be backed by evidence from the actual external owner and target environment.

## Revocation triggers

The provider owner must be able to revoke the companion when any of the following occurs:

- source commit, tree, executable, dependency lock or build recipe differs from the accepted manifest;
- host identity, service unit, filesystem, network or cgroup profile differs from the accepted target profile;
- provider credentials are rotated, exposed, disabled, scope-expanded or no longer attributable to the accepted owner;
- provider endpoint, API version, portal workflow, terms, schema or idempotency behavior changes;
- the receipt chain, durable state, clock source or audit sink is unavailable or inconsistent;
- an operation is duplicated, ambiguous, unreconciled, externally disputed or outside its authorization window;
- independent review, release approval, submission approval or production authority expires or is withdrawn;
- monitoring detects unexpected network destinations, descendant processes, writable source, privilege change or policy bypass.

An unknown trigger is treated as potentially revoking until independently classified.

## Immediate revocation actions

A revocation procedure must demonstrate all of the following in order:

1. prevent admission of new operations before changing credentials or binaries;
2. atomically advance the companion fencing generation;
3. deny every process holding the previous generation;
4. mark prepared and reconciled-absent operations as revoked;
5. retain send-started and ambiguous operations for authoritative reconciliation;
6. prevent automatic retry while revocation is active;
7. remove or disable credential access for the revoked service identity;
8. stop the complete process cgroup, including descendants;
9. seal runtime directories and preserve evidence according to retention policy;
10. emit a revocation receipt linked to the last accepted receipt chain;
11. notify the independent provider owner, release authority and evidence owner;
12. verify that no new provider-side object appeared after the revocation boundary.

Stopping a local process alone is not proof that a remote operation was absent or rolled back.

## In-flight operation disposition

Every operation present at revocation receives one explicit disposition:

```text
never_sent_revoked
remote_present_preserved
remote_absent_revoked
remote_ambiguous_manual_reconciliation
remote_duplicate_quarantined
remote_irreversible_escalated
```

The disposition binds the canonical operation identity, last durable state, fencing generation, provider account, credential version, raw request/response hashes, remote lookup identity, observation time and responsible external authority.

No timeout or missing response may produce `remote_absent_revoked`. Ambiguous and irreversible cases require the provider owner's manual or API-backed reconciliation and must remain visible in the release ledger.

## Credential compromise procedure

A compromise drill must show that:

- the old credential becomes unusable from both the accepted host and an independent denial probe;
- the service cannot read replacement credential bytes before a new source/host/release subject is accepted;
- replacement credentials have the minimum documented provider scopes;
- access is limited to the accepted service identity and target host;
- credential retrieval and use produce audit events without logging secret material;
- cached tokens and descendant processes are invalidated;
- every operation performed during the exposure window is enumerated and reconciled;
- the drill retains provider-side and host-side timestamps and receipt hashes.

Repository secrets, fixture keys and redacted configuration examples are not compromise-drill evidence.

## Rollback target

A rollback target is an immutable, previously accepted source manifest plus its corresponding target-host profile, dependency closure, configuration digest and credential version. Rolling back only the executable while retaining incompatible state, schema, credentials or service configuration is prohibited.

Before rollback, the operator verifies:

- backward compatibility of durable operation and receipt schemas;
- disposition of every operation created by the newer version;
- absence of a newer irreversible effect that the old version cannot represent;
- accepted database preimage or migration rollback receipt;
- current provider API compatibility;
- current revocation and authorization status of the target version.

If any condition is unknown, the correct action is stop-and-reconcile rather than rollback-and-resume.

## Rollback execution

The rollback procedure must:

1. quiesce admission and advance the fencing generation;
2. capture a bounded, hash-bound pre-rollback state snapshot;
3. reconcile all send-started or ambiguous operations;
4. stop the complete service cgroup;
5. mount the accepted source and configuration read-only;
6. restore or migrate durable state using the reviewed rollback procedure;
7. start the service without provider credentials and run credential-free conformance vectors;
8. attach credentials only after source, host, state and role identity are revalidated;
9. run one provider-owned sandbox canary with no production submission authority;
10. verify receipt continuity, idempotency and reconciliation;
11. re-enable bounded admission only after independent acceptance;
12. emit a rollback receipt binding old/new subjects and all evidence hashes.

## Canary and abort criteria

A rollback canary has a separately authorized sandbox account, bounded request, immutable package, fixed idempotency key and no production target. It is aborted when any identity drifts, a response is ambiguous, a duplicate appears, an unexpected endpoint is contacted, a receipt is missing, resource controls fail or the external owner withdraws approval.

An aborted canary remains evidence of failure or ambiguity. It cannot be deleted and rerun until its remote state has been reconciled.

## Required evidence packet

The revocation or rollback packet contains:

- exact source and target-host manifests before and after the action;
- credential version identifiers and access-policy digests, never credential bytes;
- service-unit, cgroup, mount, process and network observations;
- durable state snapshots and migration or rollback receipts;
- complete affected-operation inventory and reconciliation results;
- provider-side denial, lookup and canary receipts;
- append-only audit and retention identifiers;
- independent owner, evidence and release decisions;
- start/end timestamps and a canonical packet hash.

All evidence is bound to one exact subject and retained according to the external WORM policy. A repository issue closure, administrator statement, green portable test or local log is not a substitute.

## Re-enable conditions

Provider access may be re-enabled only after a new exact source/host/configuration/credential subject completes credential-free conformance, target-host isolation, crash/restart recovery, idempotency/reconciliation, revocation denial, sandbox canary and independent approval. Production submission requires a separate, explicit authority transfer after those gates.
