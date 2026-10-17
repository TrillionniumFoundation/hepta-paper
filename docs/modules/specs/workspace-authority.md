# module.workspace-authority

Status: normative module specification  
Manifest: [`../manifests/workspace-authority.v1.json`](../manifests/workspace-authority.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.workspace-authority
implementationKind: host_service
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: prepared_result_only
qualificationRequirement: target_host
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-WORKSPACE
secondaryOwnerTeam: TEAM-STATE
independentReviewerTeam: TEAM-EVIDENCE
```

Common identity, wire, retry, resource, privacy and compatibility requirements
are normative in the [shared module contract](../MODULE_MODEL.md#shared-engineering-requirements).
The sections below define this module's implementation-specific boundaries.

## Mission and non-goals

Own attempt-scoped mutable workspaces and descriptor-bound inventory, mutation, artifact, integration, cleanup, and recovery boundaries.

It does not commit campaign state, authorize release/submission, or declare its own result accepted. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- source snapshot and attempt identity
- mutation policy
- opened root descriptors
- artifact/integration request

Outputs:

- before/after inventories
- prepared mutation descriptor
- content-addressed artifacts
- cleanup/recovery receipt

## State and authority

Maximum authority class: `prepared_result_only`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It may write only attempt-local workspace or prepared-result state. A verifier and the commit sequencer decide whether any result becomes authoritative.

Declared side-effect classes: `local_ephemeral`, `workspace_mutation`, `prepared_result`.

## Dependencies

Hard registered module dependencies:

- `module.protocol-kernel`

Current implementation and contract roots:

- `rust/crates/hepta-workspace`
- `docs/modules/WORKSPACE_IMPLEMENTATIONS_HANDOFF.md`

## Concurrency and resources

Runs as a role-specific service with bounded listeners/workers, queue depth, file descriptors, CPU, memory, storage, and deadlines. Startup/recovery capacity is reserved separately. Backpressure is machine-readable, and every accepted operation is linked to a reservation or a documented control-plane exemption.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

## Failure, recovery, and idempotency

Reject symlinks, forbidden hard links, special nodes, mount crossing, descriptor replacement, ownership/mode drift, inventory overflow, stale attempts, or no-clobber conflicts. Cleanup revalidates object identity before deletion.

## Security and privacy

Use descriptor-relative no-follow traversal, private attempt principals, bounded roots, exact inventories, and no ambient credentials.

## Compatibility and migration

Workspace and inventory schemas are versioned; rollback must retain descriptor/object compatibility and prepared-result replay.

## SLO, capacity, and observability

Track readiness, admission/dispatch latency, busy and rejection rates, queue depth, crash/restart reconciliation, prepared-result durability, cleanup time, and identity/security violations. Identity violations and duplicate effects are zero-tolerance.

## Operational runbook

Use the selected implementation and its limits from the [workspace handoff](../WORKSPACE_IMPLEMENTATIONS_HANDOFF.md);
`hepta-workspace` and `hepta-workspace-authority` are not interchangeable owners.
Before mutation retain the original root/attempt identity and policy; before
publication validate actual output bytes and the selected destination again.

A no-replace destination collision is not permission to overwrite. After an
error following publication, inspect the exact destination and retained staging
identities through the owning workflow before retry or cleanup. Do not recursively
remove a path merely because its name resembles an attempt. The descriptor-bound
copy and atomic publisher have different failure artifacts; neither supplies a
standalone whole-attempt recovery command. That integration remains required.

Run the selected crate's tests after changing path/limit semantics. Source test
success is not a filesystem-isolation or production writer grant.

## Verification and evidence

Capability bindings: `CAP-WS-AUTHORITY`. Related work identifiers: `MIG-003`, `GAP-HOST-002`. Implementation/contract roots: `rust/crates/hepta-workspace`, `docs/modules/WORKSPACE_IMPLEMENTATIONS_HANDOFF.md`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

### Concrete workspace selection and publication

The [workspace implementation handoff](../WORKSPACE_IMPLEMENTATIONS_HANDOFF.md)
compares the two Rust APIs field by field, including owner checks, actual file
and tree limits, mutation policy differences and prepared-record trust. The
`hepta-workspace` publisher uses atomic Linux `RENAME_NOREPLACE`; failure after
publication and concurrent staging cleanup still require an owning recovery
workflow. The descriptor-bound `hepta-workspace-authority` copy has different
failure artifacts and no whole-attempt recovery entry. These source capabilities
do not independently establish a sandbox, scientific verification or writer grant.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `MIG-003` — `source_implemented`
- `GAP-HOST-002` — `blocked_external`
- Effective `target_host` evidence remains deployment/external-subject specific and cannot be committed as static success.
