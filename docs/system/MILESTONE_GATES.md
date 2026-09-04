# Milestone and gate model

## 1. Authority

[`truth/milestones.v1.json`](truth/milestones.v1.json) is the canonical static
milestone graph. This document explains its semantics. A milestone is not closed
by prose or by implementation state alone.

## 2. Independent milestone dimensions

Each milestone records:

```text
implementationState      not_started | design_ready | source_implemented
closureState             open | blocked_external | closed
evidenceTierRequired     design | source | hosted_installed | target_host | external_authority
dependsOnMilestoneIds    hard predecessor gates
ownerTeamIds             accountable implementation/qualification owners
workItemIds              bounded executable scope
exitCriteria             human-readable acceptance summary
evidenceOutputs          required machine artifacts/receipts
```

`source_implemented` with `closureState=open` means the planned source exists but
the gate still lacks exact-subject qualification, review, operation, or external
evidence. A blocked-external milestone remains open until its named authority
produces accepted evidence.

## 3. Dependency semantics

A milestone may begin design before all predecessors close, but it cannot claim
closure, authoritative activation, or production applicability while a hard
predecessor remains open. Evidence from different source, deployment, or trust
subjects cannot be combined to synthesize closure.

The current order is:

```text
G0 exact qualification identity
-> G1 singular global documentation truth
-> G2 module platform
-> G3 Rust control-plane composition
-> G4 resource/concurrency qualification
-> G5 capability-by-capability migration
-> G6 global optimization
-> G7 performance and organization scale
-> G8 independently controlled production prerequisites
-> G9 shadow/canary/rollback
-> G10 Rust authority cutover and Node retirement
```

G4 and G5 may progress in parallel after G2/G3 where their dependencies permit;
G6 consumes the qualified module, composition, and resource surfaces. G8 can
collect external evidence early but cannot authorize later gates before all
bound source and architecture prerequisites are current.

## 4. Closure transaction

Closing a milestone requires one immutable evidence package that binds:

- milestone ID and exact version of this graph;
- exact source/base/head/merge or deployment subject as applicable;
- complete work-item set and dependency closure;
- required test/workflow/workload artifacts;
- invariant and zero-tolerance results;
- unresolved risks and accepted residual-risk authority;
- latest required review decisions;
- rollback/recovery disposition;
- closure timestamp and expiry/revalidation rule.

Any later change to a bound dependency invalidates closure until fresh evidence
is accepted.

## 5. Program-critical gate set

`program.v2.json.openCriticalGates` must equal every milestone whose
`closureState` is not `closed`. The documentation validator rejects omissions,
preventing an open gate from disappearing merely because its source is present.
