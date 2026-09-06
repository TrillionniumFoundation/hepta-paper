# Provider technical sandbox companion

This directory contains the repository-owned **technical sandbox** companion used
by portable source integration. It is a real versioned program, not a fixed JSON
test responder, but it deliberately has no credential, network, portal,
submission, release, or production authority.

## Interface

```text
node provider-sandbox/provider-sandbox.mjs REQUEST.json RESPONSE.json
```

The request and response must be distinct absolute files in one private runtime
directory. Input is bounded to 64 KiB and must contain exactly the existing
provider-sandbox request fields. `environment` must equal `provider_sandbox` and
`liveActionAllowed` must be `false`. Output is created exclusively with mode
`0600`; an existing response is never overwritten.

The response is deterministic for the same request and explicitly records:

```text
sandbox: true
credentialsObserved: false
networkActionPerformed: false
externalActionPerformed: false
productionEligible: false
externalAuthorityClaimed: false
```

Its status is intentionally incomplete for external acceptance. It cannot prove
that a portal or provider was contacted, that a remote idempotency key exists,
that credentials are correctly held, or that a real provider receipt is
current. The existing delivery verifier is expected to quarantine the response.

## Test and operational split

`paper-core/tests/provider-sandbox-integration.test.mjs` invokes this exact
repository program in the portable source suite and verifies quarantine through
the real SQLite submission-delivery components.

`paper-core/operational/provider-sandbox-external.operational.mjs` retains the
actual sibling companion requirement and has no fallback or missing-dependency
skip. Release or external qualification orchestration must execute that file
explicitly after provisioning the authoritative companion. Portable technical
sandbox success cannot satisfy that operational gate.

## Security and limitations

The program imports no network or credential provider and does not inspect the
ambient environment. That source property and the emitted declarations are not
an operating-system network-denial proof. It is still executed by a normal Node
process and therefore requires ordinary source review, exact-version binding,
process isolation appropriate to the target host, and current qualification.

A production provider remains a separate externally authorized implementation
with credential custody, remote idempotency, authoritative reconciliation,
revocation, audit retention, canary/rollback, and independent acceptance.
