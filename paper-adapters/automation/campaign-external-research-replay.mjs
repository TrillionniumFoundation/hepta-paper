import { assertExternalResearchReplayPort } from '../../paper-ports/external-research-replay-port.mjs';
import {
  buildExternalResearchReplayRequest,
  verifyExternalResearchReplayReceipt,
} from '../../paper-domain/research/external-research-replay-contract.mjs';

export async function runCampaignExternalResearchReplay({
  campaign,
  campaignResearchSourceSnapshot,
  campaignExperiments,
  authoritativeFormalReceipt,
  externalResearchReplay,
  signal,
  assertExternalSideEffectReady = null,
} = {}) {
  const required = campaign?.spec?.autonomousResearchPreparation
    ?.capabilityScopeManifest?.replayMode === 'external-trust-domain-v1';
  if (!required) return Object.freeze({ required: false, request: null, receipt: null });
  const replayPort = assertExternalResearchReplayPort(externalResearchReplay, {
    expectedConfigurationHash: campaign.spec.autonomousResearchPreparation
      .externalResearchReplayConfigurationHash,
    requiredLocalOriginIdentitySubjectHashes: [campaign.spec.autonomousResearchPreparation
      .runtimePrincipalBinding?.authorIdentitySubjectHash].filter(Boolean),
  });
  const request = buildExternalResearchReplayRequest({
    paperId: campaign.paperId,
    campaignId: campaign.campaignId,
    sourceSnapshotHash: campaignResearchSourceSnapshot.campaignResearchSourceSnapshotHash,
    experimentPairs: campaignExperiments.map((experiment) => ({
      originalExperimentRunReceiptHash:
        experiment.experimentRunReceipt.experimentRunReceiptHash,
      localReplayExperimentRunReceiptHash:
        experiment.reproducibilityReceipt.replayExperimentRunReceiptHash,
      localReplayObservationManifestHash:
        experiment.replayWorkerReceipt?.observationManifestHash || experiment.resultHash,
    })),
    formalReplayReceiptHashes: authoritativeFormalReceipt?.formalReplayReceiptHashes || [],
  });
  if (assertExternalSideEffectReady) {
    await assertExternalSideEffectReady({
      action: 'campaign_external_research_replay',
      campaignId: campaign.campaignId,
    });
    assertExternalSideEffectReady.assertCurrent?.({
      action: 'campaign_external_research_replay',
      campaignId: campaign.campaignId,
    });
  }
  await assertExternalSideEffectReady?.markStarted?.({
    action: 'campaign_external_research_replay',
  });
  const receipt = await replayPort.replay({ request, signal });
  const verified = typeof replayPort.verifyReceipt === 'function'
    ? replayPort.verifyReceipt({ request, receipt })
    : verifyExternalResearchReplayReceipt(receipt, { request });
  if (!verified) {
    throw new Error('campaign_external_research_replay_invalid');
  }
  return Object.freeze({
    required: true,
    request,
    receipt,
    receiptVerifier: replayPort.receiptVerifier || null,
  });
}

export function assertCampaignReleaseExternalResearchReplayAuthority({
  campaign,
  researchReport,
  externalResearchReplay,
} = {}) {
  const preparation = campaign?.spec?.autonomousResearchPreparation || null;
  const required = preparation?.capabilityScopeManifest?.replayMode
    === 'external-trust-domain-v1';
  if (!required) return true;
  const replayPort = assertExternalResearchReplayPort(externalResearchReplay, {
    expectedConfigurationHash: preparation.externalResearchReplayConfigurationHash,
    requiredLocalOriginIdentitySubjectHashes: [preparation.runtimePrincipalBinding
      ?.authorIdentitySubjectHash].filter(Boolean),
  });
  const request = researchReport?.capabilities?.externalReplayRequest || null;
  const receipt = researchReport?.capabilities?.externalReplayReceipt || null;
  const verified = typeof replayPort.verifyReceipt === 'function'
    ? replayPort.verifyReceipt({ request, receipt })
    : verifyExternalResearchReplayReceipt(receipt, { request });
  if (!verified || researchReport?.externalReplayVerified !== true
    || researchReport?.externalReplayRequestHash !== request?.requestHash
    || researchReport?.externalResearchReplayReceiptHash
      !== receipt?.externalResearchReplayReceiptHash) {
    throw new Error('campaign_release_external_research_replay_authority_invalid');
  }
  return true;
}
