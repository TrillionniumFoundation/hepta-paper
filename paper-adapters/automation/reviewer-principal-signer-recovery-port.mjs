import {
  agentExecutionReceiptPayload,
  verifyAgentExecutionReceipt,
} from '../../paper-domain/evidence/agent-execution-receipt-contract.mjs';
import {
  reviewerReceiptSigningSubject,
} from '../../paper-domain/research/signed-reviewer-receipt-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildPrincipalRecoveryBindings,
  normalizeReviewerRecoveryResolution,
  recoveryCapable,
  selectedReviewerPrincipal,
  verifyUnsignedReviewerRecoveryReceipt,
} from './reviewer-principal-recovery-support.mjs';

const BLOCKER =
  'formal_domain_qualification_signer_lookup_resume_required';

function signerPrincipal(principal, pool, trustInspection) {
  const inspection = trustInspection.principalInspections?.find(
    (candidate) => candidate.principalId === principal.principalId,
  );
  return Object.freeze({
    ...principal,
    researchPrincipalPoolHash: pool.researchPrincipalPoolHash,
    identitySeparationReceipt:
      inspection?.identitySeparationReceipt || null,
    identityReferenceSubjects:
      inspection?.identityReferenceSubjects || [],
  });
}

function signingInput({ request, pool, trustInspection }) {
  const unsignedReviewerReceipt = request?.unsignedReviewerReceipt;
  const reviewRequest = request?.reviewRequest;
  if (!verifyUnsignedReviewerRecoveryReceipt({
    receipt: unsignedReviewerReceipt,
    request: reviewRequest,
    pool,
    trustInspection,
  })) throw new Error('reviewer_recovery_unsigned_receipt_invalid');
  const principal = selectedReviewerPrincipal(pool, reviewRequest);
  return Object.freeze({
    unsignedReviewerReceipt,
    principal,
    signerPrincipal: signerPrincipal(principal, pool, trustInspection),
    subjectHash: reviewerReceiptSigningSubject({
      unsignedAgentExecutionReceiptHash:
        unsignedReviewerReceipt.agentExecutionReceiptHash,
      principalDescriptorHash: principal.principalDescriptorHash,
      researchPrincipalPoolHash: pool.researchPrincipalPoolHash,
    }),
  });
}

function buildSignedReviewerAgentReceipt({
  unsignedReviewerReceipt,
  signedReviewerReceipt,
}) {
  const unsignedPayload = agentExecutionReceiptPayload(
    unsignedReviewerReceipt,
  );
  const payload = {
    ...unsignedPayload,
    unsignedAgentExecutionReceiptHash:
      unsignedReviewerReceipt.agentExecutionReceiptHash,
    unsignedAgentExecutionReceipt: unsignedReviewerReceipt,
    signedReviewerReceipt,
    signedReviewerReceiptHash:
      signedReviewerReceipt.signedReviewerReceiptHash,
    signatureVerificationReceiptHash:
      signedReviewerReceipt.signatureVerificationReceiptHash,
  };
  return Object.freeze({
    ...payload,
    agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload),
  });
}

function createSignerRecoveryPort({
  pool,
  verifiedSigners,
  trustInspection,
  verifySignedReviewerReceipt,
  configurationIdentityHash,
  recoveryOutcomeVerificationPolicyHash,
}) {
  const signerFor = (principal) => verifiedSigners.get(
    principal.principalId,
  );
  const verifyFinal = (request, receipt) => {
    let input;
    try { input = signingInput({ request, pool, trustInspection }); }
    catch { return false; }
    return verifyAgentExecutionReceipt(receipt)
      && receipt.unsignedAgentExecutionReceiptHash
        === input.unsignedReviewerReceipt.agentExecutionReceiptHash
      && JSON.stringify(receipt.unsignedAgentExecutionReceipt)
        === JSON.stringify(input.unsignedReviewerReceipt)
      && verifySignedReviewerReceipt({
        receipt: receipt.signedReviewerReceipt,
        expected: {
          subjectHash: input.subjectHash,
          principalId: input.principal.principalId,
          principalDescriptorHash:
            input.principal.principalDescriptorHash,
          researchPrincipalPoolHash: pool.researchPrincipalPoolHash,
          signerIdentityHash: input.principal.signerIdentityHash,
        },
      }) === true;
  };
  const wrap = (request, signedReviewerReceipt) => {
    const input = signingInput({ request, pool, trustInspection });
    const receipt = buildSignedReviewerAgentReceipt({
      unsignedReviewerReceipt: input.unsignedReviewerReceipt,
      signedReviewerReceipt,
    });
    if (!verifyFinal(request, receipt)) {
      throw new Error('reviewer_recovery_signed_receipt_invalid');
    }
    return receipt;
  };
  return Object.freeze({
    version: 1,
    kind: 'FormalDomainQualificationSignerRecoveryPort',
    crashRecoveryReady: true,
    configurationIdentityHash,
    recoveryOutcomeCryptographicAuthorityReady: true,
    recoveryOutcomeVerificationPolicyHash,
    verifyReceipt({ request, receipt } = {}) {
      return verifyFinal(request, receipt);
    },
    async lookup({
      operationId,
      idempotencyKey,
      request,
      signal = null,
    } = {}) {
      const input = signingInput({ request, pool, trustInspection });
      return normalizeReviewerRecoveryResolution(
        await signerFor(input.principal).lookup({
          operationId,
          idempotencyKey,
          subjectHash: input.subjectHash,
          principal: input.signerPrincipal,
          signal,
        }),
        (receipt) => wrap(request, receipt),
      );
    },
    async resume({
      operationId,
      idempotencyKey,
      request,
      signal = null,
    } = {}) {
      const input = signingInput({ request, pool, trustInspection });
      return normalizeReviewerRecoveryResolution(
        await signerFor(input.principal).resume({
          operationId,
          idempotencyKey,
          subjectHash: input.subjectHash,
          principal: input.signerPrincipal,
          signal,
        }),
        (receipt) => wrap(request, receipt),
      );
    },
    async execute({
      operationId,
      idempotencyKey,
      request,
      signal = null,
    } = {}) {
      const input = signingInput({ request, pool, trustInspection });
      const signedReviewerReceipt = await signerFor(input.principal).sign({
        operationId,
        idempotencyKey,
        subjectHash: input.subjectHash,
        principal: input.signerPrincipal,
        signal,
      });
      return wrap(request, signedReviewerReceipt);
    },
  });
}

export function inspectReviewerPrincipalSignerRecovery({
  relevantPrincipals,
  verifiedSigners,
}) {
  const signers = relevantPrincipals.map((principal) => (
    verifiedSigners.get(principal.principalId)
  ));
  if (!(relevantPrincipals.length > 0 && signers.every(recoveryCapable))) {
    return Object.freeze({
      ready: false,
      recoveryBindings: null,
      blockers: Object.freeze([BLOCKER]),
    });
  }
  return Object.freeze({
    ready: true,
    recoveryBindings: buildPrincipalRecoveryBindings(
      relevantPrincipals,
      verifiedSigners,
    ),
    blockers: Object.freeze([]),
  });
}

export function createReviewerPrincipalSignerRecoveryPort({
  pool,
  verifiedSigners,
  trustInspection,
  verifySignedReviewerReceipt,
  signerRecoveryBindings,
}) {
  const configurationIdentityHash = hashRecord(
    'FormalDomainQualificationSignerRecoveryConfiguration',
    {
      researchPrincipalPoolHash: pool.researchPrincipalPoolHash,
      signerRecoveryBindings,
      reviewerTrustSetHash: trustInspection.trustSetHash,
      reviewerSignatureVerificationPolicyHash:
        trustInspection.signatureVerificationPolicyHash,
    },
  );
  const recoveryOutcomeVerificationPolicyHash = hashRecord(
    'FormalDomainQualificationSignerRecoveryOutcomeVerificationPolicy',
    {
      researchPrincipalPoolHash: pool.researchPrincipalPoolHash,
      signerRecoveryBindings: signerRecoveryBindings.map((binding) => ({
        principalId: binding.principalId,
        recoveryOutcomeVerificationPolicyHash:
          binding.recoveryOutcomeVerificationPolicyHash,
      })),
      reviewerTrustSetHash: trustInspection.trustSetHash,
      reviewerSignatureVerificationPolicyHash:
        trustInspection.signatureVerificationPolicyHash,
    },
  );
  return createSignerRecoveryPort({
    pool,
    verifiedSigners,
    trustInspection,
    verifySignedReviewerReceipt,
    configurationIdentityHash,
    recoveryOutcomeVerificationPolicyHash,
  });
}
