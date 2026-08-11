import fs from 'node:fs';
import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;

function assertSafeDirectory(scopeRoot, candidate) {
  const selectedRoot = path.resolve(scopeRoot);
  const selected = path.resolve(candidate);
  if (!isPathWithin(selectedRoot, selected)) {
    throw new Error('advanced_numerical_campaign_output_scope_invalid');
  }
  fs.mkdirSync(selected, { recursive: true, mode: 0o700 });
  const rootReal = fs.realpathSync(selectedRoot);
  const selectedReal = fs.realpathSync(selected);
  const stat = fs.lstatSync(selected);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || !isPathWithin(rootReal, selectedReal)) {
    throw new Error('advanced_numerical_campaign_output_scope_invalid');
  }
  return selectedReal;
}

function readBytesIfPresent(candidate, maximumBytes = 16 * 1024 * 1024) {
  let descriptor;
  try {
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1
      || stat.size > maximumBytes) {
      throw new Error('advanced_numerical_campaign_evidence_target_unsafe');
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readJsonIfPresent(candidate) {
  const bytes = readBytesIfPresent(candidate);
  if (bytes === null) return null;
  try { return JSON.parse(bytes.toString('utf8')); } catch {
    throw new Error('advanced_numerical_campaign_cached_receipt_invalid');
  }
}

function writeNoClobber(candidate, bytes, { mode = 0o444 } = {}) {
  const existing = readBytesIfPresent(candidate);
  if (existing !== null) {
    if (!existing.equals(bytes)) {
      throw new Error('advanced_numerical_campaign_evidence_no_clobber_conflict');
    }
    return false;
  }
  let descriptor;
  try {
    descriptor = fs.openSync(
      candidate,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      mode,
    );
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return true;
}

function executionDirectory(outputRoot, campaign, node, plan) {
  const identityHash = hashRecord('AdvancedNumericalCampaignRunIdentity', {
    campaignId: campaign.campaignId,
    paperId: campaign.paperId,
    campaignPlanHash: campaign.spec.campaignPlanHash,
    nodeId: node.nodeId,
    attemptId: node.attemptId,
    leaseGeneration: node.leaseGeneration,
    executionPlanHash: plan.advancedNumericalCampaignExecutionPlanHash,
  });
  return path.resolve(outputRoot, 'campaign-attempts', identityHash.slice('sha256:'.length));
}

export function createCampaignAdvancedNumericalEvidenceRepository({ outputRoot } = {}) {
  const selectedOutputRoot = path.resolve(String(outputRoot || ''));
  return Object.freeze({
    version: 1,
    kind: 'CampaignAdvancedNumericalEvidenceRepository',
    prepareAttempt({ campaign, node, plan } = {}) {
      const outputDirectory = assertSafeDirectory(
        selectedOutputRoot,
        executionDirectory(selectedOutputRoot, campaign, node, plan),
      );
      return Object.freeze({
        outputDirectory,
        cachedPath: path.join(outputDirectory, 'campaign-receipt.json'),
      });
    },
    readCached({ cachedPath } = {}) {
      return readJsonIfPresent(cachedPath);
    },
    persistCached({ cachedPath, result } = {}) {
      writeNoClobber(
        cachedPath,
        Buffer.from(`${JSON.stringify(result, null, 2)}\n`, 'utf8'),
      );
    },
  });
}
