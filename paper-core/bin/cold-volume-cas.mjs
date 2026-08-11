#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { defaultPaperAssetRoot } from '../src/workspace-layout.mjs';
import { coldVolumeCasStatus, drillColdVolumeCasRestore, importColdVolumeToCas } from '../../paper-composition/bootstrap/operator-release-composition.mjs';

const command = process.argv[2] || 'status';
const execute = process.argv.includes('--execute');
const requireReady = process.argv.includes('--require-ready');
const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const contractPath = path.join(workspaceRoot, 'paper-core', 'config', 'cold-volume-contract.v1.json');
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const contractedCasRoot = contract?.storageAccessPolicy?.coldCasRoot
  ? path.resolve(contract.storageAccessPolicy.coldCasRoot)
  : path.resolve('/data/home-data/hepta-paper-cold-object-store');
const casRoot = path.resolve(process.env.HEPTA_COLD_OBJECT_STORE_ROOT || contractedCasRoot);
if (casRoot !== contractedCasRoot) {
  throw new Error('cold_volume_cas_root_contract_mismatch');
}
const stagingRoot = process.env.HEPTA_COLD_CAS_STAGING_ROOT
  ? path.resolve(process.env.HEPTA_COLD_CAS_STAGING_ROOT)
  : null;
let result;
if (command === 'status') result = coldVolumeCasStatus({ casRoot, contract, contractPath });
else if (command === 'import') result = importColdVolumeToCas({
  assetRoot: defaultPaperAssetRoot(),
  contract,
  contractPath,
  casRoot,
  execute,
  stagingRoot,
});
else if (command === 'restore-drill') result = drillColdVolumeCasRestore({ casRoot, contract, contractPath });
else throw new Error(`Unknown cold-volume CAS command: ${command}`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.status.endsWith('_blocked') || (requireReady
  && !['cold_volume_cas_ready', 'cold_volume_cas_not_required'].includes(result.status))) {
  process.exitCode = 1;
}
