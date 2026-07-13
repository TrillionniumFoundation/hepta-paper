#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifestPath = path.join(workspaceRoot, 'migration', 'legacy-salvage-manifest.v1.json');
const receiptPath = path.join(workspaceRoot, 'migration', 'legacy-salvage-verification-receipt.v1.json');
const digest = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const replacements = manifest.files.filter((item) => item.disposition === 'verified_behavioral_replacement');
const evidence = [...new Map(replacements.flatMap((item) => item.evidence).map((item) => [item.path, item])).values()]
  .sort((left, right) => left.path.localeCompare(right.path));
const execution = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...evidence.map((item) => item.path)], {
  cwd: workspaceRoot,
  encoding: 'utf8',
  timeout: 300_000,
  maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, HEPTA_MIGRATION_MATRIX_TEST: '1' },
});
const subject = {
  version: 1,
  kind: 'SalvageReplacementVerificationReceipt',
  status: execution.status === 0 ? 'salvage_replacements_behavior_verified' : 'salvage_replacements_behavior_blocked',
  manifestHash: manifest.manifestHash,
  replacementCount: replacements.length,
  replacements: replacements.map((item) => ({
    path: item.path,
    sourceHash: item.sourceHash,
    targetHashes: item.targets.map((target) => target.hash),
    evidenceHashes: item.evidence.map((test) => test.hash),
    boundReceiptHash: item.replacementVerification?.verificationReceiptHash || null,
  })),
  executedEvidence: evidence,
  executedEvidenceCount: evidence.length,
  testExitCode: execution.status,
};
const receipt = { ...subject, salvageReplacementVerificationReceiptHash: digest(Buffer.from(JSON.stringify(subject))) };
if (process.argv.includes('--write')) fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
else {
  if (execution.status !== 0) {
    process.stderr.write(String(execution.stdout || ''));
    process.stderr.write(String(execution.stderr || ''));
    process.exitCode = 1;
  } else {
    const stored = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (JSON.stringify(stored) !== JSON.stringify(receipt)) throw new Error('salvage_replacement_verification_receipt_stale');
  }
}
process.stdout.write(`${JSON.stringify({ status: receipt.status, replacementCount: receipt.replacementCount, executedEvidenceCount: receipt.executedEvidenceCount, receiptHash: receipt.salvageReplacementVerificationReceiptHash })}\n`);
