#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  blockedRRuntimeBootstrapReceipt,
  bootstrapPinnedRRuntimeImage,
  canonicalRRuntimeBuildArguments,
  inspectPinnedRRuntimeOciArchive,
  rRuntimeBootstrapUsage,
} from '../../paper-composition/automation/r-runtime-bootstrap-composition.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

export {
  bootstrapPinnedRRuntimeImage,
  canonicalRRuntimeBuildArguments,
  inspectPinnedRRuntimeOciArchive,
  rRuntimeBootstrapUsage,
};

export function parseRRuntimeBootstrapArguments(argv = []) {
  const parsed = parseStrictCliArguments(argv, {
    booleanFlags: ['build', 'help'],
    valueFlags: ['archive'],
    positional: false,
  });
  if (parsed.help) return Object.freeze({ help: true, mode: null, archivePath: null });
  const archive = String(parsed.archive || '').trim();
  if (Boolean(parsed.build) === Boolean(archive)) {
    throw new Error('r_runtime_bootstrap_exactly_one_source_required');
  }
  return Object.freeze({
    help: false,
    mode: parsed.build ? 'build' : 'archive',
    archivePath: archive ? path.resolve(archive) : null,
  });
}

const invokedAsEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsEntrypoint) {
  try {
    const options = parseRRuntimeBootstrapArguments(process.argv.slice(2));
    const result = options.help ? rRuntimeBootstrapUsage() : bootstrapPinnedRRuntimeImage(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(blockedRRuntimeBootstrapReceipt(error), null, 2)}\n`);
    process.exitCode = 1;
  }
}
