# Research evidence and submission authority pipeline

This pipeline separates five authorities that must not be conflated:

1. a proposal approver signs the exact proposal, venue, claims, quality profiles,
   risks, operator identity, and validity window before any source is materialized;
2. native research workers execute bounded local verification or analysis;
3. an academic-evidence authority signs the current source, worker receipts,
   claims, and artifacts;
4. an independent referee signs a verdict against those exact hashes; and
5. two distinct live-submission authorities sign a single-use, provider- and
   account-scoped authorization lasting at most 24 hours.

No private key belongs in this repository or in the runtime trust store. The
trust store contains active Ed25519 public keys only:

```json
{
  "version": 1,
  "kind": "AuthorityTrustStore",
  "keys": [
    {
      "keyId": "public-key-id",
      "subjectId": "authority-subject-id",
      "algorithm": "ed25519",
      "roles": ["academic_evidence_authority"],
      "status": "active",
      "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"
    }
  ]
}
```

Store it at `runtime/trust/AUTHORITY_TRUST_STORE.json`. Required roles are
`proposal_approver`, `academic_evidence_authority`, `independent_referee`,
`submission_operator`, and `live_executor_authorizer`. Run `npm run authority:status` for a read-only
inventory. It rejects private-key material in the trust store.

## Proposal approval

`PaperProposalApprovalDocument` is required before proposal materialization or
inventory staging. Its Ed25519 signature must have role `proposal_approver` and
bind the proposal envelope hash, generation receipt hash, paper ID, exact target
venue, every ordered contribution-claim hash, ordered quality profiles, all
proposal risk hashes with an explicit acceptance rationale, the operator subject,
and a validity window of at most seven days. Materialization and staging each
reload the runtime trust store and reverify the signed document and all lineage
hashes. See `proposal-approval-authority.md` for the complete contract.

## Native research workers

Each paper may provide `RESEARCH_WORKER_PLAN.json` in its source workspace.
The plan is bound to `paperId`, `taskKey`, exact input hashes, claim IDs, and an
allowlisted native worker type:

- `artifact_integrity`
- `csv_descriptive_statistics`
- `json_assertions`

These workers do not import network or subprocess APIs, never write the source
workspace, and atomically write receipts only below
`runtime/research-workers/<paper_id>/`. Execute them with:

```bash
node paper-core/bin/paper-production-core.mjs batch-run \
  --mode research-verify --paper <paper_id> --execute
```

Running without `--execute` rechecks the current inputs, engine hash, result
hash, and persisted receipt hash without writing.

## Academic evidence

`ACADEMIC_EVIDENCE_ATTESTATION.json` version 2 lives in the source workspace.
Its unsigned payload contains the paper/task identity, current source snapshot
hash, non-synthetic/non-preprogrammed declarations, exact worker receipt
hashes, claim IDs, artifact paths and hashes, and a validity window. An active
`academic_evidence_authority` signs the canonical JSON payload with Ed25519.

Version 1 self-declarations are no longer eligible. A valid signature alone is
also insufficient: every worker receipt and artifact is revalidated against
the current filesystem and every attested claim must be bound to a verified
worker receipt.

## Independent referee verdict

Place `INDEPENDENT_REFEREE_VERDICT.json` and its review artifact under
`runtime/authority-inbox/<paper_id>/`. The signed verdict binds:

- current manuscript hash;
- academic-evidence verification hash;
- artifact-package hash;
- venue-submission-plan hash;
- conflict-of-interest and author-independence declarations; and
- the review artifact hash.

The referee subject must differ from the academic-evidence signer. Local
deterministic referee scans remain diagnostic and cannot satisfy this gate.

## Live submission authorization

Place `LIVE_SUBMISSION_AUTHORIZATION.json` in the same authority inbox. It must
set `allowLiveExternalAction: true`, `environment: production`,
`portalAction: submit_manuscript`, a provider/account scope, a strong nonce,
`singleUse: true`, and a validity window no longer than 24 hours. It must bind
the exact package, evidence, independent-review, venue, and paper hashes.

Two distinct subjects must sign the same payload: one with
`submission_operator`, the other with `live_executor_authorizer`. Neither may
be the evidence authority or independent referee. A consumed nonce blocks
replay.

Passing this gate makes the controlled-executor handoff boundary ready; it
does not execute a portal action. The current overlay contains no live portal
executor and always records external actions as zero.

## Verification

```bash
npm run paper:authority-selftest
npm run migration:p1-research-selftest
npm run authority:status
npm test
```

The selftest covers concurrent worker execution, atomic runtime receipts,
source immutability, artifact tampering, signature verification, referee
separation of duties, authorization expiry, dual control, and a ready handoff
with no external action.
