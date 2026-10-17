# module.policy-engine

Status: normative module specification  
Manifest: [`../manifests/policy-engine.v1.json`](../manifests/policy-engine.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.policy-engine
implementationKind: pure_library
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: pure
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-KERNEL
secondaryOwnerTeam: TEAM-EVIDENCE
independentReviewerTeam: TEAM-STATE
```

Common identity, wire, retry, resource, privacy and compatibility requirements
are normative in the [shared module contract](../MODULE_MODEL.md#shared-engineering-requirements).
The sections below define this module's implementation-specific boundaries.

## Mission and non-goals

Evaluate hard authority, evidence, compatibility, dependency, budget, privacy, and external-effect constraints without converting them into soft penalties.

It does not hold credentials, execute external effects, or mutate authoritative state. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- snapshot
- authority and evidence rules
- budget/resource limits
- compatibility and privacy policies

Outputs:

- hard admissibility decision
- normalized reason codes
- policy hash

## State and authority

This pure result cannot grant execution, writer, or external authority.

Maximum authority class: `pure`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. The module owns no durable state and returns values only.

Declared side-effect classes: `none`.

## Dependencies

Hard registered module dependencies:

- `module.snapshot-builder`

Current implementation and contract roots:

- `docs/control-plane/COMPOSITION_ROOT.md`
- `docs/system/INVARIANTS.md`
- `rust/crates/hepta-control-plane`

## Concurrency and resources

Runs in-process with bounded input and output sizes and no independently created threads, network calls, child processes, or mutable global state. CPU and memory limits are inherited from the calling command; algorithmic bounds and maximum collection sizes are part of the protocol.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

## Failure, recovery, and idempotency

Reject unknown rules, conflicting hard policies, invalid hashes, unsupported authority classes, or missing decision inputs. A policy evaluation failure is denial, never a default allow.

## Security and privacy

Policy code is pure, versioned, and independently reviewed; override attempts are audit events and never silently widen authority.

## Compatibility and migration

Policy versions and hashes are immutable inputs. A policy change invalidates affected plans and prepared results unless explicitly compatible and reverified.

## SLO, capacity, and observability

Track bounded latency, result bytes, rejection classes, resource use, replay determinism, recovery disposition, and capability-specific zero-tolerance counters. Thresholds are attached to named canonical workloads and exact evidence subjects.

## Operational runbook

No long-lived service lifecycle is assumed. Callers validate module/version/configuration before use, record typed failures, invalidate cached results on any bound subject change, and rerun the module's conformance suite after protocol, policy, dependency, resource, ownership, or implementation changes.

## Verification and evidence

Capability bindings: `CAP-CTL-POLICY`. Related work identifiers: `CTL-003`. Implementation/contract roots: `docs/control-plane/COMPOSITION_ROOT.md`, `docs/system/INVARIANTS.md`, `rust/crates/hepta-control-plane`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `CTL-003` — `source_implemented`
- No additional repository-local implementation blocker is asserted by this specification; qualification, activation, and operation remain separate.
