import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  exactPlainObject,
  jsonEqual,
  requiredDeepLearningHash,
  requiredDeepLearningId,
  safeIntegerInRange,
} from './deep-learning-contract-primitives.mjs';
import {
  buildDeepLearningInlineTrainingDataset,
  verifyDeepLearningInlineTrainingDataset,
} from './deep-learning-training-dataset-contract.mjs';

const SYNTHETIC_ORIGIN = 'canonical-synthetic-generated-v1';
const EXTERNAL_ORIGIN = 'external-source-declared-non-authoritative-v1';
const PARITY_GENERATOR = 'cartesian-binary-parity-v1';
const SPDX_ID = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;
const SYNTHETIC_INPUT_KEYS = Object.freeze(['datasetId', 'featureCount']);
const EXTERNAL_INPUT_KEYS = Object.freeze([
  'consent', 'externalAuthority', 'license', 'source', 'splitLineage',
  'trainingDataset',
]);
const AUTHORITY_KEYS = Object.freeze([
  'blockers', 'consent', 'datasetContentHash', 'datasetProductionUseAuthorized',
  'deepLearningTrainingDatasetAuthorityHash', 'externalAuthority',
  'externalAuthorityRequired', 'kind', 'license', 'originClass',
  'productionPromotionEligible', 'selfAuthorizesOverallProductionPromotion',
  'source', 'splitLineage', 'status', 'trainingDatasetManifestHash', 'version',
]);
const EXTERNAL_SOURCE_KEYS = Object.freeze([
  'acquisitionReceiptHash', 'datasetVersion', 'publisherId', 'sourceLocatorHash',
]);
const EXTERNAL_LICENSE_KEYS = Object.freeze([
  'licenseTermsDocumentHash', 'modelTrainingAllowed', 'redistributionAllowed',
  'spdxLicenseId',
]);
const EXTERNAL_CONSENT_KEYS = Object.freeze([
  'consentAuthorityDocumentHash', 'consentRequired', 'humanSubjectsPresent',
  'personalDataPresent',
]);
const EXTERNAL_SPLIT_KEYS = Object.freeze([
  'hiddenTestIndexManifestHash', 'leakageReviewDocumentHash',
  'parentDatasetManifestHash', 'splitAlgorithmId', 'splitSeedHash',
  'trainingIndexManifestHash', 'validationIndexManifestHash',
]);
const EXTERNAL_AUTHORITY_KEYS = Object.freeze([
  'authorityDocumentHash', 'signatureVerificationReceiptHash',
]);

function indexManifestHash(sampleCount) {
  return hashRecord('DeepLearningTrainingDatasetSampleIndexManifest', {
    indexing: 'zero-based-contiguous-v1',
    sampleCount,
    firstIndex: 0,
    lastIndex: sampleCount - 1,
  });
}

function canonicalParityDatasetInput({ datasetId, featureCount } = {}) {
  if (!requiredDeepLearningId(datasetId)
    || !safeIntegerInRange(featureCount, 1, 12)) {
    throw new Error('deep_learning_synthetic_dataset_generator_invalid');
  }
  const sampleCount = 2 ** featureCount;
  const features = [];
  const labels = [];
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const row = [];
    let parity = 0;
    for (let featureIndex = 0; featureIndex < featureCount; featureIndex += 1) {
      const bit = (sampleIndex >> (featureCount - featureIndex - 1)) & 1;
      row.push(bit);
      parity ^= bit;
    }
    features.push(row);
    labels.push(parity);
  }
  return { datasetId, classCount: 2, features, labels };
}

export function buildCanonicalParityDeepLearningTrainingDataset(value = {}) {
  if (!exactPlainObject(value, SYNTHETIC_INPUT_KEYS)) {
    throw new Error('deep_learning_synthetic_dataset_generator_invalid');
  }
  return buildDeepLearningInlineTrainingDataset(canonicalParityDatasetInput(value));
}

function syntheticAuthorityPayload(trainingDataset, generatorSpec) {
  const source = {
    version: 1,
    kind: 'DeepLearningTrainingDatasetSourceProvenance',
    originClass: SYNTHETIC_ORIGIN,
    generatorId: PARITY_GENERATOR,
    generatorParameters: generatorSpec,
    generatorParametersHash: hashRecord(
      'DeepLearningSyntheticDatasetGeneratorParameters', generatorSpec,
    ),
    generatedDatasetContentHash: trainingDataset.datasetContentHash,
    externalSourceLocatorHash: null,
  };
  const license = {
    version: 1,
    kind: 'DeepLearningTrainingDatasetLicenseBinding',
    rightsBasis: 'canonical-generator-no-external-content-v1',
    spdxLicenseId: 'CC0-1.0',
    licenseTermsDocumentHash: null,
    modelTrainingAllowed: true,
    redistributionAllowed: true,
    attributionRequired: false,
  };
  const consent = {
    version: 1,
    kind: 'DeepLearningTrainingDatasetConsentBinding',
    humanSubjectsPresent: false,
    personalDataPresent: false,
    consentRequired: false,
    consentAuthorityDocumentHash: null,
  };
  const splitLineage = {
    version: 1,
    kind: 'DeepLearningTrainingDatasetSplitLineage',
    parentDatasetManifestHash:
      trainingDataset.deepLearningTrainingDatasetManifestHash,
    parentDatasetContentHash: trainingDataset.datasetContentHash,
    splitName: 'train',
    splitPolicy: 'all-generated-records-training-only-v1',
    splitAlgorithmId: 'identity-split-v1',
    splitSeedHash: null,
    trainingIndexManifestHash: indexManifestHash(trainingDataset.sampleCount),
    validationIndexManifestHash: null,
    hiddenTestIndexManifestHash: null,
    leakageReviewDocumentHash: null,
  };
  return {
    version: 1,
    kind: 'DeepLearningTrainingDatasetAuthorityBinding',
    status: 'deep_learning_training_dataset_authority_bound',
    originClass: SYNTHETIC_ORIGIN,
    trainingDatasetManifestHash:
      trainingDataset.deepLearningTrainingDatasetManifestHash,
    datasetContentHash: trainingDataset.datasetContentHash,
    source,
    license,
    consent,
    splitLineage,
    externalAuthority: null,
    externalAuthorityRequired: false,
    datasetProductionUseAuthorized: true,
    selfAuthorizesOverallProductionPromotion: false,
    productionPromotionEligible: false,
    blockers: ['deep_learning_dataset_authority_not_sufficient_for_overall_promotion'],
  };
}

export function buildCanonicalSyntheticDeepLearningDatasetAuthority({
  trainingDataset,
  generatorSpec,
} = {}) {
  if (!exactPlainObject(generatorSpec, SYNTHETIC_INPUT_KEYS)
    || !verifyDeepLearningInlineTrainingDataset(trainingDataset)
    || !jsonEqual(
      buildCanonicalParityDeepLearningTrainingDataset(generatorSpec),
      trainingDataset,
    )) {
    throw new Error('deep_learning_synthetic_dataset_authority_invalid');
  }
  const payload = syntheticAuthorityPayload(trainingDataset, generatorSpec);
  return deepFreezeJsonValue({
    ...payload,
    deepLearningTrainingDatasetAuthorityHash:
      hashRecord('DeepLearningTrainingDatasetAuthorityBinding', payload),
  });
}

function requiredExternalSource(value) {
  if (!exactPlainObject(value, EXTERNAL_SOURCE_KEYS)
    || !requiredDeepLearningHash(value.sourceLocatorHash)
    || !requiredDeepLearningHash(value.acquisitionReceiptHash)
    || !requiredDeepLearningId(value.publisherId)
    || !requiredDeepLearningId(value.datasetVersion)) {
    throw new Error('deep_learning_external_dataset_source_invalid');
  }
  return {
    acquisitionReceiptHash: value.acquisitionReceiptHash,
    datasetVersion: value.datasetVersion,
    publisherId: value.publisherId,
    sourceLocatorHash: value.sourceLocatorHash,
  };
}

function requiredExternalLicense(value) {
  if (!exactPlainObject(value, EXTERNAL_LICENSE_KEYS)
    || !SPDX_ID.test(String(value.spdxLicenseId || ''))
    || !requiredDeepLearningHash(value.licenseTermsDocumentHash)
    || typeof value.modelTrainingAllowed !== 'boolean'
    || typeof value.redistributionAllowed !== 'boolean') {
    throw new Error('deep_learning_external_dataset_license_invalid');
  }
  return {
    licenseTermsDocumentHash: value.licenseTermsDocumentHash,
    modelTrainingAllowed: value.modelTrainingAllowed,
    redistributionAllowed: value.redistributionAllowed,
    spdxLicenseId: value.spdxLicenseId,
  };
}

function requiredExternalConsent(value) {
  if (!exactPlainObject(value, EXTERNAL_CONSENT_KEYS)
    || typeof value.humanSubjectsPresent !== 'boolean'
    || typeof value.personalDataPresent !== 'boolean'
    || typeof value.consentRequired !== 'boolean'
    || ((value.humanSubjectsPresent || value.personalDataPresent
      || value.consentRequired)
      ? !requiredDeepLearningHash(value.consentAuthorityDocumentHash)
      : value.consentAuthorityDocumentHash !== null)) {
    throw new Error('deep_learning_external_dataset_consent_invalid');
  }
  return {
    consentAuthorityDocumentHash: value.consentAuthorityDocumentHash,
    consentRequired: value.consentRequired,
    humanSubjectsPresent: value.humanSubjectsPresent,
    personalDataPresent: value.personalDataPresent,
  };
}

function requiredExternalSplitLineage(value) {
  if (!exactPlainObject(value, EXTERNAL_SPLIT_KEYS)
    || !requiredDeepLearningHash(value.parentDatasetManifestHash)
    || !requiredDeepLearningId(value.splitAlgorithmId)
    || !requiredDeepLearningHash(value.splitSeedHash)
    || !requiredDeepLearningHash(value.trainingIndexManifestHash)
    || !requiredDeepLearningHash(value.validationIndexManifestHash)
    || !requiredDeepLearningHash(value.hiddenTestIndexManifestHash)
    || !requiredDeepLearningHash(value.leakageReviewDocumentHash)) {
    throw new Error('deep_learning_external_dataset_split_lineage_invalid');
  }
  return {
    hiddenTestIndexManifestHash: value.hiddenTestIndexManifestHash,
    leakageReviewDocumentHash: value.leakageReviewDocumentHash,
    parentDatasetManifestHash: value.parentDatasetManifestHash,
    splitAlgorithmId: value.splitAlgorithmId,
    splitSeedHash: value.splitSeedHash,
    trainingIndexManifestHash: value.trainingIndexManifestHash,
    validationIndexManifestHash: value.validationIndexManifestHash,
  };
}

function requiredExternalAuthority(value) {
  if (!exactPlainObject(value, EXTERNAL_AUTHORITY_KEYS)
    || !requiredDeepLearningHash(value.authorityDocumentHash)
    || !requiredDeepLearningHash(value.signatureVerificationReceiptHash)) {
    throw new Error('deep_learning_external_dataset_authority_invalid');
  }
  return {
    authorityDocumentHash: value.authorityDocumentHash,
    signatureVerificationReceiptHash: value.signatureVerificationReceiptHash,
  };
}

export function buildExternalDeepLearningDatasetProvenanceDeclaration(value = {}) {
  if (!exactPlainObject(value, EXTERNAL_INPUT_KEYS)
    || !verifyDeepLearningInlineTrainingDataset(value.trainingDataset)) {
    throw new Error('deep_learning_external_dataset_declaration_invalid');
  }
  const payload = {
    version: 1,
    kind: 'DeepLearningTrainingDatasetAuthorityBinding',
    status: 'deep_learning_external_dataset_authority_unverified',
    originClass: EXTERNAL_ORIGIN,
    trainingDatasetManifestHash:
      value.trainingDataset.deepLearningTrainingDatasetManifestHash,
    datasetContentHash: value.trainingDataset.datasetContentHash,
    source: {
      version: 1,
      kind: 'DeepLearningTrainingDatasetSourceProvenance',
      originClass: EXTERNAL_ORIGIN,
      ...requiredExternalSource(value.source),
    },
    license: {
      version: 1,
      kind: 'DeepLearningTrainingDatasetLicenseBinding',
      ...requiredExternalLicense(value.license),
    },
    consent: {
      version: 1,
      kind: 'DeepLearningTrainingDatasetConsentBinding',
      ...requiredExternalConsent(value.consent),
    },
    splitLineage: {
      version: 1,
      kind: 'DeepLearningTrainingDatasetSplitLineage',
      trainingDatasetManifestHash:
        value.trainingDataset.deepLearningTrainingDatasetManifestHash,
      trainingDatasetContentHash: value.trainingDataset.datasetContentHash,
      ...requiredExternalSplitLineage(value.splitLineage),
    },
    externalAuthority: {
      version: 1,
      kind: 'DeepLearningExternalDatasetAuthorityReference',
      ...requiredExternalAuthority(value.externalAuthority),
      cryptographicVerificationPerformedHere: false,
    },
    externalAuthorityRequired: true,
    datasetProductionUseAuthorized: false,
    selfAuthorizesOverallProductionPromotion: false,
    productionPromotionEligible: false,
    blockers: [
      'deep_learning_external_dataset_signature_verification_authority_required',
      'deep_learning_external_dataset_independent_legal_review_required',
    ],
  };
  return deepFreezeJsonValue({
    ...payload,
    deepLearningTrainingDatasetAuthorityHash:
      hashRecord('DeepLearningTrainingDatasetAuthorityBinding', payload),
  });
}

function syntheticAuthorityInput(value, trainingDataset) {
  return {
    trainingDataset,
    generatorSpec: value?.source?.generatorParameters,
  };
}

function externalAuthorityInput(value, trainingDataset) {
  return {
    trainingDataset,
    source: value?.source && Object.fromEntries(
      EXTERNAL_SOURCE_KEYS.map((key) => [key, value.source[key]]),
    ),
    license: value?.license && Object.fromEntries(
      EXTERNAL_LICENSE_KEYS.map((key) => [key, value.license[key]]),
    ),
    consent: value?.consent && Object.fromEntries(
      EXTERNAL_CONSENT_KEYS.map((key) => [key, value.consent[key]]),
    ),
    splitLineage: value?.splitLineage && Object.fromEntries(
      EXTERNAL_SPLIT_KEYS.map((key) => [key, value.splitLineage[key]]),
    ),
    externalAuthority: value?.externalAuthority && Object.fromEntries(
      EXTERNAL_AUTHORITY_KEYS.map((key) => [key, value.externalAuthority[key]]),
    ),
  };
}

export function verifyDeepLearningTrainingDatasetAuthority(
  value,
  { trainingDataset } = {},
) {
  try {
    const selectedTrainingDataset = trainingDataset
      || (value?.originClass === SYNTHETIC_ORIGIN
        ? buildCanonicalParityDeepLearningTrainingDataset(
          value?.source?.generatorParameters,
        )
        : null);
    if (!exactPlainObject(value, AUTHORITY_KEYS)
      || !verifyDeepLearningInlineTrainingDataset(selectedTrainingDataset)
      || value.trainingDatasetManifestHash
        !== selectedTrainingDataset.deepLearningTrainingDatasetManifestHash
      || value.datasetContentHash !== selectedTrainingDataset.datasetContentHash
      || value.productionPromotionEligible !== false
      || value.selfAuthorizesOverallProductionPromotion !== false) return false;
    if (value.originClass === SYNTHETIC_ORIGIN) {
      return jsonEqual(
        buildCanonicalSyntheticDeepLearningDatasetAuthority(
          syntheticAuthorityInput(value, selectedTrainingDataset),
        ),
        value,
      );
    }
    if (value.originClass === EXTERNAL_ORIGIN) {
      return jsonEqual(
        buildExternalDeepLearningDatasetProvenanceDeclaration(
          externalAuthorityInput(value, selectedTrainingDataset),
        ),
        value,
      );
    }
  } catch { /* invalid */ }
  return false;
}

export function verifyCanonicalSyntheticDeepLearningDatasetAuthority(
  value,
  { trainingDataset } = {},
) {
  return value?.originClass === SYNTHETIC_ORIGIN
    && value?.datasetProductionUseAuthorized === true
    && value?.externalAuthorityRequired === false
    && verifyDeepLearningTrainingDatasetAuthority(value, { trainingDataset });
}

export const DEEP_LEARNING_TRAINING_DATASET_ORIGIN_CLASSES = Object.freeze({
  canonicalSynthetic: SYNTHETIC_ORIGIN,
  externalDeclared: EXTERNAL_ORIGIN,
});
