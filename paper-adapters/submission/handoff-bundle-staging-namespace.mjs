import crypto from 'node:crypto';
import path from 'node:path';

const MAXIMUM_LABEL_BYTES = 80;
const OWNER_TOKEN = /^[0-9a-f]{32}$/u;

function stagingLabel(finalRoot) {
  const finalName = path.basename(path.resolve(finalRoot || '.'));
  let label = '';
  for (const character of finalName) {
    if (Buffer.byteLength(label + character, 'utf8') > MAXIMUM_LABEL_BYTES) break;
    label += character;
  }
  if (!label) throw new Error('handoff_bundle_staging_namespace_invalid');
  return label;
}

function stagingPrefix(finalRoot) {
  const selected = path.resolve(finalRoot || '.');
  const namespace = crypto.createHash('sha256')
    .update(selected).digest('hex').slice(0, 24);
  return `.${stagingLabel(selected)}.handoff-stage-${namespace}-`;
}

export function submissionHandoffBundleStagingNamePattern(finalRoot) {
  const escaped = stagingPrefix(finalRoot)
    .replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^${escaped}([0-9]+)-[0-9a-f]{32}$`, 'u');
}

export function createSubmissionHandoffBundleStagingName({
  finalRoot,
  ownerPid = process.pid,
  ownerToken = crypto.randomBytes(16).toString('hex'),
} = {}) {
  if (!Number.isSafeInteger(ownerPid) || ownerPid < 1
    || !OWNER_TOKEN.test(ownerToken)) {
    throw new Error('handoff_bundle_staging_namespace_invalid');
  }
  const name = `${stagingPrefix(finalRoot)}${ownerPid}-${ownerToken}`;
  if (Buffer.byteLength(name, 'utf8') > 255) {
    throw new Error('handoff_bundle_staging_namespace_invalid');
  }
  return name;
}
