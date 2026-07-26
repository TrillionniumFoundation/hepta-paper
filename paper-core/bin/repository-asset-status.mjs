#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectRepositoryAssetExternalization } from '../src/repository-asset-externalization.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifestPath = path.join(
  repositoryRoot,
  'paper-core',
  'config',
  'repository-asset-externalization.v1.json',
);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const inspection = inspectRepositoryAssetExternalization({ repositoryRoot, manifest });
process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
if (!inspection.repositoryBoundaryReady
  || (process.argv.includes('--require-externalized') && !inspection.fullyExternalized)) {
  process.exitCode = 1;
}
