#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildRepositoryAssetExternalizationHandoff,
  inspectRepositoryAssetExternalization,
} from '../src/repository-asset-externalization.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifestPath = path.join(
  repositoryRoot,
  'paper-core',
  'config',
  'repository-asset-externalization.v1.json',
);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const args = parseStrictCliArguments(process.argv.slice(2), {
  booleanFlags: ['handoff', 'require-externalized'],
  positional: false,
});
const inspection = inspectRepositoryAssetExternalization({ repositoryRoot, manifest });
const output = args.handoff
  ? buildRepositoryAssetExternalizationHandoff({ repositoryRoot, manifest })
  : inspection;
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
if (!inspection.repositoryBoundaryReady
  || (args['require-externalized'] && !inspection.fullyExternalized)) {
  process.exitCode = 1;
}
