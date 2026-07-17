#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { currentCodeProvenance } from '../src/code-provenance.mjs';
import { contentTreeManifest, sha256File, signReleasePayload } from './release-evidence-lib.mjs';
import { assertWorkspaceLayoutPhysicallyDecoupled, defaultLegacyPaperFactoryRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const execute = process.argv.includes('--execute');
const legacyRoot = defaultLegacyPaperFactoryRoot();
const runtimeRoot = defaultPaperRuntimeRoot();
assertWorkspaceLayoutPhysicallyDecoupled({ legacyRoot, runtimeRoot });
const roots = ['bin', 'paperctl_modules', 'plugins', 'schema', 'registry', 'templates', 'docs', 'paper_factory.sqlite'];
const before = contentTreeManifest(legacyRoot, roots);
const version = currentCodeProvenance().packageVersion;
const archiveRoot = path.join(path.dirname(legacyRoot), 'hepta-paper-legacy-reference', version);
const archivePath = path.join(archiveRoot, 'paper-factory-control-plane-reference.tar.gz');
fs.mkdirSync(archiveRoot, { recursive: true });
if (execute && !fs.existsSync(archivePath)) {
  const result = spawnSync('tar', ['-czf', archivePath, '-C', legacyRoot, ...roots.filter((item) => fs.existsSync(path.join(legacyRoot, item)))], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'legacy_reference_archive_failed');
}
function readOnly(absolute) {
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absolute)) readOnly(path.join(absolute, name));
    fs.chmodSync(absolute, 0o555);
  } else if (stat.isFile()) fs.chmodSync(absolute, 0o444);
}
if (execute) for (const relative of roots) {
  const absolute = path.join(legacyRoot, relative);
  if (fs.existsSync(absolute)) readOnly(absolute);
}
const after = contentTreeManifest(legacyRoot, roots);
const payload = {
  version: 1,
  kind: 'LegacyArchiveReadOnlyReceipt',
  status: execute && before.treeHash === after.treeHash ? 'legacy_control_plane_posix_read_only' : 'legacy_archive_read_only_planned',
  codeProvenance: currentCodeProvenance(),
  legacyRoot,
  protectedRoots: roots,
  contentTreeHashBefore: before.treeHash,
  contentTreeHashAfter: after.treeHash,
  contentUnchanged: before.treeHash === after.treeHash,
  referenceArchivePath: archivePath,
  referenceArchiveHash: fs.existsSync(archivePath) ? sha256File(archivePath) : null,
  enforcement: execute ? 'posix_permission_read_only' : 'none',
  wormOrImmutableFilesystemClaimed: false,
  destructiveRemovalPerformed: false,
  createdAt: new Date().toISOString(),
};
const receipt = { ...payload, legacyArchiveReadOnlyReceiptHash: hashRecord('LegacyArchiveReadOnlyReceipt', payload) };
const signature = signReleasePayload(receipt, runtimeRoot);
fs.writeFileSync(path.join(archiveRoot, 'LEGACY_ARCHIVE_READ_ONLY_RECEIPT.json'), `${JSON.stringify(receipt, null, 2)}\n`);
fs.writeFileSync(path.join(archiveRoot, 'LEGACY_ARCHIVE_READ_ONLY_SIGNATURE.json'), `${JSON.stringify(signature, null, 2)}\n`);
if ((fs.statSync(archivePath).mode & 0o777) !== 0o444) fs.chmodSync(archivePath, 0o444);
process.stdout.write(`${JSON.stringify({ ...receipt, signatureFingerprint: signature.publicKeyFingerprint }, null, 2)}\n`);
