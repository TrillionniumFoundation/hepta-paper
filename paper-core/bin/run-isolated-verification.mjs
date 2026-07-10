#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { currentCodeProvenance } from '../src/code-provenance.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mode = process.argv[2] || 'test';
if (!['test', 'ci', 'release'].includes(mode)) throw new Error(`Unsupported isolated verification mode: ${mode}`);
const productionRuntimeRoot = defaultPaperRuntimeRoot();
const isolatedRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `hepta-paper-${mode}-`));
const isolatedDb = path.join(isolatedRuntimeRoot, 'hepta-paper.sqlite');
const productionDb = path.join(productionRuntimeRoot, 'hepta-paper.sqlite');

function sha(file) {
  return fs.existsSync(file) ? `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}` : null;
}

const productionHashBefore = sha(productionDb);
if (fs.existsSync(productionDb)) fs.copyFileSync(productionDb, isolatedDb);
for (const relative of ['owner-acceptance', 'operational-proof', 'trust', 'authority-inbox']) {
  const source = path.join(productionRuntimeRoot, relative);
  const target = path.join(isolatedRuntimeRoot, relative);
  if (fs.existsSync(source)) fs.cpSync(source, target, { recursive: true, dereference: false });
}
const store = createDefaultPaperStore({ root: defaultPaperAssetRoot(), runtimeRoot: isolatedRuntimeRoot, dbPath: isolatedDb });
if (!fs.existsSync(productionDb)) {
  store.execute("INSERT OR IGNORE INTO papers(slug,title,canonical_dir,source_dir,status) VALUES('verification_fixture','Verification fixture','verification_fixture','','draft');");
}
const provenance = {
  ...currentCodeProvenance(),
  evidenceEnvironment: 'verification',
  evidenceClass: 'technical_conformance',
};
const env = {
  ...process.env,
  HEPTA_PAPER_RUNTIME_ROOT: isolatedRuntimeRoot,
  HEPTA_EVIDENCE_ENVIRONMENT: 'verification',
  HEPTA_EVIDENCE_CLASS: 'technical_conformance',
  HEPTA_RELEASE_COMMIT: provenance.commit || '',
};
const startedAt = new Date().toISOString();
const result = spawnSync('npm', ['run', `${mode}:inner`], {
  cwd: workspaceRoot,
  env,
  encoding: 'utf8',
  stdio: ['inherit', 'inherit', 'inherit'],
});
const productionHashAfter = sha(productionDb);
const payload = {
  version: 1,
  kind: 'IsolatedVerificationReceipt',
  status: result.status === 0 && productionHashBefore === productionHashAfter
    ? 'isolated_verification_passed'
    : 'isolated_verification_blocked',
  mode,
  codeProvenance: provenance,
  startedAt,
  completedAt: new Date().toISOString(),
  exitCode: result.status,
  isolatedRuntimeRoot,
  isolatedStoreHash: sha(isolatedDb),
  productionStoreHashBefore: productionHashBefore,
  productionStoreHashAfter: productionHashAfter,
  productionStoreMutated: productionHashBefore !== productionHashAfter,
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
    fs.copyFileSync(capabilityManifest, path.join(currentRoot, 'CAPABILITY_VERIFICATION_MANIFEST.json'));
  }
}
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
if (receipt.status === 'isolated_verification_passed') fs.rmSync(isolatedRuntimeRoot, { recursive: true, force: true });
else process.stderr.write(`Isolated verification runtime retained: ${isolatedRuntimeRoot}\n`);
if (result.status !== 0 || receipt.productionStoreMutated) process.exitCode = result.status || 1;
