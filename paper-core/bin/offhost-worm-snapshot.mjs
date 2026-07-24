#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveImmutableLegacyMatrixArchive } from '../../migration/legacy-matrix-reference.mjs';
import {
  createOffhostWormSnapshot,
  drillOffhostWormRestore,
  resolveLatestReleaseEvidencePointer,
  verifyOffhostWormTarget,
} from '../../paper-composition/bootstrap/operator-release-composition.mjs';
import {
  composeAutonomousResearchStateBackupService,
} from '../../paper-composition/bootstrap/autonomous-research-state-backup-composition.mjs';
import { defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtimeRoot = defaultPaperRuntimeRoot();
const contractPath = path.join(workspaceRoot, 'paper-core', 'config', 'offhost-worm-contract.v1.json');
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const command = process.argv[2] || 'status';
const execute = process.argv.includes('--execute');
const authorityConfigIndex = process.argv.indexOf('--authority-config');
if (authorityConfigIndex >= 0
  && (!process.argv[authorityConfigIndex + 1]
    || process.argv[authorityConfigIndex + 1].startsWith('--'))) {
  throw new Error('offhost_worm_authority_config_value_required');
}
const authorityConfigurationPath = authorityConfigIndex >= 0
  ? path.resolve(process.argv[authorityConfigIndex + 1])
  : process.env.HEPTA_AUTONOMOUS_RESEARCH_STATE_BACKUP_AUTHORITY_CONFIG
    ? path.resolve(process.env.HEPTA_AUTONOMOUS_RESEARCH_STATE_BACKUP_AUTHORITY_CONFIG)
    : null;
const pointerPath = resolveLatestReleaseEvidencePointer(runtimeRoot);
let result;
if (command === 'status') result = verifyOffhostWormTarget({ workspaceRoot, contract });
else if (command === 'snapshot') {
  const pointer = pointerPath && fs.existsSync(pointerPath) ? JSON.parse(fs.readFileSync(pointerPath, 'utf8')) : null;
  const stateBackup = composeAutonomousResearchStateBackupService({
    workspaceRoot,
    runtimeRoot,
    authorityConfigurationPath,
  }).offhostSources();
  const stateSources = stateBackup.status === 'autonomous_research_state_backup_sources_ready'
    ? stateBackup.sources
    : [{
      role: 'autonomous_state_backup_bundle',
      path: path.join(
        runtimeRoot,
        'backups',
        'autonomous-research-state',
        'CURRENT_AUTONOMOUS_RESEARCH_STATE_BACKUP_MISSING',
      ),
    }];
  const sources = [
    { role: 'release_evidence_pointer', path: pointerPath || '' },
    { role: 'release_evidence_bundle', path: pointer?.bundlePath || '' },
    { role: 'release_evidence_signature', path: pointer?.signaturePath || '' },
    { role: 'legacy_reference_archive', path: resolveImmutableLegacyMatrixArchive() },
    { role: 'legacy_differential_fixture', path: path.join(workspaceRoot, 'migration', 'fixtures', 'legacy-differential-reference-v1.tar.gz') },
    ...stateSources,
  ];
  result = createOffhostWormSnapshot({ workspaceRoot, contract, sources, execute });
} else if (command === 'restore-drill') {
  const manifestIndex = process.argv.indexOf('--manifest');
  result = drillOffhostWormRestore({ manifestPath: manifestIndex >= 0 ? path.resolve(process.argv[manifestIndex + 1]) : null });
} else throw new Error(`Unknown offhost WORM command: ${command}`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.status.endsWith('_blocked')) process.exitCode = 1;
