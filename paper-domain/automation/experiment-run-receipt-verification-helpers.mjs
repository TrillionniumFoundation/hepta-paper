import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isDeeplyFrozenJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import {
  canonicalExperimentObservation,
  experimentObservationKey,
} from './experiment-observation-contract.mjs';
import {
  REQUIRED_SYSTEM_BENCHMARK_ARMS,
} from './system-benchmark-schedule.mjs';
import { verifyVersionedExperimentIr } from './versioned-experiment-ir.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const verifiedImmutableRecordHashes = new WeakMap();

function createBoundedVerifiedReceiptHashCache(limit = 256) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('verified_receipt_hash_cache_limit_invalid');
  }
  const cache = new Map();
  return Object.freeze({
    has: (receiptHash) => cache.has(receiptHash),
    remember(receiptHash) {
      if (cache.has(receiptHash)) cache.delete(receiptHash);
      cache.set(receiptHash, true);
      if (cache.size > limit) cache.delete(cache.keys().next().value);
    },
  });
}

export const verifiedHarnessReceiptHashes = createBoundedVerifiedReceiptHashCache();
export const verifiedExperimentRunReceiptHashes =
  createBoundedVerifiedReceiptHashCache();

export function verifiedRecordHash(record, { kind, hashField } = {}) {
  const claimedHash = record?.[hashField];
  if (!SHA256.test(String(claimedHash || ''))) return null;
  const cacheKey = `${kind}\0${hashField}`;
  const cached = verifiedImmutableRecordHashes.get(record)?.get(cacheKey);
  if (cached === claimedHash) return claimedHash;
  const payload = { ...record };
  delete payload[hashField];
  if (hashRecord(kind, payload) !== claimedHash) return null;
  if (isDeeplyFrozenJsonValue(record)) {
    const recordCache = verifiedImmutableRecordHashes.get(record) || new Map();
    recordCache.set(cacheKey, claimedHash);
    verifiedImmutableRecordHashes.set(record, recordCache);
  }
  return claimedHash;
}

export function verifiedReceiptPreflight(record, kind, hashField, cache) {
  const recordHash = verifiedRecordHash(record, { kind, hashField });
  return recordHash ? Object.freeze({
    recordHash,
    cached: cache.has(recordHash),
    rememberIf: (valid) => { if (valid) cache.remember(recordHash); },
  }) : null;
}

export function experimentRunObservationScheduleComplete({
  observations,
  requiredMetrics,
  design,
} = {}) {
  const expected = new Set();
  for (const seed of design?.seedSchedule || []) {
    for (let repetition = 1;
      repetition <= Number(design?.minimumRepetitions || 0);
      repetition += 1) {
      for (const arm of REQUIRED_SYSTEM_BENCHMARK_ARMS) {
        expected.add(`${seed}\0${repetition}\0${arm}`);
      }
    }
  }
  const observed = new Set();
  const valid = Array.isArray(observations) && observations.every((item) => {
    const canonical = canonicalExperimentObservation(item, requiredMetrics || []);
    if (!canonical) return false;
    const key = experimentObservationKey(canonical);
    if (observed.has(key)) return false;
    observed.add(key);
    return expected.has(key);
  });
  return valid
    && observed.size === expected.size
    && [...expected].every((key) => observed.has(key));
}

export function inspectSystemBenchmarkExperimentIrBinding(
  receipt,
  { operatorDatasetHarnessAuthority = null } = {},
) {
  const validBaseBinding = verifyVersionedExperimentIr(receipt?.experimentIr)
    && receipt.versionedExperimentIrHash
      === receipt.experimentIr.versionedExperimentIrHash
    && receipt.experimentIr.design.campaignBenchmarkSelectorHash
      === receipt.campaignBenchmarkSelectorHash
    && receipt.experimentIr.design.experimentDesignHash
      === receipt.experimentDesignHash
    && receipt.experimentIr.design.benchmarkHarnessHash
      === receipt.benchmarkHarnessHash
    && receipt.experimentIr.design.systemBenchmarkArmProtocolSetHash
      === receipt.systemBenchmarkArmProtocolSetHash
    && receipt.experimentIr.execution.systemBenchmarkArmAdapterSetHash
      === receipt.systemBenchmarkArmAdapterSetHash
    && receipt.experimentIr.dataset.datasetAuthorizationSetHash
      === receipt.datasetAuthorizationSetHash
    && receipt.experimentIr.analysisProtocol.analysisProtocolHash
      === receipt.analysisProtocolHash
    && receipt.experimentIr.provenance.experimentAttemptId
      === receipt.experimentAttemptId
    && receipt.experimentIr.provenance.sourceLineageHash
      === receipt.sourceLineageHash
    && receipt.experimentIr.provenance.sourceMerkleHash
      === receipt.sourceMerkleHash
    && receipt.experimentIr.provenance.sourceWorkspaceManifestHash
      === receipt.sourceWorkspaceManifestHash;
  const researchResolved = validBaseBinding
    && receipt.experimentIr.version === 5;
  const validResearchBinding = !researchResolved || (
    receipt.experimentIr.researchBinding.datasetCompatibility.datasetName
      === receipt.experimentIr.dataset.datasetMountName
    && receipt.experimentIr.researchBinding.datasetCompatibility
      .datasetManifestHash === receipt.experimentIr.dataset.datasetManifestHash
    && receipt.experimentIr.researchBinding.datasetCompatibility
      .datasetSplitManifestHash
      === receipt.experimentIr.dataset.datasetSplitManifestHash
    && operatorDatasetHarnessAuthority?.operatorDatasetAuthorityDocumentHash
      === receipt.experimentIr.researchBinding.datasetCompatibility
        .operatorDatasetAuthorityDocumentHash
    && operatorDatasetHarnessAuthority?.operatorDatasetResearchSemanticsHash
      === receipt.experimentIr.researchBinding.datasetCompatibility
        .datasetResearchSemanticsHash
  );
  return Object.freeze({
    valid: validBaseBinding && validResearchBinding,
    researchResolved,
  });
}
