# Adapter Runner Stub

`src/adapter-runner.mjs` is the dry-run boundary after `ChannelActionManifest`.

It accepts a `ChannelActionManifest` and returns an `AdapterRunPreview` with:

- channel adapter action ID
- generic handoff command preview
- command owner marker
- required flags
- manifest hash and preview hash
- approval and evidence hashes
- approved customer-message preview/hash when the manifest carries one
- human-feedback revision contract hash when a customer-facing feedback
  manifest is bound to a feedback revision
- prompt/generation binding hashes when provider/model spend is tied to a prompt
  production chain
- canonical `packageRole` when the manifest identifies human feedback by a
  package/review role instead of by product/workflow alone
- artifact names
- blockers and warnings

It never executes the command preview.

## Supported Preview Shape

Core no longer maps adapter action IDs to channel package commands. Every action
uses the same generic handoff shape:

```sh
adapter-runner handoff --action-id <channel.action> --dry-run --task <id> --approval-hash <hash> --evidence-hash <hash>
```

The owning channel package must map that action ID to its real local command in
its own adapter registry. `design-production-core` only carries action ID,
required hashes, artifact names, approved customer-message preview metadata, and
dry-run handoff metadata. Customer-message previews carry `messagePreviewHash`
in required hashes. Customer-facing feedback handoffs also carry
`humanFeedbackRevisionContractHash` in the required hashes and payload for
`customer_message`, `live_submit` / EPWK `workModifyLive`, and
`acceptance_apply`; only customer-message handoffs carry `messagePreviewHash`.
Prompt-generation spend previews carry the redacted `promptGenerationBinding`
in both required hashes and payload.

## Runner Rules

A preview becomes `dry_run_ready` only when:

- manifest kind is `ChannelActionManifest`
- manifest status is `ready_for_adapter`
- stored manifest hash is present and matches the recomputed manifest content
  hash
- the stored identity comes from `manifestHash`; generic `hash` is only checked
  as the matching file/content binding and is never used as a substitute when
  `manifestHash` is stripped
- customer-message manifests carry a concrete message preview and
  `messagePreviewHash`, and the runner rehashes the preview text before
  producing a dry-run preview using
  `computeCustomerMessagePreviewHash(messagePreview)` from `src/contracts.mjs`
- human-feedback customer-facing manifests, including direct manifests
  identified only by `packageRole`, `reviewType`, or `role`, carry
  `humanFeedbackRevisionContractHash`
- provider/model spend manifests carry a complete `promptGenerationBinding`
  with design retrieval, compiler, readiness, prompt-production contract,
  generation job, and generation prompt-production contract hashes; a manifest
  that strips this binding and recomputes `manifestHash` stays blocked at the
  runner boundary
- adapter action ID is present
- approval hash is present
- evidence hash is present
- `execute` is not requested

Blocked manifests remain `blocked_run`. Passing `execute: true` is always
blocked with `execute_not_allowed_in_core_stub`.

## Safety

`AdapterRunPreview.safety.executesExternalAction` is always `false`, and
`readyForExecution` is always `false`.

The real channel adapter runner must live outside core and must re-check the
manifest hash, approval hash, evidence hash, channel capability, duplicate
preflight, prompt-generation binding when present, and current-chat approval
before doing any external action.

The preview carries `previewHash` so a later `AdapterRunReceipt` can prove the
runner executed against the exact dry-run handoff that was reviewed. The source
helper is `computeAdapterRunPreviewHash(preview)` from `src/adapter-runner.mjs`;
it canonicalizes preview payload action/product/workflow aliases before hashing,
and also canonicalizes package/review role aliases before hashing, matching
`computeChannelActionManifestHash()` for the manifest snapshot.
