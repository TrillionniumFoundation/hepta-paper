import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAdvancedNumericalPluginDescriptor,
} from './advanced-numerical-plugin-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAXIMUM_QUALIFICATION_LIFETIME_MS = 366 * 24 * 60 * 60 * 1_000;
const EVIDENCE_KEYS = Object.freeze([
  'independentNumericOracleReceiptHash',
  'referenceExecutionReceiptHash',
  'referenceResultHash',
  'replayExecutionReceiptHash',
  'replayResultHash',
  'scientificReviewReceiptHash',
  'typedUncertaintyReviewReceiptHash',
]);
const SIGNATURE_KEYS = Object.freeze(['algorithm', 'keyId', 'role', 'value']);
const STATEMENT_KEYS = Object.freeze([
  'advancedNumericalPluginQualificationStatementHash',
  'analysisFamily',
  'descriptorHash',
  'evidence',
  'expiresAt',
  'kind',
  'pluginId',
  'pluginVersion',
  'signatures',
  'signedAt',
  'signedBundleHash',
  'status',
  'validFrom',
  'version',
]);

export const ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_ROLES = Object.freeze([
  'advanced_numerical_oracle_authority',
  'advanced_numerical_replay_authority',
  'advanced_numerical_scientific_reviewer',
  'advanced_numerical_uncertainty_reviewer',
]);

function canonicalInstant(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validSignature(signature) {
  if (!hasExactObjectKeys(signature, SIGNATURE_KEYS)
    || signature.algorithm !== 'ed25519'
    || typeof signature.keyId !== 'string' || signature.keyId.length < 1
    || typeof signature.role !== 'string' || signature.role.length < 1
    || !BASE64.test(String(signature.value || ''))) return false;
  try {
    const bytes = Buffer.from(signature.value, 'base64');
    return bytes.length === 64 && bytes.toString('base64') === signature.value;
  } catch {
    return false;
  }
}

function compileEvidence(value) {
  if (!hasExactObjectKeys(value, EVIDENCE_KEYS)
    || EVIDENCE_KEYS.some((key) => !SHA256.test(String(value[key] || '')))
    || value.referenceExecutionReceiptHash === value.replayExecutionReceiptHash
    || value.referenceResultHash !== value.replayResultHash) {
    throw new Error('advanced_numerical_plugin_qualification_evidence_invalid');
  }
  return Object.freeze(Object.fromEntries(
    EVIDENCE_KEYS.map((key) => [key, String(value[key])]),
  ));
}

export function buildAdvancedNumericalPluginQualificationStatement({
  descriptor,
  signedBundleHash,
  evidence,
  signedAt,
  validFrom = signedAt,
  expiresAt,
  signatures = [],
} = {}) {
  const signedAtMs = Date.parse(String(signedAt || ''));
  const validFromMs = Date.parse(String(validFrom || ''));
  const expiresAtMs = Date.parse(String(expiresAt || ''));
  if (!verifyAdvancedNumericalPluginDescriptor(descriptor)
    || !SHA256.test(String(signedBundleHash || ''))
    || !canonicalInstant(signedAt) || !canonicalInstant(validFrom)
    || !canonicalInstant(expiresAt)
    || signedAtMs > validFromMs || validFromMs >= expiresAtMs
    || expiresAtMs - signedAtMs > MAXIMUM_QUALIFICATION_LIFETIME_MS
    || !Array.isArray(signatures) || signatures.length > 16
    || signatures.some((signature) => !validSignature(signature))) {
    throw new Error('advanced_numerical_plugin_qualification_statement_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AdvancedNumericalPluginQualificationStatement',
    status: 'advanced_numerical_plugin_production_qualification_approved',
    pluginId: descriptor.pluginId,
    pluginVersion: descriptor.pluginVersion,
    analysisFamily: descriptor.analysisFamily,
    descriptorHash: descriptor.advancedNumericalPluginDescriptorHash,
    signedBundleHash: String(signedBundleHash),
    evidence: compileEvidence(evidence),
    signedAt,
    validFrom,
    expiresAt,
  });
  return Object.freeze({
    ...payload,
    advancedNumericalPluginQualificationStatementHash: hashRecord(
      'AdvancedNumericalPluginQualificationStatement',
      payload,
    ),
    signatures: Object.freeze(signatures.map((signature) => Object.freeze({
      algorithm: signature.algorithm,
      keyId: signature.keyId,
      role: signature.role,
      value: signature.value,
    }))),
  });
}

export function verifyAdvancedNumericalPluginQualificationStatement(value, {
  descriptor,
  signedBundleHash,
} = {}) {
  if (!hasExactObjectKeys(value, STATEMENT_KEYS)
    || value?.version !== 1
    || value?.kind !== 'AdvancedNumericalPluginQualificationStatement'
    || value?.status !== 'advanced_numerical_plugin_production_qualification_approved'
    || value?.pluginId !== descriptor?.pluginId
    || value?.pluginVersion !== descriptor?.pluginVersion
    || value?.analysisFamily !== descriptor?.analysisFamily
    || value?.descriptorHash !== descriptor?.advancedNumericalPluginDescriptorHash
    || value?.signedBundleHash !== signedBundleHash
    || !Array.isArray(value.signatures)
    || value.signatures.length !== ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_ROLES.length) {
    return false;
  }
  try {
    const rebuilt = buildAdvancedNumericalPluginQualificationStatement({
      descriptor,
      signedBundleHash,
      evidence: value.evidence,
      signedAt: value.signedAt,
      validFrom: value.validFrom,
      expiresAt: value.expiresAt,
      signatures: value.signatures,
    });
    return hashRecord('AdvancedNumericalPluginQualificationStatementEnvelope', rebuilt)
      === hashRecord('AdvancedNumericalPluginQualificationStatementEnvelope', value);
  } catch {
    return false;
  }
}
