# Documentation governance

## 1. Objective

The working tree contains only current, actionable development knowledge. Git
history, pull requests, issues, and retained evidence artifacts preserve the
audit trail for superseded material.

## 2. Allowed current-document classes

- global normative architecture, plan, invariant, qualification, or protocol;
- machine-truth projection;
- current subsystem implementation contract;
- active runbook or command reference;
- still-active ADR;
- changelog or release process explicitly scoped as a record rather than current
  status.

Forbidden working-tree classes include historical plans, dated checkpoints,
trigger notes, one-time audit snapshots, closed remediation diaries, superseded
status documents, and review scratchpads.

## 3. Canonical subject rule

Each global subject has one canonical document:

```text
global status          docs/system/CURRENT_STATUS.md
global plan            docs/system/MASTER_PLAN.md
global architecture    docs/system/ARCHITECTURE.md
module semantics       docs/modules/MODULE_MODEL.md
global optimization    docs/control-plane/GLOBAL_OPTIMIZATION.md
global qualification   docs/qualification/QUALIFICATION_MODEL.md
```

Node and Rust documents are scoped projections and link back to the global
subject. A projection cannot add a stronger implementation, qualification, or
authority claim.

## 4. Static versus effective truth

Committed source may record design, implementation, blockers, and disabled
activation. It cannot qualify or activate its own commit. Effective evidence is
produced after the commit and binds an immutable source/deployment/authority
subject.

## 5. Document lifecycle

```text
identify canonical subject
-> update machine truth/schema where applicable
-> update or replace the current document
-> update every affected projection
-> validate links and graph references
-> delete superseded files in the same change
-> obtain fresh exact-subject qualification and review
```

Do not keep both old and new plans “for reference.” The old bytes remain in Git.

## 6. Naming

Use stable semantic names. Dates and PR numbers are permitted only inside
content or immutable evidence records, not current plan/status/checkpoint
filenames. A protocol version may appear in a filename when it remains an active
contract.

## 7. Required change impact

A production-relevant change updates or explicitly declares no impact to:

- program, capability, module, work and milestone truth;
- invariants and risks;
- authority, principals, and TCB;
- protocol/state compatibility;
- resources, fairness, performance, and SLOs;
- failure, reconciliation, rollback, and retirement;
- ownership/review;
- operator procedures;
- qualification/evidence bindings;
- current document entry points.

## 8. Automated gate

Run:

```bash
node docs/tools/validate-development-docs.mjs
```

The validator checks strict machine schemas; capability/module/work/milestone,
ownership, evidence and workload references; dependency cycles; the unique
central-writer rule; canonical document presence; and forbidden historical path
patterns.

The full repository CI must invoke this command before G1 can close. Until that
integration is exact-head qualified, local validator success is implementation
evidence only.

## 9. Recovery of history

Historical content may be inspected with Git or its original pull request. It
may return to the current tree only after being rewritten for a current subject,
assigned a current owner/class, linked from machine truth, and independently
reviewed. Copying an old status file back unchanged is forbidden.
