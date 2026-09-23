# External provider companion acceptance kit

Status: source protocol ready; external acceptance not supplied  
Tracked work: issue `#100`; actual companion dependency remains issue `#55`

## Purpose and authority boundary

This directory packages the repository-owned contract for independently qualifying the credential-free external provider **sandbox** companion. It does not package a provider credential, a provider-owner decision, a target host, a remote portal identity, or production authority.

The portable reference implementation remains `provider-sandbox/provider-sandbox.mjs`. The external operational runner remains `paper-core/operational/provider-sandbox-external.operational.mjs` and deliberately resolves only the separately provisioned sibling entrypoint `../hepta-paper-provider-sandbox/provider-sandbox.mjs`. There is no fixture fallback and no missing-source success path.

A conforming sandbox response is intentionally incomplete for external acceptance and must be quarantined by submission delivery. Passing this kit cannot authorize submission, release, production, a writer, or any external effect.

## Packaged artifacts

| Artifact | Role |
|---|---|
| `schemas/provider-technical-sandbox-request-v1.schema.json` | Closed seven-field request wire schema |
| `schemas/provider-technical-sandbox-response-v1.schema.json` | Closed no-effect response wire schema |
| `external-companion-release-source-manifest.v1.json` | Repository protocol/source inventory and required external subject fields |
| `schemas/provider-external-companion-release-source-manifest-v1.schema.json` | Closed manifest schema |
| `external-companion-target-host-profile.v1.json` | Minimum credential-free Linux sandbox profile |
| `schemas/provider-external-companion-target-host-profile-v1.schema.json` | Closed host-profile schema |
| `external-companion-credential-free-vectors.v1.json` | Positive and hostile wire vectors |
| `schemas/provider-external-companion-credential-free-vectors-v1.schema.json` | Closed vector schema |
| `IDEMPOTENCY_AND_RECONCILIATION.md` | Remote-effect contract required before a production provider can exist |
| `REVOCATION_AND_ROLLBACK.md` | Compromise, revocation, quarantine and rollback procedure |
| `paper-core/operational/provider-sandbox-external.operational.mjs` | Non-skipping external execution and SQLite quarantine gate |

## Exact external subject

Every external qualification receipt must bind all of the following in one canonical record:

```text
repository
commit
tree
entrypoint path and SHA-256
release tag
release asset SHA-256
runtime image digest
runtime version
package/dependency lock SHA-256
provider identifier
account identifier
target-host identity
target-host profile hash
request schema hash
response schema hash
vector-set hash
operational-runner hash
run identifier and attempt
observation and expiry times
```

A changed field creates a new subject. Old runs, copied artifacts, source-equivalent rebuilds, author statements and repository-administrator assertions do not transfer.

## Qualification sequence

1. Fetch the immutable companion release and verify repository, commit, tree, release tag, asset digest, entrypoint digest and dependency lock before execution.
2. Provision a dedicated non-root Linux subject satisfying the target-host profile. Record image, kernel policy, cgroup/rlimit, filesystem and network-namespace evidence.
3. Run the credential-free vectors with no inherited credentials, agent sockets, cloud metadata access, proxy variables or package-manager execution options.
4. Execute the external operational runner. The response must be rejected from accepted delivery, recorded once in quarantine, create no inbox row or reconciliation binding, and report no external action.
5. Retain raw request/response bytes, stdout/stderr, exit status, source identities, host evidence and cleanup receipt under immutable retention.
6. Obtain a provider-owner acceptance and a distinct independent review, both bound to the exact subject and retained evidence.
7. Revalidate immediately before any downstream use. Revocation, expiry, source movement, host drift, a newer run, a failed rerun or evidence mutation invalidates acceptance.

## Operational invocation

From the main repository checkout, with the authoritative sibling source provisioned at its exact expected path:

```text
node --test --test-concurrency=1 \
  paper-core/operational/provider-sandbox-external.operational.mjs
```

A missing companion, unsafe source node, malformed response, timeout, nonzero exit, output alias, identity drift, delivery acceptance or missing quarantine receipt is a failed gate. The operator must not convert those outcomes to a skip or warning.

## Idempotency and reconciliation

The sandbox itself performs no external action. A future production provider is not accepted merely because it implements this wire format. It must additionally satisfy `IDEMPOTENCY_AND_RECONCILIATION.md`, including exact request-key binding, conflicting-reuse denial, durable ambiguous-state handling, authoritative remote lookup and retained reconciliation receipts.

## Revocation and rollback

Every accepted external subject must implement `REVOCATION_AND_ROLLBACK.md`. Revocation is fail-closed and prevents new admission before cleanup. Rollback never deletes evidence, rewrites ambiguity as success, restores an expired credential, or re-enables an old writer/provider generation without a new exact-subject acceptance.

## Closure rule

Issue `#100` may be closed only after this source kit is integrated on a qualified exact head. Issue `#55` remains open until an actual provider owner supplies the immutable external implementation, target host and independently accepted evidence. Neither issue closure alone grants production authority.
