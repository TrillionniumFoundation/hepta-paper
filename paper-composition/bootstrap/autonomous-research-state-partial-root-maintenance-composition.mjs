import path from 'node:path';

import {
  buildAutonomousResearchStatePartialRootMaintenancePlan,
} from '../../paper-adapters/automation/autonomous-research-state-partial-root-maintenance-inspection.mjs';
import {
  executeAutonomousResearchStatePartialRootMaintenance,
} from '../../paper-adapters/automation/autonomous-research-state-partial-root-maintenance-execution-repository.mjs';
import {
  createAutonomousResearchMachineIntakeRepository,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-repository.mjs';
import {
  createAutonomousResearchRuntimeRefreshStateRepository,
} from '../../paper-adapters/automation/autonomous-research-runtime-refresh-state-repository.mjs';
import {
  createAutonomousResearchTopicProducerRepository,
} from '../../paper-adapters/automation/autonomous-research-topic-producer-repository.mjs';
import {
  createFullResearchQualificationReceiptPointerRepository,
} from '../../paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs';
import {
  createRuntimeImageReproducibilityReceiptRepository,
} from '../../paper-adapters/automation/runtime-image-reproducibility-receipt-repository.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import {
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import {
  normalizeRuntimeReproducibilityRefreshPolicy,
} from '../../paper-domain/automation/runtime-reproducibility-refresh-policy.mjs';
import {
  verifyAutonomousResearchMachineIntakeConfiguration,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-loader.mjs';
import {
  verifyAutonomousResearchTopicProducerProfile,
} from '../../paper-domain/automation/autonomous-research-topic-producer-contract.mjs';
import {
  fileSha256HashSync,
  readRegularJsonFileSync,
} from '../../paper-adapters/runtime/pinned-file-reader.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  resolveConfiguredAutonomousResearchStateProvisioningInputs,
} from './autonomous-research-state-provisioning-input-composition.mjs';

const IMPLEMENTATION_FILES = Object.freeze([
  'paper-adapters/automation/autonomous-research-machine-intake-repository.mjs',
  'paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs',
  'paper-adapters/automation/autonomous-research-runtime-refresh-state-repository.mjs',
  'paper-adapters/automation/autonomous-research-state-database-inventory.mjs',
  'paper-adapters/automation/autonomous-research-state-partial-root-maintenance-execution-repository.mjs',
  'paper-adapters/automation/autonomous-research-state-partial-root-maintenance-inspection.mjs',
  'paper-adapters/automation/autonomous-research-supervisor-external-action-journal-storage.mjs',
  'paper-adapters/automation/autonomous-research-topic-producer-repository.mjs',
  'paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs',
  'paper-adapters/automation/runtime-image-reproducibility-receipt-repository.mjs',
  'paper-composition/bootstrap/autonomous-research-state-partial-root-maintenance-composition.mjs',
]);

function implementationManifestHash(workspaceRoot) {
  const files = IMPLEMENTATION_FILES.map((relativePath) => Object.freeze({
    relativePath,
    sha256: fileSha256HashSync(path.join(workspaceRoot, relativePath)),
  }));
  return hashRecord('AutonomousResearchStatePartialRootMaintenanceImplementation', files);
}

function closeRepositories(repositories) {
  for (const repository of [...repositories].reverse()) {
    try { repository?.close?.(); } catch { /* retain provisioning failure */ }
  }
}

function disabledOfflineMutationAuthority() {
  return Object.freeze({
    consume() {
      throw new Error('autonomous_research_state_partial_root_offline_cannot_mutate');
    },
  });
}

function provisionMissingBusinessSchemas({
  runtimeRoot,
  machineIntakeConfiguration,
  machineIntakeGenesisAuthorityMode,
  topicProducerProfile,
  providerCanaryPairMaximumCostUsd,
  runtimeRefreshPolicy,
}) {
  const repositories = [];
  try {
    const topicProducer = createAutonomousResearchTopicProducerRepository({
      runtimeRoot,
      machineIntakeConfigurationHash: machineIntakeConfiguration.configurationHash,
      producerProfile: topicProducerProfile,
      providerCanaryPairMaximumCostUsd,
      liveMutationAuthority: disabledOfflineMutationAuthority(),
      create: true,
      offlineProvision: true,
    });
    repositories.push(topicProducer);
    repositories.push(createAutonomousResearchMachineIntakeRepository({
      runtimeRoot,
      create: true,
      authorizedSourceAuthorityHash: machineIntakeConfiguration.configurationHash,
      authorizedMachineProducerProfileHash: topicProducerProfile.producerProfileHash,
      machineProducerAppendAuthority: topicProducer,
      offlineProvision: true,
      genesisAuthorityMode: machineIntakeGenesisAuthorityMode,
    }));
    repositories.push(createAutonomousResearchRuntimeRefreshStateRepository({
      runtimeRoot,
      policy: runtimeRefreshPolicy,
      offlineProvision: true,
    }));
    createRuntimeImageReproducibilityReceiptRepository({
      runtimeRoot,
      offlineProvision: true,
    }).provision();
    createFullResearchQualificationReceiptPointerRepository({
      runtimeRoot,
      offlineProvision: true,
    }).provision();
  } finally { closeRepositories(repositories); }
}

function maintenanceIdentity({
  workspaceRoot,
  machineIntakeConfiguration,
  machineIntakeGenesisAuthorityMode,
  topicProducerProfile,
  runtimeRefreshPolicy,
  cost,
}) {
  return Object.freeze({
    implementationManifestHash: implementationManifestHash(workspaceRoot),
    machineIntakeConfigurationHash: machineIntakeConfiguration.configurationHash,
    machineIntakeGenesisAuthorityMode,
    providerCanaryPairMaximumCostUsd: cost,
    providerConfigurationHash: topicProducerProfile.providerConfigurationHash,
    runtimeReproducibilityRefreshPolicyHash:
      runtimeRefreshPolicy.runtimeReproducibilityRefreshPolicyHash,
    topicProducerProfileHash: topicProducerProfile.producerProfileHash,
    writerManifestHash: autonomousResearchOnlineWriterOperationManifestHash(
      AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
    ),
  });
}

export function composeAutonomousResearchStatePartialRootMaintenanceService({
  workspaceRoot,
  runtimeRoot,
  rescueRoot,
  writerQuiescenceReceipt,
  machineIntakeConfiguration,
  machineIntakeGenesisAuthorityMode = 'external',
  topicProducerProfile,
  runtimeReproducibilityPolicy,
  clock = { now: () => new Date() },
} = {}) {
  const cost = Number(topicProducerProfile?.maximumProviderCanaryCostUsdPerUtcDay)
    / Number(topicProducerProfile?.maximumProviderCanaryAttemptsPerUtcDay);
  if (!workspaceRoot || !runtimeRoot || !rescueRoot
    || !verifyAutonomousResearchMachineIntakeConfiguration(machineIntakeConfiguration)
    || machineIntakeConfiguration.version !== 2
    || !verifyAutonomousResearchTopicProducerProfile(topicProducerProfile)
    || machineIntakeConfiguration.machineProducerProfileHash
      !== topicProducerProfile.producerProfileHash
    || !['external', 'root-owned-configuration'].includes(machineIntakeGenesisAuthorityMode)
    || !Number.isFinite(cost) || cost <= 0) {
    throw new Error('autonomous_research_state_partial_root_configuration_invalid');
  }
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  const runtimeRefreshPolicy = normalizeRuntimeReproducibilityRefreshPolicy(
    runtimeReproducibilityPolicy,
  );
  const stateDatabaseManifest = readRegularJsonFileSync(path.join(
    resolvedWorkspaceRoot,
    'paper-core/config/autonomous-research-state-databases.v1.json',
  ));
  const identity = maintenanceIdentity({
    workspaceRoot: resolvedWorkspaceRoot,
    machineIntakeConfiguration,
    machineIntakeGenesisAuthorityMode,
    topicProducerProfile,
    runtimeRefreshPolicy,
    cost,
  });
  const shared = Object.freeze({
    runtimeRoot: resolvedRuntimeRoot,
    rescueRoot: path.resolve(rescueRoot),
    stateDatabaseManifest,
    maintenanceIdentity: identity,
    writerQuiescenceReceipt,
    clock,
  });
  return Object.freeze({
    plan() {
      return buildAutonomousResearchStatePartialRootMaintenancePlan(shared);
    },
    execute({ expectedMaintenancePlanId } = {}) {
      return executeAutonomousResearchStatePartialRootMaintenance({
        ...shared,
        expectedMaintenancePlanId,
        provisionMissingBusinessSchemas: ({ runtimeRoot: stagingRoot }) => (
          provisionMissingBusinessSchemas({
            runtimeRoot: stagingRoot,
            machineIntakeConfiguration,
            machineIntakeGenesisAuthorityMode,
            topicProducerProfile,
            providerCanaryPairMaximumCostUsd: cost,
            runtimeRefreshPolicy,
          })
        ),
      });
    },
  });
}

export function composeConfiguredAutonomousResearchStatePartialRootMaintenanceService({
  rescueRoot,
  writerQuiescenceReceiptPath,
  clock,
  ...options
} = {}) {
  const inputs = resolveConfiguredAutonomousResearchStateProvisioningInputs(options);
  return composeAutonomousResearchStatePartialRootMaintenanceService({
    ...inputs,
    rescueRoot,
    writerQuiescenceReceipt: readRegularJsonFileSync(writerQuiescenceReceiptPath),
    clock,
  });
}
