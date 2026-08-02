import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAdvancedNumericalPluginDescriptor,
} from './advanced-numerical-plugin-contract.mjs';
import {
  verifyAdvancedNumericalPluginQualificationStatement,
} from './advanced-numerical-plugin-qualification-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAXIMUM_EVIDENCE_LIFETIME_MS = 366 * 24 * 60 * 60 * 1_000;
const SIGNATURE_KEYS = Object.freeze(['algorithm', 'keyId', 'role', 'value']);
const EXECUTION_MODES = Object.freeze([
  'independent-replay',
  'reference',
]);
const EXECUTION_KEYS = Object.freeze([
  'advancedNumericalQualificationExecutionReceiptHash',
  'analysisFamily',
  'descriptorHash',
  'executedAt',
  'executionMode',
  'executionProcessIdentityHash',
  'expiresAt',
  'kind',
  'pluginId',
  'pluginVersion',
  'requestCorpusHash',
  'resultHash',
  'runtimeExecutableHash',
  'runtimePackageClosureHash',
  'signatures',
  'signedAt',
  'signedBundleHash',
  'sourceMerkleHash',
  'sourceWorkspaceManifestHash',
  'status',
  'validFrom',
  'version',
]);
const ORACLE_KEYS = Object.freeze([
  'advancedNumericalOracleQualificationReceiptHash',
  'analysisFamily',
  'descriptorHash',
  'expiresAt',
  'independentNumericOracleArtifactHash',
  'kind',
  'oracleAccepted',
  'oracleContractHash',
  'pluginId',
  'pluginVersion',
  'referenceExecutionReceiptHash',
  'replayExecutionReceiptHash',
  'resultHash',
  'signatures',
  'signedAt',
  'signedBundleHash',
  'status',
  'validFrom',
  'version',
]);
const UNCERTAINTY_KEYS = Object.freeze([
  'advancedNumericalUncertaintyQualificationReceiptHash',
  'analysisFamily',
  'descriptorHash',
  'expiresAt',
  'kind',
  'pluginId',
  'pluginVersion',
  'referenceExecutionReceiptHash',
  'replayExecutionReceiptHash',
  'resultHash',
  'signatures',
  'signedAt',
  'signedBundleHash',
  'status',
  'typedUncertaintyAccepted',
  'typedUncertaintyArtifactHash',
  'uncertaintyContractHash',
  'validFrom',
  'version',
]);
const SCIENTIFIC_REVIEW_KEYS = Object.freeze([
  'advancedNumericalScientificReviewQualificationReceiptHash',
  'analysisFamily',
  'approved',
  'descriptorHash',
  'expiresAt',
  'independentNumericOracleReceiptHash',
  'kind',
  'pluginId',
  'pluginVersion',
  'referenceExecutionReceiptHash',
  'replayExecutionReceiptHash',
  'resultHash',
  'scientificReviewArtifactHash',
  'signatures',
  'signedAt',
  'signedBundleHash',
  'status',
  'typedUncertaintyReviewReceiptHash',
  'validFrom',
  'version',
]);
const BUNDLE_KEYS = Object.freeze([
  'advancedNumericalPluginQualificationEvidenceBundleHash',
  'analysisFamily',
  'descriptorHash',
  'independentNumericOracleReceipt',
  'kind',
  'pluginId',
  'pluginVersion',
  'qualificationStatementHash',
  'referenceExecutionReceipt',
  'replayExecutionReceipt',
  'scientificReviewReceipt',
  'signedBundleHash',
  'status',
  'typedUncertaintyReviewReceipt',
  'version',
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

function compileSignatures(signatures) {
  if (!Array.isArray(signatures) || signatures.length > 1
    || signatures.some((signature) => !validSignature(signature))) {
    throw new Error('advanced_numerical_qualification_evidence_signature_invalid');
  }
  return Object.freeze(signatures.map((signature) => Object.freeze({
    algorithm: signature.algorithm,
    keyId: signature.keyId,
    role: signature.role,
    value: signature.value,
  })));
}

function compileTimeWindow({
  signedAt,
  validFrom = signedAt,
  expiresAt,
  executedAt = null,
} = {}) {
  const signedAtMs = Date.parse(String(signedAt || ''));
  const validFromMs = Date.parse(String(validFrom || ''));
  const expiresAtMs = Date.parse(String(expiresAt || ''));
  const executedAtMs = executedAt === null ? null : Date.parse(String(executedAt || ''));
  if (!canonicalInstant(signedAt) || !canonicalInstant(validFrom)
    || !canonicalInstant(expiresAt)
    || signedAtMs > validFromMs || validFromMs >= expiresAtMs
    || expiresAtMs - signedAtMs > MAXIMUM_EVIDENCE_LIFETIME_MS
    || (executedAt !== null && (!canonicalInstant(executedAt)
      || executedAtMs > signedAtMs))) {
    throw new Error('advanced_numerical_qualification_evidence_time_window_invalid');
  }
  return Object.freeze({
    ...(executedAt === null ? {} : { executedAt }),
    signedAt,
    validFrom,
    expiresAt,
  });
}

function assertDescriptorBinding(descriptor, signedBundleHash) {
  if (!verifyAdvancedNumericalPluginDescriptor(descriptor)
    || !SHA256.test(String(signedBundleHash || ''))) {
    throw new Error('advanced_numerical_qualification_evidence_identity_invalid');
  }
}

function assertHashes(values) {
  if (values.some((value) => !SHA256.test(String(value || '')))) {
    throw new Error('advanced_numerical_qualification_evidence_hash_invalid');
  }
}

function identityPayload(descriptor, signedBundleHash) {
  return Object.freeze({
    pluginId: descriptor.pluginId,
    pluginVersion: descriptor.pluginVersion,
    analysisFamily: descriptor.analysisFamily,
    descriptorHash: descriptor.advancedNumericalPluginDescriptorHash,
    signedBundleHash: String(signedBundleHash),
  });
}

function envelopeMatches(kind, rebuilt, value) {
  return hashRecord(`${kind}Envelope`, rebuilt) === hashRecord(`${kind}Envelope`, value);
}

export function buildAdvancedNumericalQualificationExecutionReceipt({
  descriptor,
  signedBundleHash,
  executionMode,
  requestCorpusHash,
  resultHash,
  executionProcessIdentityHash,
  executedAt,
  signedAt,
  validFrom = signedAt,
  expiresAt,
  signatures = [],
} = {}) {
  assertDescriptorBinding(descriptor, signedBundleHash);
  assertHashes([requestCorpusHash, resultHash, executionProcessIdentityHash]);
  if (!EXECUTION_MODES.includes(executionMode)) {
    throw new Error('advanced_numerical_qualification_execution_mode_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AdvancedNumericalQualificationExecutionReceipt',
    status: 'advanced_numerical_qualification_execution_completed',
    executionMode,
    ...identityPayload(descriptor, signedBundleHash),
    requestCorpusHash,
    resultHash,
    executionProcessIdentityHash,
    runtimeExecutableHash: descriptor.runtime.executableHash,
    runtimePackageClosureHash: descriptor.runtime.packageClosureHash,
    sourceMerkleHash: descriptor.sourceIdentity.merkleHash,
    sourceWorkspaceManifestHash: descriptor.sourceIdentity.workspaceManifestHash,
    ...compileTimeWindow({
      executedAt,
      signedAt,
      validFrom,
      expiresAt,
    }),
  });
  return Object.freeze({
    ...payload,
    advancedNumericalQualificationExecutionReceiptHash: hashRecord(
      'AdvancedNumericalQualificationExecutionReceipt',
      payload,
    ),
    signatures: compileSignatures(signatures),
  });
}

export function verifyAdvancedNumericalQualificationExecutionReceipt(value, {
  descriptor,
  signedBundleHash,
  executionMode,
} = {}) {
  if (!hasExactObjectKeys(value, EXECUTION_KEYS)
    || value?.version !== 1
    || value?.kind !== 'AdvancedNumericalQualificationExecutionReceipt'
    || value?.status !== 'advanced_numerical_qualification_execution_completed'
    || value?.executionMode !== executionMode
    || value?.signatures?.length !== 1) return false;
  try {
    const rebuilt = buildAdvancedNumericalQualificationExecutionReceipt({
      descriptor,
      signedBundleHash,
      executionMode,
      requestCorpusHash: value.requestCorpusHash,
      resultHash: value.resultHash,
      executionProcessIdentityHash: value.executionProcessIdentityHash,
      executedAt: value.executedAt,
      signedAt: value.signedAt,
      validFrom: value.validFrom,
      expiresAt: value.expiresAt,
      signatures: value.signatures,
    });
    return envelopeMatches(
      'AdvancedNumericalQualificationExecutionReceipt',
      rebuilt,
      value,
    );
  } catch {
    return false;
  }
}

export function buildAdvancedNumericalOracleQualificationReceipt({
  descriptor,
  signedBundleHash,
  referenceExecutionReceiptHash,
  replayExecutionReceiptHash,
  resultHash,
  independentNumericOracleArtifactHash,
  oracleAccepted = true,
  signedAt,
  validFrom = signedAt,
  expiresAt,
  signatures = [],
} = {}) {
  assertDescriptorBinding(descriptor, signedBundleHash);
  assertHashes([
    referenceExecutionReceiptHash,
    replayExecutionReceiptHash,
    resultHash,
    independentNumericOracleArtifactHash,
  ]);
  if (oracleAccepted !== true) {
    throw new Error('advanced_numerical_oracle_qualification_not_accepted');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AdvancedNumericalOracleQualificationReceipt',
    status: 'advanced_numerical_oracle_qualification_approved',
    ...identityPayload(descriptor, signedBundleHash),
    oracleContractHash: descriptor.assuranceContracts.oracle.contractHash,
    referenceExecutionReceiptHash,
    replayExecutionReceiptHash,
    resultHash,
    independentNumericOracleArtifactHash,
    oracleAccepted: true,
    ...compileTimeWindow({ signedAt, validFrom, expiresAt }),
  });
  return Object.freeze({
    ...payload,
    advancedNumericalOracleQualificationReceiptHash: hashRecord(
      'AdvancedNumericalOracleQualificationReceipt',
      payload,
    ),
    signatures: compileSignatures(signatures),
  });
}

export function verifyAdvancedNumericalOracleQualificationReceipt(value, {
  descriptor,
  signedBundleHash,
} = {}) {
  if (!hasExactObjectKeys(value, ORACLE_KEYS)
    || value?.version !== 1
    || value?.kind !== 'AdvancedNumericalOracleQualificationReceipt'
    || value?.status !== 'advanced_numerical_oracle_qualification_approved'
    || value?.signatures?.length !== 1) return false;
  try {
    const rebuilt = buildAdvancedNumericalOracleQualificationReceipt({
      descriptor,
      signedBundleHash,
      referenceExecutionReceiptHash: value.referenceExecutionReceiptHash,
      replayExecutionReceiptHash: value.replayExecutionReceiptHash,
      resultHash: value.resultHash,
      independentNumericOracleArtifactHash:
        value.independentNumericOracleArtifactHash,
      oracleAccepted: value.oracleAccepted,
      signedAt: value.signedAt,
      validFrom: value.validFrom,
      expiresAt: value.expiresAt,
      signatures: value.signatures,
    });
    return envelopeMatches(
      'AdvancedNumericalOracleQualificationReceipt',
      rebuilt,
      value,
    );
  } catch {
    return false;
  }
}

export function buildAdvancedNumericalUncertaintyQualificationReceipt({
  descriptor,
  signedBundleHash,
  referenceExecutionReceiptHash,
  replayExecutionReceiptHash,
  resultHash,
  typedUncertaintyArtifactHash,
  typedUncertaintyAccepted = true,
  signedAt,
  validFrom = signedAt,
  expiresAt,
  signatures = [],
} = {}) {
  assertDescriptorBinding(descriptor, signedBundleHash);
  assertHashes([
    referenceExecutionReceiptHash,
    replayExecutionReceiptHash,
    resultHash,
    typedUncertaintyArtifactHash,
  ]);
  if (typedUncertaintyAccepted !== true) {
    throw new Error('advanced_numerical_uncertainty_qualification_not_accepted');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AdvancedNumericalUncertaintyQualificationReceipt',
    status: 'advanced_numerical_uncertainty_qualification_approved',
    ...identityPayload(descriptor, signedBundleHash),
    uncertaintyContractHash: descriptor.assuranceContracts.uncertainty.contractHash,
    referenceExecutionReceiptHash,
    replayExecutionReceiptHash,
    resultHash,
    typedUncertaintyArtifactHash,
    typedUncertaintyAccepted: true,
    ...compileTimeWindow({ signedAt, validFrom, expiresAt }),
  });
  return Object.freeze({
    ...payload,
    advancedNumericalUncertaintyQualificationReceiptHash: hashRecord(
      'AdvancedNumericalUncertaintyQualificationReceipt',
      payload,
    ),
    signatures: compileSignatures(signatures),
  });
}

export function verifyAdvancedNumericalUncertaintyQualificationReceipt(value, {
  descriptor,
  signedBundleHash,
} = {}) {
  if (!hasExactObjectKeys(value, UNCERTAINTY_KEYS)
    || value?.version !== 1
    || value?.kind !== 'AdvancedNumericalUncertaintyQualificationReceipt'
    || value?.status !== 'advanced_numerical_uncertainty_qualification_approved'
    || value?.signatures?.length !== 1) return false;
  try {
    const rebuilt = buildAdvancedNumericalUncertaintyQualificationReceipt({
      descriptor,
      signedBundleHash,
      referenceExecutionReceiptHash: value.referenceExecutionReceiptHash,
      replayExecutionReceiptHash: value.replayExecutionReceiptHash,
      resultHash: value.resultHash,
      typedUncertaintyArtifactHash: value.typedUncertaintyArtifactHash,
      typedUncertaintyAccepted: value.typedUncertaintyAccepted,
      signedAt: value.signedAt,
      validFrom: value.validFrom,
      expiresAt: value.expiresAt,
      signatures: value.signatures,
    });
    return envelopeMatches(
      'AdvancedNumericalUncertaintyQualificationReceipt',
      rebuilt,
      value,
    );
  } catch {
    return false;
  }
}

export function buildAdvancedNumericalScientificReviewQualificationReceipt({
  descriptor,
  signedBundleHash,
  referenceExecutionReceiptHash,
  replayExecutionReceiptHash,
  independentNumericOracleReceiptHash,
  typedUncertaintyReviewReceiptHash,
  resultHash,
  scientificReviewArtifactHash,
  approved = true,
  signedAt,
  validFrom = signedAt,
  expiresAt,
  signatures = [],
} = {}) {
  assertDescriptorBinding(descriptor, signedBundleHash);
  assertHashes([
    referenceExecutionReceiptHash,
    replayExecutionReceiptHash,
    independentNumericOracleReceiptHash,
    typedUncertaintyReviewReceiptHash,
    resultHash,
    scientificReviewArtifactHash,
  ]);
  if (approved !== true) {
    throw new Error('advanced_numerical_scientific_review_not_approved');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AdvancedNumericalScientificReviewQualificationReceipt',
    status: 'advanced_numerical_scientific_review_approved',
    ...identityPayload(descriptor, signedBundleHash),
    referenceExecutionReceiptHash,
    replayExecutionReceiptHash,
    independentNumericOracleReceiptHash,
    typedUncertaintyReviewReceiptHash,
    resultHash,
    scientificReviewArtifactHash,
    approved: true,
    ...compileTimeWindow({ signedAt, validFrom, expiresAt }),
  });
  return Object.freeze({
    ...payload,
    advancedNumericalScientificReviewQualificationReceiptHash: hashRecord(
      'AdvancedNumericalScientificReviewQualificationReceipt',
      payload,
    ),
    signatures: compileSignatures(signatures),
  });
}

export function verifyAdvancedNumericalScientificReviewQualificationReceipt(value, {
  descriptor,
  signedBundleHash,
} = {}) {
  if (!hasExactObjectKeys(value, SCIENTIFIC_REVIEW_KEYS)
    || value?.version !== 1
    || value?.kind !== 'AdvancedNumericalScientificReviewQualificationReceipt'
    || value?.status !== 'advanced_numerical_scientific_review_approved'
    || value?.signatures?.length !== 1) return false;
  try {
    const rebuilt = buildAdvancedNumericalScientificReviewQualificationReceipt({
      descriptor,
      signedBundleHash,
      referenceExecutionReceiptHash: value.referenceExecutionReceiptHash,
      replayExecutionReceiptHash: value.replayExecutionReceiptHash,
      independentNumericOracleReceiptHash:
        value.independentNumericOracleReceiptHash,
      typedUncertaintyReviewReceiptHash:
        value.typedUncertaintyReviewReceiptHash,
      resultHash: value.resultHash,
      scientificReviewArtifactHash: value.scientificReviewArtifactHash,
      approved: value.approved,
      signedAt: value.signedAt,
      validFrom: value.validFrom,
      expiresAt: value.expiresAt,
      signatures: value.signatures,
    });
    return envelopeMatches(
      'AdvancedNumericalScientificReviewQualificationReceipt',
      rebuilt,
      value,
    );
  } catch {
    return false;
  }
}

export function buildAdvancedNumericalPluginQualificationEvidenceBundle({
  descriptor,
  signedBundleHash,
  qualification,
  referenceExecutionReceipt,
  replayExecutionReceipt,
  independentNumericOracleReceipt,
  typedUncertaintyReviewReceipt,
  scientificReviewReceipt,
} = {}) {
  assertDescriptorBinding(descriptor, signedBundleHash);
  if (!verifyAdvancedNumericalPluginQualificationStatement(qualification, {
    descriptor,
    signedBundleHash,
  }) || !verifyAdvancedNumericalQualificationExecutionReceipt(
    referenceExecutionReceipt,
    { descriptor, signedBundleHash, executionMode: 'reference' },
  ) || !verifyAdvancedNumericalQualificationExecutionReceipt(
    replayExecutionReceipt,
    { descriptor, signedBundleHash, executionMode: 'independent-replay' },
  ) || !verifyAdvancedNumericalOracleQualificationReceipt(
    independentNumericOracleReceipt,
    { descriptor, signedBundleHash },
  ) || !verifyAdvancedNumericalUncertaintyQualificationReceipt(
    typedUncertaintyReviewReceipt,
    { descriptor, signedBundleHash },
  ) || !verifyAdvancedNumericalScientificReviewQualificationReceipt(
    scientificReviewReceipt,
    { descriptor, signedBundleHash },
  )) {
    throw new Error('advanced_numerical_qualification_evidence_receipt_invalid');
  }
  const referenceReceiptHash =
    referenceExecutionReceipt.advancedNumericalQualificationExecutionReceiptHash;
  const replayReceiptHash =
    replayExecutionReceipt.advancedNumericalQualificationExecutionReceiptHash;
  const oracleReceiptHash =
    independentNumericOracleReceipt.advancedNumericalOracleQualificationReceiptHash;
  const uncertaintyReceiptHash =
    typedUncertaintyReviewReceipt.advancedNumericalUncertaintyQualificationReceiptHash;
  const scientificReceiptHash =
    scientificReviewReceipt
      .advancedNumericalScientificReviewQualificationReceiptHash;
  const resultHash = referenceExecutionReceipt.resultHash;
  const receiptBindingsValid = referenceReceiptHash !== replayReceiptHash
    && referenceExecutionReceipt.executionProcessIdentityHash
      !== replayExecutionReceipt.executionProcessIdentityHash
    && referenceExecutionReceipt.requestCorpusHash
      === replayExecutionReceipt.requestCorpusHash
    && resultHash === replayExecutionReceipt.resultHash
    && independentNumericOracleReceipt.referenceExecutionReceiptHash
      === referenceReceiptHash
    && independentNumericOracleReceipt.replayExecutionReceiptHash
      === replayReceiptHash
    && independentNumericOracleReceipt.resultHash === resultHash
    && typedUncertaintyReviewReceipt.referenceExecutionReceiptHash
      === referenceReceiptHash
    && typedUncertaintyReviewReceipt.replayExecutionReceiptHash
      === replayReceiptHash
    && typedUncertaintyReviewReceipt.resultHash === resultHash
    && scientificReviewReceipt.referenceExecutionReceiptHash
      === referenceReceiptHash
    && scientificReviewReceipt.replayExecutionReceiptHash === replayReceiptHash
    && scientificReviewReceipt.independentNumericOracleReceiptHash
      === oracleReceiptHash
    && scientificReviewReceipt.typedUncertaintyReviewReceiptHash
      === uncertaintyReceiptHash
    && scientificReviewReceipt.resultHash === resultHash
    && qualification.evidence.independentNumericOracleReceiptHash
      === oracleReceiptHash
    && qualification.evidence.referenceExecutionReceiptHash
      === referenceReceiptHash
    && qualification.evidence.referenceResultHash === resultHash
    && qualification.evidence.replayExecutionReceiptHash === replayReceiptHash
    && qualification.evidence.replayResultHash === resultHash
    && qualification.evidence.scientificReviewReceiptHash
      === scientificReceiptHash
    && qualification.evidence.typedUncertaintyReviewReceiptHash
      === uncertaintyReceiptHash;
  if (!receiptBindingsValid) {
    throw new Error('advanced_numerical_qualification_evidence_binding_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AdvancedNumericalPluginQualificationEvidenceBundle',
    status: 'advanced_numerical_plugin_qualification_evidence_complete',
    ...identityPayload(descriptor, signedBundleHash),
    qualificationStatementHash:
      qualification.advancedNumericalPluginQualificationStatementHash,
    referenceExecutionReceipt: deepFreezeJsonValue(
      structuredClone(referenceExecutionReceipt),
    ),
    replayExecutionReceipt: deepFreezeJsonValue(
      structuredClone(replayExecutionReceipt),
    ),
    independentNumericOracleReceipt: deepFreezeJsonValue(
      structuredClone(independentNumericOracleReceipt),
    ),
    typedUncertaintyReviewReceipt: deepFreezeJsonValue(
      structuredClone(typedUncertaintyReviewReceipt),
    ),
    scientificReviewReceipt: deepFreezeJsonValue(
      structuredClone(scientificReviewReceipt),
    ),
  });
  return Object.freeze({
    ...payload,
    advancedNumericalPluginQualificationEvidenceBundleHash: hashRecord(
      'AdvancedNumericalPluginQualificationEvidenceBundle',
      payload,
    ),
  });
}

export function verifyAdvancedNumericalPluginQualificationEvidenceBundle(value, {
  descriptor,
  signedBundleHash,
  qualification,
} = {}) {
  if (!hasExactObjectKeys(value, BUNDLE_KEYS)
    || value?.version !== 1
    || value?.kind !== 'AdvancedNumericalPluginQualificationEvidenceBundle'
    || value?.status !== 'advanced_numerical_plugin_qualification_evidence_complete') {
    return false;
  }
  try {
    const rebuilt = buildAdvancedNumericalPluginQualificationEvidenceBundle({
      descriptor,
      signedBundleHash,
      qualification,
      referenceExecutionReceipt: value.referenceExecutionReceipt,
      replayExecutionReceipt: value.replayExecutionReceipt,
      independentNumericOracleReceipt: value.independentNumericOracleReceipt,
      typedUncertaintyReviewReceipt: value.typedUncertaintyReviewReceipt,
      scientificReviewReceipt: value.scientificReviewReceipt,
    });
    return envelopeMatches(
      'AdvancedNumericalPluginQualificationEvidenceBundle',
      rebuilt,
      value,
    );
  } catch {
    return false;
  }
}
