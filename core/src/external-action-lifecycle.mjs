export const EXTERNAL_ACTION_LIFECYCLE_SURFACE_VERSION = 1;

export const EXTERNAL_ACTION_LIFECYCLE_PUBLIC_MODULE_IDS = Object.freeze([
  'external-action-lifecycle-schema',
  'adapter-runner',
  'adapter-runner-capabilities',
  'adapter-runner-registry',
  'adapter-handoff-outbox',
  'adapter-runner-sdk',
  'adapter-receipt',
  'adapter-receipt-inbox',
  'channel-state-proof',
  'channel-state-proof-inbox',
  'receipt-state-transition-inbox',
  'adapter-dispatch-envelope',
  'adapter-dispatch-assignment',
  'adapter-dispatch-readiness-report',
  'adapter-dispatch-receipt-inbox',
  'adapter-dispatch-channel-state-proof-inbox',
  'adapter-dispatch-receipt-state-transition-inbox',
  'external-action-ledger',
  'external-action-audit-bundle',
  'external-action-audit-archive',
  'external-action-replay-guard',
  'dispatch-replay-cycle-invariant',
  'post-action-runtime-status',
]);

export function summarizeExternalActionLifecycleSurface() {
  return {
    version: EXTERNAL_ACTION_LIFECYCLE_SURFACE_VERSION,
    kind: 'ExternalActionLifecycleSurface',
    moduleIds: [...EXTERNAL_ACTION_LIFECYCLE_PUBLIC_MODULE_IDS],
    moduleCount: EXTERNAL_ACTION_LIFECYCLE_PUBLIC_MODULE_IDS.length,
    safety: {
      readOnly: true,
      executesExternalAction: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      deploys: false,
      fetchesChannelState: false,
      appliesLocalStateTransition: false,
      grantsExecutionPermission: false,
    },
  };
}

export * from './external-action-lifecycle-schema.mjs';
export * from './adapter-runner.mjs';
export * from './adapter-runner-capabilities.mjs';
export * from './adapter-runner-registry.mjs';
export * from './adapter-handoff-outbox.mjs';
export * from './adapter-runner-sdk.mjs';
export * from './adapter-receipt.mjs';
export * from './adapter-receipt-inbox.mjs';
export * from './channel-state-proof.mjs';
export * from './channel-state-proof-inbox.mjs';
export * from './receipt-state-transition-inbox.mjs';
export * from './adapter-dispatch-envelope.mjs';
export * from './adapter-dispatch-assignment.mjs';
export * from './adapter-dispatch-readiness-report.mjs';
export * from './adapter-dispatch-receipt-inbox.mjs';
export * from './adapter-dispatch-channel-state-proof-inbox.mjs';
export * from './adapter-dispatch-receipt-state-transition-inbox.mjs';
export * from './external-action-ledger.mjs';
export * from './external-action-audit-bundle.mjs';
export * from './external-action-audit-archive.mjs';
export * from './external-action-replay-guard.mjs';
export * from './dispatch-replay-cycle-invariant.mjs';
export * from './post-action-runtime-status.mjs';
