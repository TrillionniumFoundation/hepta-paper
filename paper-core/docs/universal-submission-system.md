# Universal submission system

This document defines the provider-neutral submission layer. It extends the
existing autonomous-submission handoff and durable outbox; it does not create a
second campaign or delivery state machine.

## Current implementation status

The current Hepta target catalog contains 98 venue profiles: 38 conferences and
60 journals. Every profile has exactly one explicit submission disposition.
There is no implicit portal or browser fallback.

As of this source revision:

- all 60 journal targets have at least one candidate connector family with a
  local prototype implementation;
- all 38 conference targets have at least one such family;
- COLT and ALT have independent `colt` and `alt` identities. The retired
  ambiguous `colt_alt` identifier is rejected rather than resolved by fallback;
- four targets (`iclr`, `icml`, `neurips`, and `tmlr`) have a target-specific
  OpenReview prototype seed;
- zero targets have a verified current portal binding, sandbox qualification,
  independent connector attestation, or live-commit authorization.

The historical profile data v1 remains available with its original 97 entries.
Current profile data is v2: it replaces the composite `colt_alt` row with the
two independent identities. No portal, deadline, edition, track, schema or
authentication metadata was inferred during that split. Both targets remain
fail-closed until those current external facts are verified; target selection
reports `target_selection_conference_deadline_metadata_required` while the
venue-specific deadline reference is absent.

“Candidate family available” means reusable code exists. It does not mean the
current edition, journal instance, form schema, account, terms, or submission
window has been verified.

Inspect the exact machine-readable result with:

```bash
npm run automation:journal-connector-coverage -- --summary
npm run automation:journal-connector-coverage -- \
  --summary --kind journal --require-family-prototype
npm run automation:journal-connector-coverage -- --venue <venue-id>
```

The stronger `--require-profile-resolved`, `--require-adapter-implemented`,
`--require-sandbox-qualified`, `--require-production-qualified`, and
`--require-live-ready` gates remain fail-closed.

## Contract and routing model

`CanonicalSubmissionEnvelope` is the provider-neutral source of truth. It binds
the paper and target, ordered authors and affiliations, ORCID/ROR/Ringgold and
CRediT data, declarations, reviewer preferences, dynamic portal answers, every
file role and byte hash, and the verified portal-binding hash.

Unknown declarations and dynamic answers are represented explicitly. They
block review and commit and are never converted to “No”. Email addresses and
other secrets are represented by resolver references rather than embedded
credentials.

Each target instance requires an expiring `SubmissionPortalBinding` with:

- exact provider origin, route, edition/cycle and track;
- connector family and enabled operations;
- form/API schema fingerprint and evidence hashes;
- automation-policy evidence;
- authentication-profile reference hash;
- status-mapping hash.

The connector router resolves only a verified binding. Missing implementations,
disabled operations, expired bindings, schema drift, or requests to promote a
prototype to production all fail closed.

## Connector families

The universal port exposes:

`discoverProfile`, `validate`, `createDraft`, `uploadAssets`, `fillMetadata`,
`preview`, `commit`, `getReceipt`, `getStatus`, and `reconcile`.

Implemented prototypes are:

- OpenReview API v2: discovers the current Invitation schema, emits only
  declared fields, verifies the PDF hash, consumes a single-use commit permit,
  uses an idempotency lookup, and performs read-after-write verification.
- HotCRP REST: uses the official paper JSON model, server-side `dry_run`,
  draft-first creation, `if_unmodified_since` concurrency fencing, exact asset
  hashes, a single-use commit permit, and read-after-write verification.
- OJS REST: stages submission, publication, contributors and files, saves the
  draft, checks the remote version token, consumes a single-use commit permit,
  submits, and reads the submission back.
- Playwright-assisted draft: uses an injected isolated Playwright session,
  versioned semantic selectors and DOM fingerprints. It can prepare a draft and
  preview, but `commit()` is unconditionally rejected. MFA, CAPTCHA and legal
  or author actions are handed to a human and are never bypassed.

ScholarOne Submission Integration and arXiv SWORD remain official-partner
connector families pending platform authorization. Manual handoff remains an
explicit terminal disposition where automation is unavailable or prohibited.

## Delivery and authority boundary

Provider prototypes are not imported into the research campaign process. The
production path remains:

```text
campaign release
  -> verified submission handoff
  -> durable intent/outbox
  -> independently deployed signed connector service
  -> provider adapter
  -> read-after-write/reconciliation
  -> signed external receipt
```

The existing outbox writes intent before a provider action. A transport timeout
after a possible commit is `uncertain`; recovery reconciles remotely and never
blindly repeats the commit. A provider observation from an in-process prototype
is not an independently signed submission receipt and therefore cannot satisfy
production readiness.

Final commit requires a human-reviewed, hash-bound, single-use authorization.
Author order and consent, declarations, conflicts, ethics, licenses, APC or
payment decisions, and any provider legal terms cannot be inferred or accepted
by the system.

## Target onboarding

A target becomes sandbox-qualified only after all of the following are
supplied and verified:

1. A single stable venue identity; conferences also require an exact edition
   and track.
2. The official current portal origin and route.
3. Current API/form schema evidence and a matching fingerprint.
4. Written automation-policy or API authorization evidence.
5. An isolated credential profile owned by the connector service.
6. A no-side-effect live canary and golden fixture.
7. Provider-specific status mapping and idempotent reconciliation.
8. An independently signed receipt path.

Production and live-commit qualification additionally require the real account,
current submission window, final human approval bound to the package and
metadata hashes, and successful provider read-after-write evidence.

Numerical reference candidates use the same external-authority principle. A
deployment may set
`HEPTA_ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_REGISTRY` to an owner-private,
hash-bound registry of per-candidate runtime configurations. The production
handoff re-verifies each signed plugin bundle, independent qualification
statement, exact source snapshot, entrypoint, runtime closure and all required
authority roles. A registry boolean or a mismatched candidate can never promote
an unqualified reference implementation.
