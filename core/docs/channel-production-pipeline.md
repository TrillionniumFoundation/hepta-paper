# Channel Production Pipeline Contract

`channel-production-pipeline` is the shared contract that keeps ZBJ, EPWK, and
Hepta on the same production backbone without copying one channel's platform
details into another.

Common chain:

```text
ChannelTask
-> CreativeBrief
-> ProductionPlanEnvelope
-> ArtifactPackage
-> ReviewReport
-> ChannelSubmission
-> AdapterRunReceipt
-> ChannelStateProof
```

## Channel Differences

- ZBJ supports prepare, live submit, acceptance, and IM preview, but must keep
  seller-side duplicate, refund, deadline, live-capacity, and captcha gates.
- EPWK supports read-only discovery/detail, prepare-only evidence, and guarded
  live submit handoff; the runner must still re-check account/shop gates,
  platform schema, workback duplicate proof, adapter receipt, and channel-state
  proof.
- Hepta uses delivery/deployment proof instead of pitch-upload proof, and must
  keep buyer-facing copy free of local/dev/mock/debug wording.
- Customer-message receipt/proof evidence for every channel includes
  `messagePreviewHash`; human-feedback customer-facing handoffs also carry
  `humanFeedbackRevisionContractHash` through receipt/proof evidence for
  `customer_message`, `live_submit` / EPWK `workModifyLive`, and
  `acceptance_apply`, so downstream ledgers, bundles, archives, and
  reconciliation reports do not collapse them into generic external-action
  records.

## Boundary

The module is descriptor-only. It never runs adapters, opens browser/API
sessions, uploads, submits, sends messages, accepts delivery, pays, deploys, or
grants execution permission.

Pipeline contracts and contract sets must preserve both their semantic hash
aliases (`pipelineContractHash` / `pipelineContractSetHash`) and generic `hash`
fields. Validators use the semantic aliases as the descriptor identity; a
generic `hash` field is not accepted as a substitute for a stripped semantic
alias.

Pipeline runner locations must also resolve to external sibling workspaces such
as `../zbj-auto-intake`, `../epwk-auto-intake`, or `../hepta`. A pipeline
contract that points the runner back into `design-production-core` is blocked
before it can become a ready channel contract.
