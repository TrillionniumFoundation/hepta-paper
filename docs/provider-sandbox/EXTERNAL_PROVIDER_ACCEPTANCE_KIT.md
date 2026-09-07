# External provider companion acceptance kit

## Purpose

This kit packages the repository-owned protocol and verification material required to evaluate an independently implemented provider companion. It closes only the repository's acceptance-contract gap. It does not create a provider implementation, provision credentials, qualify a target host, authorize a portal mutation, or transfer release, submission or production authority.

The machine index is [`provider-external-acceptance-kit.v1.json`](provider-external-acceptance-kit.v1.json). Every checked-in template and credential-free vector is deliberately non-authorizing.

## Acceptance subject

One external acceptance decision binds all of the following as one indivisible subject:

- provider-owner and acceptance-authority identities;
- immutable source repository, commit, tree and executable bytes;
- release artifact, signature artifact, dependency lock and build recipe;
- request and response schema bytes;
- target host, operating system, kernel, systemd unit, service identity and source mount;
- filesystem, network, cgroup, audit and receipt-store configuration;
- provider sandbox account and credential version identifiers;
- idempotency, reconciliation, revocation and rollback protocol versions;
- complete credential-free and provider-owned sandbox test results;
- independent owner, evidence and release decisions.

Any change invalidates the prior decision. Partial evidence from different source, host, account or credential subjects cannot be combined.

## Source and release manifest

The external owner supplies an instance of [`provider-external-companion-source-manifest-v1.schema.json`](schemas/provider-external-companion-source-manifest-v1.schema.json). The repository provides only the non-authorizing [`source-manifest template`](templates/provider-external-companion-source-manifest-v1.template.json).

The accepted manifest must bind the source and release artifacts, executable path and digest, dependency lock, build recipe, Node runtime, protocol schemas and reproducible source archive. The build occurs from a clean captured source with no dependency-network access. Rebuilding the same subject must reproduce the accepted executable bytes.

The manifest's authority fields remain false. Source identity is necessary for acceptance but cannot itself authorize provider access.

## Target-host sandbox profile

The external operator supplies an instance of [`provider-external-target-host-profile-v1.schema.json`](schemas/provider-external-target-host-profile-v1.schema.json). The checked-in [`target-host template`](templates/provider-external-target-host-profile-v1.template.json) identifies mandatory bindings and is never acceptance evidence.

The profile requires a dedicated non-root service identity, immutable source mount, private `0700` runtime root, no-new-privileges, strict system protection, private devices and temporary storage, cgroup v2 resource ceilings, complete-process-group termination, default-deny networking, explicit destinations and append-only audit retention.

The profile records intended configuration. Target-host qualification must independently inspect the active kernel, mounts, unit, process, cgroup and network policy before and during execution. A configuration file alone does not prove enforcement.

## Credential-free conformance vectors

The vector contract is [`provider-external-conformance-vectors-v1.schema.json`](schemas/provider-external-conformance-vectors-v1.schema.json), with checked-in inputs at [`provider-external-conformance-vectors-v1.json`](fixtures/provider-external-conformance-vectors-v1.json).

These vectors require no provider credential and authorize no external action. Positive cases must emit the exact technical-sandbox response with all credential, network, external-action, production and authority declarations false. Hostile mutations cover live action, production environment, terminal-control suffixes, unknown fields and missing identities; each must fail before a response file is created.

Credential-free success proves protocol compatibility only. It cannot prove credential custody, provider behavior, remote idempotency, reconciliation or portal authority.

## Idempotency and reconciliation

The normative state machine is [`EXTERNAL_PROVIDER_IDEMPOTENCY_RECONCILIATION.md`](EXTERNAL_PROVIDER_IDEMPOTENCY_RECONCILIATION.md). An implementation must persist intent before send, retain ambiguous outcomes, reconcile authoritatively before retry, prevent conflicting key reuse and recover under a persistent fencing generation after process death or host restart.

Exactly-once delivery is never inferred from a local timeout or duplicate filter. If remote absence cannot be authoritatively proven, the operation remains ambiguous and non-retriable.

## Revocation and rollback

The required procedure is [`EXTERNAL_PROVIDER_REVOCATION_ROLLBACK.md`](EXTERNAL_PROVIDER_REVOCATION_ROLLBACK.md). Qualification includes credential compromise, source or host drift, fencing loss, ambiguous in-flight work, complete process-group shutdown, provider-side denial, immutable rollback target, state compatibility and an independently accepted sandbox canary.

Stopping a process or replacing a binary does not reverse a remote effect. Every in-flight operation receives an explicit reconciled or quarantined disposition.

## Operational runner

[`run-external-provider-acceptance.sh`](tools/run-external-provider-acceptance.sh) is the repository-owned non-interactive entrypoint. It accepts exact manifest and host-profile files, verifies strict schemas and captured file identities, executes credential-free vectors against the authoritative sibling companion, and then invokes the existing [`external quarantine gate`](../../paper-core/operational/provider-sandbox-external.operational.mjs).

The runner has no fallback companion, fixture substitution or missing-input skip. It records an evidence directory but does not sign, publish, deploy or authorize the result. The external orchestrator is responsible for immutable retention and independent signatures.

## Acceptance sequence

The external owner performs the following sequence on one unchanged subject:

1. publish the source/release manifest and signature artifact;
2. reproduce the executable from captured source and compare bytes;
3. install the immutable source and target-host profile without credentials;
4. run the credential-free conformance vector set;
5. inspect active host isolation and resource controls;
6. provision the minimum-scope sandbox credential through the accepted custody mechanism;
7. run provider-owned idempotency, disconnect, crash, restart and reconciliation cases;
8. run revocation and credential-compromise denial cases;
9. run a bounded sandbox canary and reconcile its remote state;
10. retain raw provider, host, state and receipt evidence under the accepted retention policy;
11. obtain distinct provider-owner, evidence-owner and release decisions.

Failure or ambiguity at any step leaves the subject unaccepted. Later success does not delete earlier failed attempts; the packet retains complete history.

## Evidence packet

The retained packet includes exact manifests, schema and vector digests, executable and build evidence, host observations, service/cgroup/mount/network state, credential-version identifiers, operation and receipt chains, raw bounded provider responses, reconciliation results, revocation denial, canary disposition and independent decisions.

Each file is hashed and the packet has a canonical index and predecessor linkage. Confidential bytes remain in the protected evidence store; public repository records carry only allowed digests and dispositions.

## Failure semantics

Missing source, manifest, signature, host profile, companion, credential version, provider response, reconciliation fact, receipt, retention target or independent decision is a failure, not a skip. A timeout is ambiguity, not absence. A portable repository pass is not target-host or provider acceptance. An administrator cannot replace an independent owner decision.

## Authority boundary

Completing this kit may justify closing the repository-owned acceptance-kit work item, but issue #55 and the Global Plan external gates remain open until the actual provider owner supplies and independently accepts the implementation, credentials, target host, remote evidence, revocation and canary results.

Production, release, submission and portal authority require a separate explicit transfer after all source, host, provider, retention, governance and rollback gates are current. No checked-in file in this kit performs that transfer.
