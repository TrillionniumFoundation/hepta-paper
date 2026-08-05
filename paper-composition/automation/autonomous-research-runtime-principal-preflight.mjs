import {
  preflightCodexResearchAuthor,
} from '../../paper-adapters/automation/codex-research-author-preflight.mjs';
import {
  preflightCodexFormalReviewer,
} from '../../paper-adapters/automation/codex-formal-reviewer-preflight.mjs';
import {
  preflightAutonomousEmpiricalRuntimes,
} from '../../paper-adapters/automation/autonomous-empirical-runtime-preflight.mjs';
import {
  preflightLocalOllamaResearchAgent,
} from '../../paper-adapters/automation/ollama-local-agent-preflight.mjs';
import {
  inspectAutonomousResearchAuthorIdentity,
  readAutonomousResearchAuthorIdentityConfiguration,
} from '../../paper-adapters/automation/autonomous-research-author-identity-configuration.mjs';
import {
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION,
} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';
import {
  buildResearchPrincipalDescriptor,
  buildResearchPrincipalPool,
} from '../../paper-domain/research/research-principal-pool-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  preflightReviewerPrincipalPool as defaultPreflightReviewerPrincipalPool,
} from './reviewer-principal-pool-composition.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function errorCode(error) {
  return String(error?.message || error || 'unknown_error').slice(0, 512);
}

export function autonomousResearchAuthorIdentitySubjectHash(inspection) {
  const subject = inspection?.subject || null;
  const candidate = String(
    subject?.externalPrincipalIdentityAttestationSubjectHash
      || subject?.autonomousResearchAuthorSessionIdentitySubjectHash
      || '',
  ).trim().toLowerCase();
  return SHA256.test(candidate) ? candidate : null;
}

function inspectAutonomousResearchAuthorSessionIdentity({ author } = {}) {
  const capability = author?.capabilityReceipt || null;
  const capabilityReceiptHash = String(
    capability?.codexResearchAuthorCapabilityReceiptHash || '',
  ).trim().toLowerCase();
  if (!author?.effectivePrincipalId || !SHA256.test(capabilityReceiptHash)
    || !SHA256.test(String(capability?.credentialRootIdentityHash || '').toLowerCase())
    || !SHA256.test(String(capability?.credentialConfigIdentityHash || '').toLowerCase())
    || capability?.provider !== 'openai'
    || capability?.status !== 'codex_research_author_capability_ready'
    || capability?.freshEphemeralSessionRequired !== true
    || capability?.priorAgentContextInheritanceForbidden !== true) {
    throw new Error('autonomous_research_author_session_identity_invalid');
  }
  const subjectPayload = {
    version: 1,
    kind: 'AutonomousResearchAuthorSessionIdentitySubject',
    status: 'autonomous_research_author_session_identity_bound',
    principalId: author.effectivePrincipalId,
    provider: capability.provider,
    model: capability.model,
    credentialRootIdentityHash: capability.credentialRootIdentityHash,
    credentialConfigIdentityHash: capability.credentialConfigIdentityHash,
    capabilityReceiptHash,
    freshEphemeralSessionRequired: true,
    priorAgentContextInheritanceForbidden: true,
  };
  const subject = Object.freeze({
    ...subjectPayload,
    autonomousResearchAuthorSessionIdentitySubjectHash: hashRecord(
      'AutonomousResearchAuthorSessionIdentitySubject',
      subjectPayload,
    ),
  });
  const policyPayload = {
    version: 1,
    kind: 'AutonomousResearchAuthorSessionIdentityPolicy',
    subjectHash: subject.autonomousResearchAuthorSessionIdentitySubjectHash,
    executorSessionMode: 'fresh-ephemeral-no-resume',
    authorContextInheritance: 'forbidden',
    frozenArtifactReviewRequired: true,
  };
  const configurationHash = hashRecord(
    'AutonomousResearchAuthorSessionIdentityPolicy',
    policyPayload,
  );
  const payload = {
    version: 1,
    kind: 'AutonomousResearchAuthorIdentityInspection',
    status: 'autonomous_research_author_session_identity_verified',
    ready: true,
    identityMode: 'fresh-ephemeral-session-policy',
    cryptographicAuthorityReady: false,
    identityIndependenceReferenceReady: true,
    sessionIsolationReady: true,
    configurationVersion: 1,
    stablePolicyPinned: false,
    stableIdentityPolicyHash: null,
    configurationPinned: true,
    expectedConfigurationHash: configurationHash,
    configurationHash,
    subject,
    authorityEnvelope: null,
    verificationReceipt: null,
    trustSetHash: hashRecord('AutonomousResearchAuthorSessionIdentityTrustSet', {
      capabilityReceiptHash,
      credentialRootIdentityHash: capability.credentialRootIdentityHash,
      credentialConfigIdentityHash: capability.credentialConfigIdentityHash,
    }),
    signatureVerificationPolicyHash: hashRecord(
      'AutonomousResearchAuthorSessionIdentityVerificationPolicy',
      {
        policy: 'capability-receipt-fresh-ephemeral-no-resume-v1',
        capabilityReceiptHash,
      },
    ),
  };
  return Object.freeze({
    ...payload,
    autonomousResearchAuthorIdentityInspectionHash: hashRecord(
      'AutonomousResearchAuthorIdentityInspection',
      payload,
    ),
  });
}

export function inspectConfiguredAutonomousResearchAuthorIdentity({
  environment = process.env,
  author,
  clock = { now: () => new Date() },
} = {}) {
  const configPath = String(
    environment.HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG || '',
  ).trim();
  const expectedConfigurationHash = String(
    environment.HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH || '',
  ).trim().toLowerCase();
  if (!configPath && !expectedConfigurationHash) return null;
  if (!configPath || !SHA256.test(expectedConfigurationHash)) {
    throw new Error('autonomous_research_author_identity_configuration_pin_invalid');
  }
  if (!author) {
    throw new Error('autonomous_research_author_identity_preflight_required');
  }
  return inspectAutonomousResearchAuthorIdentity({
    configuration: readAutonomousResearchAuthorIdentityConfiguration({
      configPath,
      expectedConfigurationHash,
    }),
    author,
    now: clock.now(),
    expectedConfigurationHash,
  });
}

export function inspectAutonomousResearchAuthorRuntimeIdentity(options = {}) {
  const configured = inspectConfiguredAutonomousResearchAuthorIdentity(options);
  return configured || inspectAutonomousResearchAuthorSessionIdentity(options);
}

function reviewerSessionCapability(reviewer) {
  const capability = reviewer?.capabilityReceipt || null;
  const capabilityReceiptHash = String(
    capability?.codexFormalReviewerCapabilityReceiptHash || '',
  ).trim().toLowerCase();
  if (!reviewer?.effectivePrincipalId
    || !SHA256.test(capabilityReceiptHash)
    || !SHA256.test(String(capability?.credentialRootIdentityHash || '').toLowerCase())
    || !SHA256.test(String(capability?.credentialConfigIdentityHash || '').toLowerCase())
    || !SHA256.test(String(capability?.codexBinaryIdentityHash || '').toLowerCase())
    || capability?.provider !== 'openai'
    || capability?.status !== 'codex_formal_reviewer_capability_ready'
    || capability?.providerCredentialSharingPermitted !== true
    || capability?.freshEphemeralSessionRequired !== true
    || capability?.authorContextInheritanceForbidden !== true
    || capability?.frozenArtifactReviewRequired !== true
    || capability?.reviewerMustDifferFromAuthorPrincipal !== true
    || capability?.assuranceScope
      !== 'ephemeral_session_frozen_artifact_and_role_separation') {
    throw new Error('autonomous_research_reviewer_session_capability_invalid');
  }
  return Object.freeze({ capability, capabilityReceiptHash });
}

export function buildAutonomousResearchReviewerSessionPrincipalPool({
  author,
  reviewer,
} = {}) {
  const { capability, capabilityReceiptHash } = reviewerSessionCapability(reviewer);
  if (!author?.effectivePrincipalId
    || author.effectivePrincipalId === reviewer.effectivePrincipalId) {
    throw new Error('autonomous_research_reviewer_session_role_separation_invalid');
  }
  const sessionPolicy = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchReviewerSessionEvidencePolicy',
    policy: 'fresh-ephemeral-no-resume-frozen-artifact-review-v1',
    authorPrincipalId: author.effectivePrincipalId,
    reviewerPrincipalId: reviewer.effectivePrincipalId,
    capabilityReceiptHash,
    providerCredentialSharingPermitted: true,
    freshEphemeralSessionRequired: true,
    authorContextInheritanceForbidden: true,
    frozenArtifactReviewRequired: true,
    reviewerMustDifferFromAuthorPrincipal: true,
  });
  const sessionPolicyHash = hashRecord(
    'AutonomousResearchReviewerSessionEvidencePolicy',
    sessionPolicy,
  );
  const trustSetHash = hashRecord('AutonomousResearchReviewerSessionTrustSet', {
    authorPrincipalId: author.effectivePrincipalId,
    reviewerPrincipalId: reviewer.effectivePrincipalId,
    capabilityReceiptHash,
    credentialRootIdentityHash: capability.credentialRootIdentityHash,
    credentialConfigIdentityHash: capability.credentialConfigIdentityHash,
  });
  const descriptor = buildResearchPrincipalDescriptor({
    principalId: reviewer.effectivePrincipalId,
    roles: ['formal-review', 'independent-review'],
    provider: 'openai-codex',
    modelIdentityHash: hashRecord('ResearchReviewerModelIdentity', {
      provider: capability.provider,
      model: capability.model,
      codexVersion: capability.codexVersion,
      codexBinaryIdentityHash: capability.codexBinaryIdentityHash,
    }),
    providerAccountIdentityHash: hashRecord(
      'AutonomousResearchReviewerProviderAuthenticationScope',
      {
        provider: capability.provider,
        credentialRootIdentityHash: capability.credentialRootIdentityHash,
        credentialConfigIdentityHash: capability.credentialConfigIdentityHash,
      },
    ),
    credentialRootIdentityHash: capability.credentialRootIdentityHash,
    credentialConfigIdentityHash: capability.credentialConfigIdentityHash,
    trustDomainIdentityHash: trustSetHash,
    capabilityReceiptHash,
    signerIdentityHash: sessionPolicyHash,
  });
  const pool = buildResearchPrincipalPool({
    poolId: 'hepta-reviewer-fresh-session-pool-v1',
    principals: [descriptor],
    minimumReviewerTrustDomains: 1,
  });
  const trustPayload = {
    version: 2,
    kind: 'ReviewerPrincipalPoolTrustInspection',
    status: 'reviewer_session_pool_trust_ready',
    strongReviewerPool: false,
    authorityMode: 'fresh-isolated-session',
    sessionIsolationReady: true,
    cryptographicAuthorityReady: false,
    identityIndependenceReady: true,
    trustSetHash,
    signatureVerificationPolicyHash: sessionPolicyHash,
    evidenceProfile: 'fresh-ephemeral-frozen-artifact-review-v1',
    principalInspections: Object.freeze([Object.freeze({
      principalId: descriptor.principalId,
      principalDescriptorHash: descriptor.principalDescriptorHash,
      capabilityReceiptHash,
      sessionPolicyHash,
    })]),
    authorIdentityAttestation: null,
    blockers: Object.freeze([]),
  };
  const trustInspection = Object.freeze({
    ...trustPayload,
    reviewerPrincipalPoolTrustInspectionHash: hashRecord(
      'ReviewerPrincipalPoolTrustInspection',
      trustPayload,
    ),
  });
  return Object.freeze({
    configuration: null,
    pool,
    entries: Object.freeze([Object.freeze({
      descriptor,
      preflight: reviewer,
      signer: null,
      executor: null,
    })]),
    trustInspection,
    authorityMode: 'fresh-isolated-session',
    sessionIsolationReady: true,
    cryptographicAuthorityReady: false,
    identityIndependenceReady: true,
    trustSetHash,
    signatureVerificationPolicyHash: sessionPolicyHash,
    evidenceProfile: trustInspection.evidenceProfile,
  });
}

export function inspectAutonomousResearchRuntimePrincipals({
  authorConfiguration,
  reviewerConfiguration,
  refereeCount,
  environment = process.env,
  preflightAuthor = preflightCodexResearchAuthor,
  preflightReviewer = preflightCodexFormalReviewer,
  preflightEmpiricalRuntime = preflightAutonomousEmpiricalRuntimes,
  preflightReviewerPrincipalPool = defaultPreflightReviewerPrincipalPool,
  preflightLocalOllamaAgent = preflightLocalOllamaResearchAgent,
  spawnSyncImpl = undefined,
  clock = { now: () => new Date() },
  localOnly = false,
} = {}) {
  const blockers = [];
  let author = null;
  let reviewer = null;
  let reviewerPrincipalPoolInspection = null;
  let authorIdentityAttestation = null;
  let empiricalRuntimeCapabilityInspection = null;
  try {
    empiricalRuntimeCapabilityInspection = preflightEmpiricalRuntime({
      ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
    });
  } catch (error) {
    blockers.push(`autonomous_empirical_runtime_preflight_failed:${errorCode(error)}`);
  }
  const localOllama = localOnly === true
    && authorConfiguration?.provider === 'ollama'
    && reviewerConfiguration?.provider === 'ollama';
  if (localOllama) {
    try {
      author = preflightLocalOllamaAgent({
        role: 'research-author',
        model: authorConfiguration.model,
        environment,
        ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
      });
    } catch (error) {
      blockers.push(`autonomous_research_author_preflight_failed:${errorCode(error)}`);
    }
    try {
      reviewer = preflightLocalOllamaAgent({
        role: 'formal-reviewer',
        model: reviewerConfiguration.model,
        environment,
        ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
      });
    } catch (error) {
      blockers.push(`autonomous_research_reviewer_preflight_failed:${errorCode(error)}`);
    }
    if (author && reviewer && author.effectivePrincipalId === reviewer.effectivePrincipalId) {
      blockers.push('autonomous_research_local_ollama_principals_not_distinct');
    }
  } else {
    try {
      author = preflightAuthor({
        ...authorConfiguration,
        environment,
        ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
      });
    } catch (error) {
      blockers.push(`autonomous_research_author_preflight_failed:${errorCode(error)}`);
    }
    try {
      authorIdentityAttestation = inspectAutonomousResearchAuthorRuntimeIdentity({
        environment,
        author,
        clock,
      });
    } catch (error) {
      const code = errorCode(error);
      blockers.push(code === 'autonomous_research_author_identity_configuration_pin_invalid'
        ? code
        : `autonomous_research_author_identity_preflight_failed:${code}`);
    }
    const reviewerPrincipalPoolConfigPath = String(
      environment.HEPTA_REVIEWER_PRINCIPAL_POOL_CONFIG || '',
    ).trim();
    if (author && reviewerPrincipalPoolConfigPath) {
      try {
        reviewerPrincipalPoolInspection = preflightReviewerPrincipalPool({
          configPath: reviewerPrincipalPoolConfigPath,
          authorProvider: authorConfiguration.provider,
          authorCodexHome: author.codexHome || authorConfiguration.codexHome,
          environment,
          preflightReviewer,
          authorIdentityAttestation,
          clock,
          ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
        });
        const primaryReviewer = reviewerPrincipalPoolInspection.entries.find((entry) => (
          entry.descriptor.roles.includes('formal-review')
        ));
        reviewer = primaryReviewer ? Object.freeze({
          ...primaryReviewer.preflight,
          effectivePrincipalId: primaryReviewer.descriptor.principalId,
        }) : null;
        if (reviewerPrincipalPoolInspection.pool.reviewerPrincipalCount < refereeCount
          || reviewerPrincipalPoolInspection.pool.reviewerTrustDomainCount < refereeCount) {
          blockers.push(
            'autonomous_research_reviewer_pool_referee_coverage_insufficient',
          );
        }
      } catch (error) {
        blockers.push(`autonomous_research_reviewer_pool_preflight_failed:${errorCode(error)}`);
      }
    } else if (author) {
      try {
        reviewer = preflightReviewer({
          ...reviewerConfiguration,
          authorProvider: authorConfiguration.provider,
          authorCodexHome: author.codexHome || authorConfiguration.codexHome,
          environment,
          ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
        });
        reviewerPrincipalPoolInspection =
          buildAutonomousResearchReviewerSessionPrincipalPool({ author, reviewer });
      } catch (error) {
        blockers.push(`autonomous_research_reviewer_preflight_failed:${errorCode(error)}`);
      }
    } else {
      blockers.push('autonomous_research_reviewer_preflight_requires_author');
    }
  }
  return Object.freeze({
    author,
    reviewer,
    reviewerPrincipalPoolInspection,
    authorIdentityAttestation,
    empiricalRuntimeCapabilityInspection,
    empiricalPluginStartupInspection:
      AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION,
    blockers: Object.freeze(blockers),
  });
}
