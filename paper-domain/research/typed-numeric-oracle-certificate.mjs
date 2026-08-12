import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const ORACLE_TYPES = new Set([
  'condition-number-bound-v1',
  'convergence-rate-bound-v1',
  'error-bound-v1',
  'optimality-gap-bound-v1',
  'property-oracle-v1',
  'residual-bound-v1',
]);
const ALGORITHMIC_ORACLE_TYPES = new Set([
  'condition-number-bound-v1',
  'convergence-rate-bound-v1',
  'error-bound-v1',
  'optimality-gap-bound-v1',
]);
const RELATIONS = new Set(['greater-than-or-equal', 'interval', 'less-than-or-equal']);
const ASSURANCE_SCOPES = Object.freeze({
  'producer-bound-self-check-v1': Object.freeze({
    independentlyRecomputed: false,
    processIndependent: false,
    externalTrustDomainVerified: false,
  }),
  'repository-separate-implementation-same-process-v1': Object.freeze({
    independentlyRecomputed: true,
    processIndependent: false,
    externalTrustDomainVerified: false,
  }),
  'process-isolated-independent-implementation-v1': Object.freeze({
    independentlyRecomputed: true,
    processIndependent: true,
    externalTrustDomainVerified: false,
  }),
  'os-sandboxed-process-independent-implementation-v1': Object.freeze({
    independentlyRecomputed: true,
    processIndependent: true,
    externalTrustDomainVerified: false,
  }),
  'external-trust-domain-independent-verifier-v1': Object.freeze({
    independentlyRecomputed: true,
    processIndependent: true,
    externalTrustDomainVerified: true,
  }),
});
const CERTIFICATE_KEYS_V2 = Object.freeze([
  'assuranceScope', 'blockers', 'candidateAuthoredValueAccepted', 'certificateId',
  'evidenceHashes', 'externalTrustDomainVerified', 'independentlyRecomputed', 'kind',
  'lowerBound', 'observedValue', 'oracleType', 'processIndependent',
  'producerImplementationHash', 'quantity', 'relation', 'status', 'subjectHash',
  'typedNumericOracleCertificateHash', 'unit', 'upperBound',
  'verificationReceiptHash', 'verifierId', 'verifierImplementationHash', 'version',
]);
const CERTIFICATE_KEYS_V3 = Object.freeze([
  ...CERTIFICATE_KEYS_V2,
  'algorithmConfigurationHash', 'algorithmId', 'algorithmVersion',
  'boundsAuthorityHash', 'finiteInputCount', 'finiteInputsVerified',
  'numericInputManifestHash', 'numericOutputHash',
]);

function id(value) {
  const candidate = String(value || '').trim();
  return SAFE_ID.test(candidate) ? candidate : null;
}

function sha(value) {
  const candidate = String(value || '').toLowerCase();
  return SHA256.test(candidate) ? candidate : null;
}

function finiteOrNull(value) {
  if (value === null) return null;
  return Number.isFinite(Number(value)) && Math.abs(Number(value)) <= 1e300
    ? Number(value) : undefined;
}

function hashes(values, { minimum = 1, maximum = 512 } = {}) {
  if (!Array.isArray(values) || values.length < minimum || values.length > maximum) return null;
  const selected = values.map(sha);
  if (selected.some((value) => !value) || new Set(selected).size !== selected.length) return null;
  return Object.freeze([...selected].sort());
}

function relationSatisfied({ relation, observedValue, lowerBound, upperBound }) {
  if (relation === 'less-than-or-equal') {
    return lowerBound === null && typeof upperBound === 'number'
      && observedValue <= upperBound;
  }
  if (relation === 'greater-than-or-equal') {
    return upperBound === null && typeof lowerBound === 'number'
      && observedValue >= lowerBound;
  }
  return typeof lowerBound === 'number' && typeof upperBound === 'number'
    && lowerBound <= upperBound && observedValue >= lowerBound && observedValue <= upperBound;
}

export function buildTypedNumericOracleCertificate({
  version = null,
  certificateId,
  oracleType,
  subjectHash,
  quantity,
  observedValue,
  relation,
  lowerBound = null,
  upperBound = null,
  unit,
  verifierId,
  producerImplementationHash,
  verifierImplementationHash,
  verificationReceiptHash,
  evidenceHashes,
  assuranceScope,
  algorithmId = null,
  algorithmVersion = null,
  algorithmConfigurationHash = null,
  numericInputManifestHash = null,
  numericOutputHash = null,
  finiteInputCount = null,
  finiteInputsVerified = null,
  boundsAuthorityHash = null,
} = {}) {
  const observed = finiteOrNull(observedValue);
  const lower = finiteOrNull(lowerBound);
  const upper = finiteOrNull(upperBound);
  const evidence = hashes(evidenceHashes);
  const assurance = ASSURANCE_SCOPES[assuranceScope] || null;
  const producerHash = sha(producerImplementationHash);
  const verifierHash = sha(verifierImplementationHash);
  const selectedVersion = Number(version || (algorithmId ? 3 : 2));
  const outputHash = hashRecord('TypedNumericOracleNumericOutput', {
    oracleType,
    quantity: id(quantity),
    observedValue: observed,
    relation,
    lowerBound: lower,
    upperBound: upper,
    unit: id(unit),
  });
  if (!id(certificateId) || !ORACLE_TYPES.has(oracleType) || !sha(subjectHash)
    || !id(quantity) || typeof observed !== 'number' || !RELATIONS.has(relation)
    || lower === undefined || upper === undefined || !id(unit) || !id(verifierId)
    || !producerHash || !verifierHash || !sha(verificationReceiptHash)
    || !evidence || !assurance
    || (assurance.independentlyRecomputed && producerHash === verifierHash)
    || ![2, 3].includes(selectedVersion)
    || (ALGORITHMIC_ORACLE_TYPES.has(oracleType) && selectedVersion !== 3)
    || (selectedVersion === 3 && (
      !id(algorithmId) || !id(algorithmVersion) || !sha(algorithmConfigurationHash)
      || !sha(numericInputManifestHash)
      || (numericOutputHash !== null && sha(numericOutputHash) !== outputHash)
      || !Number.isSafeInteger(Number(finiteInputCount)) || Number(finiteInputCount) < 1
      || finiteInputsVerified !== true || !sha(boundsAuthorityHash)
      || assurance.independentlyRecomputed !== true
    ))) {
    throw new Error('typed_numeric_oracle_certificate_invalid');
  }
  const blockers = relationSatisfied({
    relation,
    observedValue: observed,
    lowerBound: lower,
    upperBound: upper,
  }) ? Object.freeze([]) : Object.freeze(['typed_numeric_oracle_bound_unsatisfied']);
  const payload = {
    version: selectedVersion,
    kind: 'TypedNumericOracleCertificate',
    status: blockers.length
      ? 'typed_numeric_oracle_certificate_blocked'
      : 'typed_numeric_oracle_certificate_verified',
    certificateId: id(certificateId),
    oracleType,
    subjectHash: sha(subjectHash),
    quantity: id(quantity),
    observedValue: observed,
    relation,
    lowerBound: lower,
    upperBound: upper,
    unit: id(unit),
    verifierId: id(verifierId),
    producerImplementationHash: producerHash,
    verifierImplementationHash: verifierHash,
    verificationReceiptHash: sha(verificationReceiptHash),
    evidenceHashes: evidence,
    assuranceScope,
    independentlyRecomputed: assurance.independentlyRecomputed,
    processIndependent: assurance.processIndependent,
    externalTrustDomainVerified: assurance.externalTrustDomainVerified,
    candidateAuthoredValueAccepted: false,
    ...(selectedVersion === 3 ? {
      algorithmId: id(algorithmId),
      algorithmVersion: id(algorithmVersion),
      algorithmConfigurationHash: sha(algorithmConfigurationHash),
      numericInputManifestHash: sha(numericInputManifestHash),
      numericOutputHash: outputHash,
      finiteInputCount: Number(finiteInputCount),
      finiteInputsVerified: true,
      boundsAuthorityHash: sha(boundsAuthorityHash),
    } : {}),
    blockers,
  };
  return Object.freeze({
    ...payload,
    typedNumericOracleCertificateHash:
      hashRecord('TypedNumericOracleCertificate', payload),
  });
}

export function verifyTypedNumericOracleCertificate(certificate, expected = {}) {
  const keys = certificate?.version === 3 ? CERTIFICATE_KEYS_V3 : CERTIFICATE_KEYS_V2;
  if (!hasExactObjectKeys(certificate, keys)) return false;
  let rebuilt = null;
  try { rebuilt = buildTypedNumericOracleCertificate(certificate); }
  catch { return false; }
  return JSON.stringify(rebuilt) === JSON.stringify(certificate)
    && certificate.status === 'typed_numeric_oracle_certificate_verified'
    && Object.entries(expected).every(([field, value]) => (
      value === undefined || value === null || certificate[field] === value
    ));
}

export function buildTypedNumericOracleCertificateSet({
  analysisProtocolHash,
  experimentAttemptId,
  sourceLineageHash,
  requiredOracleTypes,
  certificates,
  empiricalPluginProfileHash = null,
  independentRecomputationReceiptHash = null,
} = {}) {
  const required = Array.isArray(requiredOracleTypes)
    ? [...new Set(requiredOracleTypes.map(String))].sort() : [];
  const selected = Array.isArray(certificates)
    ? [...certificates].sort((left, right) => left.certificateId.localeCompare(right.certificateId))
    : [];
  const extended = empiricalPluginProfileHash !== null
    || independentRecomputationReceiptHash !== null;
  if (!sha(analysisProtocolHash) || !id(experimentAttemptId) || !sha(sourceLineageHash)
    || !required.length || required.some((type) => !ORACLE_TYPES.has(type))
    || !selected.length || selected.some((certificate) => (
      !verifyTypedNumericOracleCertificate(certificate)
    )) || new Set(selected.map((certificate) => certificate.certificateId)).size !== selected.length
    || (extended && (!sha(empiricalPluginProfileHash)
      || !sha(independentRecomputationReceiptHash)))) {
    throw new Error('typed_numeric_oracle_certificate_set_invalid');
  }
  const observedTypes = new Set(selected.map((certificate) => certificate.oracleType));
  if (observedTypes.size !== selected.length
    || observedTypes.size !== required.length
    || required.some((type) => !observedTypes.has(type))) {
    throw new Error('typed_numeric_oracle_certificate_set_type_bijection_invalid');
  }
  const blockers = Object.freeze([]);
  const payload = {
    version: extended ? 2 : 1,
    kind: 'TypedNumericOracleCertificateSet',
    status: blockers.length
      ? 'typed_numeric_oracle_certificate_set_blocked'
      : 'typed_numeric_oracle_certificate_set_verified',
    analysisProtocolHash: sha(analysisProtocolHash),
    experimentAttemptId: id(experimentAttemptId),
    sourceLineageHash: sha(sourceLineageHash),
    requiredOracleTypes: Object.freeze(required),
    verifiedOracleTypes: Object.freeze([...observedTypes].sort()),
    certificates: Object.freeze(selected),
    certificateCount: selected.length,
    candidateAuthoredValuesAccepted: false,
    ...(extended ? {
      empiricalPluginProfileHash: sha(empiricalPluginProfileHash),
      independentRecomputationReceiptHash: sha(independentRecomputationReceiptHash),
    } : {}),
    blockers,
  };
  return Object.freeze({
    ...payload,
    typedNumericOracleCertificateSetHash:
      hashRecord('TypedNumericOracleCertificateSet', payload),
  });
}

export function verifyTypedNumericOracleCertificateSet(certificateSet, expected = {}) {
  try {
    const rebuilt = buildTypedNumericOracleCertificateSet(certificateSet);
    return JSON.stringify(rebuilt) === JSON.stringify(certificateSet)
      && certificateSet.status === 'typed_numeric_oracle_certificate_set_verified'
      && Object.entries(expected).every(([field, value]) => (
        value === undefined || value === null || certificateSet[field] === value
      ));
  } catch {
    return false;
  }
}

export const TYPED_NUMERIC_ORACLE_TYPES = Object.freeze([...ORACLE_TYPES].sort());
export const TYPED_NUMERIC_ORACLE_ASSURANCE_SCOPES = Object.freeze(
  Object.keys(ASSURANCE_SCOPES).sort(),
);
