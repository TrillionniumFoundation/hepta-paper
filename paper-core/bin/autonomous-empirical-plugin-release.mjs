#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';
import {
  composeAutonomousAdvancedNumericalPluginReleaseTemplate,
  inspectConfiguredAutonomousEmpiricalPluginRelease,
  planConfiguredAutonomousEmpiricalPluginRelease,
  publishConfiguredAutonomousEmpiricalPluginRelease,
} from '../../paper-composition/automation/autonomous-empirical-plugin-release-composition.mjs';

export function autonomousEmpiricalPluginReleaseUsage() {
  return [
    'Usage: autonomous-empirical-plugin-release --action template|plan|publish|inspect [options]',
    '',
    '  template                         Emit a canonical unsigned advanced-oracle template.',
    '  plan                             Validate template and configured external signer.',
    '  publish                          Generate, externally sign, verify, and atomically install.',
    '  inspect                          Reverify an installed activation without signing.',
    '',
    '  --template PATH                  Immutable release template; omit to use generated template.',
    '  --package-id ID                  Generated-template package identity.',
    '  --package-version SEMVER         Generated-template package version.',
    '  --benchmark-family FAMILY        Repeat for generated-template family selection.',
    '  --signing-config PATH            External-command Ed25519 authority configuration.',
    '  --install-root PATH              Content-addressed release installation root.',
    '  --activation PATH                Installed activation.json for inspect.',
    '',
    'The signing command receives a canonical payload on stdin. Hepta never loads private-key',
    'material; publication succeeds only after verification against the configured public trust store.',
  ].join('\n');
}

function generatedTemplate(args) {
  if (args.template) return null;
  if (!args['package-version'] && ['plan', 'publish'].includes(args.action)) {
    throw new Error('autonomous_empirical_plugin_release_package_version_required');
  }
  return composeAutonomousAdvancedNumericalPluginReleaseTemplate({
    packageId: args['package-id'],
    packageVersion: args['package-version'],
    benchmarkFamilies: args['benchmark-family'],
  }).template;
}

export function parseAutonomousEmpiricalPluginReleaseArguments(argv = []) {
  const args = parseStrictCliArguments(argv, {
    booleanFlags: ['help'],
    valueFlags: [
      'action', 'activation', 'install-root', 'package-id', 'package-version',
      'signing-config', 'template',
    ],
    repeatableValueFlags: ['benchmark-family'],
    positional: false,
  });
  if (args.help) return Object.freeze({ help: true });
  const action = String(args.action || 'plan');
  if (!['inspect', 'plan', 'publish', 'template'].includes(action)) {
    throw new Error(`autonomous_empirical_plugin_release_action_invalid:${action}`);
  }
  if (action === 'inspect') {
    if (!args.activation) {
      throw new Error('autonomous_empirical_plugin_release_activation_required');
    }
    return Object.freeze({
      help: false,
      action,
      activationPath: path.resolve(args.activation),
    });
  }
  if (args.template && (args['package-id'] || args['package-version']
    || args['benchmark-family'])) {
    throw new Error('autonomous_empirical_plugin_release_template_options_conflict');
  }
  const normalized = {
    ...args,
    action,
    'package-id': args['package-id'] || 'hepta.advanced-numerical-empirical-families',
    'package-version': args['package-version'] || (action === 'template' ? '1.0.0' : null),
    'benchmark-family': args['benchmark-family'] || ['ml_algorithm_benchmark'],
  };
  const releaseTemplate = generatedTemplate(normalized);
  if (action === 'template') {
    return Object.freeze({ help: false, action, releaseTemplate });
  }
  if (!args['signing-config']) {
    throw new Error('autonomous_empirical_plugin_release_signing_configuration_required');
  }
  if (action === 'publish' && !args['install-root']) {
    throw new Error('autonomous_empirical_plugin_release_install_root_required');
  }
  return Object.freeze({
    help: false,
    action,
    templatePath: args.template ? path.resolve(args.template) : null,
    releaseTemplate,
    signingConfigurationPath: path.resolve(args['signing-config']),
    installRoot: args['install-root'] ? path.resolve(args['install-root']) : null,
    activationPointerPath: action === 'publish' && args.activation
      ? path.resolve(args.activation) : null,
  });
}

export function runAutonomousEmpiricalPluginRelease({
  argv = process.argv.slice(2),
  environment = process.env,
  clock,
  spawnSyncImpl,
} = {}) {
  const options = parseAutonomousEmpiricalPluginReleaseArguments(argv);
  if (options.help) return autonomousEmpiricalPluginReleaseUsage();
  if (options.action === 'template') return options.releaseTemplate;
  if (options.action === 'inspect') {
    return inspectConfiguredAutonomousEmpiricalPluginRelease({
      activationPath: options.activationPath,
      environment,
      ...(clock ? { now: clock.now() } : {}),
    });
  }
  const input = {
    templatePath: options.templatePath,
    releaseTemplate: options.releaseTemplate,
    signingConfigurationPath: options.signingConfigurationPath,
  };
  if (options.action === 'plan') {
    return planConfiguredAutonomousEmpiricalPluginRelease(input);
  }
  return publishConfiguredAutonomousEmpiricalPluginRelease({
    ...input,
    installRoot: options.installRoot,
    activationPointerPath: options.activationPointerPath,
    environment,
    ...(clock ? { clock } : {}),
    ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
  });
}

const invokedAsEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsEntrypoint) {
  try {
    const report = runAutonomousEmpiricalPluginRelease();
    process.stdout.write(`${typeof report === 'string'
      ? report : JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  }
}
