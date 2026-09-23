# Autonomous research state-safety readiness

`fullyAutonomousResearchSystemReady` is fail-closed on state safety. Campaign,
resident, and machine-intake readiness are necessary but no longer sufficient.
The state-safety inspection requires all four of these conditions at the same
time:

1. the canonical closed SQLite inventory covers all ten registered trust-state
   roles and contains no unknown autonomous SQLite database;
2. the newest valid whole-state bundle has a restore-drill-passed receipt and
   covers those same ten roles;
3. a short-lived signed current-head receipt and a recent signed active-challenge
   receipt have both been verified with pinned external-authority trust and bind
   the same authority id, key, sequence, and head hash; and
4. the online writer manifest covers all ten database roles. Its role coverage
   must match both a repository AST/import inspection and a broker-signed scope
   receipt bound to the same current authority head.

The role set is `native-store`, `submission-handoff`, `machine-intake`, `topic-producer`,
`supervisor-state`, `resident-instance`, `runtime-reproducibility-refresh`,
`runtime-reproducibility-publication`, `external-qualification`, and
`full-research-qualification-publication`. Coverage is computed from manifest
writer entries; caller-supplied counts are not accepted. The production
manifest currently contains sixteen writer entries and 202
coordinator-integrated operations across all ten roles, so the code-level
coverage contract reports `10/10` (100%). Deployment readiness remains separate:
each concrete database, authority head, broker scope and runtime activation
must still verify.

## Passive and active inspection

Ordinary `automation-status` remains passive. It may validate the short-lived
derived JSON evidence cache written only after a successful active startup, but
it does not contact the broker or refresh any receipt. Supervisor startup first
reconciles all ten databases, performs a no-write broker challenge, reconciles
every finalized head, and validates active state safety. Only then does it
atomically persist
`automation-cache/online-authority-evidence-v1/current.json`, recheck that the
canonical inventory hash is unchanged, and expose the ready coordinator. The
cache is signed-evidence transport for passive status only; it is outside the
ten-database inventory and cannot authorize mutation. Missing, expired,
tampered, unsafe-path, wrong-scope, or wrong-manifest cache evidence fails
closed. The passive and active paths use the same pinned signature verifier and
receipt contract.

Restore evidence is reverified with the pinned public trust loaded from
`HEPTA_AUTONOMOUS_RESEARCH_STATE_BACKUP_AUTHORITY_CONFIG`. Status exposes only
whether that configuration is present and its pinned configuration hash; it
does not expose the configuration path and does not invoke the broker. Without
that trust configuration, a locally stored restore receipt remains blocked.

A local boolean, environment variable, unsigned JSON document, backup
reservation, backup finalization, or restore-drill receipt cannot stand in for
online evidence. Backup/restore proves recoverability of a snapshot. It does
not prove that every production writer participates in transaction-time
`reserve -> SQLite apply -> finalize` fencing.

At present the production coordinator contract is integrated for all declared
writer roles. The passive inspection can nevertheless report:

- online coordinator not runtime-activated;
- current external authority head required;
- recent active challenge required;
- static writer coverage required;
- broker-signed writer scope required; and
- writer coverage or static/broker binding failure when the deployed manifest,
  schemas or signed scope do not match the current production graph.

Startup reconciliation queries a signed unresolved-reservation list for a
database instance. A trusted local pending marker may be finalized
idempotently. A marker-absent reservation may be automatically aborted only
while an immediate database write lock proves that its latest local
database sequence, hash, schema, and state hash still exactly match the signed
reserve request's previous state. The signed abort is followed by a second
unresolved-list confirmation. Any mismatch remains possible commit or rollback
evidence and blocks startup. Runtime readiness also requires finalized-head
reconciliation and a fresh active authority challenge after all ten databases
have reconciled.

Consequently a deployment cannot report fully autonomous readiness merely from
code-level `10/10` coverage. It must also provision and reconcile all ten
databases, validate the current signed authority head and recent challenge,
and bind the broker-signed scope to the exact manifest.

## Status contract

The `autonomousStateSafety` section of `automation-status` exposes inventory and
restore role counts, passive/active receipt verification, writer manifest hash,
static and broker coverage verification, computed writer role coverage, and
the full blocker list. `autonomousStateOnlineAntiRollbackReady` becomes true
only when current-head, recent active challenge, static manifest coverage, and
broker scope are all verified for the same head.

The contract is implemented in
`paper-domain/automation/autonomous-research-state-safety-contract.mjs`; the
production read-only composition is
`paper-composition/automation/autonomous-research-state-safety-inspection.mjs`.
