import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAutonomousResearchAgendaProductionReceipt,
} from '../../paper-domain/automation/autonomous-research-agenda-production-contract.mjs';
import {
  verifyAutonomousResearchCapabilityScopeManifest,
} from '../../paper-domain/automation/autonomous-research-capability-scope-manifest.mjs';
import { verifyResearchAgendaIr } from '../../paper-domain/automation/research-agenda-ir.mjs';
import {
  inspectAutonomousResearchProductionProfilePreparation,
  verifyAutonomousResearchProductionPriorArtAuthority,
} from '../../paper-domain/automation/autonomous-research-production-profile-contract.mjs';
import {
  verifyConservativePriorArtClaimAlignment,
} from '../../paper-application/automation/prior-art-claim-alignment-production.mjs';

function verifiedAgendaAuthority(row, {
  currentPriorArtAuthorityTrustConfiguration = null,
  currentExternalCapabilityTrustInspection = null,
  now = null,
} = {}) {
  let spec;
  try { spec = JSON.parse(String(row?.spec_json || '')); }
  catch { return null; }
  const { campaignPlanHash: claimedPlanHash, ...planPayload } = spec || {};
  const preparation = spec?.autonomousResearchPreparation;
  const {
    autonomousResearchLoopPreparationReportHash: claimedPreparationHash,
    ...preparationPayload
  } = preparation || {};
  const receipt = preparation?.researchAgendaProducerReceipt || null;
  const researchAgendaIr = preparation?.researchAgendaIr || null;
  const manifest = preparation?.capabilityScopeManifest || null;
  const productionProfileInspection =
    inspectAutonomousResearchProductionProfilePreparation(preparation);
  if (spec?.kind !== 'PaperCampaignPlan'
    || row?.campaign_id !== spec?.campaignId
    || row?.paper_id !== spec?.paperId
    || hashRecord('PaperCampaignPlan', planPayload) !== claimedPlanHash
    || preparation?.kind !== 'AutonomousResearchLoopPreparationReport'
    || preparation?.launchMode !== 'production-run'
    || hashRecord('AutonomousResearchLoopPreparationReport', preparationPayload)
      !== claimedPreparationHash
    || !verifyAutonomousResearchCapabilityScopeManifest(manifest)
    || manifest.agendaMode !== 'machine-generated'
    || receipt?.version !== 3
    || !verifyAutonomousResearchAgendaProductionReceipt(receipt).valid
    || productionProfileInspection.required !== true
    || productionProfileInspection.ready !== true
    || receipt.paperId !== row.paper_id
    || receipt.selectedObjective !== preparation?.proposal?.objective
    || receipt.selectedProtocolFamily !== preparation?.proposal?.protocolFamily
    || !manifest.empiricalFamilies.includes(receipt.selectedProtocolFamily)) {
    return null;
  }
  const verifiedResearchAgendaIr = verifyResearchAgendaIr(researchAgendaIr, {
    agendaProductionReceipt: receipt,
  }) ? researchAgendaIr : null;
  const priorArtEvidenceReceipt = preparation?.priorArtReceipt || null;
  const priorArtClaimAlignmentReceipt =
    preparation?.priorArtClaimAlignmentReceipt || null;
  const agendaSelectionReceipt = preparation?.proposal?.agendaSelectionReceipt || null;
  const priorArtAuthorityReady = verifyAutonomousResearchProductionPriorArtAuthority({
    priorArtReceipt: priorArtEvidenceReceipt,
    authorityBundle: preparation?.priorArtAuthorityVerificationBundle || null,
    trustConfiguration: currentPriorArtAuthorityTrustConfiguration,
    externalCapabilityTrustInspection: currentExternalCapabilityTrustInspection,
    researchAgendaIr: verifiedResearchAgendaIr,
    now,
  });
  const priorArtClaimAlignmentReady = priorArtAuthorityReady
    && verifiedResearchAgendaIr !== null
    && verifyConservativePriorArtClaimAlignment(priorArtClaimAlignmentReceipt, {
      researchAgendaIr: verifiedResearchAgendaIr,
      agendaSelectionReceipt,
      priorArtEvidenceReceipt,
    });
  return Object.freeze({
    campaignId: row.campaign_id,
    paperId: row.paper_id,
    campaignPlanHash: claimedPlanHash,
    preparationHash: claimedPreparationHash,
    capabilityScopeManifestHash:
      manifest.autonomousResearchCapabilityScopeManifestHash,
    receipt,
    researchAgendaIr: verifiedResearchAgendaIr,
    priorArtEvidenceReceipt: priorArtClaimAlignmentReady
      ? priorArtEvidenceReceipt : null,
    priorArtClaimAlignmentReceipt: priorArtClaimAlignmentReady
      ? priorArtClaimAlignmentReceipt : null,
    priorArtClaimAlignmentReady,
  });
}

export function inspectPersistedAutonomousResearchAgendaAuthority({
  store,
  currentPriorArtAuthorityTrustConfiguration = null,
  currentExternalCapabilityTrustInspection = null,
  now = null,
} = {}) {
  const query = store?.query?.(`SELECT campaign_id,paper_id,spec_json,updated_at
    FROM paper_campaigns
    WHERE json_extract(spec_json,'$.autonomousResearchPreparation.researchAgendaProducerReceipt')
      IS NOT NULL
    ORDER BY updated_at DESC,campaign_id ASC LIMIT 128;`);
  if (!query?.ok) {
    return Object.freeze({
      status: 'autonomous_research_agenda_authority_unavailable',
      ready: false,
      statusReadOnly: true,
      campaignId: null,
      paperId: null,
      campaignPlanHash: null,
      preparationHash: null,
      capabilityScopeManifestHash: null,
      researchAgendaProducerReceipt: null,
      researchAgendaIr: null,
      priorArtEvidenceReceipt: null,
      priorArtClaimAlignmentReceipt: null,
      priorArtClaimAlignmentReady: false,
      blockers: Object.freeze(['autonomous_research_agenda_authority_query_failed']),
    });
  }
  const candidates = query.rows.map((row) => verifiedAgendaAuthority(row, {
    currentPriorArtAuthorityTrustConfiguration,
    currentExternalCapabilityTrustInspection,
    now,
  })).filter(Boolean);
  const authority = candidates[0] || null;
  return Object.freeze({
    status: authority
      ? 'autonomous_research_agenda_authority_verified'
      : 'autonomous_research_agenda_authority_not_persisted',
    ready: Boolean(authority),
    statusReadOnly: true,
    campaignId: authority?.campaignId || null,
    paperId: authority?.paperId || null,
    campaignPlanHash: authority?.campaignPlanHash || null,
    preparationHash: authority?.preparationHash || null,
    capabilityScopeManifestHash: authority?.capabilityScopeManifestHash || null,
    researchAgendaProducerReceipt: authority?.receipt || null,
    researchAgendaIr: authority?.researchAgendaIr || null,
    priorArtEvidenceReceipt: authority?.priorArtEvidenceReceipt || null,
    priorArtClaimAlignmentReceipt:
      authority?.priorArtClaimAlignmentReceipt || null,
    priorArtClaimAlignmentReady:
      authority?.priorArtClaimAlignmentReady === true,
    blockers: Object.freeze(authority
      ? [] : ['autonomous_research_machine_generated_agenda_authority_not_persisted']),
  });
}
