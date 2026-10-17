# RFC and ADR process

## 1. When a design note is useful

Record material decisions in the existing module contract or PR. A separate
RFC is optional, not a pre-implementation approval gate. Useful topics include:

- new capability or module boundary;
- protocol/schema breaking change;
- authority or credential movement;
- new central/shared state;
- scheduler objective or hard-constraint change;
- resource/fairness semantics;
- production process/service boundary;
- evidence-tier or qualification change;
- cutover/retirement strategy;
- cross-team operational ownership.

## 2. RFC content

```text
problem and non-goals
capability/module IDs
current behavior and evidence
options and tradeoffs
proposed contracts and data flow
authority/TCB impact
concurrency/resource/performance impact
failure/recovery and migration
security/privacy
rollout/rollback/retirement
required tests, workloads and evidence
owners and decision deadline
```

An RFC is a proposal, not current architecture.

## 3. ADR content

For durable cross-cutting decisions, record one stable ADR containing:

```text
status: accepted/superseded
context
decision
invariants and authority consequences
rejected alternatives
compatibility/migration consequences
operational consequences
revisit conditions
supersedes/superseded-by links
```

Only accepted, still-relevant ADRs remain in the working tree. When superseded,
the replacement ADR summarizes the previous decision and the old bytes remain
in Git history.

## 4. Numbering

ADR IDs are monotonic and never reused. Filenames use a semantic title, not a
status/date suffix.

## 5. Review

The maintainer decides after applicable tests. No separate human reviewer is
required for an RFC or ADR. Architecture cannot manufacture
external authority on behalf of the real authority owner.
