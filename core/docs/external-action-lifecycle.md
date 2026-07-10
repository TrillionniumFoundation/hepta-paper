# External Action Lifecycle Facade

`external-action-lifecycle` is the stable facade for the external-action
control plane and is exported through the package root.

It intentionally gathers the previously scattered runner handoff, capability,
registry, receipt, proof, inbox, dispatch, ledger, audit, replay, and lifecycle
schema helpers behind one public facade. Channel adapters can still keep their
platform-specific evidence collectors, but they should not need to know every
internal receipt/proof/inbox module name.

Use it like this:

```js
import {
  buildAdapterRunPreview,
  buildAdapterRunReceipt,
  buildChannelStateProof,
  buildExternalActionLedgerEntry,
  buildExternalActionLifecycleSchema,
  buildPostActionRuntimeStatus,
  validateExternalActionLifecycleChain,
} from 'design-production-core';
```

`buildPostActionRuntimeStatus` is the stable summary helper for downstream code
that needs the whole post-action closure without importing individual matrix
modules. Pass it the existing runtime and post-action matrix report objects; it
checks stage ok/hash fields, 20-route and 7-action-class coverage, and upstream
hash continuity through reconciliation. It also carries the runtime dry-run
external runner-location summary, so callers can verify that all ready handoffs
stay in sibling workspaces. The helper only summarizes provided report objects
and does not read files or write reports.

The facade is contract-only. It does not execute adapters, upload, submit, send
messages, accept delivery, pay, deploy, fetch channel state, apply local state
transitions, or grant execution permission.
