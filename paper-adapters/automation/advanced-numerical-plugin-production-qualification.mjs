import crypto from 'node:crypto';

import {
  ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_ROLES,
  verifyAdvancedNumericalPluginQualificationStatement,
} from '../../paper-domain/research/advanced-numerical-plugin-qualification-contract.mjs';
import {
  verifyAdvancedNumericalPluginQualificationEvidenceBundle,
} from '../../paper-domain/research/advanced-numerical-plugin-qualification-evidence-contract.mjs';
import {
  buildAdvancedNumericalGpuRuntimeAuthority,
} from '../../paper-domain/research/advanced-numerical-plugin-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAuthoritySignatures,
  verifyAuthorityTimeWindow,
} from '../authority/authority-signatures.mjs';

const MAXIMUM_QUALIFICATION_LIFETIME_MS = 366 * 24 * 60 * 60 * 1_000;
const MAXIMUM_EVIDENCE_AGE_MS = 31 * 24 * 60 * 60 * 1_000;
const PLUGIN_AUTHORITY_ROLE = 'advanced_numerical_plugin_authority';

function prefixedBlockers(prefix, blockers) {
  return blockers.map((blocker) => `${prefix}:${blocker}`);
}

function canonicalOrganization(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function signerControlIdentities(verifiedSignatures, trustStore) {
  const organizations = [];
  const publicKeySpkiHashes = [];
  const blockers = [];
  for (const signature of verifiedSignatures) {
    const trustedKey = trustStore?.keys?.find((key) => (
      key?.keyId === signature.keyId
    ));
    const organization = canonicalOrganization(trustedKey?.organization);
    if (!organization) {
      blockers.push('advanced_numerical_authority_organization_required');
      continue;
    }
    organizations.push(organization);
    try {
      const publicKey = crypto.createPublicKey(String(trustedKey.publicKeyPem || ''));
      publicKeySpkiHashes.push(`sha256:${crypto.createHash('sha256')
        .update(publicKey.export({ type: 'spki', format: 'der' }))
        .digest('hex')}`);
    } catch {
      blockers.push('advanced_numerical_authority_public_key_identity_invalid');
    }
  }
  return Object.freeze({
    organizations: Object.freeze(organizations.sort()),
    publicKeySpkiHashes: Object.freeze(publicKeySpkiHashes.sort()),
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

function verifyEvidenceReceiptAuthority({
  receipt,
  trustStore,
  role,
  label,
  qualification,
  now,
} = {}) {
  const time = verifyAuthorityTimeWindow({
    signedAt: receipt?.signedAt,
    validFrom: receipt?.validFrom,
    expiresAt: receipt?.expiresAt,
    now,
    maximumLifetimeMs: MAXIMUM_QUALIFICATION_LIFETIME_MS,
  });
  const signatures = verifyAuthoritySignatures({
    document: receipt,
    trustStore,
    requiredRoles: [role],
    minSignatures: 1,
    requireDistinctSubjects: true,
  });
  const blockers = [
    ...prefixedBlockers(label, time.blockers),
    ...prefixedBlockers(label, signatures.blockers),
  ];
  const qualificationSignedAtMs = Date.parse(String(qualification?.signedAt || ''));
  const qualificationExpiresAtMs = Date.parse(String(qualification?.expiresAt || ''));
  const evidenceInstantMs = Date.parse(String(receipt?.executedAt || receipt?.signedAt || ''));
  const evidenceSignedAtMs = Date.parse(String(receipt?.signedAt || ''));
  const evidenceExpiresAtMs = Date.parse(String(receipt?.expiresAt || ''));
  if (!Number.isFinite(qualificationSignedAtMs)
    || !Number.isFinite(evidenceInstantMs)
    || evidenceInstantMs > qualificationSignedAtMs
    || qualificationSignedAtMs - evidenceInstantMs > MAXIMUM_EVIDENCE_AGE_MS) {
    blockers.push(`${label}:advanced_numerical_qualification_evidence_not_current`);
  }
  if (!Number.isFinite(evidenceSignedAtMs)
    || evidenceSignedAtMs > qualificationSignedAtMs) {
    blockers.push(`${label}:advanced_numerical_qualification_evidence_signed_after_statement`);
  }
  if (!Number.isFinite(qualificationExpiresAtMs)
    || !Number.isFinite(evidenceExpiresAtMs)
    || evidenceExpiresAtMs < qualificationExpiresAtMs) {
    blockers.push(`${label}:advanced_numerical_qualification_evidence_expiry_not_covering_statement`);
  }
  return Object.freeze({
    blockers: Object.freeze([...new Set(blockers)]),
    verifiedSignatures: Object.freeze(signatures.verifiedSignatures),
    verifiedSubjectIds: Object.freeze(signatures.verifiedSubjectIds),
  });
}

export function verifyAdvancedNumericalPluginProductionQualification({
  descriptor,
  signedBundleHash,
  pluginAuthorityVerification,
  pluginTrustStore,
  qualification,
  evidenceBundle,
  trustStore,
  now = new Date(),
} = {}) {
  const blockers = [];
  if (!verifyAdvancedNumericalPluginQualificationStatement(qualification, {
    descriptor,
    signedBundleHash,
  })) {
    blockers.push('advanced_numerical_plugin_qualification_statement_invalid');
  }
  const time = verifyAuthorityTimeWindow({
    signedAt: qualification?.signedAt,
    validFrom: qualification?.validFrom,
    expiresAt: qualification?.expiresAt,
    now,
    maximumLifetimeMs: MAXIMUM_QUALIFICATION_LIFETIME_MS,
  });
  blockers.push(...time.blockers);
  const signatures = verifyAuthoritySignatures({
    document: qualification,
    trustStore,
    requiredRoles: ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_ROLES,
    minSignatures: ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_ROLES.length,
    requireDistinctSubjects: true,
  });
  blockers.push(...signatures.blockers);
  const pluginAuthoritySubjects = new Set(
    (pluginAuthorityVerification?.verifiedSignatures || [])
      .map((signature) => String(signature.subjectId || ''))
      .filter(Boolean),
  );
  if (pluginAuthorityVerification?.signatureVerified !== true
    || pluginAuthoritySubjects.size !== 1
    || pluginAuthorityVerification.verifiedSignatures.length !== 1) {
    blockers.push('advanced_numerical_plugin_authority_verification_required');
  }
  if (signatures.verifiedSubjectIds.some((subjectId) => (
    pluginAuthoritySubjects.has(subjectId)
  ))) {
    blockers.push('advanced_numerical_plugin_qualification_subject_independence_required');
  }
  const pluginControlIdentities = signerControlIdentities(
    pluginAuthorityVerification?.verifiedSignatures || [],
    pluginTrustStore,
  );
  const qualificationControlIdentities = signerControlIdentities(
    signatures.verifiedSignatures,
    trustStore,
  );
  blockers.push(
    ...pluginControlIdentities.blockers,
    ...qualificationControlIdentities.blockers,
  );
  const allOrganizations = [
    ...pluginControlIdentities.organizations,
    ...qualificationControlIdentities.organizations,
  ];
  const allPublicKeySpkiHashes = [
    ...pluginControlIdentities.publicKeySpkiHashes,
    ...qualificationControlIdentities.publicKeySpkiHashes,
  ];
  const requiredAuthorityCount =
    ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_ROLES.length + 1;
  if (allOrganizations.length !== requiredAuthorityCount
    || new Set(allOrganizations).size !== requiredAuthorityCount) {
    blockers.push(
      'advanced_numerical_plugin_qualification_organization_independence_required',
    );
  }
  if (allPublicKeySpkiHashes.length !== requiredAuthorityCount
    || new Set(allPublicKeySpkiHashes).size !== requiredAuthorityCount) {
    blockers.push(
      'advanced_numerical_plugin_qualification_public_key_independence_required',
    );
  }
  const evidenceBundleVerified =
    verifyAdvancedNumericalPluginQualificationEvidenceBundle(evidenceBundle, {
      descriptor,
      signedBundleHash,
      qualification,
    });
  if (!evidenceBundleVerified) {
    blockers.push('advanced_numerical_plugin_qualification_evidence_bundle_invalid');
  }
  const evidenceAuthorities = [];
  if (evidenceBundleVerified) {
    const evidenceSpecifications = Object.freeze([
      Object.freeze({
        label: 'reference_execution',
        receipt: evidenceBundle.referenceExecutionReceipt,
        role: PLUGIN_AUTHORITY_ROLE,
        trustStore: pluginTrustStore,
      }),
      Object.freeze({
        label: 'replay_execution',
        receipt: evidenceBundle.replayExecutionReceipt,
        role: 'advanced_numerical_replay_authority',
        trustStore,
      }),
      Object.freeze({
        label: 'numeric_oracle',
        receipt: evidenceBundle.independentNumericOracleReceipt,
        role: 'advanced_numerical_oracle_authority',
        trustStore,
      }),
      Object.freeze({
        label: 'typed_uncertainty_review',
        receipt: evidenceBundle.typedUncertaintyReviewReceipt,
        role: 'advanced_numerical_uncertainty_reviewer',
        trustStore,
      }),
      Object.freeze({
        label: 'scientific_review',
        receipt: evidenceBundle.scientificReviewReceipt,
        role: 'advanced_numerical_scientific_reviewer',
        trustStore,
      }),
    ]);
    for (const specification of evidenceSpecifications) {
      const verification = verifyEvidenceReceiptAuthority({
        ...specification,
        qualification,
        now,
      });
      blockers.push(...verification.blockers);
      evidenceAuthorities.push(Object.freeze({
        label: specification.label,
        role: specification.role,
        verifiedSubjectIds: verification.verifiedSubjectIds,
      }));
    }
    const statementSubjectByRole = new Map(
      signatures.verifiedSignatures.map((signature) => [
        signature.role,
        signature.subjectId,
      ]),
    );
    for (const authority of evidenceAuthorities) {
      if (authority.verifiedSubjectIds.length !== 1) {
        blockers.push(
          `advanced_numerical_${authority.label}_single_authority_subject_required`,
        );
        continue;
      }
      const [subjectId] = authority.verifiedSubjectIds;
      if (authority.role === PLUGIN_AUTHORITY_ROLE) {
        if (!pluginAuthoritySubjects.has(subjectId)) {
          blockers.push(
            'advanced_numerical_reference_execution_plugin_authority_binding_invalid',
          );
        }
      } else if (statementSubjectByRole.get(authority.role) !== subjectId) {
        blockers.push(
          `advanced_numerical_${authority.label}_statement_authority_binding_invalid`,
        );
      }
    }
  }
  if (blockers.length) {
    throw new Error(
      `advanced_numerical_plugin_production_qualification_invalid:${[
        ...new Set(blockers),
      ].sort().join(',')}`,
    );
  }
  const gpuRuntimeAuthority = descriptor.version === 2
    ? buildAdvancedNumericalGpuRuntimeAuthority(descriptor) : null;
  const payload = Object.freeze({
    version: gpuRuntimeAuthority ? 3 : 2,
    kind: 'AdvancedNumericalPluginProductionQualificationInspection',
    status: 'advanced_numerical_plugin_production_qualified',
    productionQualified: true,
    pluginId: descriptor.pluginId,
    pluginVersion: descriptor.pluginVersion,
    analysisFamily: descriptor.analysisFamily,
    descriptorHash: descriptor.advancedNumericalPluginDescriptorHash,
    signedBundleHash,
    qualificationStatementHash:
      qualification.advancedNumericalPluginQualificationStatementHash,
    qualificationEvidenceBundleHash:
      evidenceBundle.advancedNumericalPluginQualificationEvidenceBundleHash,
    pluginAuthoritySubjectIds: Object.freeze([...pluginAuthoritySubjects].sort()),
    pluginAuthorityOrganizations: pluginControlIdentities.organizations,
    pluginAuthorityPublicKeySpkiHashes:
      pluginControlIdentities.publicKeySpkiHashes,
    qualificationAuthoritySubjectIds:
      Object.freeze([...signatures.verifiedSubjectIds].sort()),
    qualificationAuthorityOrganizations:
      qualificationControlIdentities.organizations,
    qualificationAuthorityPublicKeySpkiHashes:
      qualificationControlIdentities.publicKeySpkiHashes,
    qualificationAuthorityRoles:
      Object.freeze([...signatures.verifiedRoles].sort()),
    signedAt: time.signedAt,
    validFrom: time.validFrom,
    expiresAt: time.expiresAt,
    requestCorpusHash: evidenceBundle.referenceExecutionReceipt.requestCorpusHash,
    resultHash: evidenceBundle.referenceExecutionReceipt.resultHash,
    referenceExecutionProcessIdentityHash:
      evidenceBundle.referenceExecutionReceipt.executionProcessIdentityHash,
    replayExecutionProcessIdentityHash:
      evidenceBundle.replayExecutionReceipt.executionProcessIdentityHash,
    ...(gpuRuntimeAuthority ? {
      gpuRuntimeAuthority,
      gpuRuntimeAuthorityHash:
        gpuRuntimeAuthority.advancedNumericalGpuRuntimeAuthorityHash,
    } : {}),
    evidenceReceiptHashes: Object.freeze({
      independentNumericOracleReceiptHash:
        evidenceBundle.independentNumericOracleReceipt
          .advancedNumericalOracleQualificationReceiptHash,
      referenceExecutionReceiptHash:
        evidenceBundle.referenceExecutionReceipt
          .advancedNumericalQualificationExecutionReceiptHash,
      replayExecutionReceiptHash:
        evidenceBundle.replayExecutionReceipt
          .advancedNumericalQualificationExecutionReceiptHash,
      scientificReviewReceiptHash:
        evidenceBundle.scientificReviewReceipt
          .advancedNumericalScientificReviewQualificationReceiptHash,
      typedUncertaintyReviewReceiptHash:
        evidenceBundle.typedUncertaintyReviewReceipt
          .advancedNumericalUncertaintyQualificationReceiptHash,
    }),
  });
  return Object.freeze({
    ...payload,
    advancedNumericalPluginProductionQualificationInspectionHash: hashRecord(
      'AdvancedNumericalPluginProductionQualificationInspection',
      payload,
    ),
  });
}
