import {
  deliverAutonomousSubmission,
} from '../../paper-application/automation/autonomous-submission-delivery.mjs';
import {
  bootstrapAutonomousSubmissionHandoffContext,
} from '../bootstrap/autonomous-submission-handoff-context-bootstrap.mjs';
import {
  createAutonomousSubmissionDispatchAuthority,
} from './autonomous-submission-dispatch-authority-composition.mjs';
import {
  composeAutonomousSubmissionDispatcherServices,
} from './autonomous-submission-dispatcher-services-composition.mjs';
import {
  buildAutonomousSubmissionDispatcherCycleReceipt,
} from '../../paper-domain/automation/autonomous-submission-dispatcher-challenge-contract.mjs';
import {
  listPendingAutonomousSubmissionDispatcherChallenges,
  publishAutonomousSubmissionDispatcherCycleEnvelope,
} from '../../paper-adapters/automation/autonomous-submission-dispatcher-cycle-publisher.mjs';
import {
  inspectAutonomousSubmissionDispatcherHandoffState,
} from '../../paper-adapters/automation/autonomous-submission-dispatcher-handoff-inspection.mjs';
import {
  readAutonomousSubmissionDispatcherCycleSigningConfiguration,
  signAutonomousSubmissionDispatcherCycleReceipt,
} from '../../paper-adapters/automation/autonomous-submission-dispatcher-cycle-signer.mjs';
import {
  assertAutonomousSubmissionPortalCanaryAuthorityIndependentFromDispatcher,
} from '../../paper-adapters/automation/autonomous-submission-dispatcher-cycle-verifier.mjs';
import {
  autonomousSubmissionDispatcherProcessIdentity,
  inspectAutonomousSubmissionDispatcherStoragePreflight,
} from '../../paper-adapters/automation/autonomous-submission-dispatcher-storage-preflight.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export async function deliverAutonomousSubmissionStatesIfReady({
  states = [],
  portalVerifierReady,
  portalIdentityIndependenceReady,
  portalFullProductionReady,
  livePortalCanaryReady,
  storagePreflight,
  portal,
  outbox,
  submissionRequestVerifier,
  signal = null,
  assertExternalSideEffectReady = null,
  deliver = deliverAutonomousSubmission,
} = {}) {
  if (portalVerifierReady !== true
    || portalIdentityIndependenceReady !== true
    || portalFullProductionReady !== true
    || livePortalCanaryReady !== true
    || storagePreflight?.ready !== true) return Object.freeze([]);
  const results = [];
  for (const state of states) {
    results.push(await deliver({
      portal,
      outbox,
      request: state.request,
      submissionRequestVerifier,
      signal,
      assertExternalSideEffectReady,
    }));
  }
  return Object.freeze(results);
}

export async function dispatchAutonomousSubmissionHandoffs({
  root,
  runtimeRoot,
  campaignId = null,
  limit = 100,
  environment = process.env,
  serviceOverrides = {},
  signal = null,
  assertExternalSideEffectReady = null,
  storagePreflightOverride = null,
  processIdentityOverride = null,
} = {}) {
  if (!Number.isSafeInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 1000) {
    throw new Error('autonomous_submission_dispatcher_limit_invalid');
  }
  const autonomousSubmissionDispatchAuthority =
    createAutonomousSubmissionDispatchAuthority();
  const context = bootstrapAutonomousSubmissionHandoffContext({
    root,
    runtimeRoot,
    environment,
    autonomousSubmissionDispatchAuthority,
    handoffOnly: false,
    outboxOverride: serviceOverrides.autonomousSubmissionOutbox || null,
  });
  try {
    const services = composeAutonomousSubmissionDispatcherServices({
      environment,
      autonomousSubmissionRequestVerifier:
        context.services.autonomousSubmissionRequestVerifier,
      autonomousSubmissionPortalDispatchCapability:
        autonomousSubmissionDispatchAuthority.portal,
    });
    if (!services.autonomousSubmissionPortal) {
      throw new Error('autonomous_submission_dispatcher_portal_configuration_required');
    }
    const startedAt = context.services.clock.nowIso();
    const challenges = listPendingAutonomousSubmissionDispatcherChallenges({
      runtimeRoot,
      now: new Date(startedAt),
      limit: Number(limit),
    });
    const portalVerifierReady =
      context.services.autonomousSubmissionRequestVerifier?.kind
        === 'AutonomousSubmissionRequestVerifier'
      && services.autonomousSubmissionPortal.cryptographicAuthorityReady === true;
    const portalIdentityIndependenceReady =
      services.autonomousSubmissionPortal.identityIndependenceReady === true;
    const storagePreflight = storagePreflightOverride
      || inspectAutonomousSubmissionDispatcherStoragePreflight({ runtimeRoot });
    const signingConfiguration = challenges.length > 0
      ? readAutonomousSubmissionDispatcherCycleSigningConfiguration({ environment })
      : null;
    const portalCanaries = new Map();
    for (const challenge of challenges) {
      let canary = null;
      let authorityIndependence = null;
      const portalBindingVerified = challenge.portalId
          === services.autonomousSubmissionPortal.portalId
        && challenge.portalConfigurationHash
          === services.autonomousSubmissionPortal.configurationHash
        && challenge.portalDescriptorHash === services.portalDescriptorHash
        && services.autonomousSubmissionPortal.portalDescriptorHash
          === services.portalDescriptorHash
        && services.autonomousSubmissionPortal.fullProductionReady === true;
      if (portalBindingVerified
        && typeof services.autonomousSubmissionPortal.probeReadiness === 'function') {
        try {
          canary = await services.autonomousSubmissionPortal.probeReadiness({
            challenge,
            signal,
          });
          authorityIndependence =
            assertAutonomousSubmissionPortalCanaryAuthorityIndependentFromDispatcher({
              verificationReceipt: canary.signatureVerificationReceipt,
              identity: signingConfiguration.identity,
            });
        } catch { canary = null; }
      }
      portalCanaries.set(challenge.challengeHash, Object.freeze({
        portalBindingVerified,
        canary,
        authorityIndependence,
      }));
    }
    const states = context.services.autonomousSubmissionOutbox
      .listDispatchableAutonomousSubmissions({ campaignId, limit: Number(limit) });
    const liveCanaryGateReady = challenges.length > 0
      && challenges.every((challenge) => (
        portalCanaries.get(challenge.challengeHash)?.canary?.ready === true
        && portalCanaries.get(challenge.challengeHash)?.canary
          ?.externalActionPerformed === false
        && portalCanaries.get(challenge.challengeHash)
          ?.authorityIndependence?.independent === true
      ));
    const deliveryGateReady = liveCanaryGateReady
      && services.autonomousSubmissionPortal.fullProductionReady === true;
    const results = deliveryGateReady
      ? await deliverAutonomousSubmissionStatesIfReady({
      states,
      portalVerifierReady,
      portalIdentityIndependenceReady,
      portalFullProductionReady:
        services.autonomousSubmissionPortal.fullProductionReady,
      livePortalCanaryReady: liveCanaryGateReady,
      storagePreflight,
      portal: services.autonomousSubmissionPortal,
      outbox: context.services.autonomousSubmissionOutbox,
      submissionRequestVerifier:
        context.services.autonomousSubmissionRequestVerifier,
      signal,
      assertExternalSideEffectReady,
      }) : Object.freeze([]);
    const networkActionPerformed = results.some(
      (result) => result.networkActionPerformed === true,
    );
    const cycleReceipts = [];
    if (challenges.length > 0) {
      const handoff = inspectAutonomousSubmissionDispatcherHandoffState({ runtimeRoot });
      const processIdentity = processIdentityOverride
        || autonomousSubmissionDispatcherProcessIdentity();
      for (const challenge of challenges) {
        const challengeCanary = portalCanaries.get(challenge.challengeHash);
        const canary = challengeCanary?.canary || null;
        const signedAt = context.services.clock.nowIso();
        const expiresAt = new Date(Math.min(
          Date.parse(challenge.expiresAt),
          Date.parse(signedAt) + signingConfiguration.identity.maximumLifetimeMs,
        )).toISOString();
        const cyclePlanHash = hashRecord('AutonomousSubmissionDispatcherCyclePlan', {
          version: 1,
          challengeHash: challenge.challengeHash,
          campaignId,
          limit: Number(limit),
          dispatcherPrincipalId: signingConfiguration.identity.principalId,
          dispatcherIdentityConfigurationHash:
            signingConfiguration.identity.configurationHash,
          portalId: services.autonomousSubmissionPortal.portalId,
          portalConfigurationHash:
            services.autonomousSubmissionPortal.configurationHash,
          portalDescriptorHash: services.portalDescriptorHash,
          portalBindingVerified: challengeCanary?.portalBindingVerified === true,
          livePortalCanaryReceiptHash: canary?.canaryReceiptHash || null,
          livePortalCanaryAuthorityIndependenceHash:
            challengeCanary?.authorityIndependence
              ?.portalCanaryAuthorityIndependenceHash || null,
          cutoverId: handoff.cutoverId,
          handoffInstanceNonce: handoff.handoffInstanceNonce,
          handoffDatabaseIdentityHash: handoff.handoffDatabaseIdentityHash,
        });
        const receipt = buildAutonomousSubmissionDispatcherCycleReceipt({
          challenge,
          cyclePlanHash,
          dispatcherPrincipalId: signingConfiguration.identity.principalId,
          dispatcherIdentityConfigurationHash:
            signingConfiguration.identity.configurationHash,
          processIdentityHash: processIdentity.processIdentityHash,
          portalId: services.autonomousSubmissionPortal.portalId,
          portalConfigurationHash: services.autonomousSubmissionPortal.configurationHash,
          portalDescriptorHash: services.portalDescriptorHash,
          portalBindingVerified: challengeCanary?.portalBindingVerified === true,
          portalVerifierReady,
          portalIdentityIndependenceReady,
          portalFullProductionReady:
            services.autonomousSubmissionPortal.fullProductionReady === true,
          livePortalCanaryVerified: canary?.ready === true,
          livePortalCanaryReceiptHash: canary?.canaryReceiptHash || null,
          livePortalCanaryVerificationReceiptHash:
            canary?.pinnedExternalEvidenceVerificationReceiptHash || null,
          livePortalCanaryVerificationVerifiedAt:
            canary?.signatureVerificationReceipt?.verifiedAt || null,
          livePortalCanaryAuthorityIndependentFromDispatcher:
            challengeCanary?.authorityIndependence?.independent === true,
          livePortalCanaryExternalActionPerformed:
            canary?.externalActionPerformed ?? null,
          livePortalCanaryEvidence: canary?.evidence || null,
          cutoverId: handoff.cutoverId,
          handoffInstanceNonce: handoff.handoffInstanceNonce,
          handoffDatabaseIdentityHash: handoff.handoffDatabaseIdentityHash,
          nativeStoreInaccessibleOrReadOnlyVerified:
            storagePreflight.nativeStoreInaccessibleOrReadOnlyVerified,
          handoffStoreWriteVerified: storagePreflight.handoffStoreWriteVerified,
          storageLayoutHash: storagePreflight.storageLayoutHash,
          ...handoff,
          networkActionPerformed,
          startedAt,
          signedAt,
          expiresAt,
        });
        const envelope = signAutonomousSubmissionDispatcherCycleReceipt({
          receipt,
          challenge,
          signingConfiguration,
          environment,
        });
        publishAutonomousSubmissionDispatcherCycleEnvelope({
          runtimeRoot,
          challenge,
          envelope,
        });
        cycleReceipts.push(Object.freeze({
          challengeHash: challenge.challengeHash,
          cycleReceiptHash: envelope.cycleReceiptHash,
          ready: envelope.ready,
        }));
      }
    }
    const status = states.length > 0 && !deliveryGateReady
      ? 'autonomous_submission_dispatcher_blocked'
      : results.some((result) => (
      result.status === 'autonomous_submission_delivery_explicit_failure'
    ))
      ? 'autonomous_submission_dispatcher_explicit_failure'
      : results.some((result) => result.terminal !== true)
        ? 'autonomous_submission_dispatcher_pending'
        : 'autonomous_submission_dispatcher_completed';
    return Object.freeze({
      version: 1,
      kind: 'AutonomousSubmissionDispatcherReport',
      status,
      ready: status === 'autonomous_submission_dispatcher_completed'
        && services.autonomousSubmissionPortal.fullProductionReady === true
        && liveCanaryGateReady
        && cycleReceipts.length > 0
        && cycleReceipts.every((receipt) => receipt.ready === true)
        && (states.length === 0 || results.length === states.length),
      portalFullProductionReady:
        services.autonomousSubmissionPortal.fullProductionReady === true,
      livePortalCanaryGateReady: liveCanaryGateReady,
      inspectedCampaignCount: new Set(states.map((state) => state.request.campaignId)).size,
      inspectedHandoffCount: states.length,
      networkActionPerformed,
      cycleReceipts: Object.freeze(cycleReceipts),
      results: Object.freeze(results),
    });
  } finally {
    context.services.persistenceSession.close();
  }
}
