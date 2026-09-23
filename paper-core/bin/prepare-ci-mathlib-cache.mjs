#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CI_MATHLIB_CACHE_USAGE,
  prepareCiMathlibCache,
} from '../../paper-composition/automation/ci-mathlib-cache-composition.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const options = parseStrictCliArguments(process.argv.slice(2), {
  booleanFlags: ['help', 'prepare'],
  valueFlags: ['root'],
  positional: false,
});

if (options.help) {
  process.stdout.write(`${JSON.stringify(CI_MATHLIB_CACHE_USAGE, null, 2)}\n`);
  process.exit(0);
}

const receipt = prepareCiMathlibCache({
  workspaceRoot,
  root: options.root || null,
  prepare: options.prepare === true,
});
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
process.exitCode = receipt.status === 'ci_mathlib_cache_verified' ? 0 : 1;
