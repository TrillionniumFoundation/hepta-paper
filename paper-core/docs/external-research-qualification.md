# External research qualification process configuration

Production autonomous research uses two distinct external processes: a qualifier that may issue a
full-research qualification receipt, and an independent verifier that replays the full qualification
domain before the receipt is accepted. Configure them with
`HEPTA_AUTONOMOUS_EXTERNAL_QUALIFICATION_CONFIG`.

The configuration is exact-shape version 3. Extra fields, omitted fields, older-version documents,
inline credentials, private-key material, and private-key paths fail closed. A complete example is:

```json
{
  "version": 3,
  "kind": "ExternalResearchQualificationProcessConfiguration",
  "status": "active",
  "maximumQualificationCostUsd": 5,
  "qualificationCostAuthority": "operator_declared_worst_case_usd",
  "qualifier": {
    "serviceId": "research-qualifier-a",
    "principalId": "research-qualifier-principal-a",
    "protocol": "external-qualification-json-stdio-v1",
    "executable": "/opt/hepta/bin/research-qualifier-a",
    "args": [],
    "credentialRoot": "/run/credentials/research-qualifier-a",
    "environmentAllowlist": ["PATH"],
    "timeoutMs": 300000
  },
  "verifier": {
    "serviceId": "research-verifier-b",
    "principalId": "research-verifier-principal-b",
    "protocol": "external-qualification-json-stdio-v1",
    "executable": "/opt/hepta/bin/research-verifier-b",
    "args": [],
    "credentialRoot": "/run/credentials/research-verifier-b",
    "environmentAllowlist": ["PATH"],
    "timeoutMs": 300000
  },
  "trustedSignerTrustSet": {
    "version": 1,
    "kind": "ResearchExecutionReleaseAttestorTrustSet",
    "keys": [
      {
        "keyId": "release-attestor-2026-a",
        "keyVersion": "version-1",
        "subjectId": "research-release-attestor-a",
        "organization": "example-research-office",
        "role": "research_execution_release_attestor",
        "algorithm": "ed25519",
        "status": "active",
        "effectiveFrom": "2026-07-01T00:00:00.000Z",
        "expiresAt": "2026-10-01T00:00:00.000Z",
        "revokedAt": null,
        "publicKeyPath": "/etc/hepta-paper/trust/release-attestor-2026-a.pub.pem"
      },
      {
        "keyId": "release-attestor-2026-b",
        "keyVersion": "version-1",
        "subjectId": "research-release-attestor-b",
        "organization": "example-research-office",
        "role": "research_execution_release_attestor",
        "algorithm": "ed25519",
        "status": "retiring",
        "effectiveFrom": "2026-09-15T00:00:00.000Z",
        "expiresAt": "2027-01-01T00:00:00.000Z",
        "revokedAt": null,
        "publicKeyPath": "/etc/hepta-paper/trust/release-attestor-2026-b.pub.pem"
      }
    ]
  },
  "verifierAttestor": {
    "keyId": "qualification-verifier-b",
    "keyVersion": "version-1",
    "subjectId": "qualification-verifier-attestor-b",
    "organization": "example-independent-verification-office",
    "role": "external_qualification_independent_verifier",
    "algorithm": "ed25519",
    "status": "active",
    "effectiveFrom": "2026-07-01T00:00:00.000Z",
    "expiresAt": "2027-07-01T00:00:00.000Z",
    "revokedAt": null,
    "publicKeyPath": "/etc/hepta-paper/trust/qualification-verifier-b.pub.pem"
  }
}
```

`maximumQualificationCostUsd` is the combined worst-case cost of one complete qualifier-plus-verifier
attempt. It and `qualificationCostAuthority` are bound into the configuration identity. A positive
maximum requires `operator_declared_worst_case_usd`; a genuinely zero-cost externally operated pair
must use a maximum of `0` with `externally_operated_zero_cost`. Missing, unknown, negative, mismatched,
or over-$1,000 declarations fail closed. Before either process starts, recovery durably reserves at
least this configured maximum. A caller may raise that reservation but cannot lower it, and a total
qualification budget below the configured maximum is rejected. Provider author/reviewer canaries use
their own independently priced and reserved budget; their price is not a proxy for qualification cost.

Every command object and signer object must contain exactly the fields shown. The trust set must
contain between 1 and 32 Ed25519 public keys, with unique `keyId`/`keyVersion` tuples and unique
normalized SPKI identities. Re-encoding the same key in a different PEM representation does not
create a distinct key and is rejected. Canonical ISO timestamps are required. The qualifier and
verifier must have distinct service IDs, principals, executable identities and contents, and
credential roots. Their strict credential roots may contain only private service credentials: the
roots must each contain at least one non-empty regular file, all entries must share the root owner,
and hard links, symlinks, special files and group/world access fail closed. The sets of regular-file
content hashes must be disjoint, so copying a credential under another name or adding unrelated
files still fails closed. Put shared CA certificates and other public material outside these roots.
Every release-attestor and verifier-attestor organization is mandatory and
non-empty. The verifier-attestor identity and normalized public key must also be distinct from every
release-attestor key, and its organization must differ from every release-attestor organization
after case and whitespace normalization. Command objects have no organization field; adding one is
an exact-shape error rather than a way to claim independence.

## Independent verification protocol

The stdio transport name remains `external-qualification-json-stdio-v1`, but the independent
verification request and response documents are exact-shape version 2. The request carries a
canonical verification policy bound to the current paper, campaign, release-binding hash and
version, launch mode, qualification scope, proposal/policy/seed hashes, canonical prior-art v2
receipt, and native formal-intake v3 requirement. Production v4 and bounded golden v3 policies are
mutually exclusive. A version-1 response, a missing policy, or a response copied from another
release fails closed.

The response must echo the request and policy hashes, contain the independently derived inspection,
include a canonical `signedAt`, and be signed by the configured verifier attestor. The attestor must
be `active`, unrevoked, and valid at request time, signing time, and verification time. Signing time
may differ from request time by at most five minutes; the expiry instant itself is not valid. A
`retiring` verifier attestor cannot sign new responses in the current single-key model.

After live verification, the complete signed request/response evidence and its canonical hash are
stored in the qualification inspection. Local renewal, golden qualification, ResearchClosure, and
the pinned submission verifier rebuild the current request and policy and reverify that evidence.
They do not trust a persisted `independentVerifierVerified` boolean or an unsigned inspection hash.
Reverification after the verifier key expires fails closed and requires fresh independent evidence
under an active key.

## Rotation contract

Preprovision the next release key in both the production release-attestor trust set and this external
qualification trust set before its `effectiveFrom`. In the external qualification document, keep
exactly one non-revoked entry labelled `active`; the next key may be labelled `retiring` even before
cutover. These external labels describe a verification/preprovisioning set. They do not grant current
signing authority.

At cutover, change only the production release-attestor configuration so the old key becomes
`retiring` and the new key becomes `active`. Do not edit the external qualification configuration.
Readiness compares the rotation-stable key material—identity, role, algorithm, validity window and
normalized SPKI—while ignoring that release-only status flip. For every qualification, the controller
runs a fresh random-challenge inspection of the actual production KMS/HSM release attestor. Only the
key reported active by that current, hardware-protected, non-exportable production inspection may
sign a newly issued receipt.

A historical receipt signed by a non-revoked retiring key remains verifiable only when its signed
time is within that key's explicit window and strictly before the current active key's
`effectiveFrom`. A future-key signature, a retiring key used for a fresh issuance, an expired key, a
revoked key, an algorithm mismatch, or a release/external stable-material mismatch fails closed.

## Version-1 and version-2 migration

Version 1 used one `trustedSigner` object. It is intentionally not accepted by the production reader.
Version 2 introduced the trust set but did not declare a qualification cost authority, so it is also
intentionally rejected. Before deploying version-3 code:

1. Build a release-attestor trust set containing the current and next public keys if migrating from
   version 1.
2. Replace `trustedSigner` with the exact `trustedSignerTrustSet` object above and set the root
   `version` to `3`, or retain the existing trust set when migrating from version 2.
3. Add the exact `maximumQualificationCostUsd` and `qualificationCostAuthority` fields after
   determining the combined qualifier-plus-verifier worst-case attempt cost.
4. Provision only public-key files in the configuration/trust mount. Keep KMS/HSM credentials in the
   qualifier, verifier and release-signer credential roots; never place a private key, token, cookie
   or inline credential in this JSON.
5. Run readiness and obtain a new full-research qualification bound to the version-3 configuration
   identity before launching production campaigns.

There is no permissive compatibility fallback: an unchanged version-1 or version-2 document blocks
production.

A same-release recovery state written by older code without the persisted cost-budget fields is
also never guessed or reset. A still-current verified receipt may be reused read-only, but a new
external attempt returns `qualification_external_service_legacy_cost_state_unpriced` without
calling either service or rewriting the state. A different release starts a new, version-3-bound
budget lifecycle.
