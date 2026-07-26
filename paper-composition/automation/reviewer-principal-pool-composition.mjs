import path from 'node:path';
import { createCodexAgentExecutor } from '../../paper-adapters/automation/codex-agent-executor.mjs';
import { preflightCodexFormalReviewer } from '../../paper-adapters/automation/codex-formal-reviewer-preflight.mjs';
import { createHttpReviewerReceiptSignerAdapter } from '../../paper-adapters/automation/http-reviewer-receipt-signer-adapter.mjs';
import {
  createHttpRecoverableReviewerExecutorAdapter,
} from '../../paper-adapters/automation/http-recoverable-reviewer-executor-adapter.mjs';
import { createIsolatedAgentExecutor } from '../../paper-adapters/automation/isolated-agent-executor.mjs';
import {
  createReviewerPrincipalExecutorPool,
  createReviewerReceiptVerificationAuthority,
} from '../../paper-adapters/automation/reviewer-principal-executor-pool.mjs';
import {
  readReviewerPrincipalPoolConfiguration,
} from '../../paper-adapters/automation/reviewer-principal-pool-configuration-reader.mjs';
import {
  buildResearchPrincipalDescriptor,
  buildResearchPrincipalPool,
  verifyResearchPrincipalPool,
} from '../../paper-domain/research/research-principal-pool-contract.mjs';
import {
  evaluateExternalPrincipalIdentitySeparation,
  verifyExternalPrincipalIdentityAttestationSubject,
} from '../../paper-domain/evidence/external-principal-identity-attestation-contract.mjs';
import {
  assertPinnedExternalEvidenceVerificationReceipt,
} from '../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import {
  REVIEWER_IDENTITY_ATTESTATION_SUBJECT_KIND,
} from '../../paper-domain/research/signed-reviewer-receipt-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function capabilityHash(receipt) {
  return receipt?.codexFormalReviewerCapabilityReceiptHash || null;
}

function buildReviewerPrincipalPoolTrustInspection({
  configuration,
  entries,
  authorIdentityAttestation,
  now,
}) {
  const blockers = [];
  const cryptographicAuthorityReady = configuration.version === 2
    && entries.every((entry) => (
      entry.signer.cryptographicAuthorityReady === true
      && entry.executor?.crashRecoveryReady === true
      && entry.executor?.recoveryOutcomeCryptographicAuthorityReady === true
    ));
  if (!cryptographicAuthorityReady) {
    blockers.push('reviewer_principal_pool_cryptographic_authority_not_ready');
  }
  const identityEntries = entries.map((entry) => ({
    entry,
    subject: entry.signer.identityAttestationSubject || null,
  }));
  let authorIdentitySubject = null;
  try {
    authorIdentitySubject = authorIdentityAttestation?.subject || null;
    if (!verifyExternalPrincipalIdentityAttestationSubject(authorIdentitySubject, {
      now,
      requirePlatformAttestation: true,
    })) throw new Error('author_identity_subject_invalid');
    assertPinnedExternalEvidenceVerificationReceipt(
      authorIdentityAttestation?.verificationReceipt,
      {
        subjectKind: REVIEWER_IDENTITY_ATTESTATION_SUBJECT_KIND,
        subjectHash: authorIdentitySubject.externalPrincipalIdentityAttestationSubjectHash,
        requiredRole: 'external_principal_identity_attestor',
      },
    );
  } catch {
    authorIdentitySubject = null;
    blockers.push('reviewer_principal_author_identity_attestation_not_ready');
  }
  for (const { entry, subject } of identityEntries) {
    if (!verifyExternalPrincipalIdentityAttestationSubject(subject, {
      now,
      requirePlatformAttestation: true,
    }) || subject.serviceId !== entry.signer.serviceId
      || subject.principalId !== entry.descriptor.principalId
      || subject.provider !== entry.descriptor.provider
      || subject.providerAccountIdentityHash
        !== entry.descriptor.providerAccountIdentityHash
      || subject.credentialRootIdentityHash !== entry.descriptor.credentialRootIdentityHash
      || subject.trustDomainIdentityHash !== entry.descriptor.trustDomainIdentityHash) {
      blockers.push(`reviewer_principal_identity_attestation_invalid:${entry.descriptor.principalId}`);
    }
  }
  const principalInspections = identityEntries.map(({ entry, subject }) => {
    const references = [
      ...(authorIdentitySubject ? [authorIdentitySubject] : []),
      ...identityEntries
        .filter((candidate) => candidate.entry !== entry)
        .map((candidate) => candidate.subject),
    ];
    const separationReceipt = evaluateExternalPrincipalIdentitySeparation({
      candidate: subject,
      references,
      now,
      requirePlatformAttestation: true,
    });
    if (!separationReceipt.identityIndependenceReady) {
      blockers.push(...separationReceipt.blockers.map((blocker) => (
        `reviewer_principal_identity_separation_invalid:${entry.descriptor.principalId}:${blocker}`
      )));
    }
    return Object.freeze({
      principalId: entry.descriptor.principalId,
      principalDescriptorHash: entry.descriptor.principalDescriptorHash,
      signerConfigurationHash: entry.signer.configurationHash,
      signerTrustSetHash: entry.signer.trustSetHash,
      signerSignatureVerificationPolicyHash:
        entry.signer.signatureVerificationPolicyHash,
      reviewerExecutorConfigurationHash:
        entry.executor?.configurationHash || null,
      reviewerExecutorRecoveryConfigurationIdentityHash:
        entry.executor?.recoveryConfigurationIdentityHash || null,
      reviewerExecutorRecoveryOutcomeVerificationPolicyHash:
        entry.executor?.recoveryOutcomeVerificationPolicyHash || null,
      identityAttestationSubjectHash:
        subject?.externalPrincipalIdentityAttestationSubjectHash || null,
      identityReferenceSubjects: Object.freeze(references),
      identitySeparationReceipt: separationReceipt,
    });
  });
  const identityIndependenceReady = cryptographicAuthorityReady && blockers.length === 0;
  const trustSetHash = cryptographicAuthorityReady
    ? hashRecord('ReviewerPrincipalPoolTrustSet', {
      configurationHash: configuration.configurationHash,
      signerTrustSetHashes: entries.map((entry) => entry.signer.trustSetHash).sort(),
      reviewerExecutorRecoveryConfigurationIdentityHashes: entries
        .map((entry) => entry.executor.recoveryConfigurationIdentityHash).sort(),
      authorIdentitySubjectHash:
        authorIdentitySubject?.externalPrincipalIdentityAttestationSubjectHash || null,
      authorIdentityTrustStoreHash:
        authorIdentityAttestation?.verificationReceipt?.trustStoreHash || null,
    }) : null;
  const signatureVerificationPolicyHash = cryptographicAuthorityReady
    ? hashRecord('ReviewerPrincipalPoolSignatureVerificationPolicy', {
      policy: 'all-reviewers-pinned-canonical-json-ed25519-v2',
      signerSignatureVerificationPolicyHashes: entries
        .map((entry) => entry.signer.signatureVerificationPolicyHash).sort(),
      reviewerExecutorRecoveryOutcomeVerificationPolicyHashes: entries
        .map((entry) => entry.executor.recoveryOutcomeVerificationPolicyHash).sort(),
      identityPlatformAttestationRequired: true,
      signedAuthorIdentityReferenceRequired: true,
      pairwiseDistinctFields: Object.freeze([
        'credentialRoot', 'host', 'process', 'providerAccount', 'signerSpki', 'trustDomain',
      ]),
    }) : null;
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const payload = {
    version: 2,
    kind: 'ReviewerPrincipalPoolTrustInspection',
    status: cryptographicAuthorityReady && identityIndependenceReady
      ? 'reviewer_principal_pool_trust_ready'
      : 'reviewer_principal_pool_trust_blocked',
    strongReviewerPool: configuration.version === 2,
    cryptographicAuthorityReady,
    identityIndependenceReady,
    trustSetHash,
    signatureVerificationPolicyHash,
    evidenceProfile: cryptographicAuthorityReady && identityIndependenceReady
      ? 'pinned-signed-independent-reviewer-pool-v2'
      : 'bounded-configured-reviewer-pool-v1',
    principalInspections: Object.freeze(principalInspections),
    authorIdentityAttestation: authorIdentitySubject ? Object.freeze({
      subject: authorIdentitySubject,
      verificationReceipt: authorIdentityAttestation.verificationReceipt,
    }) : null,
    blockers: uniqueBlockers,
  };
  return Object.freeze({
    ...payload,
    reviewerPrincipalPoolTrustInspectionHash: hashRecord(
      'ReviewerPrincipalPoolTrustInspection',
      payload,
    ),
  });
}

export function preflightReviewerPrincipalPool({
  configPath,
  authorProvider,
  authorCodexHome,
  environment = process.env,
  spawnSyncImpl = undefined,
  preflightReviewer = preflightCodexFormalReviewer,
  fetchImpl = globalThis.fetch,
  clock = { now: () => new Date() },
  authorIdentityAttestation = null,
} = {}) {
  const configuration = readReviewerPrincipalPoolConfiguration({ configPath });
  const entries = configuration.principals.map((principalConfiguration) => {
    const preflight = preflightReviewer({
      codexBinary: principalConfiguration.codexBinary,
      codexHome: principalConfiguration.codexHome,
      model: principalConfiguration.model,
      authorProvider,
      authorCodexHome,
      environment,
      ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
    });
    const capabilityReceipt = preflight.capabilityReceipt;
    const descriptor = buildResearchPrincipalDescriptor({
      principalId: preflight.effectivePrincipalId,
      roles: principalConfiguration.roles,
      provider: 'openai-codex',
      modelIdentityHash: hashRecord('ResearchReviewerModelIdentity', {
        provider: capabilityReceipt.provider,
        model: capabilityReceipt.model,
        codexVersion: capabilityReceipt.codexVersion,
        codexBinaryIdentityHash: capabilityReceipt.codexBinaryIdentityHash,
      }),
      providerAccountIdentityHash: principalConfiguration.providerAccountIdentityHash,
      credentialRootIdentityHash: capabilityReceipt.credentialRootIdentityHash,
      credentialConfigIdentityHash: capabilityReceipt.credentialConfigIdentityHash,
      trustDomainIdentityHash: principalConfiguration.trustDomainIdentityHash,
      capabilityReceiptHash: capabilityHash(capabilityReceipt),
      signerIdentityHash: principalConfiguration.signerConfiguration.signerIdentityHash,
    });
    const signer = createHttpReviewerReceiptSignerAdapter({
      configuration: principalConfiguration.signerConfiguration,
      environment,
      fetchImpl,
      clock,
    });
    const executor = configuration.version === 2
      ? createHttpRecoverableReviewerExecutorAdapter({
        configuration: principalConfiguration.recoverableExecutorConfiguration,
        principal: descriptor,
        environment,
        fetchImpl,
        clock,
      }) : null;
    return Object.freeze({
      principalConfiguration,
      preflight,
      descriptor,
      signer,
      executor,
    });
  });
  const pool = buildResearchPrincipalPool({
    poolId: configuration.poolId,
    principals: entries.map((entry) => entry.descriptor),
    minimumReviewerTrustDomains: configuration.minimumReviewerTrustDomains,
  });
  if (!verifyResearchPrincipalPool(pool)) {
    throw new Error(`reviewer_principal_pool_not_ready:${pool.blockers.join(',')}`);
  }
  const trustInspection = buildReviewerPrincipalPoolTrustInspection({
    configuration,
    entries,
    authorIdentityAttestation,
    now: clock.now(),
  });
  return Object.freeze({
    configuration,
    pool,
    entries: Object.freeze(entries),
    trustInspection,
    cryptographicAuthorityReady: trustInspection.cryptographicAuthorityReady,
    identityIndependenceReady: trustInspection.identityIndependenceReady,
    trustSetHash: trustInspection.trustSetHash,
    signatureVerificationPolicyHash: trustInspection.signatureVerificationPolicyHash,
    evidenceProfile: trustInspection.evidenceProfile,
  });
}

export function composeReviewerPrincipalExecutorPool({
  configPath,
  authorProvider,
  authorCodexHome,
  runtimeRoot,
  workspaceRegistry,
  environment = process.env,
  spawnSyncImpl = undefined,
  preflightReviewer = preflightCodexFormalReviewer,
  fetchImpl = globalThis.fetch,
  clock = { now: () => new Date() },
  authorIdentityAttestation = null,
  assertExternalSideEffectReady = null,
} = {}) {
  if (!runtimeRoot) throw new Error('reviewer_principal_pool_runtime_root_required');
  const inspection = preflightReviewerPrincipalPool({
    configPath,
    authorProvider,
    authorCodexHome,
    environment,
    spawnSyncImpl,
    preflightReviewer,
    fetchImpl,
    clock,
    authorIdentityAttestation,
  });
  const executors = new Map();
  const signers = new Map();
  for (const entry of inspection.entries) {
    if (inspection.configuration.version === 2) {
      executors.set(
        entry.descriptor.principalId,
        createHttpRecoverableReviewerExecutorAdapter({
          configuration: entry.principalConfiguration.recoverableExecutorConfiguration,
          principal: entry.descriptor,
          environment,
          fetchImpl,
          clock,
          assertExternalSideEffectReady,
        }),
      );
    } else {
      const delegate = createCodexAgentExecutor({
        codexBinary: entry.preflight.codexBinary || entry.principalConfiguration.codexBinary,
        codexHome: entry.preflight.codexHome,
        model: entry.principalConfiguration.model,
        principalId: entry.descriptor.principalId,
        formalReviewerCapabilityReceipt: entry.preflight.capabilityReceipt,
      });
      executors.set(entry.descriptor.principalId, createIsolatedAgentExecutor({
        delegate,
        isolationRoot: path.join(
          runtimeRoot,
          'automation-reviewer-workspaces',
          entry.descriptor.principalDescriptorHash.slice(7, 23),
        ),
        keepWorkspaces: false,
        keepFailedWorkspaces: true,
        workspaceRegistry,
        assertExternalSideEffectReady,
      }));
    }
    signers.set(entry.descriptor.principalId, entry.signer);
  }
  return Object.freeze({
    ...inspection,
    executorPool: createReviewerPrincipalExecutorPool({
      pool: inspection.pool,
      executors,
      signers,
      trustInspection: inspection.trustInspection,
      assertExternalSideEffectReady,
    }),
  });
}

export function composeReviewerReceiptVerificationAuthority({
  configPath,
  authorProvider,
  authorCodexHome,
  environment = process.env,
  spawnSyncImpl = undefined,
  preflightReviewer = preflightCodexFormalReviewer,
  fetchImpl = globalThis.fetch,
  clock = { now: () => new Date() },
  authorIdentityAttestation = null,
} = {}) {
  const inspection = preflightReviewerPrincipalPool({
    configPath,
    authorProvider,
    authorCodexHome,
    environment,
    spawnSyncImpl,
    preflightReviewer,
    fetchImpl,
    clock,
    authorIdentityAttestation,
  });
  const verificationAuthority = createReviewerReceiptVerificationAuthority({
    pool: inspection.pool,
    signers: new Map(inspection.entries.map((entry) => (
      [entry.descriptor.principalId, entry.signer]
    ))),
    trustInspection: inspection.trustInspection,
  });
  return Object.freeze({ ...inspection, verificationAuthority });
}
