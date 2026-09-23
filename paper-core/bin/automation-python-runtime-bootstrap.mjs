#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PYTHON_RUNTIME_BOOTSTRAP_PROFILES,
  blockedPythonRuntimeBootstrapReceipt,
  bootstrapPinnedPythonRuntimeImage,
  canonicalPythonRuntimeBuildArguments,
  inspectPinnedPythonRuntimeOciArchive,
  pythonRuntimeBootstrapUsage,
} from '../../paper-composition/automation/python-runtime-bootstrap-composition.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

export {
  PYTHON_RUNTIME_BOOTSTRAP_PROFILES,
  bootstrapPinnedPythonRuntimeImage,
  canonicalPythonRuntimeBuildArguments,
  inspectPinnedPythonRuntimeOciArchive,
  pythonRuntimeBootstrapUsage,
};

export function parsePythonRuntimeBootstrapArguments(argv = []) {
  const parsed = parseStrictCliArguments(argv, {
    booleanFlags: ['build', 'help'],
    valueFlags: ['archive', 'profile'],
    positional: false,
  });
  if (parsed.help) {
    return Object.freeze({ help: true, profile: null, mode: null, archivePath: null });
  }
  const profile = String(parsed.profile || '').trim();
  if (!PYTHON_RUNTIME_BOOTSTRAP_PROFILES.includes(profile)) {
    throw new Error('python_runtime_bootstrap_profile_invalid');
  }
  const archive = String(parsed.archive || '').trim();
  if (Boolean(parsed.build) === Boolean(archive)) {
    throw new Error('python_runtime_bootstrap_exactly_one_source_required');
  }
  return Object.freeze({
    help: false,
    profile,
    mode: parsed.build ? 'build' : 'archive',
    archivePath: archive ? path.resolve(archive) : null,
  });
}

const invokedAsEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsEntrypoint) {
  let profile = null;
  try {
    const options = parsePythonRuntimeBootstrapArguments(process.argv.slice(2));
    profile = options.profile;
    const result = options.help
      ? pythonRuntimeBootstrapUsage()
      : bootstrapPinnedPythonRuntimeImage(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(blockedPythonRuntimeBootstrapReceipt(error, profile), null, 2)}\n`,
    );
    process.exitCode = 1;
  }
}
