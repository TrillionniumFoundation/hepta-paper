#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { defaultPaperAssetRoot } from '../src/workspace-layout.mjs';
import { coldVolumeCasStatus, drillColdVolumeCasRestore, importColdVolumeToCas } from '../src/cold-volume-cas-repository.mjs';

const command = process.argv[2] || 'status';
const execute = process.argv.includes('--execute');
const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const contractPath = path.join(workspaceRoot, 'paper-core', 'config', 'cold-volume-contract.v1.json');
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const casRoot = path.resolve(process.env.HEPTA_COLD_OBJECT_STORE_ROOT || '/data/home-data/hepta-paper-cold-object-store');
let result;
if (command === 'status') result = coldVolumeCasStatus({ casRoot });
else if (command === 'import') result = importColdVolumeToCas({ assetRoot: defaultPaperAssetRoot(), contract, contractPath, casRoot, execute });
else if (command === 'restore-drill') result = drillColdVolumeCasRestore({ casRoot });
else throw new Error(`Unknown cold-volume CAS command: ${command}`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.status.endsWith('_blocked')) process.exitCode = 1;
