import {
  createAutonomousResearchTopicProducer,
} from '../../paper-application/automation/autonomous-research-topic-producer.mjs';
import {
  createAutonomousResearchTopicProducerLiveAuthority,
} from '../../paper-application/automation/autonomous-research-topic-producer-live-authority.mjs';
import {
  ResidentReactivationRequired,
  isResidentReactivationRequired,
} from '../../paper-application/automation/autonomous-research-resident-reactivation-required.mjs';
import {
  createAutonomousResearchMachineIntakeRepository,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-repository.mjs';
import {
  loadConfiguredAutonomousResearchMachineIntakes,
  readAutonomousResearchMachineIntakeConfiguration,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-loader.mjs';
import {
  createAutonomousResearchTopicProducerRepository,
} from '../../paper-adapters/automation/autonomous-research-topic-producer-repository.mjs';
import {
  inspectAutonomousResearchTopicProducerImplementationIdentity,
  readAutonomousResearchTopicProducerProfile,
} from '../../paper-adapters/automation/autonomous-research-topic-producer-profile-loader.mjs';
import {
  AUTONOMOUS_RESEARCH_MACHINE_INTAKE_DATABASE_INSTANCE_ID,
  AUTONOMOUS_RESEARCH_MACHINE_INTAKE_SCHEMA_CONTRACT_ID,
  AUTONOMOUS_RESEARCH_MACHINE_INTAKE_WRITER_ID,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-mutation-plan.mjs';
import {
  assertExternallyFencedSqliteMutationCoordinatorPort,
} from '../../paper-ports/autonomous-research-online-mutation-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export {
  createAutonomousResearchSupervisorMachineIntakeAdapter,
} from './autonomous-research-supervisor-machine-intake-adapter.mjs';

export function createLegacyAutonomousResearchMachineIntakeRepository(options = {}) {
  return createAutonomousResearchMachineIntakeRepository(options);
}

export function inspectConfiguredAutonomousResearchTopicProducer({
  configuration,
  providerConfiguration,
  environment = process.env,
  profilePath = null,
} = {}) {
  if (configuration?.version !== 2 || configuration.machineAppendEnabled !== true) {
    return Object.freeze({
      ready: false,
      producerProfile: null,
      implementationIdentity: null,
      datasetSnapshot: null,
      blocker: 'autonomous_research_topic_producer_profile_binding_required',
    });
  }
  try {
    const loaded = readAutonomousResearchTopicProducerProfile({
      profilePath,
      environment,
      expectedProfileHash: configuration.machineProducerProfileHash,
      expectedProviderConfigurationHash:
        providerConfiguration?.autonomousResearchProviderConfigurationHash,
    });
    return Object.freeze({
      ready: true,
      producerProfile: loaded.producerProfile,
      implementationIdentity: loaded.implementationIdentity,
      datasetSnapshot: loaded.datasetSnapshot,
      profilePath: loaded.profilePath,
      blocker: null,
    });
  } catch (error) {
    return Object.freeze({
      ready: false,
      producerProfile: null,
      implementationIdentity: null,
      datasetSnapshot: null,
      blocker: String(error?.message || error),
    });
  }
}

export function composeAutonomousResearchMachineIntakePlane({
  runtimeRoot,
  configuration,
  configPath,
  providerConfiguration,
  environment,
  producerInspection,
  providerCanaryPairMaximumCostUsd,
  providerCanaryRunner,
  clock,
  ownerId,
  signal = null,
  topicProducerMutationCoordinator = null,
  requireExternallyFencedTopicProducer = false,
  machineIntakeMutationCoordinator = null,
  machineIntakeDatabaseInstanceId = AUTONOMOUS_RESEARCH_MACHINE_INTAKE_DATABASE_INSTANCE_ID,
  machineIntakeSchemaContractId = AUTONOMOUS_RESEARCH_MACHINE_INTAKE_SCHEMA_CONTRACT_ID,
  machineIntakeWriterId = AUTONOMOUS_RESEARCH_MACHINE_INTAKE_WRITER_ID,
  requireExternallyFencedMachineIntake = false,
} = {}) {
  const expected = producerInspection;
  if (expected?.ready !== true) {
    throw new Error(expected?.blocker || 'autonomous_research_topic_producer_not_ready');
  }
  if (requireExternallyFencedMachineIntake) {
    try { assertExternallyFencedSqliteMutationCoordinatorPort(machineIntakeMutationCoordinator); }
    catch {
      throw new Error('autonomous_research_machine_intake_external_mutation_coordinator_required');
    }
    const status = machineIntakeMutationCoordinator.inspectStatus();
    if (machineIntakeMutationCoordinator.implemented !== true
      || status?.implemented !== true
      || status.status !== 'externally_fenced_sqlite_mutation_coordinator_ready'
      || !Array.isArray(status.blockers) || status.blockers.length !== 0
      || !machineIntakeMutationCoordinator.coveredDatabaseRoles?.includes('machine-intake')
      || !status.coveredDatabaseRoles?.includes('machine-intake')) {
      throw new Error('autonomous_research_machine_intake_external_mutation_coordinator_required');
    }
  }
  const remeasureAuthorities = (authority) => {
    try {
      const currentConfiguration = readAutonomousResearchMachineIntakeConfiguration({
        configPath,
        environment,
        validateStaticContent: false,
      }).configuration;
      if (currentConfiguration.configurationHash !== configuration.configurationHash) {
        throw new ResidentReactivationRequired({
          source: 'machine_intake_configuration',
          reason: 'autonomous_research_machine_intake_configuration_rotated',
          startupIdentityHash: configuration.configurationHash,
          observedIdentityHash: currentConfiguration.configurationHash,
        });
      }
      const currentProducer = inspectConfiguredAutonomousResearchTopicProducer({
        configuration: currentConfiguration,
        providerConfiguration,
        environment,
        profilePath: expected.profilePath,
      });
      const implementation = inspectAutonomousResearchTopicProducerImplementationIdentity({
        producerProfile: currentProducer.producerProfile,
      });
      const ready = currentProducer.ready === true && implementation.ready === true
        && currentConfiguration.configurationHash === authority.machineIntakeConfigurationHash
        && currentProducer.producerProfile.producerProfileHash === authority.producerProfileHash
        && currentProducer.producerProfile.providerConfigurationHash
          === authority.providerConfigurationHash
        && implementation.implementationSha256 === authority.implementationSha256
        && currentProducer.datasetSnapshot?.datasetSnapshotHash
          === expected.datasetSnapshot?.datasetSnapshotHash;
      return Object.freeze({
        ready,
        blocker: ready ? null : 'autonomous_research_topic_producer_authority_rotated',
        authorityMeasurementHash: ready ? hashRecord(
          'AutonomousResearchTopicProducerAuthorityMeasurement',
          {
            machineIntakeConfigurationHash: currentConfiguration.configurationHash,
            producerProfileHash: currentProducer.producerProfile.producerProfileHash,
            providerConfigurationHash:
              currentProducer.producerProfile.providerConfigurationHash,
            implementationSha256: implementation.implementationSha256,
          },
        ) : null,
      });
    } catch (error) {
      if (isResidentReactivationRequired(error)) throw error;
      return Object.freeze({
        ready: false,
        blocker: String(error?.message || error),
        authorityMeasurementHash: null,
      });
    }
  };
  const liveMutationAuthority = createAutonomousResearchTopicProducerLiveAuthority({
    clock,
    hashRecord,
    remeasureAuthorities,
    providerCanaryPairMaximumCostUsd,
    runProviderCanary: ({
      expectedProviderConfigurationHash,
      providerCanaryReservation,
      signal: canarySignal,
      betweenCanaryChecks,
      beforePreflightAction,
      beforeCanaryAction,
      afterCanaryAction,
    }) => providerCanaryRunner({
      providerConfiguration,
      expectedProviderConfigurationHash,
      environment,
      signal: canarySignal,
      clock,
      betweenCanaryChecks,
      beforePreflightAction,
      beforeCanaryAction,
      afterCanaryAction,
      providerCanaryReservation,
    }),
  });
  const producerRepository = createAutonomousResearchTopicProducerRepository({
    runtimeRoot,
    machineIntakeConfigurationHash: configuration.configurationHash,
    producerProfile: expected.producerProfile,
    providerCanaryPairMaximumCostUsd,
    liveMutationAuthority,
    mutationCoordinator: topicProducerMutationCoordinator,
    offlineProvision: !requireExternallyFencedTopicProducer,
    requireExternallyFencedMutations: requireExternallyFencedTopicProducer,
  });
  const machineIntakeRepository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    create: true,
    authorizedSourceAuthorityHash: configuration.configurationHash,
    authorizedMachineProducerProfileHash: expected.producerProfile.producerProfileHash,
    machineProducerAppendAuthority: producerRepository,
    offlineProvision: !requireExternallyFencedMachineIntake,
    mutationCoordinator: machineIntakeMutationCoordinator,
    databaseInstanceId: machineIntakeDatabaseInstanceId,
    schemaContractId: machineIntakeSchemaContractId,
    writerId: machineIntakeWriterId,
    requireExternallyFencedMutations: requireExternallyFencedMachineIntake,
  });
  const producer = createAutonomousResearchTopicProducer({
    configuration,
    producerProfile: expected.producerProfile,
    producerRepository,
    machineIntakeRepository,
    liveMutationAuthority,
    clock,
    ownerId,
  });
  return Object.freeze({
    configuration,
    producerProfile: expected.producerProfile,
    machineIntakeRepository,
    producerRepository,
    async loadConfiguredIntakes({
      now,
      residentLeaseContext,
      operationMode = 'full',
      assertAutonomyCurrent,
      reconcileStateRecoverability = null,
      assertStateRecoverabilityCurrent = null,
    }) {
      if (typeof assertAutonomyCurrent !== 'function') {
        throw new Error('autonomous_research_machine_intake_autonomy_fence_required');
      }
      const current = readAutonomousResearchMachineIntakeConfiguration({
        configPath,
        environment,
        validateStaticContent: false,
      }).configuration;
      if (current.configurationHash !== configuration.configurationHash) {
        throw new ResidentReactivationRequired({
          source: 'machine_intake_configuration',
          reason: 'autonomous_research_machine_intake_configuration_rotated',
          startupIdentityHash: configuration.configurationHash,
          observedIdentityHash: current.configurationHash,
        });
      }
      const loaded = loadConfiguredAutonomousResearchMachineIntakes({
        configuration: current,
        repository: machineIntakeRepository,
        now,
        operationMode,
      });
      await reconcileStateRecoverability?.({
        residentLeaseContext,
        action: 'machine_intake_after_configured_load',
      });
      assertStateRecoverabilityCurrent?.('topic_producer_reconciliation_entry');
      const topicProducer = operationMode === 'full'
        ? await producer.reconcile({
          residentLeaseContext,
          assertAutonomyCurrent,
          reconcileStateRecoverability,
          assertStateRecoverabilityCurrent,
          signal,
        }) : null;
      return Object.freeze({
        ...loaded,
        topicProducer,
        topicProducerDatasetSnapshot: expected.datasetSnapshot,
      });
    },
    close() {
      producerRepository.close();
      machineIntakeRepository.close();
    },
  });
}
