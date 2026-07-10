# Adapter Runner Capabilities

`src/adapter-runner-capabilities.mjs` describes what an external channel runner
claims it can handle before the control plane sends it a dispatch envelope.

The capability descriptor records:

- runner ID and channel ID
- supported adapter action IDs
- runner location hint
- whether the external runner may execute real side effects
- mandatory policy requirements: explicit execute flag, current approval, fresh
  evidence, and replay guard

## Why It Exists

`AdapterDispatchEnvelope` is only a handoff descriptor. Before a channel-specific
runner consumes one, the control plane needs a redacted, selftestable contract
that says the runner belongs to the channel and will re-check the same gates.

The capability check blocks:

- missing runner ID
- unknown channel
- empty action list
- action IDs owned by another channel
- runner locations that do not point to an external sibling workspace
- runners that do not require explicit execute flags
- runners that do not require current approval or fresh evidence
- descriptors that do not declare the external runner boundary

`computeAdapterRunnerCapabilityHash(capability)` is the source helper for the
capability digest. Runner registries and dispatch assignments re-run this
helper against supplied capability objects instead of trusting a copied
`capabilityHash` string.

## Boundary

The capability module is descriptor-only. It never runs the runner, opens a
browser, calls providers, uploads, submits, sends messages, accepts delivery,
pays, deploys, fetches channel state, applies lifecycle state, or grants
permission.

Executable runner descriptors must keep `runnerLocation` outside
`design-production-core`, for example `../zbj-auto-intake`,
`../epwk-auto-intake`, or `../hepta`. Core-local paths such as `.`, `./src`, or
`../design-production-core` are blocked before registry, dispatch assignment,
readiness, or SDK handoff.

`runnerMayExecuteExternalAction=true` means only that a ready external runner
declares it is capable of side effects outside core. It is not approval and does
not bypass the action manifest, replay guard, dispatch envelope, receipt,
channel-state proof, or current-chat authorization gates.
