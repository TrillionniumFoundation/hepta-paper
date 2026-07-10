import {
  canonicalExternalActionOrNull,
  canonicalPackageRole,
  canonicalProductLineIdOrNull,
  normalizeText,
} from './contracts.mjs';

function text(value) {
  return normalizeText(value || '') || null;
}

function normalizeFieldValue(field, value) {
  if (field === 'action') return canonicalExternalActionOrNull(value);
  if (field === 'productLineId' || field === 'workflowId') return canonicalProductLineIdOrNull(value);
  if (field === 'packageRole') return canonicalPackageRole(value || '') || null;
  return text(value);
}

function valuesFor(field, values = []) {
  return values.map((value) => normalizeFieldValue(field, value)).filter(Boolean);
}

function compareSnapshotField(mismatches, field, expectedValue, groups) {
  const expected = normalizeFieldValue(field, expectedValue);
  if (!expected) return;
  for (const [groupName, rawValues] of groups) {
    const values = valuesFor(field, rawValues);
    if (!values.length) {
      mismatches.push(`${groupName}.${field}:missing`);
      continue;
    }
    const wrong = values.filter((value) => value !== expected);
    if (wrong.length) {
      mismatches.push(`${groupName}.${field}:expected=${expected};actual=${[...new Set(values)].join('|')}`);
    }
  }
}

export function handoffSnapshotIdentityMismatches({ handoff = {}, snapshots = {} } = {}) {
  const mismatches = [];
  const manifest = snapshots?.manifest || {};
  const preview = snapshots?.preview || {};

  compareSnapshotField(mismatches, 'channelId', handoff.channelId, [
    ['manifest', [manifest.channelId, manifest.adapter?.channelId]],
    ['preview', [preview.adapter?.channelId]],
  ]);
  compareSnapshotField(mismatches, 'actionId', handoff.actionId, [
    ['manifest', [manifest.adapter?.actionId]],
    ['preview', [preview.adapter?.actionId]],
  ]);
  compareSnapshotField(mismatches, 'action', handoff.action, [
    ['manifest', [manifest.action, manifest.payload?.action]],
    ['preview', [preview.payload?.action]],
  ]);
  compareSnapshotField(mismatches, 'taskKey', handoff.taskKey, [
    ['manifest', [manifest.taskKey]],
    ['preview', [preview.payload?.taskKey]],
  ]);
  compareSnapshotField(mismatches, 'externalId', handoff.externalId, [
    ['manifest', [manifest.payload?.externalId]],
    ['preview', [preview.payload?.externalId]],
  ]);
  compareSnapshotField(mismatches, 'productLineId', handoff.productLineId, [
    ['manifest', [manifest.productLineId, manifest.payload?.productLineId]],
    ['preview', [preview.payload?.productLineId]],
  ]);
  compareSnapshotField(mismatches, 'workflowId', handoff.workflowId, [
    ['manifest', [manifest.workflowId, manifest.payload?.workflowId]],
    ['preview', [preview.payload?.workflowId]],
  ]);
  compareSnapshotField(mismatches, 'packageRole', handoff.packageRole, [
    ['manifest', [manifest.payload?.packageRole]],
    ['preview', [preview.payload?.packageRole]],
  ]);

  return mismatches;
}

export function handoffSnapshotIdentityMatches(input = {}) {
  return handoffSnapshotIdentityMismatches(input).length === 0;
}
