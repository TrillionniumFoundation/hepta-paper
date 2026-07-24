import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

function hashList(values) {
  const normalized = (Array.isArray(values) ? values : []).map((value) => String(value).toLowerCase());
  if (normalized.some((value) => !SHA256.test(value)) || new Set(normalized).size !== normalized.length) {
    throw new Error('empirical_failed_attempt_lineage_invalid');
  }
  return Object.freeze(normalized);
}

export function buildEmpiricalPreDataAccessFreeze({
  experimentAttemptId,
  attemptVersion = 1,
  failedAttemptLineageHashes = [],
  versionedExperimentIrHash,
  campaignBenchmarkSelectorHash,
  experimentDesignHash,
  analysisProtocolHash,
  systemBenchmarkArmProtocolSetHash,
  systemBenchmarkArmAdapterSetHash,
  sourceMerkleHash,
  sourceWorkspaceManifestHash,
  sourceLineageHash,
  experimentResearchBindingHash = null,
  datasetResearchCompatibilityHash = null,
} = {}) {
  const version = Number(attemptVersion);
  const hashes = {
    campaignBenchmarkSelectorHash,
    experimentDesignHash,
    analysisProtocolHash,
    systemBenchmarkArmProtocolSetHash,
    systemBenchmarkArmAdapterSetHash,
    sourceMerkleHash,
    sourceWorkspaceManifestHash,
    sourceLineageHash,
    versionedExperimentIrHash,
  };
  const researchResolved = experimentResearchBindingHash !== null
    || datasetResearchCompatibilityHash !== null;
  if (researchResolved) {
    hashes.experimentResearchBindingHash = experimentResearchBindingHash;
    hashes.datasetResearchCompatibilityHash = datasetResearchCompatibilityHash;
  }
  if (!String(experimentAttemptId || '') || !Number.isSafeInteger(version) || version < 1
    || Object.values(hashes).some((value) => !SHA256.test(String(value || '')))) {
    throw new Error('empirical_pre_data_access_freeze_input_invalid');
  }
  const lineage = hashList(failedAttemptLineageHashes);
  if (lineage.length !== version - 1) throw new Error('empirical_failed_attempt_lineage_version_mismatch');
  const sourceVersionPayload = {
    attemptVersion: version,
    sourceMerkleHash: String(sourceMerkleHash).toLowerCase(),
    sourceWorkspaceManifestHash: String(sourceWorkspaceManifestHash).toLowerCase(),
    sourceLineageHash: String(sourceLineageHash).toLowerCase(),
    failedAttemptLineageHashes: lineage,
  };
  const payload = {
    version: researchResolved ? 3 : 2,
    kind: 'EmpiricalPreDataAccessFreeze',
    status: 'empirical_protocol_and_code_frozen',
    experimentAttemptId: String(experimentAttemptId),
    attemptVersion: version,
    failedAttemptLineageHashes: lineage,
    versionedExperimentIrHash: String(versionedExperimentIrHash).toLowerCase(),
    ...(researchResolved ? {
      experimentResearchBindingHash: String(experimentResearchBindingHash).toLowerCase(),
      datasetResearchCompatibilityHash:
        String(datasetResearchCompatibilityHash).toLowerCase(),
    } : {}),
    campaignBenchmarkSelectorHash: String(campaignBenchmarkSelectorHash).toLowerCase(),
    experimentDesignHash: String(experimentDesignHash).toLowerCase(),
    analysisProtocolHash: String(analysisProtocolHash).toLowerCase(),
    systemBenchmarkArmProtocolSetHash: String(systemBenchmarkArmProtocolSetHash).toLowerCase(),
    systemBenchmarkArmAdapterSetHash: String(systemBenchmarkArmAdapterSetHash).toLowerCase(),
    sourceMerkleHash: sourceVersionPayload.sourceMerkleHash,
    sourceWorkspaceManifestHash: sourceVersionPayload.sourceWorkspaceManifestHash,
    sourceLineageHash: sourceVersionPayload.sourceLineageHash,
    empiricalSourceVersionHash: hashRecord('EmpiricalSourceVersion', sourceVersionPayload),
    protocolFrozenBeforeDataAccess: true,
    codeFrozenBeforeDataAccess: true,
    dataAccessAllowedAfterFreezeOnly: true,
  };
  return Object.freeze({
    ...payload,
    empiricalPreDataAccessFreezeHash: hashRecord('EmpiricalPreDataAccessFreeze', payload),
  });
}

export function verifyEmpiricalPreDataAccessFreeze(value) {
  const researchResolved = value?.version === 3;
  if (!exactKeys(value, [
    'version', 'kind', 'status', 'experimentAttemptId', 'attemptVersion', 'failedAttemptLineageHashes',
    'versionedExperimentIrHash',
    'campaignBenchmarkSelectorHash', 'experimentDesignHash', 'analysisProtocolHash',
    'systemBenchmarkArmProtocolSetHash', 'systemBenchmarkArmAdapterSetHash', 'sourceMerkleHash',
    'sourceWorkspaceManifestHash', 'sourceLineageHash', 'empiricalSourceVersionHash',
    'protocolFrozenBeforeDataAccess', 'codeFrozenBeforeDataAccess', 'dataAccessAllowedAfterFreezeOnly',
    'empiricalPreDataAccessFreezeHash',
    ...(researchResolved ? [
      'experimentResearchBindingHash', 'datasetResearchCompatibilityHash',
    ] : []),
  ]) || ![2, 3].includes(value.version) || value.kind !== 'EmpiricalPreDataAccessFreeze'
    || value.status !== 'empirical_protocol_and_code_frozen' || !String(value.experimentAttemptId || '')
    || !Number.isSafeInteger(value.attemptVersion) || value.attemptVersion < 1
    || value.protocolFrozenBeforeDataAccess !== true || value.codeFrozenBeforeDataAccess !== true
    || value.dataAccessAllowedAfterFreezeOnly !== true) return false;
  let lineage;
  try { lineage = hashList(value.failedAttemptLineageHashes); } catch { return false; }
  if (lineage.length !== value.attemptVersion - 1
    || JSON.stringify(lineage) !== JSON.stringify(value.failedAttemptLineageHashes)) return false;
  const hashes = [
    value.campaignBenchmarkSelectorHash, value.experimentDesignHash, value.analysisProtocolHash,
    value.systemBenchmarkArmProtocolSetHash, value.systemBenchmarkArmAdapterSetHash,
    value.sourceMerkleHash, value.sourceWorkspaceManifestHash, value.sourceLineageHash,
    value.versionedExperimentIrHash,
    ...(researchResolved ? [
      value.experimentResearchBindingHash,
      value.datasetResearchCompatibilityHash,
    ] : []),
    value.empiricalSourceVersionHash, value.empiricalPreDataAccessFreezeHash,
  ];
  if (hashes.some((hash) => !SHA256.test(String(hash || '')))) return false;
  const expectedSourceVersionHash = hashRecord('EmpiricalSourceVersion', {
    attemptVersion: value.attemptVersion,
    sourceMerkleHash: value.sourceMerkleHash,
    sourceWorkspaceManifestHash: value.sourceWorkspaceManifestHash,
    sourceLineageHash: value.sourceLineageHash,
    failedAttemptLineageHashes: value.failedAttemptLineageHashes,
  });
  const { empiricalPreDataAccessFreezeHash, ...payload } = value;
  return value.empiricalSourceVersionHash === expectedSourceVersionHash
    && hashRecord('EmpiricalPreDataAccessFreeze', payload) === empiricalPreDataAccessFreezeHash;
}
