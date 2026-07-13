#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildLegacyCapabilityMatrixV3 } from '../../migration/legacy-capability-matrix-v3.mjs';
import { currentCodeProvenance } from '../src/code-provenance.mjs';
import { sha256File, signReleasePayload } from './release-evidence-lib.mjs';
import { defaultLegacyPaperFactoryRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyLegacyDifferentialReference } from '../../migration/legacy-reference-fixture.mjs';
import { resolveImmutableLegacyMatrixArchive } from '../../migration/legacy-matrix-reference.mjs';
import { copySqliteDatabase } from '../../paper-adapters/persistence/sqlite-consistent-copy.mjs';

const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const runtimeRoot = defaultPaperRuntimeRoot();
const legacyRoot = defaultLegacyPaperFactoryRoot();
const archivePath = resolveImmutableLegacyMatrixArchive();
if (!fs.existsSync(archivePath)) throw new Error(`Legacy reference archive missing: ${archivePath}`);
const drillRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-legacy-deletion-drill-'));
const extract = spawnSync('tar', ['-xzf', archivePath, '-C', drillRoot], { encoding: 'utf8' });
if (extract.status !== 0) throw new Error(extract.stderr || 'legacy_reference_extract_failed');
const verificationRuntimeRoot = path.join(drillRoot, 'verification-runtime');
fs.mkdirSync(verificationRuntimeRoot, { recursive: true });
const productionStorePath = path.join(runtimeRoot, 'hepta-paper.sqlite');
if (fs.existsSync(productionStorePath)) {
  await copySqliteDatabase({ sourcePath: productionStorePath, destinationPath: path.join(verificationRuntimeRoot, 'hepta-paper.sqlite') });
}
const retirementEvidenceRoot = path.join(runtimeRoot, 'legacy-retirement');
if (fs.existsSync(retirementEvidenceRoot)) {
  fs.cpSync(retirementEvidenceRoot, path.join(verificationRuntimeRoot, 'legacy-retirement'), { recursive: true });
}
function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PAPER_FACTORY_LEGACY_ROOT: drillRoot,
      HEPTA_PAPER_RUNTIME_ROOT: verificationRuntimeRoot,
      HEPTA_PAPER_RUNTIME_ISOLATED: '1',
      HEPTA_LEGACY_REFERENCE_PREPARED: '1',
      HEPTA_LEGACY_REFERENCE_ARCHIVE: archivePath,
    },
    timeout: 240000,
  });
  return { args, exitCode: result.status, stdoutHash: hashRecord('CommandStdout', String(result.stdout || '')), stderr: String(result.stderr || '').slice(0, 500) };
}
const checks = [
  run(['migration/tests/matrix-integrity.mjs']),
  run(['migration/tests/p0-production-core-differential.mjs']),
  run(['migration/tests/p1-referee-revision-differential.mjs']),
];
const sqlite = spawnSync('sqlite3', ['-readonly', path.join(drillRoot, 'paper_factory.sqlite'), 'PRAGMA quick_check;'], { encoding: 'utf8' });
const fixtureVerification = verifyLegacyDifferentialReference();
const immutableAttribute = spawnSync('lsattr', ['-d', archivePath], { encoding: 'utf8' });
const archiveImmutable = immutableAttribute.status === 0
  && /^.{0,20}i/.test(String(immutableAttribute.stdout || '').split(/\s+/)[0] || '');
const matrix = buildLegacyCapabilityMatrixV3({ runtimeRoot });
const blockers = [];
if (checks.some((check) => check.exitCode !== 0)) blockers.push('legacy_reference_differential_replay_failed');
if (String(sqlite.stdout || '').trim() !== 'ok') blockers.push('legacy_database_restore_quick_check_failed');
if (fixtureVerification.status !== 'legacy_differential_reference_verified') blockers.push('minimal_legacy_differential_fixture_invalid');
if (!archiveImmutable) blockers.push('legacy_reference_archive_not_filesystem_immutable');
if (matrix.summary.ownerAccepted !== matrix.summary.entryCount) blockers.push('owner_acceptance_incomplete');
if (matrix.summary.operationallyProven !== matrix.summary.operationallyNotProven + matrix.summary.operationallyProven) blockers.push('operational_proof_incomplete');
const payload = {
  version: 1,
  kind: 'LegacyPhysicalDeletionAndRestoreDrillReceipt',
  status: checks.every((check) => check.exitCode === 0) && String(sqlite.stdout || '').trim() === 'ok'
    ? (blockers.length ? 'legacy_reference_restore_drill_passed_deletion_blocked' : 'legacy_reference_restore_drill_passed_deletion_allowed')
    : 'legacy_reference_restore_drill_blocked',
  codeProvenance: currentCodeProvenance(),
  archivePath,
  archiveHash: sha256File(archivePath),
  checks,
  sqliteQuickCheck: String(sqlite.stdout || '').trim(),
  minimalDifferentialFixture: fixtureVerification,
  archiveImmutable,
  ownerAccepted: matrix.summary.ownerAccepted,
  ownerAcceptanceRequired: matrix.summary.entryCount,
  operationallyProven: matrix.summary.operationallyProven,
  operationalProofRequired: matrix.summary.operationallyProven + matrix.summary.operationallyNotProven,
  physicalDeletionAllowed: blockers.length === 0,
  blockers,
  destructiveDeletionPerformed: !fs.existsSync(legacyRoot),
  liveLegacyRootPresent: fs.existsSync(legacyRoot),
  restoredFromReferenceArchive: true,
  createdAt: new Date().toISOString(),
};
const receipt = { ...payload, legacyPhysicalDeletionAndRestoreDrillReceiptHash: hashRecord('LegacyPhysicalDeletionAndRestoreDrillReceipt', payload) };
const signature = signReleasePayload(receipt, runtimeRoot);
const outputRoot = path.join(runtimeRoot, 'legacy-retirement', 'deletion-drills');
fs.mkdirSync(outputRoot, { recursive: true });
fs.writeFileSync(path.join(outputRoot, `LEGACY_DELETION_DRILL_${Date.now()}.json`), `${JSON.stringify({ ...receipt, signature }, null, 2)}\n`);
function makeExtractedTreeRemovable(candidate) {
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.chmodSync(candidate, 0o700);
    for (const name of fs.readdirSync(candidate)) makeExtractedTreeRemovable(path.join(candidate, name));
  } else if (stat.isFile()) fs.chmodSync(candidate, 0o600);
}
makeExtractedTreeRemovable(drillRoot);
fs.rmSync(drillRoot, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
if (!receipt.status.startsWith('legacy_reference_restore_drill_passed')) process.exitCode = 1;
