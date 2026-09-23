import {
  assertPaperCampaignModeExecutable,
  buildPaperCampaignPlan,
} from '../../paper-domain/automation/campaign-plan.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { normalizePaperQualityProfiles } from '../../paper-domain/quality/paper-quality-profile-set.mjs';

function normalizedOptional(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function commandId(paperId, mode) {
  const modeToken = String(mode).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return `paper-campaign:${paperId}:batch-${modeToken}`;
}

export function buildBatchCampaignCommand({
  paperTask,
  paperState = null,
  sourceWorkspace,
  mode,
  maxRounds = 3,
  targetScopeReceipt,
  venueTarget = null,
  datasetRoot = null,
  datasetMounts = [],
  benchmarkId = null,
  applyManuscript = false,
  qualityProfile = null,
  qualityProfiles = [],
  languages = ['python', 'latex'],
  empiricalClaimUniverse = null,
} = {}) {
  if (!paperTask?.paperId || !paperTask?.semanticIdentityHash) {
    throw new Error('batch_campaign_command_paper_semantic_identity_required');
  }
  if (!sourceWorkspace || !mode) throw new Error('batch_campaign_command_source_and_mode_required');
  if (targetScopeReceipt?.status !== 'target_scope_verified'
    || !targetScopeReceipt.selectedPaperIds?.includes(paperTask.paperId)) {
    throw new Error('batch_campaign_command_target_scope_not_verified');
  }
  const requestedMode = normalizedOptional(mode);
  const effectiveMode = assertPaperCampaignModeExecutable(requestedMode);
  const canonicalVenueTarget = normalizedOptional(venueTarget) || normalizedOptional(paperTask.venueTarget);
  const normalizedLanguages = Object.freeze([...new Set((Array.isArray(languages) ? languages : String(languages || '').split(','))
    .map((language) => String(language).trim().toLowerCase()).filter(Boolean))]);
  const requestedQualityProfiles = normalizePaperQualityProfiles([
    qualityProfile, qualityProfiles, paperTask.paperQualityProfile, paperTask.paperQualityProfiles,
  ], { languages: normalizedLanguages });
  const effectiveDatasetMounts = Object.freeze((datasetMounts || []).map((mount) => Object.freeze({
    name: normalizedOptional(mount?.name),
    source: normalizedOptional(mount?.source),
    readOnly: mount?.readOnly === true,
    manifestHash: normalizedOptional(mount?.manifestHash),
    licenseId: normalizedOptional(mount?.licenseId),
    ...(normalizedOptional(mount?.operatorAuthorizationHash) ? { operatorAuthorizationHash: normalizedOptional(mount.operatorAuthorizationHash) } : {}),
    ...(normalizedOptional(mount?.operatorDatasetAuthorityDocumentHash) ? { operatorDatasetAuthorityDocumentHash: normalizedOptional(mount.operatorDatasetAuthorityDocumentHash) } : {}),
    ...(mount?.operatorDatasetAuthority ? { operatorDatasetAuthority: mount.operatorDatasetAuthority } : {}),
    ...(normalizedOptional(mount?.operatorDatasetHarnessHandle) ? { operatorDatasetHarnessHandle: normalizedOptional(mount.operatorDatasetHarnessHandle) } : {}),
    ...(normalizedOptional(mount?.splitManifestHash) ? { splitManifestHash: normalizedOptional(mount.splitManifestHash) } : {}),
    ...(normalizedOptional(mount?.benchmarkHarnessDocumentHash) ? { benchmarkHarnessDocumentHash: normalizedOptional(mount.benchmarkHarnessDocumentHash) } : {}),
    ...(normalizedOptional(mount?.benchmarkHarnessDefinitionHash) ? { benchmarkHarnessDefinitionHash: normalizedOptional(mount.benchmarkHarnessDefinitionHash) } : {}),
    ...(mount?.analysisProtocol ? { analysisProtocol: mount.analysisProtocol } : {}),
    ...(normalizedOptional(mount?.analysisProtocolHash) ? { analysisProtocolHash: normalizedOptional(mount.analysisProtocolHash) } : {}),
    ...(normalizedOptional(mount?.benchmarkFamily) ? { benchmarkFamily: normalizedOptional(mount.benchmarkFamily) } : {}),
    ...(Array.isArray(mount?.benchmarkSeedSchedule) ? { benchmarkSeedSchedule: Object.freeze(mount.benchmarkSeedSchedule.map(Number)) } : {}),
    ...(Number.isSafeInteger(Number(mount?.benchmarkMinimumRepetitions)) ? { benchmarkMinimumRepetitions: Number(mount.benchmarkMinimumRepetitions) } : {}),
  })));
  const commandSubject = Object.freeze({
    version: 3,
    kind: 'PaperBatchCampaignCommand',
    paperId: paperTask.paperId,
    paperSemanticIdentityHash: paperTask.semanticIdentityHash,
    paperQualityProfile: requestedQualityProfiles[0] || null,
    paperQualityProfiles: requestedQualityProfiles,
    languages: normalizedLanguages,
    sourceWorkspace,
    requestedMode,
    requestedMaxRounds: Math.max(1, Number(maxRounds || 3)),
    requestedVenueTarget: normalizedOptional(venueTarget),
    requestedDatasetRoot: normalizedOptional(datasetRoot),
    requestedBenchmarkId: normalizedOptional(benchmarkId),
    requestedApplyManuscript: Boolean(applyManuscript),
    venueTarget: canonicalVenueTarget,
    effectiveDatasetRoot: effectiveDatasetMounts[0]?.source || normalizedOptional(datasetRoot),
    effectiveDatasetMounts,
    scope: Object.freeze({
      requestedPaperIds: Object.freeze([...(targetScopeReceipt.requestedPaperIds || [])]),
      selectedPaperIds: Object.freeze([...(targetScopeReceipt.selectedPaperIds || [])]),
      inventorySource: targetScopeReceipt.inventorySource || null,
      inventoryFallback: targetScopeReceipt.inventoryFallback || null,
    }),
  });
  // requestedMode is audit metadata. Canonicalize it only in the scheduling
  // identity so aliases cannot create distinct command hashes.
  const batchCampaignCommandHash = hashRecord('PaperBatchCampaignCommand', Object.freeze({
    ...commandSubject,
    requestedMode: effectiveMode,
  }));
  const campaignId = commandId(paperTask.paperId, effectiveMode);
  const campaignPlan = buildPaperCampaignPlan({
    paperId: paperTask.paperId,
    sourceWorkspace,
    campaignId,
    maxRounds: commandSubject.requestedMaxRounds,
    languages: commandSubject.languages,
    paperQualityProfile: commandSubject.paperQualityProfile,
    paperQualityProfiles: commandSubject.paperQualityProfiles,
    mode: effectiveMode,
    venueTarget: commandSubject.venueTarget,
    datasetRoot: commandSubject.effectiveDatasetRoot,
    datasetMounts: commandSubject.effectiveDatasetMounts,
    benchmarkId: commandSubject.requestedBenchmarkId,
    applyManuscript: commandSubject.requestedApplyManuscript,
    paperTask,
    paperState,
    empiricalClaimUniverse,
    commandBinding: Object.freeze({
      version: 3,
      kind: 'PaperBatchCampaignCommandBinding',
      batchCampaignCommandHash,
      requestedMode: effectiveMode,
      paperSemanticIdentityHash: paperTask.semanticIdentityHash,
      venueTarget: commandSubject.venueTarget,
      effectiveDatasetRoot: commandSubject.effectiveDatasetRoot,
      requestedBenchmarkId: commandSubject.requestedBenchmarkId,
      requestedApplyManuscript: commandSubject.requestedApplyManuscript,
    }),
  });
  return Object.freeze({
    ...commandSubject,
    effectiveMode,
    batchCampaignCommandHash,
    campaignId,
    campaignPlan,
    campaignPlanHash: campaignPlan.campaignPlanHash,
  });
}

export function submitBatchCampaignCommand({ command, campaignStore } = {}) {
  if (!command?.campaignId || !command?.campaignPlanHash || !command?.campaignPlan?.nodes?.length) {
    throw new Error('batch_campaign_command_invalid');
  }
  if (!campaignStore?.createCampaign || !campaignStore?.getCampaign || !campaignStore?.listNodes || !campaignStore?.listEvents) {
    throw new Error('batch_campaign_command_campaign_store_required');
  }
  const existing = campaignStore.getCampaign(command.campaignId);
  if (existing && existing.spec?.campaignPlanHash !== command.campaignPlanHash) {
    throw new Error('batch_campaign_definition_conflict');
  }
  const campaign = campaignStore.createCampaign(command.campaignPlan);
  if (campaign?.campaignId !== command.campaignId
    || campaign?.paperId !== command.paperId
    || campaign?.spec?.campaignPlanHash !== command.campaignPlanHash) {
    throw new Error('batch_campaign_authority_binding_invalid');
  }
  const nodes = campaignStore.listNodes(command.campaignId);
  const events = campaignStore.listEvents(command.campaignId);
  const createdEvent = events.find((event) => event.kind === 'campaign_created');
  if (nodes.length !== command.campaignPlan.nodes.length || !createdEvent) {
    throw new Error('batch_campaign_authority_incomplete');
  }
  const nodeKinds = Object.freeze([...new Set(nodes.map((node) => node.kind))].sort());
  return Object.freeze({
    version: 2,
    kind: 'PaperBatchCampaignSubmission',
    status: existing ? 'paper_campaign_already_queued' : 'paper_campaign_queued',
    executionStatus: 'queued_not_executed',
    workflowExecutionPerformed: false,
    idempotentReplay: Boolean(existing),
    paperId: command.paperId,
    campaignId: command.campaignId,
    campaignPlanHash: command.campaignPlanHash,
    batchCampaignCommandHash: command.batchCampaignCommandHash,
    campaign,
    nodeCount: nodes.length,
    nodeKinds,
    requestedMode: command.requestedMode,
    effectiveMode: command.campaignPlan.mode,
    campaignCreatedEventHash: createdEvent.eventSha256 || null,
    externalActionPerformed: false,
  });
}
