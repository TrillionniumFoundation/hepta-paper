# Adapter Runner Registry

`src/adapter-runner-registry.mjs` turns ready
`AdapterRunnerCapability` descriptors into a deterministic local registry.

The registry owns two jobs:

- validate that registered runners are ready and channel-owned
- select a runner capability by `channelId` and `actionId`

It blocks:

- empty capability sets
- non-capability inputs
- blocked runner capabilities
- runner locations that point back into `design-production-core`
- duplicate runner IDs
- duplicate channel/action routes
- registries or selections that claim core execution permission
- unsupported channel/action selections

## Output

`buildAdapterRunnerRegistry({ capabilities })` returns an
`AdapterRunnerRegistry` with redacted runner entries, route rows, blockers, and a
deterministic `registryHash`.

`selectAdapterRunnerCapability({ registry, channelId, actionId })` returns an
`AdapterRunnerSelection` with the selected runner ID and capability hash, or a
blocked selection when the route is unavailable or the registry is not ready.

`computeAdapterRunnerRegistryHash(registry)` and
`computeAdapterRunnerSelectionHash(selection)` are the source helpers for these
digests. Selection, assignment, and readiness checks recompute the relevant
content hash so a descriptor with edited routes or runner identity cannot pass
by carrying an old hash string.

## Boundary

The registry is not a scheduler and not a runner. It never runs adapters,
uploads, submits, sends messages, accepts delivery, pays, deploys, fetches
channel state, applies lifecycle state, or grants permission.

A ready selection only says which external runner capability matches the
channel/action. The selected runner still needs a ready dispatch assignment and
must re-check current approval, fresh evidence, replay guard, duplicate/channel
state, and current-chat authorization before any external action.
