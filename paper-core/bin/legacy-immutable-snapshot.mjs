#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { currentCodeProvenance } from '../src/code-provenance.mjs';
import { assertWorkspaceLayoutPhysicallyDecoupled, defaultLegacyPaperFactoryRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { sha256File, signReleasePayload } from './release-evidence-lib.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const execute = process.argv.includes('--execute');
const requestedVersion = process.argv.find((value) => value.startsWith('--version='))?.split('=')[1];
const version = requestedVersion || currentCodeProvenance().packageVersion;
const legacyRoot = defaultLegacyPaperFactoryRoot();
const runtimeRoot = defaultPaperRuntimeRoot();
assertWorkspaceLayoutPhysicallyDecoupled({ legacyRoot, runtimeRoot });
const archiveRoot = path.join(path.dirname(legacyRoot), 'hepta-paper-legacy-reference', version);
const archivePath = path.join(archiveRoot, 'paper-factory-control-plane-reference.tar.gz');
if (!fs.existsSync(archivePath)) throw new Error(`Legacy reference archive missing: ${archivePath}`);

function immutable(file) {
  const result = spawnSync('lsattr', ['-d', file], { encoding: 'utf8' });
  return result.status === 0 && /^.{0,20}i/.test(String(result.stdout || '').split(/\s+/)[0] || '');
}

let immutableCommand = { exitCode: null, stderr: '' };
if (execute && !immutable(archivePath)) {
  const result = spawnSync('sudo', ['-n', 'chattr', '+i', archivePath], { encoding: 'utf8' });
  immutableCommand = { exitCode: result.status, stderr: String(result.stderr || '').trim() };
}
const archiveImmutable = immutable(archivePath);
const payload = {
  version: 1,
  kind: 'LegacyReferenceImmutableSnapshotReceipt',
  status: archiveImmutable ? 'legacy_reference_ext4_inode_immutable' : 'legacy_reference_immutable_snapshot_blocked',
  codeProvenance: currentCodeProvenance(),
  referenceVersion: version,
  archivePath,
  archiveHash: sha256File(archivePath),
  filesystemMechanism: 'ext4_inode_immutable_flag',
  archiveImmutable,
  posixMode: fs.statSync(archivePath).mode & 0o777,
  immutableCommand,
  fullFilesystemWormClaimed: false,
  immutableContentObjectClaimed: archiveImmutable,
  destructiveDeletionPerformed: false,
  createdAt: new Date().toISOString(),
};
const receipt = { ...payload, immutableSnapshotReceiptHash: hashRecord('LegacyReferenceImmutableSnapshotReceipt', payload) };
const signature = signReleasePayload(receipt, runtimeRoot);
const token = receipt.immutableSnapshotReceiptHash.replace(/^sha256:/, '');
const receiptPath = path.join(archiveRoot, `IMMUTABLE_SNAPSHOT_RECEIPT_${token}.json`);
const signaturePath = path.join(archiveRoot, `IMMUTABLE_SNAPSHOT_SIGNATURE_${token}.json`);
if (!fs.existsSync(receiptPath)) fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o444 });
if (!fs.existsSync(signaturePath)) fs.writeFileSync(signaturePath, `${JSON.stringify(signature, null, 2)}\n`, { mode: 0o444 });
if (execute) for (const candidate of [receiptPath, signaturePath]) {
  if (!immutable(candidate)) spawnSync('sudo', ['-n', 'chattr', '+i', candidate], { encoding: 'utf8' });
}
process.stdout.write(`${JSON.stringify({
  ...receipt,
  receiptPath,
  signaturePath,
  receiptImmutable: immutable(receiptPath),
  signatureImmutable: immutable(signaturePath),
}, null, 2)}\n`);
if (!archiveImmutable) process.exitCode = 1;
