# Provider technical sandbox companion

`provider-sandbox/provider-sandbox.mjs` is the single canonical repository-owned
**technical sandbox** executable used by portable source integration. It is a
versioned program, not a fixed JSON fixture, but it deliberately has no credential,
network, portal, submission, release, or production authority. No second adapter
implementation is maintained; schema, CLI, adversarial and SQLite quarantine tests
all execute this same file.

## Interface

```text
node provider-sandbox/provider-sandbox.mjs REQUEST.json RESPONSE.json
```

The request and response must be distinct absolute files in one canonical private
runtime directory. Input is bounded to 64 KiB and must contain exactly the
existing seven provider-sandbox request fields. `environment` must equal
`provider_sandbox`, `liveActionAllowed` must be `false`, and opaque package and
dispatch identities must use the bounded `sha256:` domain. Duplicate decoded
JSON keys, malformed UTF-8/JSON, excessive depth/token count, noncanonical parent
paths, symlinked/multi-linked input and changed captured bytes are denied.

Output is created exclusively with mode `0600`; an existing response is never
overwritten. For the same canonical request, response bytes are deterministic and
explicitly record:

```text
sandbox: true
credentialsObserved: false
networkActionPerformed: false
externalActionPerformed: false
productionEligible: false
externalAuthorityClaimed: false
```

The response status is intentionally incomplete for external acceptance. It
cannot prove that a portal or provider was contacted, that a remote idempotency
key exists, that credentials are correctly held, or that a real provider receipt
is current. The existing delivery verifier is expected to quarantine it.

## Portable and operational gates

`paper-core/tests/provider-sandbox-integration.test.mjs` invokes this exact source
in the portable suite and sends its response through the real SQLite
submission-delivery components.

`paper-core/operational/provider-sandbox-external.operational.mjs` retains the
actual sibling companion requirement with no fallback and no missing-dependency
skip. Release or external-qualification orchestration must execute that file
explicitly on a subject where the authoritative companion has been provisioned.
Portable technical-sandbox success cannot satisfy that operational gate.

## Security boundary

The technical companion imports no network or credential provider and does not
inspect the ambient environment. This source property and its emitted
self-declarations are not an operating-system network-denial proof. The program
still runs as a normal Node process and therefore needs exact source identity,
ordinary code review, target-host process restrictions, and current source
qualification.

A production provider remains a separate externally authorized implementation
with credential custody, remote idempotency and reconciliation, revocation,
audit retention, canary/rollback, and independent acceptance. Neither this file
nor its tests close those requirements, issue #55, or Global Plan external gates.
