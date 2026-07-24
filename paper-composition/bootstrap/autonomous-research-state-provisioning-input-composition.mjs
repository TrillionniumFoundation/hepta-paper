import {
  readAutonomousResearchMachineIntakeConfiguration,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-loader.mjs';
import {
  readAutonomousResearchTopicProducerProfile,
} from '../../paper-adapters/automation/autonomous-research-topic-producer-profile-loader.mjs';
import {
  resolveAutonomousResearchProviderConfiguration,
} from '../automation/autonomous-research-provider-configuration.mjs';
import {
  composeAutonomousResearchStateBusinessSchemaProvisioningService,
} from './autonomous-research-state-business-schema-provisioning-composition.mjs';

export function composeConfiguredAutonomousResearchStateProvisioningService({
  workspaceRoot,
  runtimeRoot,
  machineIntakeConfigPath,
  topicProducerProfilePath,
  datasetRoot,
  providerCanaryPairMaximumCostUsd,
  runtimeReproducibilityPolicy,
  providerOptions = {},
  environment = process.env,
} = {}) {
  const providerConfiguration = resolveAutonomousResearchProviderConfiguration({
    options: providerOptions,
    environment,
  });
  const machineIntakeConfiguration = readAutonomousResearchMachineIntakeConfiguration({
    configPath: machineIntakeConfigPath,
    environment,
  }).configuration;
  const topicProducerProfile = readAutonomousResearchTopicProducerProfile({
    profilePath: topicProducerProfilePath,
    environment,
    expectedProfileHash: machineIntakeConfiguration.machineProducerProfileHash,
    expectedProviderConfigurationHash:
      providerConfiguration.autonomousResearchProviderConfigurationHash,
    datasetRoot,
  }).producerProfile;
  return composeAutonomousResearchStateBusinessSchemaProvisioningService({
    workspaceRoot,
    runtimeRoot,
    machineIntakeConfiguration,
    topicProducerProfile,
    providerCanaryPairMaximumCostUsd,
    runtimeReproducibilityPolicy,
  });
}
