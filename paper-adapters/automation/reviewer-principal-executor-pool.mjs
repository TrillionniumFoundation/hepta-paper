import { assertAgentExecutorPort } from '../../paper-ports/agent-executor-port.mjs';
import {
  selectResearchPrincipal,
  verifyResearchPrincipalPool,
} from '../../paper-domain/research/research-principal-pool-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { assertReviewerReceiptSignerPort } from '../../paper-ports/reviewer-receipt-signer-port.mjs';
import {
  reviewerReceiptSigningSubject,
  verifySignedReviewerReceipt,
} from '../../paper-domain/research/signed-reviewer-receipt-contract.mjs';
import {
  agentExecutionReceiptPayload,
  verifyAgentExecutionReceipt,
} from '../../paper-domain/evidence/agent-execution-receipt-contract.mjs';
import {
  reviewerSemanticReceiptSigningSubject,
  verifyReviewerExecutionAuthorityContext,
} from '../../paper-domain/research/reviewer-semantic-evidence-contract.mjs';
import {
  createReviewerPrincipalRecoveryPorts,
} from './reviewer-principal-recovery-ports.mjs';

function inspectReviewerTrust({ pool, signers, trustInspection }) {
  if (!verifyResearchPrincipalPool(pool)) {
    throw new Error('reviewer_principal_executor_pool_invalid');
  }
  const {
    reviewerPrincipalPoolTrustInspectionHash: trustInspectionHash,
    ...trustInspectionPayload
  } = trustInspection || {};
  const valid = trustInspection === null || (
    trustInspection?.kind === 'ReviewerPrincipalPoolTrustInspection'
    && trustInspection?.version === 2
    && hashRecord('ReviewerPrincipalPoolTrustInspection', trustInspectionPayload)
      === trustInspectionHash
  );
  if (!valid) throw new Error('reviewer_principal_pool_trust_inspection_invalid');
  const strong = trustInspection?.strongReviewerPool === true;
  if (strong && (trustInspection?.cryptographicAuthorityReady !== true
    || trustInspection?.identityIndependenceReady !== true)) {
    throw new Error('reviewer_principal_pool_strong_trust_not_ready');
  }
  const verifiedSigners = new Map();
  for (const principal of pool.principals) {
    if (!principal.roles.some((role) => (
      ['formal-review', 'independent-review'].includes(role)
    ))) continue;
    if (signers instanceof Map && signers.has(principal.principalId)) {
      verifiedSigners.set(
        principal.principalId,
        assertReviewerReceiptSignerPort(signers.get(principal.principalId)),
      );
    }
    if (strong && (!verifiedSigners.has(principal.principalId)
      || verifiedSigners.get(principal.principalId).cryptographicAuthorityReady !== true)) {
      throw new Error(`reviewer_principal_cryptographic_signer_required:${principal.principalId}`);
    }
  }
  return Object.freeze({ strong, verifiedSigners });
}

export function createReviewerReceiptVerificationAuthority({
  pool,
  signers = null,
  trustInspection = null,
} = {}) {
  const { strong: strongReviewerPool, verifiedSigners } = inspectReviewerTrust({
    pool, signers, trustInspection,
  });
  const cryptographicAuthorityReady = strongReviewerPool
    && trustInspection.cryptographicAuthorityReady === true;
  const identityIndependenceReady = cryptographicAuthorityReady
    && trustInspection.identityIndependenceReady === true;
  const verifyPoolSignedReviewerReceipt = ({ receipt, expected = {} } = {}) => {
    const signer = verifiedSigners.get(expected.principalId || receipt?.principalId) || null;
    if (!signer) return false;
    return signer.version === 2
      ? signer.verifySignedReceipt({
        receipt,
        expected,
        identityReferenceSigners: [...verifiedSigners.values()].filter(
          (candidate) => candidate.serviceId !== signer.serviceId,
        ),
        identityReferenceAuthorities: trustInspection?.authorIdentityAttestation
          ? [trustInspection.authorIdentityAttestation] : [],
      })
      : verifySignedReviewerReceipt(receipt, expected);
  };
  return Object.freeze({
    version: strongReviewerPool ? 2 : 1,
    kind: 'ReviewerReceiptVerificationAuthority',
    researchPrincipalPoolHash: pool.researchPrincipalPoolHash,
    cryptographicAuthorityReady,
    identityIndependenceReady,
    reviewerTrustSetHash: cryptographicAuthorityReady ? trustInspection.trustSetHash : null,
    reviewerSignatureVerificationPolicyHash: cryptographicAuthorityReady
      ? trustInspection.signatureVerificationPolicyHash : null,
    verifySignedReviewerReceipt: verifyPoolSignedReviewerReceipt,
  });
}

export function createReviewerPrincipalExecutorPool({
  pool,
  executors,
  signers = null,
  trustInspection = null,
  assertExternalSideEffectReady = null,
} = {}) {
  if (!(executors instanceof Map)) throw new Error('reviewer_principal_executor_pool_invalid');
  if (assertExternalSideEffectReady !== null
    && typeof assertExternalSideEffectReady !== 'function') {
    throw new Error('reviewer_principal_external_side_effect_gate_invalid');
  }
  const verificationAuthority = createReviewerReceiptVerificationAuthority({
    pool, signers, trustInspection,
  });
  const { verifiedSigners } = inspectReviewerTrust({ pool, signers, trustInspection });
  const verifiedExecutors = new Map();
  for (const principal of pool.principals) {
    if (!principal.roles.some((role) => (
      ['formal-review', 'independent-review'].includes(role)
    ))) continue;
    verifiedExecutors.set(
      principal.principalId,
      assertAgentExecutorPort(executors.get(principal.principalId)),
    );
  }
  const cryptographicAuthorityReady = verificationAuthority.cryptographicAuthorityReady;
  const identityIndependenceReady = verificationAuthority.identityIndependenceReady;
  const strongReviewerPool = verificationAuthority.version === 2;
  const verifyPoolSignedReviewerReceipt = verificationAuthority.verifySignedReviewerReceipt;
  const recovery = strongReviewerPool
    ? createReviewerPrincipalRecoveryPorts({
      pool,
      verifiedExecutors,
      verifiedSigners,
      trustInspection,
      verifySignedReviewerReceipt: verifyPoolSignedReviewerReceipt,
    })
    : Object.freeze({
      ready: false,
      reviewerRecoveryPort: null,
      signerRecoveryPort: null,
      blockers: Object.freeze([
        'formal_domain_qualification_strong_reviewer_pool_required',
      ]),
    });
  return Object.freeze({
    version: verificationAuthority.version,
    kind: 'ReviewerPrincipalExecutorPool',
    pool,
    cryptographicAuthorityReady,
    identityIndependenceReady,
    trustSetHash: verificationAuthority.reviewerTrustSetHash,
    signatureVerificationPolicyHash:
      verificationAuthority.reviewerSignatureVerificationPolicyHash,
    trustInspection,
    verifySignedReviewerReceipt: verifyPoolSignedReviewerReceipt,
    crashRecoveryReady: recovery.ready,
    crashRecoveryBlockers: recovery.blockers,
    reviewerRecoveryPort: recovery.reviewerRecoveryPort,
    signerRecoveryPort: recovery.signerRecoveryPort,
    async execute(request) {
      const executionSideEffectGate = request?.assertExternalSideEffectReady
        || assertExternalSideEffectReady;
      if (executionSideEffectGate !== null
        && executionSideEffectGate !== undefined
        && typeof executionSideEffectGate !== 'function') {
        throw new Error('reviewer_principal_external_side_effect_gate_invalid');
      }
      const role = request?.role === 'formal-review' ? 'formal-review' : 'independent-review';
      const reviewerExecutionAuthorityContext =
        request?.context?.reviewerExecutionAuthorityContext || null;
      const semanticReviewerEvidence = role === 'independent-review'
        && verifyReviewerExecutionAuthorityContext(reviewerExecutionAuthorityContext)
        && request?.context?.campaignId === reviewerExecutionAuthorityContext.campaignId
        && request?.context?.campaignPlanHash
          === reviewerExecutionAuthorityContext.campaignPlanHash
        && request?.context?.paperId === reviewerExecutionAuthorityContext.paperId
        && request?.context?.nodeId === reviewerExecutionAuthorityContext.nodeId
        && request?.context?.roundIndex === reviewerExecutionAuthorityContext.roundIndex
        && request?.context?.attemptId
          === reviewerExecutionAuthorityContext.reviewAttemptId
        && request?.context?.manuscriptHash
          === reviewerExecutionAuthorityContext.manuscriptHash;
      if (strongReviewerPool && role === 'independent-review'
        && !semanticReviewerEvidence) {
        throw new Error('reviewer_principal_semantic_authority_context_required');
      }
      const selectionKey = request?.context?.nodeId || request?.context?.attemptId
        || request?.context?.campaignId || request?.role;
      const principal = selectResearchPrincipal({ pool, role, selectionKey });
      const receipt = await verifiedExecutors.get(principal.principalId).execute(request);
      if (!verifyAgentExecutionReceipt(receipt)) {
        throw new Error('reviewer_principal_agent_receipt_invalid');
      }
      const receiptPayload = agentExecutionReceiptPayload(receipt);
      const unsignedPayload = {
        ...receiptPayload,
        reviewPrincipalId: principal.principalId,
        reviewPrincipalDescriptorHash: principal.principalDescriptorHash,
        reviewerProviderAccountIdentityHash: principal.providerAccountIdentityHash,
        reviewerCredentialRootIdentityHash: principal.credentialRootIdentityHash,
        reviewerTrustDomainIdentityHash: principal.trustDomainIdentityHash,
        reviewerSignerIdentityHash: principal.signerIdentityHash,
        researchPrincipalPoolHash: pool.researchPrincipalPoolHash,
        reviewerCryptographicAuthorityReady: cryptographicAuthorityReady,
        reviewerIdentityIndependenceReady: identityIndependenceReady,
        reviewerTrustSetHash: cryptographicAuthorityReady ? trustInspection.trustSetHash : null,
        reviewerSignatureVerificationPolicyHash: cryptographicAuthorityReady
          ? trustInspection.signatureVerificationPolicyHash : null,
        ...(semanticReviewerEvidence ? { reviewerExecutionAuthorityContext } : {}),
      };
      const unsignedAgentExecutionReceiptHash = hashRecord(
        'AgentExecutionReceipt',
        unsignedPayload,
      );
      const unsignedAgentExecutionReceipt = Object.freeze({
        ...unsignedPayload,
        agentExecutionReceiptHash: unsignedAgentExecutionReceiptHash,
      });
      const signer = verifiedSigners.get(principal.principalId) || null;
      let signedReviewerReceipt = null;
      if (signer) {
        const subjectHash = semanticReviewerEvidence
          ? reviewerSemanticReceiptSigningSubject({
            unsignedAgentExecutionReceipt,
            principalDescriptorHash: principal.principalDescriptorHash,
            researchPrincipalPoolHash: pool.researchPrincipalPoolHash,
          })
          : reviewerReceiptSigningSubject({
            unsignedAgentExecutionReceiptHash,
            principalDescriptorHash: principal.principalDescriptorHash,
            researchPrincipalPoolHash: pool.researchPrincipalPoolHash,
          });
        const signingOperationId = hashRecord(
          'ReviewerPrincipalReceiptSigningOperation',
          {
            unsignedAgentExecutionReceiptHash,
            principalDescriptorHash: principal.principalDescriptorHash,
            researchPrincipalPoolHash: pool.researchPrincipalPoolHash,
          },
        );
        const signingIdempotencyKey = hashRecord(
          'ReviewerPrincipalReceiptSigningIdempotency',
          {
            signingOperationId,
            signerConfigurationHash: signer.configurationHash,
            subjectHash,
          },
        );
        if (executionSideEffectGate) {
          await executionSideEffectGate({
            action: `reviewer_receipt_sign:${principal.principalId}`,
            campaignId: request?.context?.campaignId || null,
            nodeId: request?.context?.nodeId || null,
            operationId: signingOperationId,
            idempotencyKey: signingIdempotencyKey,
          });
          executionSideEffectGate.assertCurrent?.({
            action: `reviewer_receipt_sign:${principal.principalId}`,
            campaignId: request?.context?.campaignId || null,
            nodeId: request?.context?.nodeId || null,
            operationId: signingOperationId,
            idempotencyKey: signingIdempotencyKey,
          });
        }
        await executionSideEffectGate?.markStarted?.({
          action: `reviewer_receipt_sign:${principal.principalId}`,
          operationId: signingOperationId,
          idempotencyKey: signingIdempotencyKey,
        });
        signedReviewerReceipt = await signer.sign({
          operationId: signingOperationId,
          idempotencyKey: signingIdempotencyKey,
          subjectHash,
          principal: Object.freeze({
            ...principal,
            researchPrincipalPoolHash: pool.researchPrincipalPoolHash,
            identitySeparationReceipt: trustInspection?.principalInspections?.find(
              (inspection) => inspection.principalId === principal.principalId,
            )?.identitySeparationReceipt || null,
            identityReferenceSubjects: trustInspection?.principalInspections?.find(
              (inspection) => inspection.principalId === principal.principalId,
            )?.identityReferenceSubjects || [],
          }),
          signal: request?.signal || null,
        });
        const expectedSignedReceipt = {
          subjectHash,
          principalId: principal.principalId,
          principalDescriptorHash: principal.principalDescriptorHash,
          researchPrincipalPoolHash: pool.researchPrincipalPoolHash,
          signerIdentityHash: principal.signerIdentityHash,
        };
        const signedReceiptVerified = verifyPoolSignedReviewerReceipt({
          receipt: signedReviewerReceipt,
          expected: expectedSignedReceipt,
        });
        if (!signedReceiptVerified) {
          throw new Error('reviewer_principal_signed_receipt_invalid');
        }
        if (strongReviewerPool && (signedReviewerReceipt.version !== 2
          || signedReviewerReceipt.cryptographicAuthorityReady !== true
          || signedReviewerReceipt.identityIndependenceReady !== true)) {
          throw new Error('reviewer_principal_cryptographic_receipt_required');
        }
      }
      const payload = {
        ...unsignedPayload,
        ...(signedReviewerReceipt ? {
          unsignedAgentExecutionReceiptHash,
          unsignedAgentExecutionReceipt,
          signedReviewerReceipt,
          signedReviewerReceiptHash: signedReviewerReceipt.signedReviewerReceiptHash,
          signatureVerificationReceiptHash:
            signedReviewerReceipt.signatureVerificationReceiptHash,
        } : {}),
      };
      return Object.freeze({
        ...payload,
        agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload),
      });
    },
  });
}
