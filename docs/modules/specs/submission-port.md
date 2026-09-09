# module.submission-port

Status: normative module specification  
Manifest: [`../manifests/submission-port.v1.json`](../manifests/submission-port.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.submission-port
implementationKind: external_service
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: external_effect
qualificationRequirement: external_authority
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-RELEASE
secondaryOwnerTeam: TEAM-EVIDENCE
independentReviewerTeam: TEAM-KERNEL
```

The exact executable/image/source digest, configuration digest, deployment generation, host identity, active qualification evidence, and rollback version are supplied by the qualified deployment registry. This static document cannot grant them.

## Mission and non-goals

Mediate separately authorized portal and journal mutations with durable intent, human approval, idempotency, and authoritative remote reconciliation.

It does not decide scientific validity or bypass independent human/external authorization. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- approved exact package
- venue target and metadata
- human/external authorization
- idempotency and remote identity

Outputs:

- durable intent and portal mutation
- remote authoritative receipt
- reconciliation/withdrawal disposition

Every request, result, event, health record, and receipt carries explicit schema/kind/version, canonical encoding, maximum bytes/counts, freshness and authority requirements, idempotency identity where applicable, unknown-field policy, and confidentiality classification. Large or confidential content moves by immutable artifact reference rather than unbounded protocol payload.

## State and authority

Maximum authority class: `external_effect`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It performs an external effect only after durable intent and independently provisioned authorization. Timeout is ambiguous until authoritative remote reconciliation completes.

Declared side-effect classes: `external_effect`, `portal_mutation`, `submission`.

Module-private journals may support idempotency and recovery but never become a second campaign-state authority. All durable or irreversible boundaries emit a typed receipt or conservative ambiguity disposition.

## Dependencies

Hard registered module dependencies:

- `module.external-authority-verifier`

Current implementation and contract roots:

- `paper-domain/submission`
- `paper-adapters`

Imports of another module's private source are not a dependency contract. Runtime, schema, trust, host, dataset, provider, and external-authority dependencies must also be bound by exact identity in the deployment subject.

## Concurrency and resources

Consumes separately provisioned external concurrency, cost, rate-limit, and irreversible-action budgets. Local availability is not authority. Each call is admitted before release, journalled by idempotency identity, and reconciled from the external system after timeout or ambiguity.

The qualified profile records minimum/typical/hard maximum resources, startup and warm-cache cost, maximum inflight work and queue depth, preemption points, affinity/anti-affinity, expected duration/confidence, overload response, and settlement evidence.

## Determinism and optimization contract

Declared class: `external_observation`. Determinism applies to validation of a frozen external receipt set, not to the external system. Every observation binds authority, time window, generation, request/idempotency identity, and reconciliation provenance.

A candidate-producing module must expose feasible alternatives or a justified singleton, finite resource/cost/latency/risk estimates, uncertainty, expiry, dependency effects, and a canonical payload hash. Local utility is advisory; global priority and integration remain control-plane decisions.

## Failure, recovery, and idempotency

Reject missing human/external authorization, stale package identity, metadata mismatch, duplicate-conflicting intent, unqualified target, unavailable reconciliation, or ambiguous remote outcomes. Unknown outcomes block retry until queried from the portal.

Retries occur only at the documented layer and use a new attempt when identity, method, policy, tolerance, dataset, runtime, or irreversible-effect disposition changes. Exact duplicates return the original result/receipt; conflicting reuse of an idempotency identity is rejected.

## Security and privacy

Keep portal credentials and final authorization outside research/model domains. Bind each irreversible mutation to durable intent and externally verifiable receipt.

Logs and telemetry use an allowlist of bounded machine fields. Credential bytes, private keys, unrestricted prompts/provider responses, confidential manuscript content, developer home paths, and environment dumps are prohibited unless an independently reviewed evidence contract explicitly requires a protected representation.

## Compatibility and migration

Each venue connector declares target API/UI version and supported operations. Metadata/package changes after intent require a new idempotency identity.

Compatibility is one of exact, semantic, evaluation-based, or retired. A breaking protocol, state, authority, resource-unit, side-effect, or rubric change requires a new module version, migration/rollback plan, fresh conformance, and downstream qualification invalidation.

## SLO, capacity, and observability

Track verification/ingest/reconciliation latency, stale/revoked/duplicate/conflict rates, unresolved ambiguity age, and trust/currentness failures. False acceptance, duplicate external effects, and self-issued promotion are zero-tolerance.

Every signal binds module/version/configuration, campaign/plan/attempt/reservation identities as applicable, schema version, producer trust class, privacy class, and retention rule. A dashboard or healthy heartbeat is not qualification or authority.

## Operational runbook

Startup validates exact source/binary or image, configuration, principal, paths, schema/state versions, dependency health, qualification freshness, and recovery residue before readiness. Operators stop admission before shutdown, preserve journals and prepared artifacts, reconcile ambiguous effects, and use the owning work-item/external package for escalation. No operator command may bypass idempotency, fencing, independent verification, or the authority ceiling.

## Verification and evidence

Capability bindings: `CAP-SUBMIT`, `CAP-REL-VERIFY`. Related work identifiers: `SUBMIT-001`. Implementation/contract roots: `paper-domain/submission`, `paper-adapters`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

The canonical `provider:sandbox-selftest` command still requires the actual
external `hepta-paper-provider-sandbox/provider-sandbox.mjs`. Missing or unsafe
source is a nonzero preflight failure before temporary runtime, database, or
outbox creation. There is no fixture fallback and no missing-dependency skip.

Both the quarantine probe and `run-real-paper-provider-sandbox.mjs` now use
`paper-adapters/submission/provider-sandbox-process.mjs` through the appropriate
composition boundary. The operator performs source preflight before allocating
its verification context, and closes its returned persistence context and owned
temporary root in a `finally` path. Executable identity is checked for local
byte drift only; an observed hash is not an authorized companion version or a
proof of the transitive dependency graph. Issue #55 retains that requirement.

The shared direct-child invocation has a 10,000 ms default/maximum timeout,
SIGKILL timeout signal, no shell, 65,536-byte stdout/stderr capture bounds, and
an explicit environment containing only PATH, private HOME/TMPDIR and locale.
It does not inherit operator credentials, proxy variables, NODE_OPTIONS or the
operator's runtime-root environment. Raw child diagnostics do not become error
messages, causes or receipts. Timeout/nonzero exit/output overflow deny without
consuming the response. These are direct-child controls, not process-tree,
network, filesystem, disk-quota or privileged host isolation guarantees. A
child's side effects cannot be undone by returning a denial.

Only the seven existing request fields are accepted, with explicit
`environment: provider_sandbox` and `liveActionAllowed: false`; textual fields
are nonempty and limited to 2048 characters. Request creation is exclusive and
private (0600) through `provider-sandbox-request-repository.mjs`; existing
request/response paths are not reused. Successful child
exit is followed by runtime-directory identity, companion-byte and input-byte
checks. Response files must be bounded single-link regular files opened without
following a symlink. The same captured response bytes must be valid UTF-8 and
JSON; duplicate decoded keys, non-finite numbers, nesting above 32 levels and
more than 8192 lexical tokens are rejected before downstream consumption.
Checks before and after execution do not constitute a race-free OS execution
identity or an externally verified trust statement.

Before the real-paper operator offers a response to delivery verification, it
requires an exact dispatch-authorization binding, `providerReceipt.sandbox:
true` and `externalActionPerformed: false`. Missing, conflicting or coerced
claims cannot be replaced by hardcoded false fields in a signed local report.
These declarations are necessary consistency conditions, not proof of a real
external outcome. The existing delivery/evidence verifier still runs and may
reject incomplete or untrusted receipts. No positive signing or submission
qualification is implied.

`paper-core/tests/provider-sandbox-lifecycle.test.mjs` exercises thirteen
failure/success lifecycle controls through isolated test children with real
SQLite stores. `paper-core/tests/provider-sandbox-process.test.mjs` adds process,
environment, byte/JSON and declaration controls. It also executes an unchanged
copy of the actual operator entrypoint with explicitly local test composition
ports: unsafe claims and inherited-environment canaries cannot reach signing,
and a consistent declaration still reaches (and must pass) downstream delivery
verification. The tests never install a substitute at the canonical companion
path, never sign a real receipt, and never count as independent provider
acceptance. Failures remain nonzero and the owned verification directory is
removed; operator production credentials and positive execution remain untested.

The module documentation validator additionally proves one-to-one registry/spec/manifest coverage, required section presence, registry-field consistency, source-path existence, and authority-specific safety language.

## Rollout and rollback

Current channel is `disabled`. Promotion follows disabled → shadow/read-only comparison → bounded canary → authoritative, with an exact rollback version and atomic mutual-exclusion fencing. A failed or ambiguous canary stops admission and invokes reconciliation before rollback; dual authority is forbidden.

## Open blockers

- `SUBMIT-001` — `source_implemented`
- Effective `external_authority` evidence remains deployment/external-subject specific and cannot be committed as static success.
- Provider sandbox dependency reproducibility remains open in issue #55: an accessible authoritative companion, immutable source/dependency identity, explicit provisioning, and current-head real integration evidence are still required. Lifecycle regression success does not close this blocker.
