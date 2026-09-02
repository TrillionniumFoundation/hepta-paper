# Capability-to-evidence traceability

## 1. Purpose

Every development claim must resolve through one machine-readable chain:

```text
system objective
-> invariant
-> capability
-> registered module
-> module specification + documentation manifest
-> implementation
-> work item
-> milestone
-> contract/source path
-> validation path
-> workflow context
-> canonical workload or external evidence
-> effective exact-subject qualification
```

A successful repository-wide workflow without this capability-specific chain cannot qualify an unmapped capability. A document, module, or work item without a stable upstream and downstream link is incomplete rather than implicitly covered.

The canonical capability mapping is [`truth/evidence-bindings.v1.json`](truth/evidence-bindings.v1.json). The canonical one-to-one module-documentation mapping is [`../modules/module-documentation.v1.json`](../modules/module-documentation.v1.json).

## 2. Static and effective layers

The committed traceability graph records:

- capability, module, work-item, and milestone identities;
- one normative specification and one engineering manifest for every registered module;
- normative contracts and current implementation paths;
- representative validation paths;
- required source workflow contexts;
- canonical performance/fault workloads;
- minimum evidence tier and external blockers;
- the rule that effective qualification is derived only after commit.

It does not record a current successful qualification result. Run IDs, artifacts, review decisions, deployment identities, and current external receipts belong to an exact-subject effective artifact.

## 3. Completeness rules

For every capability and module:

1. at least one registered module implements or is planned to implement each capability;
2. every registered module has exactly one specification and one documentation manifest;
3. every module specification contains identity, mission, inputs/outputs, state/authority, dependencies, resources, determinism, failure/recovery, security, compatibility, SLO, runbook, verification, rollout/rollback, and blocker sections;
4. at least one executable work item owns the next closure step;
5. every implementation module reciprocally lists the capability;
6. every contract, implementation, documentation, and validation path exists in the candidate tree unless explicitly declared as a planned path;
7. every workflow context is present in the active required-context registry;
8. source-implemented capabilities have non-empty implementation and validation evidence;
9. performance-sensitive capabilities bind at least one canonical workload;
10. external requirements name stable blocker/work-item IDs and cannot be satisfied by repository-local fixtures;
11. effective qualification remains `derived_only`.

## 4. Change impact

A change to any node in the chain invalidates the affected downstream claim. Examples:

- protocol/schema changes invalidate implementing module conformance and every consumer capability;
- module ownership, authority, specification, or manifest changes invalidate organization and TCB review;
- objective/resource changes invalidate scheduler and canonical performance evidence;
- workflow/test-path changes invalidate the corresponding evidence binding;
- removal of the final validation path demotes the capability to its static implementation state;
- an external package revocation demotes only the capabilities that bind it.

The affected-test planner should consume this graph rather than relying only on path-name heuristics.

## 5. No circular qualification

A capability cannot qualify itself by producing the only evidence that judges it. At minimum, the implementation producer, mechanical validator, and required independent reviewer/authority are distinct roles for authority-bearing, scientific, release, qualification, and global-objective changes.

A module specification and manifest describe required behavior and evidence; neither may serve as the sole evidence that its own implementation satisfies those requirements.

## 6. Review output

Every PR should include a generated impact summary containing:

```text
changed capability IDs
changed module IDs, specifications, manifests, and versions
changed work-item/milestone IDs
changed invariants and risks
changed evidence bindings
required source contexts and workloads
qualification invalidations
activation/authority consequences
rollback disposition
```

An empty impact summary is accepted only when the validator independently proves that the change cannot reach a registered capability or current document.
