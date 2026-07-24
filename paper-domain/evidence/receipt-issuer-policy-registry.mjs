import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const DEFINITIONS = Object.freeze({
  'artifact-repository': Object.freeze({
    writerId: 'filesystem-artifact-repository',
    writerKind: 'content-addressed-repository',
    assurance: 'in_process_registered_issuer',
    allowedKinds: ['ArtifactWriteReceipt', 'ArtifactGarbageCollectionReceipt'],
    allowedStreams: ['artifact-writes', 'artifact-retention'],
  }),
  'production-capability-verifier': Object.freeze({
    writerId: 'production-capability-verifier',
    writerKind: 'capability-verifier',
    assurance: 'in_process_registered_issuer',
    allowedKinds: ['CapabilityVerificationReceipt'],
    allowedStreams: ['capability-verification'],
  }),
  'production-capability-artifact-repository': Object.freeze({
    writerId: 'production-capability-artifact-repository',
    writerKind: 'content-addressed-repository',
    assurance: 'in_process_registered_issuer',
    allowedKinds: ['ArtifactWriteReceipt'],
    allowedStreams: ['artifact-writes'],
  }),
  'conformance-replay': Object.freeze({
    writerId: 'production-source-conformance-replay',
    writerKind: 'isolated-conformance-runner',
    assurance: 'local_admin_delegated_conformance',
    allowedKinds: [
      'ArtifactWriteReceipt',
      'ExperimentWorkerExecutionReceipt',
      'ExperimentReproducibilityReceipt',
      'OperationalJobResultReceipt',
      'ResearchGapPlanBindingReceipt',
      'ResearchGapPlanningReceipt',
      'SubmissionResponsePersistedReceipt',
    ],
    allowedStreams: [
      'artifact-writes',
      'experiment-workers',
      'experiment-reproducibility',
      'jobs',
      'research-gap-jobs',
      'submission-delivery',
    ],
  }),
  'native-research-worker': Object.freeze({
    writerId: 'native-research-worker-runtime',
    writerKind: 'native-research-worker',
    assurance: 'in_process_registered_issuer',
    allowedKinds: ['NativeResearchWorkerExecutionReceipt'],
    allowedStreams: ['jobs'],
  }),
  'experiment-worker': Object.freeze({
    writerId: 'experiment-worker-runtime',
    writerKind: 'experiment-worker',
    assurance: 'in_process_registered_issuer',
    allowedKinds: ['ExperimentWorkerExecutionReceipt'],
    allowedStreams: ['experiment-workers'],
  }),
  'experiment-reproducibility': Object.freeze({
    writerId: 'experiment-reproducibility-runtime',
    writerKind: 'experiment-reproducibility-verifier',
    assurance: 'in_process_registered_issuer',
    allowedKinds: ['ExperimentReproducibilityReceipt'],
    allowedStreams: ['experiment-reproducibility'],
  }),
  'formal-adapter-bootstrap': Object.freeze({
    writerId: 'formal-adapter-bootstrap',
    writerKind: 'formal-adapter-bootstrap',
    assurance: 'in_process_registered_issuer',
    allowedKinds: ['FormalVerifierAdapterReceipt'],
    allowedStreams: ['formal-verifier-adapters'],
  }),
  'formal-verifier-runner': Object.freeze({
    writerId: 'formal-verifier-runner',
    writerKind: 'formal-verifier-runner',
    assurance: 'in_process_registered_issuer',
    allowedKinds: ['FormalVerifierExecutionReceipt'],
    allowedStreams: ['formal-verifier-executions'],
  }),
  'ledger-administrator': Object.freeze({
    writerId: 'receipt-ledger-administrator',
    writerKind: 'append-only-ledger-administrator',
    assurance: 'in_process_registered_administrator',
    allowedKinds: ['ReceiptLedgerIntegrityRepairReceipt', 'RuntimeEvidenceHygieneReceipt'],
    allowedStreams: ['store-integrity', 'runtime-hygiene'],
  }),
  'automation-reconciler': Object.freeze({
    writerId: 'automation-runtime-reconciler',
    writerKind: 'automation-state-reconciler',
    assurance: 'in_process_registered_administrator',
    allowedKinds: ['AutomationRuntimeReconciliationReceipt'],
    allowedStreams: ['automation-reconciliation'],
  }),
  'store-administrator': Object.freeze({
    writerId: 'hepta-store-administrator',
    writerKind: 'native-store-administrator',
    assurance: 'in_process_registered_administrator',
    allowedKinds: ['HeptaStoreBackupReceipt', 'HeptaStoreRestoreDrillReceipt'],
    allowedStreams: ['store-admin'],
  }),
  'runtime-retention': Object.freeze({
    writerId: 'runtime-retention-administrator',
    writerKind: 'runtime-retention-administrator',
    assurance: 'in_process_registered_administrator',
    allowedKinds: ['RuntimeRetentionIntent', 'RuntimeRetentionReceipt'],
    allowedStreams: ['runtime-retention'],
  }),
  'package-lifecycle-authority': Object.freeze({
    writerId: 'package-lifecycle-authority',
    writerKind: 'append-only-package-lifecycle-authority',
    assurance: 'in_process_registered_administrator',
    allowedKinds: [
      'PackageLifecycleRecordingIntent',
      'PackageLifecycleReceipt',
      'PackageSupersessionReceipt',
      'PackageRetentionLegalHoldReceipt',
    ],
    allowedStreams: ['package-lifecycle-intents', 'package-lifecycle'],
  }),
  'workspace-snapshot-verifier': Object.freeze({
    writerId: 'workspace-snapshot-restore-verifier',
    writerKind: 'workspace-snapshot-verifier',
    assurance: 'in_process_registered_verifier',
    allowedKinds: ['WorkspaceSnapshotRestoreReceipt'],
    allowedStreams: ['workspace-snapshot-restore'],
  }),
  'workflow-state-projector': Object.freeze({
    writerId: 'workflow-state-projector',
    writerKind: 'workflow-state-projection-writer',
    assurance: 'in_process_registered_issuer',
    allowedKinds: ['PaperWorkflowStateProjectionReceipt'],
    allowedStreams: ['workflow-state'],
  }),
  'autonomous-submission-handoff': Object.freeze({
    writerId: 'autonomous-submission-handoff-state-writer',
    writerKind: 'autonomous-submission-handoff-state-machine',
    assurance: 'in_process_registered_issuer',
    allowedKinds: ['AutonomousSubmissionDeliveryStateReceipt'],
    allowedStreams: ['autonomous-submission-delivery'],
  }),
});

function materializePolicy(policyId, definition) {
  const normalized = Object.freeze({
    ...definition,
    allowedKinds: Object.freeze([...definition.allowedKinds]),
    allowedStreams: Object.freeze([...definition.allowedStreams]),
  });
  return Object.freeze({
    ...normalized,
    issuerPolicyHash: hashRecord('ReceiptIssuerPolicy', {
      version: 1,
      policyId,
      ...normalized,
    }),
  });
}

export const RECEIPT_ISSUER_POLICIES = Object.freeze(Object.fromEntries(
  Object.entries(DEFINITIONS).map(([policyId, definition]) => [
    policyId,
    materializePolicy(policyId, definition),
  ]),
));

export function receiptIssuerPolicies() {
  return RECEIPT_ISSUER_POLICIES;
}

export function resolveReceiptIssuerPolicy(policyId) {
  return RECEIPT_ISSUER_POLICIES[String(policyId || '')] || null;
}
