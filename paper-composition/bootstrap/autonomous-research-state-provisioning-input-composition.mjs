import fs from 'node:fs';
import path from 'node:path';

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

const PRODUCTION_RUNTIME_ROOT = '/var/lib/hepta-paper/runtime';
const PRODUCTION_INTAKE_CONFIG =
  '/etc/hepta-paper/intake/config.json';
const PRODUCTION_TOPIC_PRODUCER_PROFILE =
  '/etc/hepta-paper/intake/topic-producer-profile.json';

function assertRootOwnedPath(candidate, { file }) {
  const requested = path.resolve(candidate);
  const components = requested.split(path.sep).filter(Boolean);
  let cursor = path.parse(requested).root;
  for (let index = 0; index < components.length; index += 1) {
    cursor = path.join(cursor, components[index]);
    const identity = fs.lstatSync(cursor);
    const expectedFile = file && index === components.length - 1;
    if (identity.isSymbolicLink() || identity.uid !== 0 || (identity.mode & 0o022) !== 0
      || (expectedFile
        ? (!identity.isFile() || identity.nlink !== 1)
        : !identity.isDirectory())
      || fs.realpathSync(cursor) !== cursor) {
      throw new Error('autonomous_research_state_provisioning_root_owned_input_invalid');
    }
  }
}

function genesisAuthorityMode({
  runtimeRoot,
  machineIntakeConfigPath,
  topicProducerProfilePath,
}) {
  if (path.resolve(runtimeRoot) !== PRODUCTION_RUNTIME_ROOT) return 'external';
  if (path.resolve(machineIntakeConfigPath) !== PRODUCTION_INTAKE_CONFIG
    || path.resolve(topicProducerProfilePath) !== PRODUCTION_TOPIC_PRODUCER_PROFILE) {
    throw new Error('autonomous_research_state_provisioning_production_input_path_invalid');
  }
  assertRootOwnedPath(machineIntakeConfigPath, { file: true });
  assertRootOwnedPath(topicProducerProfilePath, { file: true });
  return 'root-owned-configuration';
}

export function resolveConfiguredAutonomousResearchStateProvisioningInputs({
  workspaceRoot,
  runtimeRoot,
  machineIntakeConfigPath,
  topicProducerProfilePath,
  datasetRoot,
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
  const machineIntakeGenesisAuthorityMode = genesisAuthorityMode({
    runtimeRoot,
    machineIntakeConfigPath,
    topicProducerProfilePath,
  });
  return Object.freeze({
    workspaceRoot,
    runtimeRoot,
    machineIntakeConfiguration,
    machineIntakeGenesisAuthorityMode,
    topicProducerProfile,
    runtimeReproducibilityPolicy,
  });
}

export function composeConfiguredAutonomousResearchStateProvisioningService(options = {}) {
  return composeAutonomousResearchStateBusinessSchemaProvisioningService(
    resolveConfiguredAutonomousResearchStateProvisioningInputs(options),
  );
}
