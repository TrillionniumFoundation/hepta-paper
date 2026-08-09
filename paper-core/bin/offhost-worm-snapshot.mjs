#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveImmutableLegacyMatrixArchive } from '../../migration/legacy-matrix-reference.mjs';
import {
  createOffhostWormSnapshot,
  drillOffhostWormRestore,
  selectLatestVerifiedReleaseEvidence,
  verifyOffhostWormTarget,
} from '../../paper-composition/bootstrap/operator-release-composition.mjs';
import {
  composeAutonomousResearchStateBackupService,
} from '../../paper-composition/bootstrap/autonomous-research-state-backup-composition.mjs';
import { defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { releaseIntegrityEvidence } from './release-integrity-evidence.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtimeRoot = defaultPaperRuntimeRoot();
function localManifestAuthority() {
  const pinned = releaseIntegrityEvidence.loadExistingReleaseSigningKey(runtimeRoot);
  const verifyManifestSignature = (payload, signature) => (
    releaseIntegrityEvidence.verifyReleaseIntegritySignature(payload, signature, {
      pinnedPublicKeyPem: pinned.publicKeyPem,
      pinnedPublicKeyFingerprint: pinned.publicKeyFingerprint,
    })
  );
  return Object.freeze({
    signManifest(payload) {
      const signature = releaseIntegrityEvidence.signReleasePayload(
        payload,
        runtimeRoot,
        { allowKeyCreation: false },
      );
      if (!verifyManifestSignature(payload, signature)) {
        throw new Error('offhost_worm_manifest_signing_key_changed');
      }
      return signature;
    },
    verifyManifestSignature,
  });
}
const contractPath = path.join(workspaceRoot, 'paper-core', 'config', 'offhost-worm-contract.v1.json');
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const command = process.argv[2] || 'status';
const execute = process.argv.includes('--execute');
const requireCustodyCount = process.argv.filter((argument) => (
  argument === '--require-custody'
)).length;
if (requireCustodyCount > 1) throw new Error('offhost_worm_require_custody_duplicate');
if (requireCustodyCount === 1 && command !== 'status') {
  throw new Error('offhost_worm_require_custody_status_only');
}
const requireCustody = requireCustodyCount === 1;
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
let result;
if (command === 'status') {
  result = verifyOffhostWormTarget({ workspaceRoot, contract, requireCustody });
}
else if (command === 'snapshot') {
  const manifestAuthority = execute ? localManifestAuthority() : {};
  const releaseEvidence = selectLatestVerifiedReleaseEvidence(runtimeRoot);
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
    ...releaseEvidence.sources,
    { role: 'legacy_reference_archive', path: resolveImmutableLegacyMatrixArchive() },
    { role: 'legacy_differential_fixture', path: path.join(workspaceRoot, 'migration', 'fixtures', 'legacy-differential-reference-v1.tar.gz') },
    ...stateSources,
  ];
  result = createOffhostWormSnapshot({
    workspaceRoot,
    runtimeRoot,
    contract,
    sources,
    sourceBlockers: releaseEvidence.blockers,
    execute,
    ...manifestAuthority,
  });
} else if (command === 'restore-drill') {
  const manifestIndex = process.argv.indexOf('--manifest');
  if (manifestIndex >= 0
    && (!process.argv[manifestIndex + 1]
      || process.argv[manifestIndex + 1].startsWith('--'))) {
    throw new Error('offhost_worm_manifest_value_required');
  }
  result = drillOffhostWormRestore({
    manifestPath: manifestIndex >= 0 ? path.resolve(process.argv[manifestIndex + 1]) : null,
    targetMountRoot: path.resolve(
      process.env.HEPTA_OFFHOST_WORM_ROOT || contract.targetMountRoot,
    ),
    verifyManifestSignature: localManifestAuthority().verifyManifestSignature,
  });
} else throw new Error(`Unknown offhost WORM command: ${command}`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.status.endsWith('_blocked')) process.exitCode = 1;
