import path from 'node:path';

import {
  buildAutonomousResearchStateBusinessSchemaProvisioningPlan,
  provisionAutonomousResearchStateBusinessSchemas,
} from '../../paper-adapters/automation/autonomous-research-state-business-schema-provisioning-repository.mjs';
import {
  createAutonomousResearchMachineIntakeRepository,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-repository.mjs';
import {
  createAutonomousResearchQualificationStateRepository,
} from '../../paper-adapters/automation/autonomous-research-qualification-state-repository.mjs';
import {
  createAutonomousResearchRuntimeRefreshStateRepository,
} from '../../paper-adapters/automation/autonomous-research-runtime-refresh-state-repository.mjs';
import {
  createAutonomousResearchSupervisorInstanceRepository,
} from '../../paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs';
import {
  createAutonomousResearchSupervisorStateRepository,
} from '../../paper-adapters/automation/autonomous-research-supervisor-state-repository.mjs';
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
import { readRegularJsonFileSync } from '../../paper-adapters/runtime/pinned-file-reader.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import {
  convergeAutonomousSubmissionHandoff,
} from './autonomous-submission-handoff-migration-composition.mjs';
import {
  verifyAutonomousResearchMachineIntakeConfiguration,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-loader.mjs';
import {
  verifyAutonomousResearchTopicProducerProfile,
} from '../../paper-domain/automation/autonomous-research-topic-producer-contract.mjs';
import {
  normalizeRuntimeReproducibilityRefreshPolicy,
} from '../../paper-domain/automation/runtime-reproducibility-refresh-policy.mjs';
import {
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import {
  awaitProductionAutonomousSubmissionHandoffLayoutReceipt,
} from '../../paper-adapters/automation/autonomous-submission-handoff-layout-receipt-repository.mjs';

function closeRepositories(repositories) {
  for (const repository of [...repositories].reverse()) {
    try { repository?.close?.(); } catch { /* retain provisioning failure */ }
  }
}

function disabledOfflineMutationAuthority() {
  return Object.freeze({
    consume() {
      throw new Error('autonomous_research_state_offline_provisioning_cannot_mutate');
    },
  });
}

function convergeNativeStoreForAtomicInstallation(store) {
  const checkpoint = store.checkpoint({ mode: 'TRUNCATE' });
  if (checkpoint?.ok !== true) {
    throw new Error('autonomous_research_state_native_store_checkpoint_failed');
  }
  const journal = store.execute('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
  const observed = store.query('PRAGMA journal_mode;');
  if (journal?.ok !== true || observed?.ok !== true
    || String(observed.rows?.[0]?.journal_mode || '').toLowerCase() !== 'delete') {
    throw new Error('autonomous_research_state_native_store_offline_journal_failed');
  }
}

function provisioningIdentity({
  machineIntakeConfiguration,
  machineIntakeGenesisAuthorityMode,
  topicProducerProfile,
  providerCanaryPairMaximumCostUsd,
  runtimeRefreshPolicy,
}) {
  return Object.freeze({
    machineIntakeConfigurationHash: machineIntakeConfiguration.configurationHash,
    machineIntakeGenesisAuthorityMode,
    providerCanaryPairMaximumCostUsd,
    providerConfigurationHash: topicProducerProfile.providerConfigurationHash,
    runtimeReproducibilityRefreshPolicyHash:
      runtimeRefreshPolicy.runtimeReproducibilityRefreshPolicyHash,
    topicProducerProfileHash: topicProducerProfile.producerProfileHash,
    writerManifestHash: autonomousResearchOnlineWriterOperationManifestHash(
      AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
    ),
  });
}

function provisionCanonicalBusinessSchemas({
  workspaceRoot,
  runtimeRoot,
  machineIntakeConfiguration,
  machineIntakeGenesisAuthorityMode,
  topicProducerProfile,
  providerCanaryPairMaximumCostUsd,
  runtimeRefreshPolicy,
}) {
  const repositories = [];
  try {
    const nativeStore = createDefaultPaperStore({
      root: workspaceRoot,
      runtimeRoot,
    });
    repositories.push(nativeStore);
    convergeAutonomousSubmissionHandoff({
      nativeStore,
      runtimeRoot,
    });
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
    repositories.push(createAutonomousResearchSupervisorStateRepository({
      runtimeRoot,
      offlineProvision: true,
    }));
    repositories.push(createAutonomousResearchSupervisorInstanceRepository({
      runtimeRoot,
      create: true,
      offlineProvision: true,
    }));
    repositories.push(createAutonomousResearchRuntimeRefreshStateRepository({
      runtimeRoot,
      policy: runtimeRefreshPolicy,
      offlineProvision: true,
    }));
    const runtimePublication = createRuntimeImageReproducibilityReceiptRepository({
      runtimeRoot,
      offlineProvision: true,
    });
    runtimePublication.provision();
    repositories.push(createAutonomousResearchQualificationStateRepository({
      runtimeRoot,
      paperId: 'state-provisioning-bootstrap',
      create: true,
      offlineProvision: true,
    }));
    const qualificationPublication =
      createFullResearchQualificationReceiptPointerRepository({
        runtimeRoot,
        offlineProvision: true,
      });
    qualificationPublication.provision();
    convergeNativeStoreForAtomicInstallation(nativeStore);
  } finally {
    closeRepositories(repositories);
  }
}

export function composeAutonomousResearchStateBusinessSchemaProvisioningService({
  workspaceRoot,
  runtimeRoot,
  machineIntakeConfiguration,
  machineIntakeGenesisAuthorityMode = 'external',
  topicProducerProfile,
  runtimeReproducibilityPolicy,
} = {}) {
  const cost = Number(topicProducerProfile?.maximumProviderCanaryCostUsdPerUtcDay)
    / Number(topicProducerProfile?.maximumProviderCanaryAttemptsPerUtcDay);
  if (!workspaceRoot || !runtimeRoot
    || !verifyAutonomousResearchMachineIntakeConfiguration(machineIntakeConfiguration)
    || machineIntakeConfiguration.version !== 2
    || !verifyAutonomousResearchTopicProducerProfile(topicProducerProfile)
    || machineIntakeConfiguration.machineProducerProfileHash
      !== topicProducerProfile.producerProfileHash
    || !['external', 'root-owned-configuration'].includes(
      machineIntakeGenesisAuthorityMode,
    )
    || !Number.isFinite(cost) || cost <= 0) {
    throw new Error('autonomous_research_state_provisioning_configuration_invalid');
  }
  const runtimeRefreshPolicy = normalizeRuntimeReproducibilityRefreshPolicy(
    runtimeReproducibilityPolicy,
  );
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  const stateDatabaseManifest = readRegularJsonFileSync(path.join(
    resolvedWorkspaceRoot,
    'paper-core',
    'config',
    'autonomous-research-state-databases.v1.json',
  ));
  const identity = provisioningIdentity({
    machineIntakeConfiguration,
    machineIntakeGenesisAuthorityMode,
    topicProducerProfile,
    providerCanaryPairMaximumCostUsd: cost,
    runtimeRefreshPolicy,
  });
  const shared = Object.freeze({
    runtimeRoot: resolvedRuntimeRoot,
    stateDatabaseManifest,
    provisioningIdentity: identity,
  });
  return Object.freeze({
    plan() {
      return buildAutonomousResearchStateBusinessSchemaProvisioningPlan(shared);
    },
    execute({ expectedProvisioningPlanId } = {}) {
      const receipt = provisionAutonomousResearchStateBusinessSchemas({
        ...shared,
        expectedProvisioningPlanId,
        provisionBusinessSchemas: ({ runtimeRoot: stagingRuntimeRoot }) => (
          provisionCanonicalBusinessSchemas({
            workspaceRoot: resolvedWorkspaceRoot,
            runtimeRoot: stagingRuntimeRoot,
            machineIntakeConfiguration,
            machineIntakeGenesisAuthorityMode,
            topicProducerProfile,
            providerCanaryPairMaximumCostUsd: cost,
            runtimeRefreshPolicy,
          })
        ),
      });
      // The production .path unit observes the atomic runtime rename and invokes
      // the isolated root native helper. Do not let the strict runner enter its
      // first online transition until that helper's atomically published
      // inode/owner/mode/content receipt matches the installed handoff.
      awaitProductionAutonomousSubmissionHandoffLayoutReceipt({
        runtimeRoot: resolvedRuntimeRoot,
      });
      return receipt;
    },
  });
}
