import path from 'node:path';

import {
  readAdvancedNumericalPluginRuntimeConfiguration,
  readIntegrityAdvancedNumericalJsonDocument,
} from '../../paper-adapters/automation/advanced-numerical-plugin-runtime-configuration.mjs';
import {
  ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_ROLES,
} from '../../paper-domain/research/advanced-numerical-plugin-qualification-contract.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  composeAdvancedNumericalPluginRuntime,
} from './advanced-numerical-plugin-composition.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const REGISTRY_KEYS = Object.freeze([
  'candidateManifestHash',
  'candidateSourceMerkleHash',
  'candidateSourceWorkspaceManifestHash',
  'entries',
  'kind',
  'version',
]);
const ENTRY_KEYS = Object.freeze([
  'analysisFamily',
  'runtimeConfigurationHash',
  'runtimeConfigurationPath',
]);
const REQUIRED_QUALIFICATION_ROLES = Object.freeze(
  [...ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_ROLES].sort(),
);
const REQUIRED_EVIDENCE_RECEIPT_HASH_FIELDS = Object.freeze([
  'independentNumericOracleReceiptHash',
  'referenceExecutionReceiptHash',
  'replayExecutionReceiptHash',
  'scientificReviewReceiptHash',
  'typedUncertaintyReviewReceiptHash',
]);

function configuredPath(configDirectory, value) {
  const selected = String(value || '').trim();
  if (!selected) throw new Error('advanced_numerical_plugin_configuration_path_required');
  return path.resolve(configDirectory, selected);
}

function baseCandidate({
  analysisFamily,
  candidateManifest,
  candidateManifestHash,
  candidateSnapshot,
  entrypointHash,
  registryConfigured = false,
  registryPinned = false,
  registryHash = null,
  blockers = [],
}) {
  return Object.freeze({
    pluginId: `hepta.reference.${analysisFamily}`,
    pluginVersion: '1.0.0',
    analysisFamily,
    status: 'reference_candidate_unqualified',
    productionQualified: false,
    fullProductionReady: false,
    registryConfigured,
    registryPinned,
    registryHash,
    runtimeConfigurationPinned: false,
    runtimeConfigurationHash: null,
    dependentDocumentsPinned: false,
    entrypoint: candidateManifest.entrypoint,
    entrypointHash,
    sourceMerkleHash: candidateSnapshot.merkleHash,
    sourceWorkspaceManifestHash: candidateSnapshot.manifestHash,
    candidateManifestHash,
    runtimeExecutableHash: null,
    runtimePackageClosureHash: null,
    signedBundleHash: null,
    qualificationStatementHash: null,
    qualificationEvidenceBundleHash: null,
    qualificationInspectionHash: null,
    qualificationExpiresAt: null,
    pluginAuthoritySubjectIds: Object.freeze([]),
    pluginAuthorityOrganizations: Object.freeze([]),
    pluginAuthorityPublicKeySpkiHashes: Object.freeze([]),
    qualificationAuthoritySubjectIds: Object.freeze([]),
    qualificationAuthorityOrganizations: Object.freeze([]),
    qualificationAuthorityPublicKeySpkiHashes: Object.freeze([]),
    qualificationAuthorityRoles: Object.freeze([]),
    evidenceReceiptHashes: null,
    referenceExecutionProcessIdentityHash: null,
    replayExecutionProcessIdentityHash: null,
    qualificationResultHash: null,
    qualificationBlockers: Object.freeze([...new Set(blockers)].sort()),
  });
}

function blockedCandidate(candidate, blocker, details = {}) {
  return Object.freeze({
    ...candidate,
    ...details,
    status: 'reference_candidate_unqualified',
    productionQualified: false,
    fullProductionReady: false,
    qualificationBlockers: Object.freeze([
      ...new Set([
        ...(candidate.qualificationBlockers || []),
        String(blocker || 'advanced_numerical_reference_qualification_blocked'),
      ]),
    ].sort()),
  });
}

function uniqueNonemptyStrings(values, minimumLength) {
  return Array.isArray(values)
    && values.length >= minimumLength
    && values.every((value) => typeof value === 'string' && value.length > 0)
    && new Set(values).size === values.length;
}

function capabilitiesValid(capabilities, {
  qualification,
  qualificationEvidence,
  now,
} = {}) {
  const qualificationSubjects = capabilities?.qualificationAuthoritySubjectIds;
  const pluginSubjects = capabilities?.pluginAuthoritySubjectIds;
  const qualificationOrganizations =
    capabilities?.qualificationAuthorityOrganizations;
  const pluginOrganizations = capabilities?.pluginAuthorityOrganizations;
  const qualificationPublicKeys =
    capabilities?.qualificationAuthorityPublicKeySpkiHashes;
  const evidenceReceiptHashes = capabilities?.evidenceReceiptHashes;
  const evidenceReceiptHashValues = REQUIRED_EVIDENCE_RECEIPT_HASH_FIELDS
    .map((field) => evidenceReceiptHashes?.[field]);
  const pluginPublicKeys = capabilities?.pluginAuthorityPublicKeySpkiHashes;
  const expiresAtMs = Date.parse(String(capabilities?.qualificationExpiresAt || ''));
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ''));
  const pluginSubjectSet = new Set(pluginSubjects || []);
  const pluginOrganizationSet = new Set(pluginOrganizations || []);
  const pluginPublicKeySet = new Set(pluginPublicKeys || []);
  return capabilities?.productionQualified === true
    && SHA256.test(String(capabilities.qualificationInspectionHash || ''))
    && capabilities.qualificationStatementHash
      === qualification?.advancedNumericalPluginQualificationStatementHash
    && capabilities.qualificationEvidenceBundleHash
      === qualificationEvidence
        ?.advancedNumericalPluginQualificationEvidenceBundleHash
    && uniqueNonemptyStrings(pluginSubjects, 1)
    && uniqueNonemptyStrings(
      qualificationSubjects,
      ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_ROLES.length,
    )
    && qualificationSubjects.length
      === ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_ROLES.length
    && qualificationSubjects.every((subjectId) => !pluginSubjectSet.has(subjectId))
    && uniqueNonemptyStrings(pluginOrganizations, 1)
    && pluginOrganizations.length === 1
    && uniqueNonemptyStrings(
      qualificationOrganizations,
      ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_ROLES.length,
    )
    && qualificationOrganizations.length
      === ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_ROLES.length
    && qualificationOrganizations.every((organization) => (
      !pluginOrganizationSet.has(organization)
    ))
    && uniqueNonemptyStrings(pluginPublicKeys, 1)
    && pluginPublicKeys.length === 1
    && pluginPublicKeys.every((publicKeyHash) => SHA256.test(publicKeyHash))
    && uniqueNonemptyStrings(
      qualificationPublicKeys,
      ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_ROLES.length,
    )
    && qualificationPublicKeys.length
      === ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_ROLES.length
    && qualificationPublicKeys.every((publicKeyHash) => (
      SHA256.test(publicKeyHash) && !pluginPublicKeySet.has(publicKeyHash)
    ))
    && JSON.stringify(capabilities.qualificationAuthorityRoles)
      === JSON.stringify(REQUIRED_QUALIFICATION_ROLES)
    && evidenceReceiptHashes !== null
    && typeof evidenceReceiptHashes === 'object'
    && !Array.isArray(evidenceReceiptHashes)
    && JSON.stringify(Object.keys(evidenceReceiptHashes).sort())
      === JSON.stringify([...REQUIRED_EVIDENCE_RECEIPT_HASH_FIELDS].sort())
    && evidenceReceiptHashValues.every((value) => SHA256.test(String(value || '')))
    && new Set(evidenceReceiptHashValues).size
      === REQUIRED_EVIDENCE_RECEIPT_HASH_FIELDS.length
    && Number.isFinite(nowMs) && Number.isFinite(expiresAtMs) && expiresAtMs > nowMs
    && SHA256.test(String(
      capabilities.referenceExecutionProcessIdentityHash || '',
    ))
    && SHA256.test(String(
      capabilities.replayExecutionProcessIdentityHash || '',
    ))
    && capabilities.referenceExecutionProcessIdentityHash
      !== capabilities.replayExecutionProcessIdentityHash
    && SHA256.test(String(capabilities.qualificationResultHash || ''));
}

function inspectEntry({
  candidate,
  candidateRoot,
  entry,
  now,
  registryPath,
  registryHash,
  runtimeComposer,
}) {
  if (!hasExactObjectKeys(entry, ENTRY_KEYS)
    || entry.analysisFamily !== candidate.analysisFamily
    || !SHA256.test(String(entry.runtimeConfigurationHash || ''))) {
    throw new Error('advanced_numerical_reference_qualification_registry_entry_invalid');
  }
  const registryDirectory = path.dirname(registryPath);
  const runtimeConfiguration = readAdvancedNumericalPluginRuntimeConfiguration({
    configurationPath: configuredPath(
      registryDirectory,
      entry.runtimeConfigurationPath,
    ),
    expectedConfigurationHash: entry.runtimeConfigurationHash,
    requireProductionQualification: true,
  });
  const {
    bundle,
    trustStore,
    qualification,
    qualificationEvidence,
    qualificationTrustStore,
    pluginRoot,
    outputRoot,
  } = runtimeConfiguration;
  const runtime = runtimeComposer({
    bundle,
    trustStore,
    qualification,
    qualificationEvidence,
    qualificationTrustStore,
    pluginRoot,
    outputRoot,
    now,
  });
  const capabilities = runtime.runner.capabilities();
  const descriptor = runtime.descriptor;
  if (path.resolve(pluginRoot) !== path.resolve(candidateRoot)
    || descriptor.pluginId !== candidate.pluginId
    || descriptor.pluginVersion !== candidate.pluginVersion
    || descriptor.analysisFamily !== candidate.analysisFamily
    || descriptor.entrypoint.relativePath !== candidate.entrypoint
    || descriptor.entrypoint.sha256 !== candidate.entrypointHash
    || descriptor.sourceIdentity.merkleHash !== candidate.sourceMerkleHash
    || descriptor.sourceIdentity.workspaceManifestHash
      !== candidate.sourceWorkspaceManifestHash
    || runtimeConfiguration.configurationPinned !== true
    || runtimeConfiguration.dependentDocumentsPinned !== true
    || !capabilitiesValid(capabilities, {
      qualification,
      qualificationEvidence,
      now,
    })) {
    throw new Error('advanced_numerical_reference_qualification_identity_mismatch');
  }
  return Object.freeze({
    ...candidate,
    status: 'reference_candidate_full_production_qualified',
    productionQualified: true,
    fullProductionReady: true,
    registryConfigured: true,
    registryPinned: true,
    registryHash,
    runtimeConfigurationPinned: true,
    runtimeConfigurationHash: runtimeConfiguration.configurationHash,
    dependentDocumentsPinned: true,
    runtimeExecutableHash: descriptor.runtime.executableHash,
    runtimePackageClosureHash: descriptor.runtime.packageClosureHash,
    signedBundleHash: runtime.verifiedBundle.signedBundleHash,
    qualificationStatementHash: capabilities.qualificationStatementHash,
    qualificationEvidenceBundleHash:
      capabilities.qualificationEvidenceBundleHash,
    qualificationInspectionHash: capabilities.qualificationInspectionHash,
    qualificationExpiresAt: capabilities.qualificationExpiresAt,
    pluginAuthoritySubjectIds:
      Object.freeze([...capabilities.pluginAuthoritySubjectIds]),
    pluginAuthorityOrganizations:
      Object.freeze([...capabilities.pluginAuthorityOrganizations]),
    pluginAuthorityPublicKeySpkiHashes:
      Object.freeze([...capabilities.pluginAuthorityPublicKeySpkiHashes]),
    qualificationAuthoritySubjectIds:
      Object.freeze([...capabilities.qualificationAuthoritySubjectIds]),
    qualificationAuthorityOrganizations:
      Object.freeze([...capabilities.qualificationAuthorityOrganizations]),
    qualificationAuthorityPublicKeySpkiHashes:
      Object.freeze([
        ...capabilities.qualificationAuthorityPublicKeySpkiHashes,
      ]),
    qualificationAuthorityRoles:
      Object.freeze([...capabilities.qualificationAuthorityRoles]),
    evidenceReceiptHashes: Object.freeze({
      ...(capabilities.evidenceReceiptHashes || {}),
    }),
    referenceExecutionProcessIdentityHash:
      capabilities.referenceExecutionProcessIdentityHash,
    replayExecutionProcessIdentityHash:
      capabilities.replayExecutionProcessIdentityHash,
    qualificationResultHash: capabilities.qualificationResultHash,
    qualificationBlockers: Object.freeze([]),
  });
}

export function inspectAdvancedNumericalReferenceCandidateQualifications({
  candidateRoot,
  candidateManifest,
  candidateSnapshot,
  entrypointHash,
  registryPath = null,
  registryHash = null,
  now = new Date(),
  runtimeComposer = composeAdvancedNumericalPluginRuntime,
} = {}) {
  const candidateManifestHash = hashRecord(
    'AdvancedNumericalReferenceCandidateManifest',
    candidateManifest,
  );
  const buildBaseCandidates = ({
    registryConfigured = false,
    registryPinned = false,
    observedRegistryHash = null,
    blockers = [],
  } = {}) => Object.freeze(
    candidateManifest.analysisFamilies.map((analysisFamily) => baseCandidate({
      analysisFamily,
      candidateManifest,
      candidateManifestHash,
      candidateSnapshot,
      entrypointHash,
      registryConfigured,
      registryPinned,
      registryHash: observedRegistryHash,
      blockers,
    })),
  );
  if (!registryPath) {
    return buildBaseCandidates({
      blockers: [
        'advanced_numerical_reference_qualification_registry_path_required',
      ],
    });
  }
  if (!SHA256.test(String(registryHash || ''))) {
    return buildBaseCandidates({
      registryConfigured: true,
      blockers: [
        'advanced_numerical_reference_qualification_registry_pin_required',
      ],
    });
  }
  let registryRead;
  let registry;
  try {
    registryRead = readIntegrityAdvancedNumericalJsonDocument(
      path.resolve(registryPath),
      { expectedHash: registryHash },
    );
    registry = registryRead.value;
    if (!hasExactObjectKeys(registry, REGISTRY_KEYS)
      || registry.version !== 2
      || registry.kind
        !== 'AdvancedNumericalReferenceCandidateQualificationRegistry'
      || registry.candidateManifestHash !== candidateManifestHash
      || registry.candidateSourceMerkleHash !== candidateSnapshot.merkleHash
      || registry.candidateSourceWorkspaceManifestHash
        !== candidateSnapshot.manifestHash
      || !Array.isArray(registry.entries)
      || registry.entries.length !== candidateManifest.analysisFamilies.length) {
      throw new Error('advanced_numerical_reference_qualification_registry_invalid');
    }
    const families = registry.entries.map((entry) => entry?.analysisFamily);
    if (new Set(families).size !== candidateManifest.analysisFamilies.length
      || candidateManifest.analysisFamilies.some((analysisFamily) => (
        !families.includes(analysisFamily)
      ))) {
      throw new Error(
        'advanced_numerical_reference_qualification_registry_coverage_invalid',
      );
    }
  } catch (error) {
    return buildBaseCandidates({
      registryConfigured: true,
      blockers: [String(error?.message || error)],
    });
  }
  const baseCandidates = buildBaseCandidates({
    registryConfigured: true,
    registryPinned: true,
    observedRegistryHash: registryRead.fileHash,
  });
  return Object.freeze(baseCandidates.map((candidate) => {
    const entry = registry.entries.find((item) => (
      item.analysisFamily === candidate.analysisFamily
    ));
    try {
      return inspectEntry({
        candidate,
        candidateRoot,
        entry,
        now,
        registryPath: registryRead.path,
        registryHash: registryRead.fileHash,
        runtimeComposer,
      });
    } catch (error) {
      return blockedCandidate(candidate, String(error?.message || error), {
        registryConfigured: true,
        registryPinned: true,
        registryHash: registryRead.fileHash,
        runtimeConfigurationHash:
          SHA256.test(String(entry?.runtimeConfigurationHash || ''))
            ? entry.runtimeConfigurationHash : null,
      });
    }
  }));
}
