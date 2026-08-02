#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  composeLocalReleaseAttestorRuntime,
} from '../../paper-composition/automation/local-release-attestor-composition.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const releaseAttestorRuntime = composeLocalReleaseAttestorRuntime();

export async function runHeptaPaperReleaseAttestorDaemon({
  argv = process.argv.slice(2),
} = {}) {
  const args = parseStrictCliArguments(argv, {
    booleanFlags: ['help', 'preflight-configuration-pair'],
    valueFlags: [
      'configuration',
      'probe-configuration',
      'probe-private-key-owner-uid',
      'signer-configuration',
      'signer-private-key-owner-uid',
    ],
    positional: false,
  });
  if (args.help) {
    return Object.freeze({
      help: [
        'Usage: hepta-paper-release-attestor-daemon --configuration PATH',
        '       hepta-paper-release-attestor-daemon --preflight-configuration-pair --signer-configuration PATH --probe-configuration PATH --signer-private-key-owner-uid UID --probe-private-key-owner-uid UID',
      ].join('\n'),
    });
  }
  if (args['preflight-configuration-pair']) {
    if (args.configuration) {
      throw new Error('local_release_attestor_preflight_arguments_invalid');
    }
    const integerUid = (name) => {
      const source = String(args[name] || '');
      if (!/^(?:0|[1-9][0-9]*)$/.test(source)) {
        throw new Error('local_release_attestor_preflight_arguments_invalid');
      }
      const value = Number(source);
      if (!Number.isSafeInteger(value)) {
        throw new Error('local_release_attestor_preflight_arguments_invalid');
      }
      return value;
    };
    if (!args['signer-configuration'] || !args['probe-configuration']) {
      throw new Error('local_release_attestor_preflight_arguments_invalid');
    }
    return Object.freeze({
      preflight: releaseAttestorRuntime.preflightDaemonConfigurationPair({
        signerConfigurationPath: path.resolve(args['signer-configuration']),
        probeConfigurationPath: path.resolve(args['probe-configuration']),
        signerPrivateKeyOwnerUid: integerUid('signer-private-key-owner-uid'),
        probePrivateKeyOwnerUid: integerUid('probe-private-key-owner-uid'),
      }),
    });
  }
  if (args['signer-configuration'] || args['probe-configuration']
    || args['signer-private-key-owner-uid']
    || args['probe-private-key-owner-uid']) {
    throw new Error('local_release_attestor_preflight_arguments_invalid');
  }
  if (!args.configuration) {
    throw new Error('local_release_attestor_configuration_required');
  }
  return releaseAttestorRuntime.startDaemon({
    configurationPath: path.resolve(args.configuration),
  });
}

const invokedAsEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsEntrypoint) {
  try {
    const runtime = await runHeptaPaperReleaseAttestorDaemon();
    if (runtime.help) {
      process.stdout.write(`${runtime.help}\n`);
    } else if (runtime.preflight) {
      process.stdout.write(`${JSON.stringify(runtime.preflight)}\n`);
    } else {
      const shutdown = async () => {
        await runtime.listener.close();
        process.exit(0);
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    }
  } catch (error) {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  }
}
