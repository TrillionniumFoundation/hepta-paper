import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildPrincipalRecoveryBindings,
  buildUnsignedReviewerRecoveryReceipt,
  normalizeReviewerRecoveryResolution,
  recoveryCapable,
  selectedReviewerPrincipal,
  verifyUnsignedReviewerRecoveryReceipt,
} from './reviewer-principal-recovery-support.mjs';

const BLOCKER =
  'formal_domain_qualification_reviewer_lookup_resume_required';

function createReviewerRecoveryPort({
  pool,
  verifiedExecutors,
  trustInspection,
  configurationIdentityHash,
  recoveryOutcomeVerificationPolicyHash,
}) {
  const wrap = (request, rawReceipt) => buildUnsignedReviewerRecoveryReceipt({
    rawReceipt,
    principal: selectedReviewerPrincipal(pool, request),
    pool,
    trustInspection,
  });
  const executorFor = (request) => verifiedExecutors.get(
    selectedReviewerPrincipal(pool, request).principalId,
  );
  return Object.freeze({
    version: 1,
    kind: 'FormalDomainQualificationReviewerRecoveryPort',
    crashRecoveryReady: true,
    configurationIdentityHash,
    recoveryOutcomeCryptographicAuthorityReady: true,
    recoveryOutcomeVerificationPolicyHash,
    verifyReceipt({ request, receipt } = {}) {
      return verifyUnsignedReviewerRecoveryReceipt({
        receipt,
        request,
        pool,
        trustInspection,
      });
    },
    async lookup({
      operationId,
      idempotencyKey,
      request,
      signal = null,
    } = {}) {
      return normalizeReviewerRecoveryResolution(
        await executorFor(request).lookup({
          operationId,
          idempotencyKey,
          request,
          signal,
        }),
        (receipt) => wrap(request, receipt),
      );
    },
    async resume({
      operationId,
      idempotencyKey,
      request,
      executionRequest = null,
      signal = null,
    } = {}) {
      return normalizeReviewerRecoveryResolution(
        await executorFor(request).resume({
          operationId,
          idempotencyKey,
          request,
          ...(executionRequest ? { executionRequest } : {}),
          signal,
        }),
        (receipt) => wrap(request, receipt),
      );
    },
    async execute({
      operationId,
      idempotencyKey,
      request,
      executionRequest,
      signal = null,
    } = {}) {
      const rawReceipt = await executorFor(request).execute({
        ...(executionRequest || request),
        operationId,
        idempotencyKey,
        signal,
      });
      return wrap(request, rawReceipt);
    },
  });
}

export function inspectReviewerPrincipalExecutorRecovery({
  relevantPrincipals,
  verifiedExecutors,
}) {
  const executors = relevantPrincipals.map((principal) => (
    verifiedExecutors.get(principal.principalId)
  ));
  if (!(relevantPrincipals.length > 0 && executors.every(recoveryCapable))) {
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
      verifiedExecutors,
    ),
    blockers: Object.freeze([]),
  });
}

export function createReviewerPrincipalExecutorRecoveryPort({
  pool,
  verifiedExecutors,
  trustInspection,
  executorRecoveryBindings,
}) {
  const configurationIdentityHash = hashRecord(
    'FormalDomainQualificationReviewerRecoveryConfiguration',
    {
      researchPrincipalPoolHash: pool.researchPrincipalPoolHash,
      executorRecoveryBindings,
    },
  );
  const recoveryOutcomeVerificationPolicyHash = hashRecord(
    'FormalDomainQualificationReviewerRecoveryOutcomeVerificationPolicy',
    {
      researchPrincipalPoolHash: pool.researchPrincipalPoolHash,
      executorRecoveryBindings: executorRecoveryBindings.map((binding) => ({
        principalId: binding.principalId,
        recoveryOutcomeVerificationPolicyHash:
          binding.recoveryOutcomeVerificationPolicyHash,
      })),
    },
  );
  return createReviewerRecoveryPort({
    pool,
    verifiedExecutors,
    trustInspection,
    configurationIdentityHash,
    recoveryOutcomeVerificationPolicyHash,
  });
}
