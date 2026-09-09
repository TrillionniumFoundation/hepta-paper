# Delivery and integration discipline

## 1. Goal

Allow many module teams to deliver concurrently without turning `main`, the Rust
release-candidate branch, global protocols, or authority-bearing state into an
unreviewable integration queue.

## 2. Change package

Every PR declares:

```text
exact base and head subject
change class
capability/module/work-item/milestone IDs
public protocol and state-schema impact
authority and side-effect impact
resource/SLO and canonical-workload impact
qualification invalidations
migration, rollout, rollback, and recovery behavior
required owner and independent reviewer teams
```

The declaration is checked against the machine traceability graph. A PR cannot
self-classify as module-local when reachability shows a protocol, authority,
state, objective, qualification, or shared-runtime effect.

## 3. Branch and stacking rules

- One product release-candidate branch is the only convergence surface.
- Module branches target the current product/RC subject or an explicitly named
  stacked integration branch.
- A stacked PR states its exact dependency chain and cannot inherit predecessor
  evidence after either head or base moves.
- Temporary generator, self-mutating workflow, probe, or transport branches are
  never product ancestry.
- Final integration uses an expected-head guard and no administrator bypass.

## 4. Commit and PR sizing

A logical change should keep implementation, contracts, tests, machine truth,
and current documentation atomic. It should not mix unrelated capabilities or
mass formatting with authority/state semantics.

Large migrations are split by stable capability while preserving one final
cutover transaction. A small line count does not excuse a wide authority or
consumer blast radius; a larger generated-schema update may remain one atomic
protocol change.

## 5. Review routing

| Change class | Minimum review |
|---|---|
| private module implementation | primary or secondary module owner |
| public module protocol | module owner, protocol team, direct consumers |
| global objective/resource policy | scheduler, kernel, evidence/SRE |
| durable state/writer schema | state, migration/recovery reviewer |
| authority/credential boundary | owning team plus independent security/evidence reviewer |
| qualification/evidence schema | evidence, CI/SRE, affected capability owner |
| release/submission/external effect | release team and named external authority |
| ownership/governance | governance owner and every materially affected team |

The latest push must be reviewed; stale approval is not carried forward.

## 6. CI lanes

```text
module fast lane
consumer contract lane
architecture/authority reachability lane
system integration and replay lane
canonical performance/fault lane
exact-subject release-candidate qualification lane
```

Affected CI is an optimization, not permission to omit a required consumer or
shared-kernel lane. Unknown impact fails toward broader validation.

## 7. Merge transaction

Before merge:

1. re-read live base/head/merge identities;
2. verify every required context comes from its bound producer and complete run
   history;
3. verify all review conversations and latest-push decisions;
4. verify machine truth, document manifest, evidence bindings, and CODEOWNERS;
5. verify no new authority, writer, external effect, or historical document was
   introduced outside the declared scope;
6. merge with the exact expected head;
7. invalidate predecessor artifacts and trigger fresh product-head validation.

## 8. Rollback

Every merged capability change has a predeclared rollback class:

- source revert only;
- configuration/module-version rollback;
- prepared-result drain then rollback;
- state migration with reverse/forward recovery;
- irreversible external effect requiring reconciliation rather than rollback.

Rollback never means re-enabling two writers or replaying an ambiguous provider,
release, or submission action.

## 9. Documentation-rebuild integration rule

The global documentation rebuild is based on the audited Rust RC source but is a
new tree. It must land through its own draft PR, run the fresh exact-head/source
matrix available to that PR, receive latest-push review, and then be integrated
into the single product convergence surface. No prior RC artifact or approval is
inherited. Deleting working-tree history is a source change; Git history remains
the audit archive.
