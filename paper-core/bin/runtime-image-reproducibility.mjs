#!/usr/bin/env node
import path from 'node:path';

import {
  composeRuntimeImageReproducibilityRequest,
  composeRuntimeImageReproducibilityStatus,
  composeRuntimeImageReproducibilityVerification,
} from '../../paper-composition/automation/runtime-image-reproducibility-composition.mjs';
import { defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

function usage() {
  return [
    'Usage: hepta-paper operator runtime-image-reproducibility -- --action status|request|verify|publish [options]',
    '',
    'Actions:',
    '  status   Read and fully revalidate the persisted receipt; never invokes a verifier or writes.',
    '  request  Emit the current code/release/canonical-context-bound request; never invokes a verifier.',
    '  verify   Invoke both configured independent external verifiers and validate their Ed25519 attestations.',
    '  publish  Verify, then atomically publish only a fully valid and currently eligible receipt.',
    '',
    'Options:',
    '  --config PATH        External verifier process/trust configuration.',
    '  --receipt PATH       Receipt location (default: isolated runtime root).',
    '  --runtime-root PATH  Isolated writable runtime root.',
    '  --root PATH          Repository root containing all canonical Docker contexts.',
    '',
    'All three registered profiles are mandatory. Local Docker output and unsigned record hashes',
    'are diagnostic only and can never satisfy production readiness.',
  ].join('\n');
}

async function main() {
  const args = parseStrictCliArguments(process.argv.slice(2), {
    booleanFlags: ['help'],
    valueFlags: ['action', 'config', 'receipt', 'runtime-root', 'root'],
    positional: false,
  });
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const action = args.action || 'status';
  if (!['status', 'request', 'verify', 'publish'].includes(action)) {
    throw new Error(`runtime_reproducibility_action_invalid:${action}`);
  }
  const options = {
    repositoryRoot: path.resolve(args.root || process.cwd()),
    runtimeRoot: path.resolve(args['runtime-root'] || defaultPaperRuntimeRoot()),
    configPath: args.config || null,
    receiptPath: args.receipt || null,
    environment: process.env,
  };
  let report;
  if (action === 'request') {
    const generated = composeRuntimeImageReproducibilityRequest(options);
    report = Object.freeze({
      version: 1,
      kind: 'RuntimeImageReproducibilityRequestReport',
      status: 'runtime_image_reproducibility_request_generated',
      request: generated.request,
      configuration: Object.freeze({
        configurationIdentityHash: generated.context.configuration.configurationIdentityHash,
        trustIdentityHash: generated.context.configuration.trustIdentityHash,
        independentVerifierCount: generated.context.configuration.verifierTrust.length,
        privateSigningKeyLoaded: false,
      }),
      externalActionPerformed: false,
    });
  } else if (action === 'status') {
    report = composeRuntimeImageReproducibilityStatus(options);
  } else {
    report = await composeRuntimeImageReproducibilityVerification({ ...options, action });
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (action !== 'request' && report.ready !== true) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack || error)}\n`);
  process.exitCode = 1;
});
