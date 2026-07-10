# Contract JSON Schema

`src/contract-schema.mjs` exports the versioned JSON Schema snapshot for the
public core contract objects:

- `ChannelTask`
- `CreativeBrief`
- `ProductionPlanEnvelope`
- `ArtifactPackage`
- `HumanFeedbackRevisionContract`
- `ReviewReport`
- `ChannelSubmission`
- `AdapterRunnerSdkPhase`
- `AdapterRunnerSdkContract`

Run:

```bash
npm run schema:contracts
```

The exporter writes `reports/contract-schemas-latest.json` and `reports/contract-schemas-latest.md`. The JSON
report includes a bundled draft 2020-12 schema with `$defs`, enum snapshots for
channel ids / product lines / output modes / external actions / core stages,
a deterministic `schemaHash`, and a local validation report.

Validation requires both the semantic `schemaHash` alias and generic `hash` to
be present and equal. A generic `hash` value is not accepted as a substitute for
a stripped `schemaHash`.

The adapter runner SDK schemas pin the external-runner handoff contract in the
same public snapshot: each phase requires `requiredEvidenceKinds`, hash-bound
inputs, rechecks, action-specific receipt/proof evidence fields, and safety
flags that keep core read-only while requiring a fresh current-chat approval
before any live external runner can execute. The SDK contract also exposes
`handoffSnapshots.manifest` and `handoffSnapshots.preview` so public consumers
can validate the concrete manifest/preview objects, not just copied hashes. A
ready SDK contract cannot set `handoffSnapshots` to `null`; the manifest
snapshot must identify itself as `ChannelActionManifest` and the preview
snapshot must identify itself as `AdapterRunPreview`. Customer-message SDK
contracts also require `messagePreview` and `messagePreviewHash` in the handoff,
plus `messagePreviewHash` in `hashBinding.requiredHashes`, so public consumers
cannot treat a message ID as proof of the approved text. Human-feedback
customer-facing SDK contracts additionally require
`humanFeedbackRevisionContractHash` in both the handoff and
`hashBinding.requiredHashes` for `customer_message`, `live_submit` / EPWK
`workModifyLive`, and `acceptance_apply`, keeping the external runner bound to
the reviewed feedback contract instead of just the generic action result.
The same SDK condition recognizes package/review role aliases on
`packageRole`, `reviewType`, and `role`, and it treats live-submit/action-stage
aliases such as `work_modify_live`, `epwk.workModifyLive`, and
`acceptanceApplyLive` as customer-facing feedback exits. Public writers should
still prefer canonical action and role values, but aliases cannot bypass the
feedback-contract hash requirement.

Human feedback schemas are intentionally stricter than generic package
records: `HumanFeedbackRevisionContract` review gates must be formal
`ReviewReport`-shaped objects with embedded feedback-contract binding and
canonical `sha256:<64 hex>` reviewed artifact hashes. Feedback artifact
packages and review reports must also carry the same external task identity.
Runtime validation rejects a review gate whose embedded feedback contract hashes
to a different contract than the active outer contract, even if that embedded
contract is individually well-formed.
Bare `reviewGate: pass` or operator flags are not valid schema-level
customer-facing evidence.
Schema feedback conditions use the same exported human-feedback alias set as
runtime product-line canonicalization, so legacy `human_feedback_revision`,
`post_submission`, `shortlisted_revision`, and `won_revision` workflow IDs still
trigger embedded feedback-contract requirements.
Package-role schema conditions use the exported feedback package-role alias set,
so raw aliases such as `human-feedback-review` and
`post-submission-revision` trigger the feedback contract requirement but still
fail closed unless public JSON emits canonical package roles.
The canonical contract digest source helper is
`computeHumanFeedbackRevisionContractHash(contract)` from `src/contracts.mjs`;
human-feedback-specific helpers delegate to that source helper so workflow
chain checks, schemas, and review gates do not carry parallel digest logic. The
helper canonicalizes human-feedback product/workflow aliases and
customer-message exit-action aliases before hashing direct contract descriptors.

This is a schema snapshot, not a runtime executor. It does not call providers,
open browsers, upload, submit, send messages, pay, apply acceptance, deploy,
fetch channel state, mutate lifecycle state, or grant execution permission.
