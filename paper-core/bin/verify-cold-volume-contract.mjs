#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyColdVolumeContract } from '../../paper-composition/bootstrap/operator-release-composition.mjs';
import { defaultPaperAssetRoot } from '../src/workspace-layout.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const contractPath = path.join(workspaceRoot, 'paper-core', 'config', 'cold-volume-contract.v1.json');
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const status = verifyColdVolumeContract({ assetRoot: defaultPaperAssetRoot(), contract, contractPath });
process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
if (!status.contractValid || (process.argv.includes('--require-mounted') && !status.operationalReplayReady)) process.exitCode = 1;
