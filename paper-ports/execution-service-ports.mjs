import { assertArtifactRepository } from './artifact-repository-port.mjs';
import { assertCampaignStorePort } from './campaign-store-port.mjs';
import { assertJobReceiptStorePort } from './job-receipt-store-port.mjs';
import { assertReceiptLedgerPort } from './receipt-ledger-port.mjs';
import { assertRuntimeRetentionReachabilityProvider } from './runtime-retention-reachability-provider-port.mjs';
import { assertStorePort } from './store-port.mjs';

function requireMethods(value, kind, methods) {
  for (const method of methods) {
    if (typeof value?.[method] !== 'function') throw new Error(`${kind}.${method} is required`);
  }
  return value;
}

export function assertArtifactRepositoryFactoryPort(factory) {
  if (typeof factory !== 'function') throw new Error('ArtifactRepositoryFactoryPort must be a function');
  return (...args) => assertArtifactRepository(factory(...args));
}

export function assertPersistenceSessionPort(session) {
  if (Number(session?.version || 0) < 1 || session?.kind !== 'ScopedPersistenceSessionPort') {
    throw new Error('PersistenceSessionPort v1 is required');
  }
  return requireMethods(session, 'PersistenceSessionPort', ['available', 'close']);
}

export function assertSchemaVersionReceipt(value) {
  if (value?.version !== 1 || value?.kind !== 'ScopedSchemaVersionGateReceipt') {
    throw new Error('ScopedSchemaVersionGateReceipt v1 is required');
  }
  if (!['scoped_schema_version_verified', 'scoped_schema_gate_unavailable_read_only_store'].includes(value.status)) {
    throw new Error('ScopedSchemaVersionGateReceipt.status is invalid');
  }
  if (!Array.isArray(value.blockers) || value.blockers.length) {
    throw new Error('ScopedSchemaVersionGateReceipt must be blocker free');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(String(value.scopedSchemaVersionGateReceiptHash || ''))) {
    throw new Error('ScopedSchemaVersionGateReceipt hash is required');
  }
  return value;
}

export function assertResourceGovernorPort(governor) {
  if (Number(governor?.version || 0) < 1) throw new Error('ResourceGovernorPort.version 1 is required');
  return requireMethods(governor, 'ResourceGovernorPort', ['acquire', 'snapshot']);
}

export function assertResourceGovernorFactoryPort(factory) {
  if (typeof factory !== 'function') throw new Error('ResourceGovernorFactoryPort must be a function');
  return (...args) => assertResourceGovernorPort(factory(...args));
}

export function assertWorkspaceRegistryPort(registry) {
  if (Number(registry?.version || 0) < 1) throw new Error('WorkspaceRegistryPort.version 1 is required');
  return requireMethods(registry, 'WorkspaceRegistryPort', [
    'register', 'transition', 'recordSnapshot', 'qualifyForRetention', 'list',
    'retentionRecords', 'reconcileMissingEligible',
  ]);
}

export function assertTheoremQualityRevisionSinkPort(sink) {
  return requireMethods(sink, 'TheoremQualityRevisionSinkPort', ['record']);
}

export function assertPackageLifecycleAuthorityPort(authority) {
  if (Number(authority?.version || 0) < 1
    || authority?.kind !== 'PackageLifecycleAuthorityService') {
    throw new Error('PackageLifecycleAuthorityPort.version 1 is required');
  }
  return requireMethods(authority, 'PackageLifecycleAuthorityPort', [
    'prepareCurrentReleaseRecording', 'reconcileCampaign', 'reconcile',
  ]);
}

export function assertSubmissionDeliveryStorePort(store) {
  if (Number(store?.version || 0) < 1) throw new Error('SubmissionDeliveryStorePort.version 1 is required');
  return requireMethods(store, 'SubmissionDeliveryStorePort', [
    'enqueueAuthorized', 'registerProviderCapability', 'claimPending', 'heartbeatClaim',
    'getOutbox', 'listOutbox', 'recordResponse', 'quarantineInvalidIntake',
    'scheduleRedrive', 'enqueueRedrive', 'deadLetter', 'release',
  ]);
}

export function assertTrustedResearchReceiptWritersPort(writers) {
  const expected = ['experimentWorker', 'experimentReproducibility', 'formalAdapter', 'formalExecution'];
  const actual = Object.keys(writers || {}).sort();
  if (actual.length !== expected.length || expected.sort().some((name, index) => actual[index] !== name)) {
    throw new Error('TrustedResearchReceiptWritersPort shape is invalid');
  }
  for (const name of expected) assertReceiptLedgerPort(writers[name]);
  return writers;
}

export function assertSubmissionExecutorDescriptorValue(value) {
  if (value == null) return value;
  if (value?.version !== 1 || value?.kind !== 'SubmissionExecutorDescriptor') {
    throw new Error('SubmissionExecutorDescriptorValue v1 is required');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(String(value.submissionExecutorDescriptorHash || ''))) {
    throw new Error('SubmissionExecutorDescriptorValue hash is required');
  }
  return value;
}

export function assertLegacyStorePort(store) {
  return assertStorePort(store);
}

export {
  assertCampaignStorePort,
  assertJobReceiptStorePort,
  assertRuntimeRetentionReachabilityProvider,
};
