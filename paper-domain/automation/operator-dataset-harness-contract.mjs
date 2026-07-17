import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { validateAnalysisProtocol } from './analysis-protocol-contract.mjs';
import {
  academicAnalysisIndependentUnitCount,
  buildAcademicAnalysisInferenceProfile,
} from './academic-analysis-inference-profile.mjs';

const FAMILIES = Object.freeze({
  rl_stochastic_control_benchmark: Object.freeze(['constraintLimit', 'disturbance', 'target']),
  ml_algorithm_benchmark: Object.freeze(['label', 'robustLabel']),
  econometrics_panel_benchmark: Object.freeze(['robustEffect', 'trueEffect']),
  finance_asset_pricing_benchmark: Object.freeze(['futureReturn', 'robustReturn']),
  operations_optimization_benchmark: Object.freeze(['capacity', 'demand', 'unitCost']),
});
const SPLITS = new Set(['train', 'validation', 'test', 'public']);
const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.\/-]{1,512}$/;

function jsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const encoded = JSON.stringify(value);
    return encoded.length <= 64 * 1024 && JSON.parse(encoded) !== null;
  } catch { return false; }
}

function canonicalCase(value, family) {
  if (!exactKeys(value, ['caseId', 'input', 'ablationInput', 'referenceResponse', 'oracle'])
    || !SHA256.test(String(value.caseId || '')) || !jsonObject(value.input) || !jsonObject(value.ablationInput)
    || typeof value.referenceResponse !== 'number' || !Number.isFinite(value.referenceResponse)
    || Math.abs(value.referenceResponse) > 1e6
    || !exactKeys(value.oracle, FAMILIES[family])
    || FAMILIES[family].some((field) => typeof value.oracle[field] !== 'number'
      || !Number.isFinite(value.oracle[field]) || Math.abs(value.oracle[field]) > 1e12)) {
    throw new Error('operator_dataset_harness_case_invalid');
  }
  return Object.freeze({
    caseId: String(value.caseId).toLowerCase(),
    input: Object.freeze(JSON.parse(JSON.stringify(value.input))),
    ablationInput: Object.freeze(JSON.parse(JSON.stringify(value.ablationInput))),
    referenceResponse: value.referenceResponse,
    oracle: Object.freeze(Object.fromEntries(FAMILIES[family].map((field) => [field, value.oracle[field]]))),
  });
}

export function validateOperatorDatasetHarnessDefinition(value, { benchmarkId = null } = {}) {
  if (!exactKeys(value, ['version', 'kind', 'benchmarkId', 'benchmarkFamily', 'seedSchedule', 'minimumRepetitions', 'cells'])
    || value.version !== 1 || value.kind !== 'OperatorAuthorizedDatasetBenchmarkHarness') {
    throw new Error('operator_dataset_harness_shape_invalid');
  }
  const id = String(value.benchmarkId || '');
  const family = String(value.benchmarkFamily || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id) || (benchmarkId && id !== benchmarkId)
    || !Object.hasOwn(FAMILIES, family)) throw new Error('operator_dataset_harness_identity_invalid');
  const seedSchedule = [...new Set((Array.isArray(value.seedSchedule) ? value.seedSchedule : []).map(Number))];
  const minimumRepetitions = Number(value.minimumRepetitions);
  const inferenceProfile = buildAcademicAnalysisInferenceProfile({ benchmarkFamily: family });
  if (seedSchedule.length < 1 || seedSchedule.length > 100
    || seedSchedule.some((seed) => !Number.isSafeInteger(seed))
    || !Number.isSafeInteger(minimumRepetitions) || minimumRepetitions < 1 || minimumRepetitions > 100
    || academicAnalysisIndependentUnitCount({
      inferenceProfile, seedSchedule, minimumRepetitions,
    }) < 32) throw new Error('operator_dataset_harness_schedule_invalid');
  const expected = new Set(seedSchedule.flatMap((seed) => Array.from({ length: minimumRepetitions }, (_, index) => `${seed}\0${index + 1}`)));
  const seen = new Set();
  const cells = (Array.isArray(value.cells) ? value.cells : []).map((cell) => {
    if (!exactKeys(cell, ['seed', 'repetition', 'cases'])) throw new Error('operator_dataset_harness_cell_invalid');
    const seed = Number(cell.seed);
    const repetition = Number(cell.repetition);
    const key = `${seed}\0${repetition}`;
    if (!expected.has(key) || seen.has(key) || !Array.isArray(cell.cases) || cell.cases.length !== 8) {
      throw new Error('operator_dataset_harness_cell_invalid');
    }
    seen.add(key);
    const cases = cell.cases.map((candidate) => canonicalCase(candidate, family));
    if (new Set(cases.map((candidate) => candidate.caseId)).size !== cases.length) {
      throw new Error('operator_dataset_harness_case_duplicate');
    }
    return Object.freeze({ seed, repetition, cases: Object.freeze(cases) });
  });
  if (seen.size !== expected.size || [...expected].some((key) => !seen.has(key))) {
    throw new Error('operator_dataset_harness_schedule_incomplete');
  }
  const normalized = Object.freeze({
    version: 1,
    kind: 'OperatorAuthorizedDatasetBenchmarkHarness',
    benchmarkId: id,
    benchmarkFamily: family,
    seedSchedule: Object.freeze(seedSchedule),
    minimumRepetitions,
    cells: Object.freeze(cells.sort((left, right) => left.seed - right.seed || left.repetition - right.repetition)),
  });
  return Object.freeze({
    definition: normalized,
    operatorDatasetHarnessDefinitionHash: hashRecord('OperatorAuthorizedDatasetBenchmarkHarness', normalized),
  });
}

export function validateOperatorDatasetSplitManifest(value, { datasetName = null, datasetManifestHash = null } = {}) {
  if (!exactKeys(value, ['version', 'kind', 'datasetName', 'datasetManifestHash', 'entries'])
    || value.version !== 1 || value.kind !== 'OperatorDatasetSplitManifest') {
    throw new Error('operator_dataset_split_manifest_shape_invalid');
  }
  const name = String(value.datasetName || '');
  const manifestHash = String(value.datasetManifestHash || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) || (datasetName && name !== datasetName)
    || !SHA256.test(manifestHash) || (datasetManifestHash && manifestHash !== datasetManifestHash)) {
    throw new Error('operator_dataset_split_manifest_identity_invalid');
  }
  if (!Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 100000) {
    throw new Error('operator_dataset_split_manifest_entries_invalid');
  }
  const seen = new Set();
  const entries = value.entries.map((entry) => {
    if (!exactKeys(entry, ['path', 'sha256', 'split'])) throw new Error('operator_dataset_split_manifest_entry_invalid');
    const relative = String(entry.path || '').replace(/\\/g, '/');
    const sha256 = String(entry.sha256 || '').toLowerCase();
    const split = String(entry.split || '');
    if (!SAFE_RELATIVE_PATH.test(relative) || !SHA256.test(sha256) || !SPLITS.has(split) || seen.has(relative)) {
      throw new Error('operator_dataset_split_manifest_entry_invalid');
    }
    if (split === 'test') throw new Error('operator_dataset_hidden_test_split_must_not_be_worker_visible');
    seen.add(relative);
    return Object.freeze({ path: relative, sha256, split });
  }).sort((left, right) => left.path.localeCompare(right.path));
  const normalized = Object.freeze({
    version: 1,
    kind: 'OperatorDatasetSplitManifest',
    datasetName: name,
    datasetManifestHash: manifestHash.toLowerCase(),
    entries: Object.freeze(entries),
  });
  return Object.freeze({
    splitManifest: normalized,
    operatorDatasetSplitManifestHash: hashRecord('OperatorDatasetSplitManifest', normalized),
  });
}

export function validateOperatorDatasetAuthorityDocument(value, { datasetName = null, datasetManifestHash = null } = {}) {
  const legacy = value?.version === 1;
  const keys = [
    'version', 'kind', 'datasetName', 'datasetManifestHash', 'datasetLicenseId', 'datasetSplitManifestHash',
    'benchmarkHarnessDefinitionHash', 'benchmarkFamily', 'seedSchedule', 'minimumRepetitions',
    'workerExposurePolicy', 'signedAt', 'expiresAt', 'signatures',
    ...(!legacy ? ['analysisProtocolHash'] : []),
  ];
  if (!exactKeys(value, keys) || ![1, 2].includes(value.version) || value.kind !== 'OperatorDatasetHarnessAuthority') {
    throw new Error('operator_dataset_authority_document_shape_invalid');
  }
  const name = String(value.datasetName || '');
  const manifestHash = String(value.datasetManifestHash || '').toLowerCase();
  const family = String(value.benchmarkFamily || '');
  const seedSchedule = (Array.isArray(value.seedSchedule) ? value.seedSchedule : []).map(Number);
  const minimumRepetitions = Number(value.minimumRepetitions);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) || (datasetName && name !== datasetName)
    || !SHA256.test(manifestHash) || (datasetManifestHash && manifestHash !== String(datasetManifestHash).toLowerCase())
    || !String(value.datasetLicenseId || '') || !SHA256.test(String(value.datasetSplitManifestHash || ''))
    || !SHA256.test(String(value.benchmarkHarnessDefinitionHash || '')) || !Object.hasOwn(FAMILIES, family)
    || (!legacy && !SHA256.test(String(value.analysisProtocolHash || '')))
    || seedSchedule.length < 1 || seedSchedule.some((seed) => !Number.isSafeInteger(seed))
    || !Number.isSafeInteger(minimumRepetitions) || minimumRepetitions < 1
    || value.workerExposurePolicy !== 'signed-complete-dataset-file-manifest-v1'
    || !Number.isFinite(Date.parse(String(value.signedAt || ''))) || !Number.isFinite(Date.parse(String(value.expiresAt || '')))
    || !Array.isArray(value.signatures) || value.signatures.length < 1) {
    throw new Error('operator_dataset_authority_document_invalid');
  }
  const normalized = Object.freeze({
    version: value.version,
    kind: 'OperatorDatasetHarnessAuthority',
    datasetName: name,
    datasetManifestHash: manifestHash,
    datasetLicenseId: String(value.datasetLicenseId),
    datasetSplitManifestHash: String(value.datasetSplitManifestHash).toLowerCase(),
    benchmarkHarnessDefinitionHash: String(value.benchmarkHarnessDefinitionHash).toLowerCase(),
    ...(!legacy ? { analysisProtocolHash: String(value.analysisProtocolHash).toLowerCase() } : {}),
    benchmarkFamily: family,
    seedSchedule: Object.freeze(seedSchedule),
    minimumRepetitions,
    workerExposurePolicy: value.workerExposurePolicy,
    signedAt: new Date(value.signedAt).toISOString(),
    expiresAt: new Date(value.expiresAt).toISOString(),
    signatures: Object.freeze(value.signatures.map((signature) => Object.freeze({
      keyId: String(signature?.keyId || ''), role: String(signature?.role || ''),
      algorithm: String(signature?.algorithm || ''), value: String(signature?.value || ''),
    }))),
  });
  return Object.freeze({
    authority: normalized,
    operatorDatasetAuthorityDocumentHash: hashRecord('OperatorDatasetHarnessAuthorityDocument', normalized),
  });
}

export function validateOperatorDatasetHarnessEnvelope(value, { datasetName = null, datasetManifestHash = null } = {}) {
  const legacy = value?.version === 1;
  const keys = ['version', 'kind', 'authority', 'splitManifest', 'harnessDefinition', ...(!legacy ? ['analysisProtocol'] : [])];
  if (!exactKeys(value, keys) || ![1, 2].includes(value.version) || value.kind !== 'OperatorDatasetHarnessEnvelope'
    || value.authority?.version !== value.version) {
    throw new Error('operator_dataset_harness_envelope_shape_invalid');
  }
  const authority = validateOperatorDatasetAuthorityDocument(value.authority, { datasetName, datasetManifestHash });
  const split = validateOperatorDatasetSplitManifest(value.splitManifest, {
    datasetName: authority.authority.datasetName,
    datasetManifestHash: authority.authority.datasetManifestHash,
  });
  const harness = validateOperatorDatasetHarnessDefinition(value.harnessDefinition, { benchmarkId: authority.authority.datasetName });
  let analysis = null;
  if (!legacy) {
    analysis = validateAnalysisProtocol(value.analysisProtocol, {
      benchmarkId: authority.authority.datasetName,
      benchmarkFamily: authority.authority.benchmarkFamily,
    });
  }
  if (split.operatorDatasetSplitManifestHash !== authority.authority.datasetSplitManifestHash
    || harness.operatorDatasetHarnessDefinitionHash !== authority.authority.benchmarkHarnessDefinitionHash
    || (!legacy && analysis.analysisProtocolHash !== authority.authority.analysisProtocolHash)
    || (!legacy && academicAnalysisIndependentUnitCount({
      inferenceProfile: Object.freeze({
        ...analysis.analysisProtocol.inferenceProfile,
        inferenceProfileHash: analysis.analysisProtocol.inferenceProfileHash,
      }),
      seedSchedule: harness.definition.seedSchedule,
      minimumRepetitions: harness.definition.minimumRepetitions,
    }) < analysis.analysisProtocol.power.requiredPairedObservations)
    || harness.definition.benchmarkFamily !== authority.authority.benchmarkFamily
    || JSON.stringify(harness.definition.seedSchedule) !== JSON.stringify(authority.authority.seedSchedule)
    || harness.definition.minimumRepetitions !== authority.authority.minimumRepetitions) {
    throw new Error('operator_dataset_harness_envelope_binding_invalid');
  }
  return Object.freeze({
    ...authority,
    ...split,
    ...harness,
    analysisProtocol: analysis?.analysisProtocol || null,
    analysisProtocolHash: analysis?.analysisProtocolHash || null,
    academicAnalysisProtocolEligible: !legacy,
  });
}

export function operatorDatasetHarnessCell(definition, { seed, repetition } = {}) {
  const validated = validateOperatorDatasetHarnessDefinition(definition, { benchmarkId: definition?.benchmarkId });
  return validated.definition.cells.find((cell) => cell.seed === Number(seed) && cell.repetition === Number(repetition)) || null;
}

// This domain check proves only canonical shape, hashes, and cross-record binding.
// Cryptographic trust and freshness are adapter concerns and must be rechecked at
// every research/release authority boundary.
export function verifyOperatorDatasetHarnessAuthorityReceiptStructure(receipt, { dataset = null, selector = null } = {}) {
  if (!receipt || receipt.version !== 3 || receipt.kind !== 'OperatorDatasetHarnessAuthorityReceipt') return false;
  const { operatorDatasetHarnessAuthorityReceiptHash, ...payload } = receipt;
  if (!SHA256.test(String(operatorDatasetHarnessAuthorityReceiptHash || ''))
    || hashRecord('OperatorDatasetHarnessAuthorityReceipt', payload) !== operatorDatasetHarnessAuthorityReceiptHash
    || receipt.status !== 'operator_dataset_harness_authority_verified'
    || !Array.isArray(receipt.blockers) || receipt.blockers.length !== 0
    || receipt.authorizationScheme !== 'ed25519-signed-host-only-dataset-harness-v1'
    || receipt.evidenceAuthority !== 'host-owned-hidden-fixture-reader-and-evaluator-v2'
    || receipt.analysisAuthority !== 'operator-signed-preregistered-analysis-protocol-v1'
    || receipt.workerDatasetExposure !== 'signed-complete-dataset-file-manifest-v1'
    || receipt.hostOnlyHarnessMounted !== false || receipt.rawOraclePublished !== false
    || receipt.externalActionPerformed !== false
    || !SHA256.test(String(receipt.envelopeDocumentHash || ''))
    || !SHA256.test(String(receipt.operatorDatasetAuthorityVerificationHash || ''))
    || hashRecord('OperatorDatasetAuthorityVerification', receipt.authorityVerification)
      !== receipt.operatorDatasetAuthorityVerificationHash
    || receipt.authorityVerification?.status !== 'operator_dataset_authority_verified'
    || receipt.authorityVerification?.cryptographicSignaturesVerified !== true
    || receipt.authorityVerification?.timeWindowValid !== true) return false;
  let authority = null;
  try { authority = validateOperatorDatasetAuthorityDocument(receipt.authority, { datasetName: dataset?.name, datasetManifestHash: dataset?.manifestHash }); }
  catch { return false; }
  let analysis = null;
  const selectorAnalysisProtocol = selector?.experimentDesign?.analysisProtocolTemplate || selector?.analysisProtocol;
  const selectorAnalysisProtocolHash = selector?.experimentDesign?.analysisProtocolTemplateHash || selector?.analysisProtocolHash;
  try {
    analysis = validateAnalysisProtocol(receipt.analysisProtocol, {
      benchmarkId: receipt.datasetName,
      benchmarkFamily: receipt.benchmarkFamily,
      requiredMetrics: selector?.experimentDesign?.requiredMetrics,
      metricSpecs: selector?.experimentDesign?.metricSpecs,
    });
  } catch { return false; }
  return Boolean(dataset && selector
    && selector.selectorType === 'authorized_dataset_mount'
    && receipt.datasetName === dataset.name
    && receipt.datasetName === selector.datasetMountName
    && receipt.datasetManifestHash === dataset.manifestHash
    && receipt.datasetManifestHash === selector.datasetManifestHash
    && receipt.datasetSplitManifestHash === dataset.splitManifestHash
    && receipt.datasetSplitManifestHash === selector.datasetSplitManifestHash
    && receipt.datasetLicenseId === dataset.licenseId
    && receipt.datasetLicenseId === selector.datasetLicenseId
    && receipt.operatorAuthorizationHash === dataset.operatorAuthorizationHash
    && receipt.operatorAuthorizationHash === selector.datasetOperatorAuthorizationHash
    && receipt.operatorDatasetAuthorityDocumentHash === authority.operatorDatasetAuthorityDocumentHash
    && receipt.operatorDatasetAuthorityDocumentHash === dataset.operatorDatasetAuthorityDocumentHash
    && receipt.operatorDatasetAuthorityDocumentHash === selector.operatorDatasetAuthorityDocumentHash
    && receipt.envelopeDocumentHash === dataset.benchmarkHarnessDocumentHash
    && receipt.envelopeDocumentHash === selector.operatorDatasetHarnessDocumentHash
    && receipt.benchmarkHarnessDefinitionHash === authority.authority.benchmarkHarnessDefinitionHash
    && receipt.benchmarkHarnessDefinitionHash === dataset.benchmarkHarnessDefinitionHash
    && receipt.benchmarkHarnessDefinitionHash === selector.operatorDatasetHarnessDefinitionHash
    && receipt.analysisProtocolHash === analysis.analysisProtocolHash
    && receipt.analysisProtocolHash === authority.authority.analysisProtocolHash
    && receipt.analysisProtocolHash === dataset.analysisProtocolHash
    && receipt.analysisProtocolHash === selectorAnalysisProtocolHash
    && JSON.stringify(receipt.analysisProtocol) === JSON.stringify(analysis.analysisProtocol)
    && JSON.stringify(dataset.analysisProtocol) === JSON.stringify(analysis.analysisProtocol)
    && JSON.stringify(selectorAnalysisProtocol) === JSON.stringify(analysis.analysisProtocol)
    && receipt.benchmarkFamily === authority.authority.benchmarkFamily
    && receipt.benchmarkFamily === dataset.benchmarkFamily
    && receipt.benchmarkFamily === selector.benchmarkFamily
    && receipt.operatorAuthorizationHash === authority.operatorDatasetAuthorityDocumentHash
    && JSON.stringify(receipt.authority) === JSON.stringify(authority.authority));
}

export function isOperatorDatasetBenchmarkFamily(value) {
  return Object.hasOwn(FAMILIES, String(value || ''));
}
