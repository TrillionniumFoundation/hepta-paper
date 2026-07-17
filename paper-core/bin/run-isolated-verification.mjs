#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildSqliteLogicalIntegrityReport,
  copySqliteDatabase,
  createReadOnlyPaperStore,
} from '../../paper-composition/bootstrap/operator-persistence-composition.mjs';
import { assertWorkspaceLayoutPhysicallyDecoupled, defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { currentCodeProvenance } from '../src/code-provenance.mjs';
import { inspectIsolatedVerificationPreflight } from '../src/isolated-verification-policy.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';
import { prepareImmutableLegacyMatrixReference } from '../../migration/legacy-matrix-reference.mjs';
import { prepareIsolatedRuntimeStore } from './isolated-runtime-store.mjs';
import { inspectTrackedProductionGraph } from '../verification/tracked-production-graph.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mode = process.argv[2] || 'test';
if (!['test', 'ci', 'release'].includes(mode)) throw new Error(`Unsupported isolated verification mode: ${mode}`);
const provenanceBefore = currentCodeProvenance();
const verificationPreflight = inspectIsolatedVerificationPreflight({
  mode,
  codeProvenance: provenanceBefore,
});
const productionGraphTracking = mode === 'release'
  ? inspectTrackedProductionGraph({ workspaceRoot })
  : null;
const verificationPreflightBlockers = [
  ...verificationPreflight.blockers,
  ...(productionGraphTracking?.blockers || []),
];
if (verificationPreflightBlockers.length) {
  throw new Error(`isolated_verification_preflight_blocked:${verificationPreflightBlockers.join(',')}`);
}
const productionRuntimeRoot = defaultPaperRuntimeRoot();
if (mode === 'release') {
  assertWorkspaceLayoutPhysicallyDecoupled({
    assetRoot: defaultPaperAssetRoot(),
    runtimeRoot: productionRuntimeRoot,
  });
}
const isolatedRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `hepta-paper-${mode}-`));
const isolatedDb = path.join(isolatedRuntimeRoot, 'hepta-paper.sqlite');
const productionDb = path.join(productionRuntimeRoot, 'hepta-paper.sqlite');

if (mode === 'release' && fs.existsSync(productionDb)) {
  const preflight = spawnSync(process.execPath, ['paper-core/bin/hepta-store.mjs', 'status', '--require-trust-clean'], { cwd: workspaceRoot, env: process.env, encoding: 'utf8' });
  if (preflight.status !== 0) throw new Error(`production_store_trust_preflight_blocked:${String(preflight.stdout || preflight.stderr || '').slice(-2000)}`);
}

function sha(file) {
  return fs.existsSync(file) ? sha256FileSync(file) : null;
}

const productionHashBefore = sha(productionDb);
const legacyReference = prepareImmutableLegacyMatrixReference();
const productionLogicalBefore = fs.existsSync(productionDb)
  ? buildSqliteLogicalIntegrityReport({ dbPath: productionDb, store: createReadOnlyPaperStore({ dbPath: productionDb }) })
  : null;
if (fs.existsSync(productionDb)) await copySqliteDatabase({ sourcePath: productionDb, destinationPath: isolatedDb });
for (const relative of ['owner-acceptance', 'operational-proof', 'conformance-proof', 'trust', 'authority-inbox']) {
  const source = path.join(productionRuntimeRoot, relative);
  const target = path.join(isolatedRuntimeRoot, relative);
  if (fs.existsSync(source)) fs.cpSync(source, target, { recursive: true, dereference: false });
}
prepareIsolatedRuntimeStore({
  root: defaultPaperAssetRoot(),
  runtimeRoot: isolatedRuntimeRoot,
  dbPath: isolatedDb,
  initialize(store) {
    if (!fs.existsSync(productionDb)) {
      const inserted = store.execute("INSERT OR IGNORE INTO papers(slug,title,canonical_dir,source_dir,status) VALUES('verification_fixture','Verification fixture','verification_fixture','','draft');");
      if (!inserted.ok) throw new Error(inserted.error || 'isolated_verification_fixture_write_failed');
    }
  },
});
const provenance = {
  ...provenanceBefore,
  evidenceEnvironment: 'verification',
  evidenceClass: 'technical_conformance',
};
const env = {
  ...process.env,
  HEPTA_PAPER_RUNTIME_ROOT: isolatedRuntimeRoot,
  HEPTA_PAPER_RUNTIME_ISOLATED: '1',
  HEPTA_PRODUCTION_RUNTIME_ROOT: productionRuntimeRoot,
  HEPTA_EVIDENCE_ENVIRONMENT: 'verification',
  HEPTA_EVIDENCE_CLASS: 'technical_conformance',
  HEPTA_RELEASE_COMMIT: provenance.commit || '',
  HEPTA_LEGACY_REFERENCE_PREPARED: '1',
  HEPTA_LEGACY_REFERENCE_ARCHIVE: legacyReference.archivePath,
  PAPER_FACTORY_LEGACY_ROOT: legacyReference.root,
};
const startedAt = new Date().toISOString();
const result = spawnSync('npm', ['run', `${mode}:inner`], {
  cwd: workspaceRoot,
  env,
  encoding: 'utf8',
  stdio: ['inherit', 'inherit', 'inherit'],
});
const productionHashAfter = sha(productionDb);
const provenanceAfter = currentCodeProvenance();
const sourceMutated = provenanceBefore.commit !== provenanceAfter.commit
  || provenanceBefore.commitTree !== provenanceAfter.commitTree
  || provenanceBefore.worktreeStateHash !== provenanceAfter.worktreeStateHash;
const productionLogicalAfter = fs.existsSync(productionDb)
  ? buildSqliteLogicalIntegrityReport({ dbPath: productionDb, store: createReadOnlyPaperStore({ dbPath: productionDb }) })
  : null;
const productionLogicalMutated = productionLogicalBefore?.logicalDatabaseHash
  !== productionLogicalAfter?.logicalDatabaseHash;
const productionLogicalBlocked = Boolean(
  productionLogicalBefore?.blockers?.length || productionLogicalAfter?.blockers?.length,
);
const payload = {
  version: 1,
  kind: 'IsolatedVerificationReceipt',
  status: result.status === 0
    && productionHashBefore === productionHashAfter
    && !productionLogicalMutated
    && !productionLogicalBlocked
    && !sourceMutated
    ? 'isolated_verification_passed'
    : 'isolated_verification_blocked',
  mode,
  codeProvenance: provenance,
  completedCodeProvenance: provenanceAfter,
  sourceMutatedDuringVerification: sourceMutated,
  productionGraphTracking: productionGraphTracking
    ? {
      version: productionGraphTracking.version,
      kind: productionGraphTracking.kind,
      status: productionGraphTracking.status,
      moduleCount: productionGraphTracking.moduleCount,
      edgeCount: productionGraphTracking.edgeCount,
      trackedModuleCount: productionGraphTracking.trackedModuleCount,
      indexBoundModuleCount: productionGraphTracking.indexBoundModuleCount,
      productionGraphManifestHash: productionGraphTracking.productionGraphManifestHash,
    }
    : null,
  startedAt,
  completedAt: new Date().toISOString(),
  exitCode: result.status,
  isolatedRuntimeRoot,
  isolatedStoreHash: sha(isolatedDb),
  productionStoreHashBefore: productionHashBefore,
  productionStoreHashAfter: productionHashAfter,
  productionStoreMutated: productionHashBefore !== productionHashAfter,
  productionLogicalHashBefore: productionLogicalBefore?.logicalDatabaseHash || null,
  productionLogicalHashAfter: productionLogicalAfter?.logicalDatabaseHash || null,
  productionLogicalStoreMutated: productionLogicalMutated,
  productionLogicalIntegrityStatusBefore: productionLogicalBefore?.status || null,
  productionLogicalIntegrityStatusAfter: productionLogicalAfter?.status || null,
  evidenceEnvironment: 'verification',
  evidenceClass: 'technical_conformance',
};
const receipt = { ...payload, isolatedVerificationReceiptHash: hashRecord('IsolatedVerificationReceipt', payload) };
if (mode === 'release') {
  const outputRoot = path.join(productionRuntimeRoot, 'release-evidence', 'verification-receipts');
  fs.mkdirSync(outputRoot, { recursive: true });
  const name = `${provenance.packageVersion}-${String(provenance.commit || 'unknown').slice(0, 12)}-${Date.now()}.json`;
  fs.writeFileSync(path.join(outputRoot, name), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o444 });
  const capabilityManifest = path.join(isolatedRuntimeRoot, 'audits', 'capability-verification', 'CAPABILITY_VERIFICATION_MANIFEST.json');
  if (fs.existsSync(capabilityManifest)) {
    const currentRoot = path.join(productionRuntimeRoot, 'release-evidence', 'current');
    fs.mkdirSync(currentRoot, { recursive: true });
    const currentManifest = path.join(currentRoot, 'CAPABILITY_VERIFICATION_MANIFEST.json');
    if (fs.existsSync(currentManifest)) fs.chmodSync(currentManifest, 0o644);
    fs.copyFileSync(capabilityManifest, currentManifest);
    fs.chmodSync(currentManifest, 0o444);
  }
}
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
legacyReference.cleanup();
if (receipt.status === 'isolated_verification_passed') fs.rmSync(isolatedRuntimeRoot, { recursive: true, force: true });
else process.stderr.write(`Isolated verification runtime retained: ${isolatedRuntimeRoot}\n`);
if (result.status !== 0 || receipt.productionStoreMutated || receipt.productionLogicalStoreMutated || productionLogicalBlocked || sourceMutated) {
  process.exitCode = result.status || 1;
}
