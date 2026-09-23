# Proposal approval authority

Proposal generation is a draft-only operation. Source materialization and
inventory staging fail closed unless they can independently verify a current
Ed25519-signed `PaperProposalApprovalDocument`. A boolean, environment variable,
or unsigned review status cannot grant this authority; `--approved` is removed
and rejected by the strict CLI parser.

## Trust root

Store public keys only at `runtime/trust/AUTHORITY_TRUST_STORE.json`:

```json
{
  "version": 1,
  "kind": "AuthorityTrustStore",
  "keys": [{
    "keyId": "proposal-key-2026-01",
    "subjectId": "proposal-operator-17",
    "organization": "Research Operations",
    "algorithm": "ed25519",
    "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
    "roles": ["proposal_approver"],
    "status": "active"
  }]
}
```

Private keys are forbidden in the repository and runtime trust store. Signing
must occur in an operator-controlled process or signing service.

## Signed document

Generate the proposal once with `--json` and no materialization flag. The draft
report exposes the stable `proposalEnvelopeHash`, `generationReceiptHash`, target
venue, ordered contribution-claim hashes, ordered quality profiles, and risk
hashes under `approvalVerification`. The approver reviews those exact values and
signs this document:

```json
{
  "version": 1,
  "kind": "PaperProposalApprovalDocument",
  "decision": "approve",
  "paperId": "paper_slug",
  "proposalEnvelopeHash": "sha256:...",
  "generationReceiptHash": "sha256:...",
  "targetVenue": "NeurIPS",
  "contributionClaimHashes": ["sha256:..."],
  "qualityProfiles": ["formal_theorem_or_proof", "empirical_or_experiment"],
  "riskAcceptance": {
    "status": "accepted",
    "acceptedRiskHashes": ["sha256:...", "sha256:..."],
    "rationale": "Operator-reviewed proposal-scoped risk acceptance."
  },
  "operatorIdentity": {
    "subjectId": "proposal-operator-17",
    "displayName": "Proposal Operator",
    "role": "proposal_approver"
  },
  "signedAt": "2026-07-15T09:00:00.000Z",
  "validFrom": "2026-07-15T09:00:00.000Z",
  "expiresAt": "2026-07-16T09:00:00.000Z",
  "signatures": [{
    "keyId": "proposal-key-2026-01",
    "role": "proposal_approver",
    "algorithm": "ed25519",
    "value": "base64-ed25519-signature"
  }]
}
```

The signed payload is canonical JSON with object keys sorted recursively and
the top-level `signature`/`signatures` fields omitted. The trusted key subject
must equal `operatorIdentity.subjectId`. The validity window must be current,
ordered correctly, and no longer than seven days.

## Two-pass CLI flow

```bash
node paper-core/bin/paper-production-core.mjs proposal \
  --paper paper_slug --idea "..." --venue NeurIPS \
  --scientific-claim-document /secure/path/SCIENTIFIC_CLAIMS.json --json

# The external approver reviews the draft bindings and signs them outside the runtime.

node paper-core/bin/paper-production-core.mjs proposal \
  --paper paper_slug --idea "..." --venue NeurIPS \
  --scientific-claim-document /secure/path/SCIENTIFIC_CLAIMS.json \
  --approval-document /secure/path/PROPOSAL_APPROVAL_DOCUMENT.json \
  --materialize-source --stage-inventory --json
```

For a formal quality profile, the scientific claim document is mandatory and
must be supplied on both passes. The second invocation must reproduce the exact
approved proposal inputs. Any
change to paper ID, proposal envelope, generation receipt, target venue, claim
set or order, quality profile set or order, risks, operator identity, signature,
key status, role, or time window blocks before the first proposal artifact write.
Successful materialization preserves both the signed document and its
hash-bound verification receipt in the generated proposal source directory.
