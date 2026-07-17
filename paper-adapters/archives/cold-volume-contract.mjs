import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';

function normalized(value) {
  return path.resolve(String(value || ''));
}

export function verifyColdVolumeContract({ assetRoot, contract, contractPath = null, mountAvailableOverride = null } = {}) {
  if (!assetRoot || contract?.kind !== 'ColdVolumeMountContract' || contract?.version !== 1) {
    throw new Error('A v1 ColdVolumeMountContract and assetRoot are required');
  }
  const mountRoot = normalized(contract.mountRoot);
  const contentRoot = path.join(mountRoot, contract.contentRoot);
  const logicalRoot = path.join(normalized(assetRoot), 'drafts', 'NDU_Nature_work');
  const expected = [...new Set(contract.entries || [])].sort();
  const blockers = [];
  const rows = expected.map((relative) => {
    const logicalPath = path.join(logicalRoot, relative);
    const expectedTarget = path.join(contentRoot, relative);
    let kind = 'missing';
    let actualTarget = null;
    try {
      const stat = fs.lstatSync(logicalPath);
      kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
      if (stat.isSymbolicLink()) actualTarget = normalized(path.resolve(path.dirname(logicalPath), fs.readlinkSync(logicalPath)));
    } catch { /* represented as missing */ }
    const targetMatches = kind === 'symlink' && actualTarget === normalized(expectedTarget);
    if (!targetMatches) blockers.push(`cold_volume_link_contract_mismatch:${relative}`);
    return {
      relative,
      logicalPath,
      kind,
      expectedTarget: normalized(expectedTarget),
      actualTarget,
      targetMatches,
      targetPresent: fs.existsSync(expectedTarget),
    };
  });
  const mountProbe = spawnSync('findmnt', ['-rn', '--mountpoint', mountRoot, '-o', 'TARGET,SOURCE,FSTYPE'], { encoding: 'utf8' });
  const mountAvailable = mountAvailableOverride === null
    ? mountProbe.status === 0
    : Boolean(mountAvailableOverride);
  if (!mountAvailable) blockers.push('cold_volume_unavailable');
  const sentinelPath = path.join(mountRoot, contract.sentinelRelativePath);
  let sentinel = null;
  if (mountAvailable && contract.contentManifestRequiredWhenMounted) {
    try { sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8')); } catch { blockers.push('cold_volume_content_manifest_missing_or_invalid'); }
    if (sentinel && sentinel.contractId !== contract.contractId) blockers.push('cold_volume_content_manifest_contract_mismatch');
    if (sentinel && sentinel.kind !== 'ColdVolumeContentManifest') blockers.push('cold_volume_content_manifest_kind_invalid');
    if (sentinel && (!sentinel.manifestHash || hashRecord('ColdVolumeContentManifest', Object.fromEntries(
      Object.entries(sentinel).filter(([key]) => key !== 'manifestHash'),
    )) !== sentinel.manifestHash)) blockers.push('cold_volume_content_manifest_hash_invalid');
  }
  if (mountAvailable && rows.some((row) => !row.targetPresent)) blockers.push('cold_volume_required_content_missing');
  const contractValid = blockers.every((item) => !item.startsWith('cold_volume_link_contract_mismatch'));
  const operationalReplayReady = contractValid && mountAvailable && blockers.length === 0 && rows.every((row) => row.targetPresent);
  const payload = {
    version: 1,
    kind: 'ColdVolumeMountContractStatus',
    status: !contractValid
      ? 'cold_volume_contract_blocked'
      : operationalReplayReady
        ? 'cold_volume_mounted_and_content_verified'
        : 'cold_volume_contract_verified_volume_unavailable',
    contractId: contract.contractId,
    contractHash: contractPath ? sha256FileSync(contractPath) : hashRecord('ColdVolumeMountContract', contract),
    assetRoot: normalized(assetRoot),
    mountRoot,
    mountAvailable,
    mountIdentity: mountAvailable ? String(mountProbe.stdout || '').trim() || 'test_override' : null,
    sentinelPath,
    sentinelHash: fs.existsSync(sentinelPath) ? sha256FileSync(sentinelPath) : null,
    entryCount: rows.length,
    contractValid,
    operationalReplayReady,
    blockers,
    rows,
  };
  return Object.freeze({ ...payload, statusHash: hashRecord('ColdVolumeMountContractStatus', payload) });
}
