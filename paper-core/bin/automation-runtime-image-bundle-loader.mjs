#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PINNED_RUNTIME_IMAGE_BUNDLE_PROFILES,
  blockedRuntimeImageBundleLoadReceipt,
  loadPinnedRuntimeImageBundle,
  runtimeImageBundleLoaderUsage,
} from '../../paper-composition/automation/runtime-image-bundle-loader-composition.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

export {
  PINNED_RUNTIME_IMAGE_BUNDLE_PROFILES,
  loadPinnedRuntimeImageBundle,
  runtimeImageBundleLoaderUsage,
};

export function parseRuntimeImageBundleLoaderArguments(argv = []) {
  const parsed = parseStrictCliArguments(argv, {
    booleanFlags: ['help'],
    valueFlags: ['bundle-root'],
    positional: false,
  });
  if (parsed.help) return Object.freeze({ help: true, bundleRoot: null });
  const bundleRoot = String(parsed['bundle-root'] || '').trim();
  if (!bundleRoot) throw new Error('runtime_image_bundle_loader_root_required');
  if (!path.isAbsolute(bundleRoot)) {
    throw new Error('runtime_image_bundle_loader_root_absolute_required');
  }
  return Object.freeze({ help: false, bundleRoot: path.resolve(bundleRoot) });
}

const invokedAsEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsEntrypoint) {
  try {
    const options = parseRuntimeImageBundleLoaderArguments(process.argv.slice(2));
    const result = options.help
      ? runtimeImageBundleLoaderUsage()
      : loadPinnedRuntimeImageBundle(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(blockedRuntimeImageBundleLoadReceipt(error), null, 2)}\n`,
    );
    process.exitCode = 1;
  }
}
