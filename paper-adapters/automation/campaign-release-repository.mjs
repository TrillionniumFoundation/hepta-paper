import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { inspectScopedWriteTargetSync, readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { ensureScopedDirectorySync } from '../runtime/scoped-file-materialization-repository.mjs';
import { fsyncDirectorySync } from '../runtime/durable-json-repository.mjs';

function bundlePath(releaseRoot) {
  return path.join(path.resolve(releaseRoot), 'CAMPAIGN_RELEASE_BUNDLE.json');
}

export function readCampaignReleaseBundleSync({ runtimeRoot, releaseRoot } = {}) {
  const candidate = bundlePath(releaseRoot);
  if (!fs.existsSync(candidate)) return null;
  const read = readScopedFileSync({ scopeRoot: path.resolve(runtimeRoot), candidate, maximumBytes: 32 * 1024 * 1024 });
  if (read.status !== 'scoped_file_read_verified') throw new Error(`campaign_release_bundle_read_blocked:${read.blockers.join(',')}`);
  try { return Object.freeze({ bundle: JSON.parse(read.content.toString('utf8')), path: candidate, hash: read.hash, readReceiptHash: read.scopedFileReadReceiptHash }); }
  catch { throw new Error('campaign_release_bundle_invalid_json'); }
}

export function persistCampaignReleaseBundleSync({ runtimeRoot, releaseRoot, bundle } = {}) {
  const root = path.resolve(runtimeRoot || '.');
  const target = bundlePath(releaseRoot);
  const before = inspectScopedWriteTargetSync({ scopeRoot: root, candidate: target });
  if (before.status !== 'scoped_write_target_verified') throw new Error(`campaign_release_bundle_target_blocked:${before.blockers.join(',')}`);
  const bytes = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  ensureScopedDirectorySync({ scopeRoot: root, relative: path.relative(root, path.dirname(target)).replace(/\\/g, '/') });
  const afterDirectory = inspectScopedWriteTargetSync({ scopeRoot: root, candidate: target });
  if (afterDirectory.status !== 'scoped_write_target_verified') throw new Error(`campaign_release_bundle_target_blocked:${afterDirectory.blockers.join(',')}`);
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o444 });
    const descriptor = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    try { fs.linkSync(temporary, target); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
  } finally {
    fs.rmSync(temporary, { force: true });
    fsyncDirectorySync(path.dirname(target));
  }
  const read = readScopedFileSync({ scopeRoot: root, candidate: target, maximumBytes: 32 * 1024 * 1024 });
  if (read.status !== 'scoped_file_read_verified') throw new Error(`campaign_release_bundle_materialization_blocked:${read.blockers.join(',')}`);
  if (read.hash !== hashBytes(bytes)) throw new Error('campaign_release_bundle_immutable_collision');
  const payload = {
    version: 1,
    kind: 'CampaignReleaseBundleMaterializationReceipt',
    status: 'campaign_release_bundle_materialized',
    campaignReleaseBundleHash: bundle?.campaignReleaseBundleHash || null,
    path: target,
    contentHash: read.hash,
    bytes: read.bytes,
    atomicCreateIfAbsent: true,
    immutable: true,
    scopedFileReadReceiptHash: read.scopedFileReadReceiptHash,
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, campaignReleaseBundleMaterializationReceiptHash: hashRecord('CampaignReleaseBundleMaterializationReceipt', payload) });
}
