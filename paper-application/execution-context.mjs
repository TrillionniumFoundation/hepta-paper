// Application execution boundary; concrete services are supplied by the composition root.
import path from 'node:path';
import { assertArtifactRepositoryFactoryPort, assertCampaignStorePort, assertJobReceiptStorePort, assertLegacyStorePort, assertPersistenceSessionPort, assertResourceGovernorFactoryPort, assertSchemaVersionReceipt, assertSubmissionDeliveryStorePort, assertSubmissionExecutorDescriptorValue, assertTheoremQualityRevisionSinkPort, assertTrustedResearchReceiptWritersPort, assertWorkspaceRegistryPort } from '../paper-ports/execution-service-ports.mjs';
import { assertAuthorityVerifierPort } from '../paper-ports/authority-verifier-port.mjs';
import { assertCampaignReleaseAuthorityPort } from '../paper-ports/campaign-release-authority-port.mjs';
import { createCampaignReleaseQueryCapability } from '../paper-ports/campaign-release-query-port.mjs';
import { assertCampaignReleasePackagerPort } from '../paper-ports/campaign-release-packager-port.mjs';
import { assertCampaignResearchVerifierPort } from '../paper-ports/campaign-research-verifier-port.mjs';
import { assertClockPort } from '../paper-ports/clock-port.mjs';
import { assertExperimentRegistryAuthorityVerifierPort } from '../paper-ports/experiment-registry-authority-verifier-port.mjs';
import { assertInventoryRepositoryPort } from '../paper-ports/inventory-repository-port.mjs';
import { assertIdGeneratorPort } from '../paper-ports/id-generator-port.mjs';
import { assertJournalPolicyPort } from '../paper-ports/journal-policy-port.mjs';
import { assertPaperStageExecutionPort } from '../paper-ports/paper-stage-execution-port.mjs';
import { assertReceiptLedgerPort } from '../paper-ports/receipt-ledger-port.mjs';
import { assertSchedulerPort } from '../paper-ports/scheduler-port.mjs';
import { assertRefereeIssueQueryPort } from '../paper-ports/referee-issue-query-port.mjs';
import { assertUnitOfWorkPort } from '../paper-ports/unit-of-work-port.mjs';
import { assertWorkflowStatePort } from '../paper-ports/workflow-state-port.mjs';

const SERVICE_PROFILE_REQUIREMENTS = Object.freeze({
  handoff: Object.freeze([
    'campaignReleaseQuery',
    'persistenceSession',
    'schemaVersion',
  ]),
  inventory: Object.freeze([
    'artifactRepositoryFactory',
    'clock',
    'inventoryRepository',
    'persistenceSession',
    'receiptLedger',
    'schemaVersion',
    'unitOfWork',
    'refereeIssueQuery',
  ]),
  automation: Object.freeze([
    'artifactRepositoryFactory',
    'campaignStore',
    'clock',
    'idGenerator',
    'experimentRegistryAuthorityVerifier',
    'inventoryRepository',
    'persistenceSession',
    'receiptLedger',
    'releasePackager',
    'researchVerifier',
    'resourceGovernorFactory',
    'scheduler',
    'schemaVersion',
    'theoremQualityRevisionSink',
    'unitOfWork',
    'refereeIssueQuery',
    'workspaceRegistry',
  ]),
  batch: Object.freeze([
    'artifactRepositoryFactory',
    'clock',
    'inventoryRepository',
    'persistenceSession',
    'authorityVerifier',
    'receiptLedger',
    'jobReceiptStore',
    'nativeResearchWorkerJobReceiptStore',
    'stageExecution',
    'journalPolicy',
    'unitOfWork',
    'refereeIssueQuery',
    'schemaVersion',
  ]),
  submission: Object.freeze([
    'artifactRepositoryFactory',
    'campaignReleaseAuthorityRepository',
    'clock',
    'inventoryRepository',
    'persistenceSession',
    'authorityVerifier',
    'receiptLedger',
    'jobReceiptStore',
    'nativeResearchWorkerJobReceiptStore',
    'stageExecution',
    'journalPolicy',
    'unitOfWork',
    'refereeIssueQuery',
    'submissionDeliveryStore',
    'schemaVersion',
  ]),
  legacy: Object.freeze([
    'store',
    'artifactRepositoryFactory',
    'clock',
    'authorityVerifier',
    'receiptLedger',
    'jobReceiptStore',
    'nativeResearchWorkerJobReceiptStore',
    'workflowStateStore',
    'stageExecution',
    'journalPolicy',
    'unitOfWork',
    'refereeIssueQuery',
    'submissionDeliveryStore',
  ]),
});

const CAPABILITIES_BY_PROFILE = Object.freeze({
  handoff: Object.freeze(['submission-release-read']),
  inventory: Object.freeze(['artifact-repository', 'inventory-read', 'receipt-ledger', 'typed-persistence']),
  automation: Object.freeze(['artifact-repository', 'automation-coordination', 'receipt-ledger', 'typed-persistence']),
  batch: Object.freeze(['artifact-repository', 'batch-workflow', 'receipt-ledger', 'research-jobs', 'typed-persistence']),
  submission: Object.freeze(['artifact-repository', 'batch-workflow', 'receipt-ledger', 'research-jobs', 'submission-delivery', 'submission-policy', 'typed-persistence']),
  legacy: Object.freeze(['legacy-full-service-facade']),
});

function normalizeService(name, value, profile, allServices) {
  // Optional services may be present as explicit null compatibility slots.
  // Required null values have already been rejected above.
  if (value == null) return value;
  switch (name) {
    case 'artifactRepositoryFactory': return assertArtifactRepositoryFactoryPort(value);
    case 'authorityVerifier': return assertAuthorityVerifierPort(value);
    case 'campaignReleaseAuthorityRepository': return assertCampaignReleaseAuthorityPort(value);
    case 'campaignReleaseQuery': return createCampaignReleaseQueryCapability(value);
    case 'campaignStore': return assertCampaignStorePort(value);
    case 'clock': return assertClockPort(value);
    case 'experimentRegistryAuthorityVerifier': return assertExperimentRegistryAuthorityVerifierPort(value);
    case 'inventoryRepository': return assertInventoryRepositoryPort(value);
    case 'idGenerator': return assertIdGeneratorPort(value);
    case 'jobReceiptStore':
    case 'nativeResearchWorkerJobReceiptStore': return assertJobReceiptStorePort(value);
    case 'journalPolicy': return assertJournalPolicyPort(value);
    case 'persistenceSession': return assertPersistenceSessionPort(value);
    case 'receiptLedger':
    case 'runtimeRetentionReceiptLedger': return assertReceiptLedgerPort(value);
    case 'refereeIssueQuery': return assertRefereeIssueQueryPort(value);
    case 'releasePackager': return assertCampaignReleasePackagerPort(value);
    case 'researchVerifier': return assertCampaignResearchVerifierPort(value);
    case 'resourceGovernorFactory': return assertResourceGovernorFactoryPort(value);
    case 'schemaVersion': return assertSchemaVersionReceipt(value);
    case 'scheduler': return assertSchedulerPort(value);
    case 'store': return assertLegacyStorePort(value);
    case 'submissionDeliveryStore': return assertSubmissionDeliveryStorePort(value);
    case 'submissionExecutorDescriptor': return assertSubmissionExecutorDescriptorValue(value);
    case 'stageExecution': return assertPaperStageExecutionPort(value, {
      requireSubmission: profile === 'submission' || Boolean(allServices.campaignReleaseAuthorityRepository),
    });
    case 'theoremQualityRevisionSink': return assertTheoremQualityRevisionSinkPort(value);
    case 'trustedResearchReceiptWriters': return assertTrustedResearchReceiptWritersPort(value);
    case 'unitOfWork': return assertUnitOfWorkPort(value);
    case 'workspaceRegistry': return assertWorkspaceRegistryPort(value);
    case 'workflowStateStore': return assertWorkflowStatePort(value);
    default:
      if (profile === 'legacy') return value;
      throw new Error(`ExecutionContext service has no declared port: ${name}`);
  }
}

function normalizeExecutionServices(profile, services) {
  const required = SERVICE_PROFILE_REQUIREMENTS[profile];
  if (!required) throw new Error(`Unknown ExecutionContext service profile: ${profile}`);
  const missing = required.filter((name) => !services?.[name]);
  if (missing.length) throw new Error(`ExecutionContext ${profile} services missing: ${missing.join(',')}`);
  return Object.freeze(Object.fromEntries(Object.entries(services).map(([name, value]) => [
    name,
    normalizeService(name, value, profile, services),
  ])));
}

function deriveCapabilities(profile, services) {
  const capabilities = [...CAPABILITIES_BY_PROFILE[profile]];
  if (profile === 'batch' && services.campaignReleaseAuthorityRepository) capabilities.push('submission-policy');
  if (profile === 'batch' && services.submissionDeliveryStore) capabilities.push('submission-delivery');
  return Object.freeze([...new Set(capabilities)].sort());
}

export const EXECUTION_SERVICE_PROFILES = Object.freeze(Object.fromEntries(
  Object.entries(SERVICE_PROFILE_REQUIREMENTS).map(([profile, requiredServices]) => [
    profile,
    Object.freeze({ profile, requiredServices }),
  ]),
));

export function createExecutionContext({
  root,
  runtimeRoot,
  mode,
  execute = false,
  writeReport = false,
  serviceProfile,
  capabilities = [],
  options = {},
  services = {},
} = {}) {
  if (!root) throw new Error('ExecutionContext root is required');
  if (!runtimeRoot) throw new Error('ExecutionContext runtimeRoot is required');
  if (!mode) throw new Error('ExecutionContext mode is required');
  if (!EXECUTION_SERVICE_PROFILES[serviceProfile]) throw new Error(`Unknown ExecutionContext service profile: ${serviceProfile}`);
  const validatedServices = normalizeExecutionServices(serviceProfile, services);
  const derivedCapabilities = deriveCapabilities(serviceProfile, validatedServices);
  const declaredCapabilities = [...new Set(capabilities.map(String))].sort();
  if (declaredCapabilities.length !== derivedCapabilities.length
    || declaredCapabilities.some((item, index) => item !== derivedCapabilities[index])) {
    throw new Error(`ExecutionContext ${serviceProfile} capability declaration does not match validated services`);
  }
  return Object.freeze({
    version: 1,
    kind: 'PaperExecutionContext',
    root: path.resolve(root),
    runtimeRoot: path.resolve(runtimeRoot),
    mode,
    execute: Boolean(execute),
    writeReport: Boolean(writeReport),
    serviceProfile,
    capabilities: derivedCapabilities,
    options: Object.freeze({ ...options }),
    services: validatedServices,
    safety: Object.freeze({
      externalActionAllowed: false,
      legacyControlPlaneImportsAllowed: false,
      writesMustUseDeclaredPort: true,
      rawStoreExposed: serviceProfile === 'legacy',
    }),
  });
}

export function assertExecutionServices(context) {
  const profile = context?.serviceProfile;
  normalizeExecutionServices(profile, context?.services || {});
  return context.services;
}
