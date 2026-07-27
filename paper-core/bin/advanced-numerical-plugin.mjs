#!/usr/bin/env node
import path from 'node:path';

import {
  composeAdvancedNumericalPluginRuntime,
} from '../../paper-composition/automation/advanced-numerical-plugin-composition.mjs';
import {
  readImmutableJsonDocument,
} from '../../workflow-kernel/runtime/immutable-signed-json-bundle.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

function usage() {
  return {
    version: 1,
    kind: 'AdvancedNumericalPluginUsage',
    usage:
      'advanced-numerical-plugin --config PATH [--action status|run] [--request PATH --output-directory PATH]',
    status: 'verifies signed descriptor, local plugin identity and sandbox availability',
    run: 'executes one bounded request and remains scientifically unqualified',
  };
}

function configuredPath(configDirectory, value) {
  const selected = String(value || '').trim();
  if (!selected) throw new Error('advanced_numerical_plugin_configuration_path_required');
  return path.resolve(configDirectory, selected);
}

const args = parseStrictCliArguments(process.argv.slice(2), {
  booleanFlags: ['help', 'require-runner-ready'],
  valueFlags: ['action', 'config', 'output-directory', 'request'],
  positional: false,
});
if (args.help) {
  process.stdout.write(`${JSON.stringify(usage(), null, 2)}\n`);
  process.exit(0);
}
const action = args.action || 'status';
if (!['run', 'status'].includes(action)) {
  throw new Error(`advanced_numerical_plugin_action_invalid:${action}`);
}
const configPath = path.resolve(String(args.config || ''));
const configuration = readImmutableJsonDocument(configPath);
if (configuration?.version !== 1
  || configuration?.kind !== 'AdvancedNumericalPluginRuntimeConfiguration') {
  throw new Error('advanced_numerical_plugin_runtime_configuration_invalid');
}
const configDirectory = path.dirname(configPath);
const bundle = readImmutableJsonDocument(
  configuredPath(configDirectory, configuration.signedBundlePath),
);
const trustStore = readImmutableJsonDocument(
  configuredPath(configDirectory, configuration.trustStorePath),
  { maximumBytes: 1024 * 1024 },
);
const pluginRoot = configuredPath(configDirectory, configuration.pluginRoot);
const outputRoot = configuredPath(configDirectory, configuration.outputRoot);
const qualificationConfigured = Boolean(
  configuration.qualificationPath || configuration.qualificationTrustStorePath,
);
if (qualificationConfigured
  && (!configuration.qualificationPath || !configuration.qualificationTrustStorePath)) {
  throw new Error('advanced_numerical_plugin_qualification_configuration_incomplete');
}
const qualification = qualificationConfigured ? readImmutableJsonDocument(
  configuredPath(configDirectory, configuration.qualificationPath),
) : null;
const qualificationTrustStore = qualificationConfigured ? readImmutableJsonDocument(
  configuredPath(configDirectory, configuration.qualificationTrustStorePath),
  { maximumBytes: 1024 * 1024 },
) : null;
const {
  verifiedBundle,
  descriptor,
  workerRunner,
  runner,
} = composeAdvancedNumericalPluginRuntime({
  bundle,
  trustStore,
  qualification,
  qualificationTrustStore,
  pluginRoot,
  outputRoot,
  now: new Date(),
});
if (action === 'status') {
  const capabilities = runner.capabilities();
  const report = {
    version: 1,
    kind: 'AdvancedNumericalPluginRuntimeInspection',
    status: workerRunner.availability?.available === true
      ? capabilities.productionQualified === true
        ? 'advanced_numerical_plugin_runner_ready_qualified'
        : 'advanced_numerical_plugin_runner_ready_unqualified'
      : 'advanced_numerical_plugin_runner_blocked',
    pluginId: descriptor.pluginId,
    analysisFamily: descriptor.analysisFamily,
    descriptorHash: descriptor.advancedNumericalPluginDescriptorHash,
    signedBundleHash: verifiedBundle.signedBundleHash,
    sandboxAvailability: workerRunner.availability,
    capabilities,
    productionQualified: capabilities.productionQualified === true,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (args['require-runner-ready'] && workerRunner.availability?.available !== true) {
    process.exitCode = 1;
  }
} else {
  const request = readImmutableJsonDocument(
    path.resolve(String(args.request || '')),
    { maximumBytes: 64 * 1024 },
  );
  const receipt = await runner.run({
    runId: request.runId,
    input: request.input,
    seed: request.seed,
    outputDirectory: path.resolve(String(args['output-directory'] || '')),
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (![
    'advanced_numerical_plugin_execution_completed_qualified',
    'advanced_numerical_plugin_execution_completed_unqualified',
  ].includes(receipt.status)) {
    process.exitCode = 1;
  }
}
