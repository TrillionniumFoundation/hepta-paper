import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const issuedCapabilities = new WeakMap();

const POLICIES = Object.freeze({
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
  'test-artifact-repository': Object.freeze({
    writerId: 'test-artifact-repository',
    writerKind: 'content-addressed-repository',
    assurance: 'test_only',
    allowedKinds: ['ArtifactWriteReceipt'],
    allowedStreams: ['artifact-writes'],
  }),
});

export function receiptIssuerPolicies() {
  return Object.freeze(Object.fromEntries(Object.entries(POLICIES).map(([policyId, policy]) => [policyId, {
    ...policy,
    issuerPolicyHash: hashRecord('ReceiptIssuerPolicy', { version: 1, policyId, ...policy }),
  }])));
}

export function issueReceiptWriterCapability(policyId) {
  const policy = POLICIES[policyId];
  if (!policy) throw new Error(`receipt issuer policy not registered:${policyId}`);
  const descriptor = Object.freeze({
    version: 1,
    kind: 'ReceiptWriterCapability',
    policyId,
    ...policy,
    issuerPolicyHash: hashRecord('ReceiptIssuerPolicy', { version: 1, policyId, ...policy }),
  });
  const capability = Object.freeze({ policyId, issuerPolicyHash: descriptor.issuerPolicyHash });
  issuedCapabilities.set(capability, descriptor);
  return capability;
}

export function resolveReceiptWriterCapability(capability) {
  return capability && typeof capability === 'object' ? issuedCapabilities.get(capability) || null : null;
}
