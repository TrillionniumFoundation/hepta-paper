import {
  GPU_SCIENTIFIC_CAMPAIGN_AUTHORITY_MAXIMUM_LIFETIME_MS,
  GPU_SCIENTIFIC_PRODUCTION_QUALIFICATION_AUTHORITY_ROLE,
  GPU_SCIENTIFIC_SAME_DEVICE_REPLAY_AUTHORITY_ROLE,
  verifyGpuScientificCampaignQualificationEvidence,
} from '../../paper-domain/automation/gpu-scientific-campaign-promotion-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAuthoritySignatures,
  verifyAuthorityTimeWindow,
} from '../authority/authority-signatures.mjs';
import {
  readAutonomousResearchAuthorIdentityConfiguration,
} from './autonomous-research-author-identity-configuration.mjs';
import {
  verifyExternalPrincipalIdentityAttestationSubject,
} from '../../paper-domain/evidence/external-principal-identity-attestation-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function canonicalOrganization(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function prefixed(label, blockers) {
  return blockers.map((blocker) => `${label}:${blocker}`);
}

function verifySignedAuthority({
  document,
  trustStore,
  role,
  label,
  now,
} = {}) {
  const time = verifyAuthorityTimeWindow({
    signedAt: document?.signedAt,
    validFrom: document?.validFrom,
    expiresAt: document?.expiresAt,
    now,
    maximumLifetimeMs:
      GPU_SCIENTIFIC_CAMPAIGN_AUTHORITY_MAXIMUM_LIFETIME_MS,
  });
  const signatures = verifyAuthoritySignatures({
    document,
    trustStore,
    requiredRoles: [role],
    minSignatures: 1,
    requireDistinctSubjects: true,
  });
  const exactSignature = Array.isArray(document?.signatures)
    && document.signatures.length === 1
    && signatures.verifiedSignatures.length === 1
    && signatures.verifiedSignatures[0].role === role;
  const verified = exactSignature ? signatures.verifiedSignatures[0] : null;
  const trustedKey = verified
    ? (trustStore?.keys || []).find((key) => key?.keyId === verified.keyId)
    : null;
  const organization = canonicalOrganization(verified?.organization);
  const publicKeySpkiSha256 = verified?.publicKeySpkiSha256 || null;
  const processIdentityHash = String(
    trustedKey?.processIdentityHash || '',
  ).toLowerCase();
  const blockers = [
    ...prefixed(label, time.blockers),
    ...prefixed(label, signatures.blockers),
    ...(!exactSignature ? [`${label}:exactly_one_authority_signature_required`] : []),
    ...(!organization ? [`${label}:authority_organization_required`] : []),
    ...(!SHA256.test(String(publicKeySpkiSha256 || ''))
      ? [`${label}:authority_public_key_identity_required`] : []),
    ...(!SHA256.test(processIdentityHash)
      ? [`${label}:authority_process_identity_required`] : []),
  ];
  return Object.freeze({
    valid: blockers.length === 0,
    keyId: blockers.length ? null : document.signatures[0].keyId,
    subjectId: blockers.length ? null : verified.subjectId,
    organization: blockers.length ? null : organization,
    publicKeySpkiSha256: blockers.length ? null : publicKeySpkiSha256,
    processIdentityHash: blockers.length ? null : processIdentityHash,
    signedAt: blockers.length ? null : time.signedAt,
    validFrom: blockers.length ? null : time.validFrom,
    expiresAt: blockers.length ? null : time.expiresAt,
    blockers: Object.freeze(unique(blockers)),
  });
}

function forbiddenIdentityBlockers(identity, {
  forbiddenSubjectIds = [],
  forbiddenOrganizations = [],
  forbiddenPublicKeySpkiHashes = [],
  forbiddenProcessIdentityHashes = [],
} = {}, label) {
  const blockedSubjects = new Set(forbiddenSubjectIds.map(String));
  const blockedOrganizations = new Set(
    forbiddenOrganizations.map(canonicalOrganization).filter(Boolean),
  );
  const blockedKeys = new Set(
    forbiddenPublicKeySpkiHashes.map((value) => String(value).toLowerCase()),
  );
  const blockedProcesses = new Set(
    forbiddenProcessIdentityHashes.map((value) => String(value).toLowerCase()),
  );
  return [
    ...(identity.subjectId && blockedSubjects.has(identity.subjectId)
      ? [`${label}:authority_subject_not_independent`] : []),
    ...(identity.organization && blockedOrganizations.has(identity.organization)
      ? [`${label}:authority_organization_not_independent`] : []),
    ...(identity.publicKeySpkiSha256
      && blockedKeys.has(identity.publicKeySpkiSha256.toLowerCase())
      ? [`${label}:authority_public_key_not_independent`] : []),
    ...(identity.processIdentityHash
      && blockedProcesses.has(identity.processIdentityHash.toLowerCase())
      ? [`${label}:authority_process_not_independent`] : []),
  ];
}

export function verifyGpuScientificCampaignQualificationEvidenceAuthority({
  qualificationEvidence,
  trustStore,
  now = new Date(),
  forbiddenSubjectIds = [],
  forbiddenOrganizations = [],
  forbiddenPublicKeySpkiHashes = [],
  forbiddenProcessIdentityHashes = [],
  forbiddenIdentityContextRequired = false,
  forbiddenIdentityContextReady = false,
  forbiddenIdentityContextBlockers = [],
} = {}) {
  const blockers = [];
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) {
    blockers.push('gpu_scientific_campaign_authority_verification_time_invalid');
  }
  const structureValid = verifyGpuScientificCampaignQualificationEvidence(
    qualificationEvidence,
  );
  if (!structureValid) {
    blockers.push('gpu_scientific_campaign_qualification_evidence_invalid');
  }
  if (forbiddenIdentityContextRequired
    && forbiddenIdentityContextReady !== true) {
    blockers.push('gpu_scientific_campaign_forbidden_identity_context_required');
    blockers.push(...prefixed(
      'forbidden_identity_context',
      forbiddenIdentityContextBlockers.length
        ? forbiddenIdentityContextBlockers
        : ['unavailable'],
    ));
  }
  const replayReceipt = qualificationEvidence
    ?.gpuScientificCampaignSameDeviceReplayReceipt || null;
  const productionAuthority = qualificationEvidence
    ?.gpuScientificCampaignProductionQualificationAuthority || null;
  const replay = verifySignedAuthority({
    document: replayReceipt,
    trustStore,
    role: GPU_SCIENTIFIC_SAME_DEVICE_REPLAY_AUTHORITY_ROLE,
    label: 'same_device_replay',
    now,
  });
  const production = verifySignedAuthority({
    document: productionAuthority,
    trustStore,
    role: GPU_SCIENTIFIC_PRODUCTION_QUALIFICATION_AUTHORITY_ROLE,
    label: 'production_qualification',
    now,
  });
  blockers.push(...replay.blockers, ...production.blockers);
  if (replay.valid && production.valid) {
    if (replay.keyId === production.keyId) {
      blockers.push('gpu_scientific_campaign_authority_key_independence_required');
    }
    if (replay.subjectId === production.subjectId) {
      blockers.push('gpu_scientific_campaign_authority_subject_independence_required');
    }
    if (replay.organization === production.organization) {
      blockers.push(
        'gpu_scientific_campaign_authority_organization_independence_required',
      );
    }
    if (replay.publicKeySpkiSha256 === production.publicKeySpkiSha256) {
      blockers.push(
        'gpu_scientific_campaign_authority_public_key_independence_required',
      );
    }
    if (replay.processIdentityHash === production.processIdentityHash) {
      blockers.push(
        'gpu_scientific_campaign_authority_process_independence_required',
      );
    }
    const replaySignedAtMs = Date.parse(replay.signedAt);
    const productionSignedAtMs = Date.parse(production.signedAt);
    const replayExpiresAtMs = Date.parse(replay.expiresAt);
    const productionExpiresAtMs = Date.parse(production.expiresAt);
    if (productionSignedAtMs < replaySignedAtMs
      || productionExpiresAtMs > replayExpiresAtMs) {
      blockers.push('gpu_scientific_campaign_authority_time_binding_invalid');
    }
  }
  const forbidden = {
    forbiddenSubjectIds,
    forbiddenOrganizations,
    forbiddenPublicKeySpkiHashes,
    forbiddenProcessIdentityHashes: unique([
      ...forbiddenProcessIdentityHashes,
      ...Object.values(qualificationEvidence
        ?.gpuScientificCampaignQualificationRequest
        ?.originalExecutionProcessIdentityHashes || {}),
    ]),
  };
  blockers.push(
    ...forbiddenIdentityBlockers(replay, forbidden, 'same_device_replay'),
    ...forbiddenIdentityBlockers(
      production,
      forbidden,
      'production_qualification',
    ),
  );
  const uniqueBlockers = Object.freeze(unique(blockers));
  const payload = {
    version: 1,
    kind: 'GpuScientificCampaignQualificationAuthorityInspection',
    status: uniqueBlockers.length
      ? 'gpu_scientific_campaign_qualification_authority_blocked'
      : 'gpu_scientific_campaign_qualification_authority_verified',
    valid: uniqueBlockers.length === 0,
    structureVerified: structureValid,
    cryptographicSignaturesVerified:
      uniqueBlockers.length === 0 && replay.valid && production.valid,
    authorityIdentityIndependenceVerified:
      uniqueBlockers.length === 0 && replay.valid && production.valid,
    qualificationEvidenceHash: structureValid
      ? qualificationEvidence.gpuScientificCampaignQualificationEvidenceHash
      : null,
    replayAuthoritySubjectId: replay.valid ? replay.subjectId : null,
    replayAuthorityOrganization: replay.valid ? replay.organization : null,
    replayAuthorityPublicKeySpkiSha256:
      replay.valid ? replay.publicKeySpkiSha256 : null,
    replayAuthorityProcessIdentityHash:
      replay.valid ? replay.processIdentityHash : null,
    productionQualificationAuthoritySubjectId:
      production.valid ? production.subjectId : null,
    productionQualificationAuthorityOrganization:
      production.valid ? production.organization : null,
    productionQualificationAuthorityPublicKeySpkiSha256:
      production.valid ? production.publicKeySpkiSha256 : null,
    productionQualificationAuthorityProcessIdentityHash:
      production.valid ? production.processIdentityHash : null,
    externalActionPerformed:
      qualificationEvidence?.externalActionPerformed === true,
    blockers: uniqueBlockers,
  };
  return Object.freeze({
    ...payload,
    gpuScientificCampaignQualificationAuthorityInspectionHash: hashRecord(
      'GpuScientificCampaignQualificationAuthorityInspection',
      payload,
    ),
  });
}

export function createGpuScientificCampaignForbiddenIdentityProvider({
  environment = process.env,
  clock = null,
} = {}) {
  return Object.freeze(({ observedAt: suppliedObservedAt = null } = {}) => {
    const configPath = String(
      environment.HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG || '',
    ).trim();
    const expectedConfigurationHash = String(
      environment.HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH || '',
    ).trim().toLowerCase();
    if (!configPath || !SHA256.test(expectedConfigurationHash)) {
      throw new Error(
        'gpu_scientific_campaign_author_identity_configuration_required',
      );
    }
    const configuration = readAutonomousResearchAuthorIdentityConfiguration({
      configPath,
      expectedConfigurationHash,
    });
    const subject = configuration.subject;
    const now = suppliedObservedAt
      ?? (clock?.now ? clock.now() : new Date());
    if (!verifyExternalPrincipalIdentityAttestationSubject(subject, {
      now,
      maximumLifetimeMs: configuration.maximumLifetimeMs,
      requirePlatformAttestation: true,
    })) {
      throw new Error(
        'gpu_scientific_campaign_author_identity_context_invalid',
      );
    }
    return Object.freeze({
      identityContextReady: true,
      forbiddenSubjectIds: Object.freeze([subject.principalId]),
      forbiddenOrganizations: Object.freeze([]),
      forbiddenPublicKeySpkiHashes: Object.freeze([
        subject.signerPublicKeySpkiHash,
      ]),
      forbiddenProcessIdentityHashes: Object.freeze([
        subject.processIdentityHash,
      ]),
      blockers: Object.freeze([]),
    });
  });
}

export function createGpuScientificCampaignPromotionAuthorityVerifier({
  trustStoreProvider,
  clock = null,
  forbiddenIdentityProvider = null,
} = {}) {
  if (typeof trustStoreProvider !== 'function') {
    throw new Error('gpu_scientific_campaign_authority_trust_store_provider_required');
  }
  if (forbiddenIdentityProvider !== null
    && typeof forbiddenIdentityProvider !== 'function') {
    throw new Error('gpu_scientific_campaign_forbidden_identity_provider_invalid');
  }
  function verificationContext({ qualificationEvidence, observedAt }) {
    let forbidden = {};
    const forbiddenIdentityContextBlockers = [];
    if (forbiddenIdentityProvider) {
      try {
        forbidden = forbiddenIdentityProvider({
          qualificationEvidence,
          observedAt,
        }) || {};
      } catch (error) {
        forbiddenIdentityContextBlockers.push(
          String(error?.message || 'provider_failed'),
        );
      }
    }
    return { forbidden, forbiddenIdentityContextBlockers };
  }
  function verifyWithTrustStore({
    qualificationEvidence,
    trustStore,
    observedAt,
    forbidden,
    forbiddenIdentityContextBlockers,
  }) {
    return verifyGpuScientificCampaignQualificationEvidenceAuthority({
      qualificationEvidence,
      trustStore,
      now: observedAt,
      forbiddenSubjectIds: forbidden.forbiddenSubjectIds || [],
      forbiddenOrganizations: forbidden.forbiddenOrganizations || [],
      forbiddenPublicKeySpkiHashes:
        forbidden.forbiddenPublicKeySpkiHashes || [],
      forbiddenProcessIdentityHashes:
        forbidden.forbiddenProcessIdentityHashes || [],
      forbiddenIdentityContextRequired:
        forbiddenIdentityProvider !== null,
      forbiddenIdentityContextReady:
        forbidden.identityContextReady === true,
      forbiddenIdentityContextBlockers: [
        ...forbiddenIdentityContextBlockers,
        ...(forbidden.blockers || []),
      ],
    });
  }
  function externalTrustMismatchInspection(inspection) {
    const {
      gpuScientificCampaignQualificationAuthorityInspectionHash: ignoredHash,
      ...inspectionPayload
    } = inspection || {};
    const payload = {
      ...inspectionPayload,
      status: 'gpu_scientific_campaign_qualification_authority_blocked',
      valid: false,
      cryptographicSignaturesVerified: false,
      authorityIdentityIndependenceVerified: false,
      blockers: Object.freeze(unique([
        ...(inspection?.blockers || []),
        'gpu_scientific_campaign_release_snapshot_external_trust_mismatch',
      ])),
    };
    return Object.freeze({
      ...payload,
      gpuScientificCampaignQualificationAuthorityInspectionHash: hashRecord(
        'GpuScientificCampaignQualificationAuthorityInspection',
        payload,
      ),
    });
  }
  function observedAtFor(suppliedObservedAt) {
    return suppliedObservedAt ?? (clock?.now ? clock.now() : new Date());
  }
  return Object.freeze({
    version: 1,
    kind: 'GpuScientificCampaignPromotionAuthorityVerifier',
    verify({
      qualificationEvidence,
      trustStore: suppliedTrustStore = null,
      observedAt: suppliedObservedAt = null,
    } = {}) {
      const observedAt = observedAtFor(suppliedObservedAt);
      const context = verificationContext({ qualificationEvidence, observedAt });
      return verifyWithTrustStore({
        qualificationEvidence,
        trustStore: suppliedTrustStore
          ?? trustStoreProvider({ qualificationEvidence }),
        observedAt,
        ...context,
      });
    },
    verifyReleaseSnapshot({
      qualificationEvidence,
      trustStore,
      observedAt: suppliedObservedAt = null,
    } = {}) {
      const observedAt = observedAtFor(suppliedObservedAt);
      const context = verificationContext({ qualificationEvidence, observedAt });
      const snapshotInspection = verifyWithTrustStore({
        qualificationEvidence,
        trustStore,
        observedAt,
        ...context,
      });
      const currentTrustInspection = verifyWithTrustStore({
        qualificationEvidence,
        trustStore: trustStoreProvider({ qualificationEvidence }),
        observedAt,
        ...context,
      });
      return JSON.stringify(snapshotInspection) === JSON.stringify(currentTrustInspection)
        ? snapshotInspection
        : externalTrustMismatchInspection(snapshotInspection);
    },
  });
}
