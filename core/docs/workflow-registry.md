# Workflow Registry

`src/workflow-registry.mjs` is the reusable product-line registry.

The router decides **which** product line a task belongs to. The registry then
decides **how** that product line must be produced and reviewed.

## What It Owns

Each product profile defines:

- default output mode
- artifact count policy
- semantic and reference policy
- required gates
- quality gates
- supported channels
- a hard rule that product workflows cannot execute external channel actions

This keeps ZBJ, EPWK, and Hepta from each growing their own hidden copy of
logo, packaging, brochure, vectorization, human-feedback, or delivery rules.

## Boundary

The registry is descriptive and gate-oriented. It does not:

- call providers or models
- upload files
- submit work
- apply for acceptance
- send buyer/customer messages
- deploy Hepta changes

Those actions stay channel-owned and approval/evidence-gated.

## Current Profiles

| Product line | Default output | Main use |
| --- | --- | --- |
| `logo_brand` | `image_set` | logo, VI, brand identity boards |
| `packaging_design` | `image_set` | packaging, label, bottle, box, production-text-sensitive work |
| `proposal_board` | `pdf_deck` | spatial, storefront, landscape, concept proposal boards |
| `presentation_deck` | `pdf_deck` | PPT, pitch, report, presentation work |
| `catalog_brochure` | `pdf_deck` | brochure, catalog, leaflet, print/deck packages |
| `product_design` | `image_set` | product appearance and industrial-design visuals |
| `naming_text` | `text_form` | names, slogans, text-form submissions |
| `vectorization` | `vector_package` | Hepta vectorization and clean asset delivery |
| `human_feedback` | `mixed` | customer/buyer feedback after preview, submit, shortlist, win, or manual handoff |
| `acceptance_delivery` | `mixed` | final delivery and acceptance-bound artifacts |
| `generic_design` | `mixed` | fail-closed placeholder when explicit/agent semantic route evidence is missing |

`post_submission_revision` / `post-submission-revision` are legacy
route/workflow aliases. `consumer_feedback` and `buyer-feedback` are accepted as
English intake aliases. New code should use `human_feedback`.

## Safety Rules

- `logo_brand` blocks weak marks, template filler, and OCR-fixing overlays.
- `packaging_design` preserves buyer-supplied production/regulatory/contact/barcode text.
- PDF-style work requires rendered page review, not only raw PDF metadata.
- `naming_text` must contain actual name/explanation pairs, not a meta note.
- `vectorization` is Hepta-first and must not inherit marketplace submit rules.
- `human_feedback` changes one active correction per iteration and checks
  feedback target/baseline invariants through a
  `HumanFeedbackRevisionContract`; registry gate names alone are not enough.
  Customer-facing feedback also needs canonical `sha256:<64 hex>` source
  snapshot/source refs, canonical invariant hashes when supplied, a locked
  baseline, strong target binding, and a human-feedback review gate bound to the active
  change, target artifact, canonical contract hash, and current task identity;
  embedded review-gate contracts are rehashed rather than trusted by their
  copied `contractHash` field, and the embedded contract hash must equal the
  outer active contract hash.
  Customer-facing execution must carry a separate `ReviewReport` with canonical sha256
  reviewed artifacts; the contract cannot authorize its own handoff by embedding
  `reviewGate: pass`. The `ReviewReport` artifact hashes must match the current
  outgoing package, not a previous local preview. Approval/fresh-evidence packet
  digests also bind the same feedback contract hash and the same package/review
  artifact hashes and message preview that are about to be sent.
- `acceptance_delivery` binds only the current final delivery artifact, not stale pitch packages.
- `generic_design` cannot proceed to external action until reclassified or explicitly approved through the proper channel gate.

## Regression

Registry fixtures live in `fixtures/workflow-registry-fixtures.json`. Customer
feedback contract fail-closed fixtures live in
`fixtures/human-feedback-contract-fixtures.json`. Both run as part of:

```bash
npm run selftest
```
