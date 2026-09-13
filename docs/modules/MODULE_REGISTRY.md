# Module registry

## 1. Authority

`docs/system/truth/modules.v1.json` is the committed static registry. It records what implementations exist and what they require; it does not activate them. A deployment-specific, exact-subject registry snapshot selects admissible versions after qualification and operational checks.

Every static registry entry has exactly one normative module specification and one documentation manifest recorded by `docs/modules/module-documentation.v1.json`. Those documents describe the engineering contract but do not activate the implementation.

## 2. Required static registry fields

```text
moduleId and name
implementationKind and implementationState
activationState and operationalState
ownershipState
sourcePaths and plannedSourcePaths
capabilityIds and workItemIds
protocolRange
authorityClass and sideEffectClasses
determinismClass
primary/secondary/independent reviewer teams
hard module dependencies
rollout channel and rollback target
qualificationPolicy
specification and manifest paths
notes
```

The static registry stores qualification requirements, never an effective `qualificationState`. Effective status belongs only to an exact-subject artifact. Every list is bounded. Paths are canonical repository-relative paths. Duplicate IDs, overlapping central authority, unknown capability/work-item IDs, missing reciprocal mappings, cyclic hard module dependencies, or missing one-to-one documentation reject the registry.

A deployment snapshot adds concrete module version, runtime artifact kind and digest, configuration, resource/SLO profile, compatible state/schema versions, qualification evidence, host/service identity, and retirement/rollback state. Those deployment facts must not be fabricated in committed static truth.

## 3. Static versus deployment registry

### Static registry

Reviewed in source and maps code to capabilities, teams, schemas, specifications, work items, and expected runtime form.

### Qualified deployment registry

Generated for one exact deployment subject and additionally binds:

```text
source commit/tree
binary or image digest
configuration digest
host/service identity
qualification evidence digest and expiry
active protocol version
resource/SLO envelope
activation channel
deployment generation
```

A static manifest cannot make itself active.

## 4. Selection

The control plane selects implementations by:

1. capability match;
2. protocol compatibility;
3. required evidence tier;
4. activation state;
5. operational health and freshness;
6. authority and side-effect compatibility;
7. resource feasibility;
8. rollout policy;
9. planner preference among eligible implementations.

A shadow or challenger implementation may generate candidates or execute against copied inputs, but its prepared result cannot reach authoritative commit unless its activation policy explicitly allows the scoped canary.

## 5. Multiple implementations

Allowed reasons:

- Node-to-Rust migration;
- architecture fallback;
- hardware/runtime specialization;
- champion/challenger evaluation;
- exact versus approximate algorithm;
- regional/external authority boundaries.

The deployment registry must state:

```text
selectionPolicy
mutualExclusionGroup
authoritativeImplementation
shadowImplementations
fallbackOrder
comparison/evaluation contract
```

Two implementations in the same write/external-effect mutual-exclusion group cannot both be authoritative.

## 6. Health and expiry

Module health is a bounded observation, not authority. Admission requires:

- current qualification;
- current deployment identity;
- current health lease/heartbeat where applicable;
- circuit breaker not open;
- SLO/error budget policy permits use;
- no revocation or rollback order.

A missing or stale health record makes the module unavailable. It does not silently switch to an unqualified substitute.

## 7. Registry mutation

Registry changes are classified:

- metadata-only, no behavior/authority change;
- compatible implementation addition;
- rollout/rollback transition;
- protocol compatibility change;
- resource/SLO change;
- authority or side-effect change;
- capability ownership change;
- retirement.

Authority, protocol, state, specification, manifest, resource, ownership, and rollout changes require the mapped review and fresh conformance/evidence.

## 8. Documentation conformance

Run:

```bash
node docs/tools/validate-module-documentation.mjs
```

The validator requires exact registry/spec/manifest set equality, complete template sections, registry-field parity, existing implementation roots, no placeholders or orphan files, and authority-specific safety language. A green documentation report proves documentation structure only; it does not establish target-host behavior or external authority.

## 9. Current registry limitations

The static registry documents current Node and Rust capability owners, but planned team IDs do not yet correspond to provisioned GitHub teams. Until `ORG-001` closes through real organizational configuration, `.github/CODEOWNERS` retains the existing explicit repository reviewer and modules are not considered organizationally production-ready.
