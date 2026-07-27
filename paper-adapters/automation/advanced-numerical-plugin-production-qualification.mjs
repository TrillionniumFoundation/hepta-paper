import {
  ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_ROLES,
  verifyAdvancedNumericalPluginQualificationStatement,
} from '../../paper-domain/research/advanced-numerical-plugin-qualification-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAuthoritySignatures,
  verifyAuthorityTimeWindow,
} from '../authority/authority-signatures.mjs';

const MAXIMUM_QUALIFICATION_LIFETIME_MS = 366 * 24 * 60 * 60 * 1_000;

export function verifyAdvancedNumericalPluginProductionQualification({
  descriptor,
  signedBundleHash,
  pluginAuthorityVerification,
  qualification,
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
    || pluginAuthoritySubjects.size < 1) {
    blockers.push('advanced_numerical_plugin_authority_verification_required');
  }
  if (signatures.verifiedSubjectIds.some((subjectId) => (
    pluginAuthoritySubjects.has(subjectId)
  ))) {
    blockers.push('advanced_numerical_plugin_qualification_subject_independence_required');
  }
  if (blockers.length) {
    throw new Error(
      `advanced_numerical_plugin_production_qualification_invalid:${[
        ...new Set(blockers),
      ].sort().join(',')}`,
    );
  }
  const payload = Object.freeze({
    version: 1,
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
    pluginAuthoritySubjectIds: Object.freeze([...pluginAuthoritySubjects].sort()),
    qualificationAuthoritySubjectIds:
      Object.freeze([...signatures.verifiedSubjectIds].sort()),
    qualificationAuthorityRoles:
      Object.freeze([...signatures.verifiedRoles].sort()),
    signedAt: time.signedAt,
    validFrom: time.validFrom,
    expiresAt: time.expiresAt,
  });
  return Object.freeze({
    ...payload,
    advancedNumericalPluginProductionQualificationInspectionHash: hashRecord(
      'AdvancedNumericalPluginProductionQualificationInspection',
      payload,
    ),
  });
}
