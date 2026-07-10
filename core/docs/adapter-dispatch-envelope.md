# Adapter Dispatch Envelope

`src/adapter-dispatch-envelope.mjs` is the final core-owned handoff descriptor
before an external channel runner inspects work.

It combines:

- a queued `AdapterHandoffOutboxItem`
- a clear `ExternalActionReplayGuardDecision`

The envelope blocks dispatch when the outbox is not queued, the outbox hash is
tampered, the replay guard is missing or not clear, or the replay guard candidate
does not match the outbox task/action identity, outbox hash, customer-message
`messagePreviewHash`, or human-feedback
`humanFeedbackRevisionContractHash`. Prompt-driven provider/model spend
handoffs also require the replay guard candidate to preserve the same
`promptGenerationBinding`, and the source outbox must carry customer-message
`messagePreviewHash`, human-feedback
`humanFeedbackRevisionContractHash`, and prompt/generation binding across
payload, runner required hashes, and manifest/preview snapshots. Prompt-driven
provider/model spend bindings must also carry all six semantic fields. A
recomputed customer-message, human-feedback, or provider/model spend outbox
that strips or truncates these source bindings remains blocked even if a forged
replay guard object claims `clear`.
The source outbox must also preserve core runner hashes for manifest, preview,
approval, and evidence. Recomputing `outboxHash` after stripping those
`runner.requiredHashes` leaves the dispatch envelope blocked; route-specific
customer-message, human-feedback, prompt-generation, and ledger hashes are
required when the route carries them.
Dispatch also rechecks the outbox's manifest/preview snapshot identity. A
forged queued outbox with a recomputed `outboxHash` but mismatched
manifest/preview channel/action/task/external/product/workflow/package-role
identity is blocked with `outbox_handoff_snapshot_identity_mismatch`.
This includes replay guards backed by dispatch audit archives: if the dispatch
archive says the same task/action was already archived, the envelope remains
blocked unless a repeat-approved guard is supplied.
Archive-loop fixtures cover the same rule after a dispatch replay-guard bundle
has been archived: repeat-approved same task/action can ready a new descriptor,
but exact bundle/ledger replay and mismatched candidates remain blocked.

## Output

`buildAdapterDispatchEnvelope({ outboxItem, replayGuardDecision })` returns an
`AdapterDispatchEnvelope` with:

- `status`: `ready_adapter_dispatch_envelope` or `blocked_adapter_dispatch_envelope`
- `runner.requiredHashes`: outbox, replay guard, manifest, preview, approval,
  evidence, optional archive, optional human-feedback revision contract,
  optional customer-message preview / ledger hashes, plus optional
  prompt/generation binding
- `runner.handoffSnapshots`: the concrete manifest/preview snapshots whose
  stored hashes must match `runner.requiredHashes`
- `payload`: redacted task/action/artifact identity
- `dispatchEnvelopeHash`: deterministic hash of the descriptor

`computeAdapterDispatchEnvelopeHash(envelope)` is the source helper for that
hash. It canonicalizes adapter action aliases and human-feedback
product/workflow aliases before digesting, so prebuilt descriptors using
`consumer-feedback-message`, `consumer_feedback`, or `buyer-feedback` hash to
the same identity as builder-created `customer_message` / `human_feedback`
descriptors.

## Boundary

A ready dispatch envelope is still not execution permission. It only gives an
external runner a hash-bound descriptor to inspect. The runner must recompute
the manifest and preview snapshot hashes, then still re-check approval,
evidence, current channel state, and append an adapter receipt after any real
action.

The module never runs adapters, uploads, submits, sends customer messages,
accepts delivery, pays, deploys, fetches channel state, applies lifecycle state,
or grants execution permission.
