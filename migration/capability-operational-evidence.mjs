import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hashRecord } from '../workflow-kernel/record-hash.mjs';
import { currentCodeProvenance } from '../paper-core/src/code-provenance.mjs';
import { loadCapabilityOperationalProofs } from './operational-proof-intake.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function hashBytes(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function hashFile(file) {
  return hashBytes(fs.readFileSync(file));
}

export function capabilityEvidencePath(runtimeRoot) {
  return path.join(path.resolve(runtimeRoot), 'audits', 'capability-verification', 'CAPABILITY_VERIFICATION_MANIFEST.json');
}

export function validateCapabilityOperationalEvidence({ runtimeRoot, evidence = null } = {}) {
  let manifest = evidence;
  if (!manifest && runtimeRoot) {
    const candidates = [
      path.join(path.resolve(runtimeRoot), 'release-evidence', 'current', 'CAPABILITY_VERIFICATION_MANIFEST.json'),
      capabilityEvidencePath(runtimeRoot),
    ];
    for (const candidate of candidates) {
      try {
        manifest = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (manifest?.kind === 'CapabilityVerificationManifest') break;
      } catch { manifest = null; }
    }
  }
  const receipts = new Map();
  if (manifest?.kind !== 'CapabilityVerificationManifest') return receipts;
  for (const receipt of manifest.receipts || []) {
    const { capabilityVerificationReceiptHash: claimedHash, ledgerReceiptId, ...payload } = receipt;
    if (!claimedHash || hashRecord('CapabilityVerificationReceipt', payload) !== claimedHash) continue;
    const testFile = path.join(workspaceRoot, receipt.test?.path || '');
    if (!fs.existsSync(testFile) || hashFile(testFile) !== receipt.test?.sha256) continue;
    const targetsValid = (receipt.targets || []).length > 0 && receipt.targets.every((target) => {
      const targetFile = path.join(workspaceRoot, target.path || '');
      return fs.existsSync(targetFile) && hashFile(targetFile) === target.sha256;
    });
    if (!targetsValid || receipt.status !== 'capability_implementation_verified' || receipt.test?.result !== 'passed') continue;
    receipts.set(receipt.capabilityId, Object.freeze({ ...receipt, ledgerReceiptId }));
  }
  return receipts;
}

export async function executeCapabilityVerification({ runtimeRoot, receiptLedger, artifactRepositoryFactory, clock, capabilityCatalog } = {}) {
  if (!runtimeRoot || !receiptLedger || !artifactRepositoryFactory || !clock || !capabilityCatalog) {
    throw new Error('Capability verification requires runtimeRoot, receiptLedger, artifactRepositoryFactory, clock and capabilityCatalog');
  }
  const operationalProofs = loadCapabilityOperationalProofs({
    runtimeRoot,
    workspaceRoot,
    capabilityCatalog,
    releaseCommit: currentCodeProvenance().commit,
  });
  const receipts = [];
  for (const capabilityId of Object.keys(capabilityCatalog).sort()) {
    const catalog = capabilityCatalog[capabilityId];
    const testPath = `migration/tests/capabilities/${capabilityId}.test.mjs`;
    const testFile = path.join(workspaceRoot, testPath);
    const targetFile = path.join(workspaceRoot, catalog.target);
    const result = spawnSync(process.execPath, ['--test', testFile], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      timeout: 180000,
      env: { ...process.env, HEPTA_CAPABILITY_VERIFICATION: '1' },
    });
    const operational = operationalProofs.get(capabilityId);
    const payload = {
      version: 1,
      kind: 'CapabilityVerificationReceipt',
      capabilityId,
      status: result.status === 0 && !result.error
        ? 'capability_implementation_verified'
        : 'capability_implementation_blocked',
      executedAt: clock.nowIso(),
      test: {
        path: testPath,
        sha256: hashFile(testFile),
        result: result.status === 0 && !result.error ? 'passed' : 'failed',
        exitCode: result.status,
        stdoutHash: hashBytes(String(result.stdout || '')),
        stderrHash: hashBytes(String(result.stderr || result.error?.message || '')),
      },
      targets: [{ path: catalog.target, sha256: hashFile(targetFile) }],
      executionClass: 'release_capability_conformance',
      operationalProof: Boolean(operational?.operationalReceiptHashes?.length),
      operationalReceiptHashes: operational?.operationalReceiptHashes || [],
      externalActionPerformed: false,
    };
    const capabilityVerificationReceiptHash = hashRecord('CapabilityVerificationReceipt', payload);
    const ledger = receiptLedger.record({ ...payload, capabilityVerificationReceiptHash }, {
      stream: 'capability-verification',
    });
    receipts.push({ ...payload, capabilityVerificationReceiptHash, ledgerReceiptId: ledger.receiptId });
  }
  const manifestPayload = {
    version: 1,
    kind: 'CapabilityVerificationManifest',
    status: receipts.every((receipt) => receipt.status === 'capability_implementation_verified')
      ? 'capability_verification_complete'
      : 'capability_verification_blocked',
    generatedAt: clock.nowIso(),
    capabilityCount: receipts.length,
    passedCount: receipts.filter((receipt) => receipt.status === 'capability_implementation_verified').length,
    receipts,
  };
  const manifest = {
    ...manifestPayload,
    capabilityVerificationManifestHash: hashRecord('CapabilityVerificationManifest', manifestPayload),
  };
  const target = capabilityEvidencePath(runtimeRoot);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const repository = artifactRepositoryFactory(path.dirname(target));
  const writeReceipt = await repository.writeJson(target, manifest, {
    role: 'capability_verification_manifest',
    atomic: true,
  });
  return { manifest, writeReceipt };
}
