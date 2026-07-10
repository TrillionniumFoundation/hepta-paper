# Channel Adapter Interface

`src/channel-adapter-interface.mjs` defines one read-only contract for every production channel adapter.

It currently covers:

- `zbj` -> `channelTaskFromZbj`, runner `zbj-auto-intake.live-runner`
- `epwk` -> `channelTaskFromEpwk`, runner `epwk-auto-intake.live-runner`
- `hepta` -> `channelTaskFromHepta`, runner `hepta.delivery-runner`

Each `ChannelAdapterInterface` records:

- task source kinds and the normalizer export that must produce `ChannelTask`
- supported adapter action IDs and their external action class
- runner location, read-only probes, and required execution boundaries
- channel capabilities from `contracts.mjs`
- redacted-by-default source snapshot policy
- safety flags proving the descriptor does not execute anything

`buildChannelAdapterInterfaceSet()` builds the ZBJ / EPWK / Hepta set and hashes the interface list. `validateChannelAdapterInterfaceArtifact()` can validate either one adapter interface or the whole set.

Each adapter interface and interface set must preserve its semantic hash alias
(`adapterInterfaceHash` / `interfaceSetHash`) alongside the generic `hash`.
Validators reject missing or mismatched aliases before treating the descriptor as
coverage evidence for runner handoff surfaces. Generic `hash` is only a matching
content binding and is never used as a substitute when the semantic alias is
stripped.

Runner locations must point to external sibling workspaces, not back into
`design-production-core`. Core-local paths such as `.`, `./src`, or
`../design-production-core` are blocked at the adapter-interface layer before
runner capabilities or dispatch handoffs are built.

The interface is a contract, not a runner. It never opens browser/API sessions, uploads, submits, sends messages, applies acceptance, fetches channel state, pays, deploys, grants execution permission, or replaces approval/evidence/replay/duplicate gates.
