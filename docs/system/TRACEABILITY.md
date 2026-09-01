# Capability-to-evidence traceability

## 1. Purpose

Every development claim must resolve through one machine-readable chain:

```text
system objective
-> invariant
-> capability
-> module implementation
-> work item
-> milestone
-> contract/source path
-> validation path
-> workflow context
-> canonical workload or external evidence
-> effective exact-subject qualification
```

A successful repository-wide workflow without this capability-specific chain
cannot qualify an unmapped capability. A document, module, or work item without a
stable upstream and downstream link is incomplete rather than implicitly covered.

The canonical mapping is
[`truth/evidence-bindings.v1.json`](truth/evidence-bindings.v1.json).

## 2. Static and effective layers

The committed traceability graph records:

- capability, module, work-item, and milestone identities;
- normative contracts and current implementation paths;
- representative validation paths;
- required source workflow contexts;
- canonical performance/fault workloads;
- minimum evidence tier and external blockers;
- the rule that effective qualification is derived only after commit.

It does not record a current successful qualification result. Run IDs, artifacts,
review decisions, deployment identities, and current external receipts belong to
an exact-subject effective artifact.

## 3. Completeness rules

For every capability:

1. at least one registered module implements or is planned to implement it;
2. at least one executable work item owns its next closure step;
3. every implementation module reciprocally lists the capability;
4. every contract, implementation, and validation path exists in the candidate
   tree unless explicitly declared as a planned path;
5. every workflow context is present in the active required-context registry;
6. source-implemented capabilities have non-empty implementation and validation
   evidence;
7. performance-sensitive capabilities bind at least one canonical workload;
8. external requirements name stable blocker/work-item IDs and cannot be
   satisfied by repository-local fixtures;
9. effective qualification remains `derived_only`.

## 4. Change impact

A change to any node in the chain invalidates the affected downstream claim.
Examples:

- protocol/schema changes invalidate implementing module conformance and every
  consumer capability;
- module ownership or authority-class changes invalidate organization and TCB
  review;
- objective/resource changes invalidate scheduler and canonical performance
  evidence;
- workflow/test-path changes invalidate the corresponding evidence binding;
- removal of the final validation path demotes the capability to its static
  implementation state;
- an external package revocation demotes only the capabilities that bind it.

The affected-test planner should consume this graph rather than relying only on
path-name heuristics.

## 5. No circular qualification

A capability cannot qualify itself by producing the only evidence that judges
it. At minimum, the implementation producer, mechanical validator, and required
independent reviewer/authority are distinct roles for authority-bearing,
scientific, release, qualification, and global-objective changes.

## 6. Review output

Every PR should include a generated impact summary containing:

```text
changed capability IDs
changed module IDs and versions
changed work-item/milestone IDs
changed invariants and risks
changed evidence bindings
required source contexts and workloads
qualification invalidations
activation/authority consequences
rollback disposition
```

An empty impact summary is accepted only when the validator independently proves
that the change cannot reach a registered capability or current document.
