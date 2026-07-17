import crypto from 'node:crypto';
import path from 'node:path';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { persistCampaignReleaseBundleSync, readCampaignReleaseBundleSync } from './campaign-release-repository.mjs';
import { ensureScopedDirectorySync } from '../runtime/scoped-file-materialization-repository.mjs';
import { fsyncDirectorySync } from '../runtime/durable-json-repository.mjs';

function safeSegment(value) {
  const raw = String(value || 'missing');
  const label = raw.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100) || 'missing';
  const suffix = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return `${label}-${suffix}`;
}

function attemptRoot(runtimeRoot, category, campaign, packageNode) {
  if (!packageNode?.attemptId) throw new Error('campaign_release_package_attempt_id_required');
  return path.join(
    path.resolve(runtimeRoot),
    category,
    safeSegment(campaign?.campaignId),
    safeSegment(packageNode?.nodeId),
    safeSegment(packageNode.attemptId),
  );
}

export function campaignReleaseRootFor(runtimeRoot, campaign, packageNode) {
  return attemptRoot(runtimeRoot, 'campaign-releases', campaign, packageNode);
}

export function campaignReleaseRebuildRootFor(runtimeRoot, campaign, packageNode) {
  return attemptRoot(runtimeRoot, 'campaign-release-rebuilds', campaign, packageNode);
}

export function initializeCampaignReleaseRootSync(runtimeRoot, releaseRoot) {
  return ensureScopedDirectorySync({
    scopeRoot: runtimeRoot,
    relative: path.relative(runtimeRoot, releaseRoot).replace(/\\/g, '/'),
  });
}

export function assertImmutableCampaignPackageFilesSync(packageOutput, runtimeRoot) {
  const releaseRoot = path.resolve(packageOutput?.releaseRoot || '.');
  if (!isPathWithin(runtimeRoot, releaseRoot)) throw new Error('campaign_release_package_output_runtime_escape');
  for (const file of packageOutput?.files || []) {
    const candidate = path.resolve(file.path || '.');
    if (candidate === releaseRoot || !isPathWithin(releaseRoot, candidate)) {
      throw new Error(`campaign_release_package_output_file_escape:${file.role || 'unknown'}`);
    }
    const read = readScopedFileSync({ scopeRoot: releaseRoot, candidate });
    if (read.status !== 'scoped_file_read_verified' || read.hash !== file.hash
      || Number(read.bytes) !== Number(file.bytes)) {
      throw new Error(`campaign_release_package_output_file_invalid:${file.role || 'unknown'}`);
    }
  }
}

export function readCampaignReleaseMaterializationSync({ runtimeRoot, releaseRoot }) {
  return readCampaignReleaseBundleSync({ runtimeRoot, releaseRoot });
}

export function persistCampaignReleaseMaterializationSync({ runtimeRoot, releaseRoot, bundle }) {
  return persistCampaignReleaseBundleSync({ runtimeRoot, releaseRoot, bundle });
}

export function fsyncCampaignReleasePackageDirectorySync(packageDir) {
  fsyncDirectorySync(packageDir);
}
