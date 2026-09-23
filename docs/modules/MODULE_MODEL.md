# Module model

## 1. Purpose

The module model lets many teams improve `hepta-paper` independently without
turning each implementation into a new authority domain or forcing the central
control plane to understand module internals.

A module is a registered, independently owned, versioned implementation of one
or more stable capabilities. A directory, crate, package, process, or service is
not automatically a module. The registry defines the boundary.

## 2. Module versus deployment unit

A module may be:

| Kind | Appropriate use |
|---|---|
| `pure_library` | deterministic policy, protocol, canonicalization, planning helper |
| `trusted_in_process` | reviewed component that needs low-latency access but no separate secret/OS boundary |
| `isolated_process` | model, language runtime, build tool, or module with independent crash/resource isolation |
| `host_service` | broker, writer, or state authority with its own UID, journal, and lifecycle |
| `external_service` | KMS/HSM, immutable storage, portal, or independently administered verifier |
| `legacy_adapter` | bounded Node compatibility implementation during migration |

The default is not “make everything a service.” Process separation is required
when authority, credentials, trust, resource containment, language runtime, or
failure recovery materially differs.

## 3. Authority classes

Each module has exactly one maximum authority class:

```text
pure
read_only
workspace_local_write
prepared_result_only
central_state_write
external_effect
```

Rules:

- ordinary research, review, build, empirical, and numerical modules are at most
  `prepared_result_only`;
- only the commit-sequencer module can be `central_state_write` for campaign
  state;
- `external_effect` requires an independently provisioned capability and durable
  intent/reconciliation protocol;
- a manifest declares required authority but cannot grant it;
- actual runtime authority must be no broader than the registered class;
- raising a class is an authority change and requires architecture, security,
  state, and independent review.

## 4. Module identity

A module identity binds:

```text
moduleId
moduleVersion
implementationKind
binary/image/source digest
configuration digest
protocol minimum/maximum
capability IDs
authority class
side-effect classes
owner and reviewer identities
qualification references
rollout channel
rollback version
```

Runtime requests and receipts bind the exact selected identity. A module name
without version and implementation digest is not sufficient.

## 5. Capability ownership

Capabilities are stable system responsibilities. Modules implement them.

- A capability may have multiple implementations for migration, availability,
  or champion/challenger evaluation.
- At most one implementation is authoritative for a central or external effect
  at one time.
- Shadow implementations receive immutable inputs and cannot affect authority.
- Candidate generation may have multiple implementations; the central planner
  remains the final selector.
- Capability IDs survive implementation-language changes.

## 6. State ownership

A module declares all state it reads or writes:

```text
readModels
privateJournals
workspaceRoots
preparedResultRoots
centralStateCommands
externalAuthorityPorts
```

Hidden database access, ambient filesystem discovery, or undeclared environment
state is forbidden.

Module-private journals may support idempotency and recovery but cannot become a
second campaign-state authority. Cross-module shared mutable tables are
forbidden unless owned by a named platform module and exposed through a port.

## 7. Determinism classes

| Class | Contract |
|---|---|
| `deterministic` | same canonical input and version produce byte-identical output |
| `seeded` | same input, version, and explicit seed produce byte-identical output |
| `bounded_nondeterministic` | output may vary but schema, permissions, budgets, and metrics are bounded |
| `external_observation` | result depends on an external authority and requires receipt/reconciliation |

A module cannot claim deterministic behavior if it reads unbound wall time,
randomness, ambient environment, network state, or mutable external resources.

## 8. Side-effect classes

```text
none
local_ephemeral
workspace_mutation
provider_call
artifact_publication
central_commit
release_action
storage_deletion
portal_mutation
submission
```

Planning candidates declare their maximum side-effect class and the exact
boundary after which cancellation cannot safely imply non-execution.

## 9. Resource declaration

A module declares:

- per-command minimum, typical, and hard maximum resources;
- concurrency and queue limits;
- whether resources are divisible;
- startup and warm-cache costs;
- provider/token/cost envelope;
- preemption points;
- affinity/anti-affinity requirements;
- expected duration and confidence;
- resource settlement evidence.

Execution outside the admitted envelope is a P0 incident.

## 10. Ownership model

Every module has:

```text
primaryOwnerTeam
secondaryOwnerTeam
independentReviewerTeam
securityReviewerTeam when authority-bearing
onCallOrEscalationOwner
```

A module is not production-admissible while these roles are missing, inactive,
or held by one person for an authority-bearing change.

## 11. Public/private boundary

Public module contracts include only:

- protocol values;
- schemas and golden vectors;
- capability behavior;
- resource/SLO envelope;
- error/recovery dispositions;
- compatibility and rollout policy.

Private implementation source, database layout, internal queues, caches, and
helper APIs are not dependencies for other modules.

## 12. Module acceptance

A module is eligible for conformance only when it has:

```text
manifest
capability mapping
protocol implementation
positive and negative tests
fault/cancellation/replay tests
resource and SLO profile
secret/redaction tests
compatibility policy
rollout and rollback version
owner and reviewer assignments
non-authority statement
```

## Shared engineering requirements

The following requirements apply to every registered module specification.
Module specifications link here instead of carrying independently edited copies.
They still own their concrete fields, limits, errors, persistence, executable
examples and recovery commands. This shared section is not evidence that those
module-specific details or production integrations exist.

The qualified profile records minimum/typical/hard maximum resources, startup and warm-cache cost, maximum inflight work and queue depth, preemption points, affinity/anti-affinity, expected duration/confidence, overload response, and settlement evidence.

Every request, result, event, health record, and receipt carries explicit schema/kind/version, canonical encoding, maximum bytes/counts, freshness and authority requirements, idempotency identity where applicable, unknown-field policy, and confidentiality classification. Large or confidential content moves by immutable artifact reference rather than unbounded protocol payload.

Imports of another module's private source are not a dependency contract. Runtime, schema, trust, host, dataset, provider, and external-authority dependencies must also be bound by exact identity in the deployment subject.

Logs and telemetry use an allowlist of bounded machine fields. Credential bytes, private keys, unrestricted prompts/provider responses, confidential manuscript content, developer home paths, and environment dumps are prohibited unless an independently reviewed evidence contract explicitly requires a protected representation.

A candidate-producing module must expose feasible alternatives or a justified singleton, finite resource/cost/latency/risk estimates, uncertainty, expiry, dependency effects, and a canonical payload hash. Local utility is advisory; global priority and integration remain control-plane decisions.

The module documentation validator additionally proves one-to-one registry/spec/manifest coverage, required section presence, registry-field consistency, source-path existence, and authority-specific safety language.

Retries occur only at the documented layer and use a new attempt when identity, method, policy, tolerance, dataset, runtime, or irreversible-effect disposition changes. Exact duplicates return the original result/receipt; conflicting reuse of an idempotency identity is rejected.

The exact executable/image/source digest, configuration digest, deployment generation, host identity, active qualification evidence, and rollback version are supplied by the qualified deployment registry. This static document cannot grant them.

Module-private journals may support idempotency and recovery but never become a second campaign-state authority. All durable or irreversible boundaries emit a typed receipt or conservative ambiguity disposition.

Compatibility is one of exact, semantic, evaluation-based, or retired. A breaking protocol, state, authority, resource-unit, side-effect, or rubric change requires a new module version, migration/rollback plan, fresh conformance, and downstream qualification invalidation.

Every signal binds module/version/configuration, campaign/plan/attempt/reservation identities as applicable, schema version, producer trust class, privacy class, and retention rule. A dashboard or healthy heartbeat is not qualification or authority.
