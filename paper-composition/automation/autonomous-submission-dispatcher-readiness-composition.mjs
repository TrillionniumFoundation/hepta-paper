import {
  findAutonomousSubmissionDispatcherChallenge,
  readAutonomousSubmissionDispatcherCycleEnvelope,
} from '../../paper-adapters/automation/autonomous-submission-dispatcher-challenge-query.mjs';
import {
  inspectAutonomousSubmissionDispatcherHandoffState,
} from '../../paper-adapters/automation/autonomous-submission-dispatcher-handoff-inspection.mjs';
import {
  readAutonomousSubmissionDispatcherIdentityConfiguration,
  verifyAutonomousSubmissionDispatcherCycleEnvelope,
} from '../../paper-adapters/automation/autonomous-submission-dispatcher-cycle-verifier.mjs';
import {
  readConfiguredAutonomousSubmissionPortalDescriptorConfiguration,
} from '../../paper-adapters/automation/autonomous-submission-portal-descriptor-reader.mjs';
import {
  autonomousSubmissionPortalPublicDescriptorHash,
} from '../../paper-adapters/automation/autonomous-submission-portal-public-adapter.mjs';
import {
  AUTONOMOUS_SUBMISSION_PORTAL_READINESS_CANARY_SUBJECT_KIND,
  buildAutonomousSubmissionPortalReadinessCanaryEvidence,
  verifyAutonomousSubmissionPortalReadinessCanaryReceipt,
} from '../../paper-domain/automation/autonomous-submission-dispatcher-challenge-contract.mjs';
import {
  assertPinnedExternalEvidenceEnvelope,
} from '../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';

export function inspectAutonomousSubmissionDispatcherReadiness({
  runtimeRoot,
  environment = process.env,
  now = new Date(),
  planHash = environment.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_PLAN_HASH || null,
  idempotencyKey =
    environment.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_IDEMPOTENCY_KEY || null,
  portalId = null,
  portalConfigurationHash = null,
  portalDescriptorHash = null,
} = {}) {
  const blockers = [];
  let identity = null;
  let challenge = null;
  let envelope = null;
  let verification = null;
  let handoff = null;
  let publicPortal = null;
  let observedPortalDescriptorHash = null;
  let independentPortalCanaryVerification = null;
  try {
    identity = readAutonomousSubmissionDispatcherIdentityConfiguration({ environment });
  } catch { blockers.push('autonomous_submission_dispatcher_identity_not_ready'); }
  try {
    publicPortal = readConfiguredAutonomousSubmissionPortalDescriptorConfiguration({
      environment,
      allowPrivateConfigurationFallback: false,
      rejectPortalCredential: true,
    });
    observedPortalDescriptorHash = publicPortal
      ? autonomousSubmissionPortalPublicDescriptorHash(publicPortal) : null;
    if (!publicPortal
      || (portalId && publicPortal.portalId !== portalId)
      || (portalConfigurationHash
        && publicPortal.configurationHash !== portalConfigurationHash)
      || (portalDescriptorHash
        && observedPortalDescriptorHash !== portalDescriptorHash)) {
      throw new Error('portal_binding_invalid');
    }
  } catch { blockers.push('autonomous_submission_dispatcher_portal_binding_not_ready'); }
  try {
    challenge = findAutonomousSubmissionDispatcherChallenge({
      runtimeRoot,
      planHash,
      idempotencyKey,
      portalId: portalId || publicPortal?.portalId || null,
      portalConfigurationHash:
        portalConfigurationHash || publicPortal?.configurationHash || null,
      portalDescriptorHash:
        portalDescriptorHash || observedPortalDescriptorHash,
      now,
    });
    if (!challenge) blockers.push('autonomous_submission_dispatcher_challenge_missing');
  } catch { blockers.push('autonomous_submission_dispatcher_challenge_unreadable'); }
  try {
    if (challenge) envelope = readAutonomousSubmissionDispatcherCycleEnvelope({
      runtimeRoot,
      challengeHash: challenge.challengeHash,
    });
    if (!envelope) blockers.push('autonomous_submission_dispatcher_cycle_missing');
  } catch { blockers.push('autonomous_submission_dispatcher_cycle_unreadable'); }
  try {
    if (identity && challenge && envelope) {
      verification = verifyAutonomousSubmissionDispatcherCycleEnvelope({
        envelope, challenge, identity, now, requireReady: true,
      });
    }
  } catch { blockers.push('autonomous_submission_dispatcher_cycle_invalid'); }
  try {
    if (!verification || !publicPortal || !challenge || !envelope) {
      throw new Error('canary_prerequisite_missing');
    }
    const evidence = buildAutonomousSubmissionPortalReadinessCanaryEvidence({
      challenge,
      request: envelope.livePortalCanaryEvidence?.request,
      receipt: envelope.livePortalCanaryEvidence?.receipt,
      authorityEnvelope: envelope.livePortalCanaryEvidence?.authorityEnvelope,
    });
    const receipt = evidence.receipt;
    if (evidence.canaryEvidenceHash
        !== envelope.livePortalCanaryEvidence?.canaryEvidenceHash
      || receipt.canaryReceiptHash !== envelope.livePortalCanaryReceiptHash
      || receipt.portalId !== publicPortal.portalId
      || receipt.portalConfigurationHash !== publicPortal.configurationHash
      || receipt.portalDescriptorHash !== observedPortalDescriptorHash
      || receipt.serviceIdentityHash !== publicPortal.serviceIdentityHash
      || receipt.portalAccountIdentityHash !== publicPortal.portalAccountIdentityHash
      || receipt.portalTrustDomainIdentityHash
        !== publicPortal.portalTrustDomainIdentityHash
      || receipt.externalActionPerformed !== false
      || !verifyAutonomousSubmissionPortalReadinessCanaryReceipt(receipt, {
        request: evidence.request,
        now,
      })) {
      throw new Error('canary_binding_invalid');
    }
    independentPortalCanaryVerification = assertPinnedExternalEvidenceEnvelope({
      envelope: evidence.authorityEnvelope,
      subjectKind: AUTONOMOUS_SUBMISSION_PORTAL_READINESS_CANARY_SUBJECT_KIND,
      subjectHash: receipt.canaryReceiptHash,
      trustStore: publicPortal.receiptTrustStore,
      requiredRole: publicPortal.receiptSignerRole,
      expectedKeyIds: publicPortal.receiptSignerKeyIds,
      now,
      maximumLifetimeMs: publicPortal.receiptMaximumLifetimeMs,
    });
  } catch {
    blockers.push('autonomous_submission_dispatcher_portal_canary_not_independently_verified');
  }
  try {
    handoff = inspectAutonomousSubmissionDispatcherHandoffState({ runtimeRoot });
    if (handoff.pendingHandoffCount !== 0) {
      blockers.push('autonomous_submission_dispatcher_queue_not_drained');
    }
    if (handoff.explicitFailureCount !== 0) {
      blockers.push('autonomous_submission_dispatcher_explicit_failures_present');
    }
    if (envelope && (envelope.cutoverId !== handoff.cutoverId
      || envelope.handoffInstanceNonce !== handoff.handoffInstanceNonce
      || envelope.handoffDatabaseIdentityHash !== handoff.handoffDatabaseIdentityHash)) {
      blockers.push('autonomous_submission_dispatcher_handoff_identity_drift');
    }
  } catch { blockers.push('autonomous_submission_handoff_not_ready'); }
  const ready = blockers.length === 0 && verification?.ready === true;
  return Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionDispatcherReadinessInspection',
    status: ready
      ? 'autonomous_submission_dispatcher_ready'
      : 'autonomous_submission_dispatcher_blocked',
    ready,
    handoffReady: Boolean(handoff),
    planHash: challenge?.planHash || planHash,
    idempotencyKey: challenge?.idempotencyKey || idempotencyKey,
    challengeHash: challenge?.challengeHash || null,
    cycleReceiptHash: envelope?.cycleReceiptHash || null,
    dispatcherPrincipalId: identity?.principalId || null,
    dispatcherIdentityConfigurationHash: identity?.configurationHash || null,
    signatureVerified: verification?.signatureVerified === true,
    portalId: challenge?.portalId || publicPortal?.portalId || portalId,
    portalConfigurationHash: challenge?.portalConfigurationHash
      || publicPortal?.configurationHash || portalConfigurationHash,
    portalDescriptorHash: challenge?.portalDescriptorHash
      || observedPortalDescriptorHash || portalDescriptorHash,
    portalBindingVerified: verification?.signatureVerified === true
      && envelope?.portalBindingVerified === true
      && envelope?.portalId === publicPortal?.portalId
      && envelope?.portalConfigurationHash === publicPortal?.configurationHash
      && envelope?.portalDescriptorHash === observedPortalDescriptorHash,
    livePortalCanaryVerified: verification?.signatureVerified === true
      && envelope?.livePortalCanaryVerified === true
      && envelope?.livePortalCanaryExternalActionPerformed === false
      && independentPortalCanaryVerification?.cryptographicAuthorityReady === true,
    livePortalCanaryIndependentVerificationReceiptHash:
      independentPortalCanaryVerification
        ?.pinnedExternalEvidenceVerificationReceiptHash || null,
    signedAt: verification?.signedAt || null,
    expiresAt: verification?.expiresAt || null,
    handoff,
    blockers: Object.freeze([...new Set(blockers)].sort()),
  });
}
