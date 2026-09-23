#!/usr/bin/env node
import path from 'node:path';

import {
  composeConfiguredAdvancedNumericalPluginRuntime,
  inspectAdvancedNumericalPluginRunnerStatus,
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
    status:
      'verifies pinned runtime documents, signed evidence, local identity and sandbox availability',
    run:
      'executes one bounded request; qualified status requires the complete external evidence chain',
  };
}

function errorCode(error) {
  const candidate = String(error?.code || error?.message || '').trim();
  return candidate || 'advanced_numerical_plugin_runtime_configuration_invalid';
}

function blockedStatusReport({ configurationPath, error }) {
  const code = errorCode(error);
  const missingDocument = code === 'advanced_numerical_plugin_document_missing';
  const blocker = missingDocument
    ? error?.path === configurationPath
      ? 'advanced_numerical_plugin_runtime_configuration_missing'
      : 'advanced_numerical_plugin_runtime_dependency_missing'
    : code;
  return {
    version: 1,
    kind: 'AdvancedNumericalPluginRuntimeInspection',
    status: 'advanced_numerical_plugin_runner_blocked',
    productionQualified: false,
    blockers: [blocker],
    configurationPath,
    errorCode: code,
  };
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
const rawConfigPath = String(args.config || '').trim();
const configPath = rawConfigPath ? path.resolve(rawConfigPath) : null;
let composed = null;
try {
  if (!configPath) {
    throw new Error('advanced_numerical_plugin_configuration_path_required');
  }
  composed = composeConfiguredAdvancedNumericalPluginRuntime({
    configurationPath: configPath,
  });
} catch (error) {
  if (action !== 'status') throw error;
  process.stdout.write(`${JSON.stringify(blockedStatusReport({
    configurationPath: configPath,
    error,
  }), null, 2)}\n`);
  process.exitCode = 1;
}

if (composed !== null) {
  const {
    verifiedBundle,
    descriptor,
    workerRunner,
    runner,
    runtimeConfiguration,
  } = composed;
  if (action === 'status') {
    const capabilities = runner.capabilities();
    const runnerStatus = inspectAdvancedNumericalPluginRunnerStatus({
      available: workerRunner.availability?.available === true,
      productionQualified: capabilities.productionQualified === true,
    });
    const productionQualified = capabilities.productionQualified === true;
    const report = {
      version: 1,
      kind: 'AdvancedNumericalPluginRuntimeInspection',
      status: runnerStatus.status,
      pluginId: descriptor.pluginId,
      analysisFamily: descriptor.analysisFamily,
      descriptorHash: descriptor.advancedNumericalPluginDescriptorHash,
      signedBundleHash: verifiedBundle.signedBundleHash,
      sandboxAvailability: workerRunner.availability,
      capabilities,
      productionQualified,
      blockers: runnerStatus.blockers,
      runtimeConfiguration: Object.freeze({
        version: runtimeConfiguration.configuration.version,
        configurationHash: runtimeConfiguration.configurationHash,
        configurationPinned: runtimeConfiguration.configurationPinned,
        dependentDocumentsPinned:
          runtimeConfiguration.dependentDocumentsPinned,
        dependencyFileHashes: runtimeConfiguration.dependencyFileHashes,
      }),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (args['require-runner-ready']
      && (workerRunner.availability?.available !== true || !productionQualified)) {
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
}
