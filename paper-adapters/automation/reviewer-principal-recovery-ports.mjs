import {
  createReviewerPrincipalExecutorRecoveryPort,
  inspectReviewerPrincipalExecutorRecovery,
} from './reviewer-principal-executor-recovery-port.mjs';
import {
  createReviewerPrincipalSignerRecoveryPort,
  inspectReviewerPrincipalSignerRecovery,
} from './reviewer-principal-signer-recovery-port.mjs';

function formalReviewerPrincipals(pool) {
  return Object.freeze(pool.principals.filter((principal) => (
    principal.roles.includes('formal-review')
  )));
}

export function createReviewerPrincipalRecoveryPorts({
  pool,
  verifiedExecutors,
  verifiedSigners,
  trustInspection,
  verifySignedReviewerReceipt,
} = {}) {
  const relevantPrincipals = formalReviewerPrincipals(pool);
  const reviewer = inspectReviewerPrincipalExecutorRecovery({
    relevantPrincipals,
    verifiedExecutors,
  });
  const signer = inspectReviewerPrincipalSignerRecovery({
    relevantPrincipals,
    verifiedSigners,
  });
  const blockers = Object.freeze([
    ...reviewer.blockers,
    ...signer.blockers,
  ]);
  if (blockers.length) {
    return Object.freeze({
      ready: false,
      reviewerRecoveryPort: null,
      signerRecoveryPort: null,
      blockers,
    });
  }
  return Object.freeze({
    ready: true,
    reviewerRecoveryPort: createReviewerPrincipalExecutorRecoveryPort({
      pool,
      verifiedExecutors,
      trustInspection,
      executorRecoveryBindings: reviewer.recoveryBindings,
    }),
    signerRecoveryPort: createReviewerPrincipalSignerRecoveryPort({
      pool,
      verifiedSigners,
      trustInspection,
      verifySignedReviewerReceipt,
      signerRecoveryBindings: signer.recoveryBindings,
    }),
    blockers,
  });
}
