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

const CURRENT_PRODUCTION_CAMPAIGN_QUERY = `SELECT
    c.campaign_id,c.paper_id,c.status,c.revision,c.spec_json,c.updated_at
  FROM paper_campaigns c
  WHERE json_extract(
    c.spec_json,'$.autonomousResearchPreparation.launchMode'
  )='production-run'
    AND NOT EXISTS (
      SELECT 1 FROM paper_campaigns successor
      WHERE successor.paper_id=c.paper_id
        AND (successor.recovery_of_campaign_id=c.campaign_id
          OR successor.supersedes_campaign_id=c.campaign_id)
    )
  ORDER BY c.updated_at DESC,c.campaign_id ASC
  LIMIT 1;`;

const AGENDA_AUTHORITY_SNAPSHOT_FIELDS = Object.freeze([
  'campaignId',
  'paperId',
  'campaignStatus',
  'campaignRevision',
  'campaignPlanHash',
  'preparationHash',
  'capabilityScopeManifestHash',
  'researchAgendaProducerReceiptHash',
]);

function sameAgendaAuthoritySnapshot(left, right) {
  return left?.ready === true && right
    && AGENDA_AUTHORITY_SNAPSHOT_FIELDS.every((field) => (
      left[field] === right[field]
    ));
}

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
    || !['running', 'completed'].includes(row?.status)
    || !Number.isSafeInteger(Number(row?.revision))
    || Number(row.revision) < 0
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
    campaignStatus: row.status,
    campaignRevision: Number(row.revision),
    campaignPlanHash: claimedPlanHash,
    preparationHash: claimedPreparationHash,
    capabilityScopeManifestHash:
      manifest.autonomousResearchCapabilityScopeManifestHash,
    researchAgendaProducerReceiptHash:
      receipt.autonomousResearchAgendaProductionReceiptHash,
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
  expectedAgendaAuthorityInspection = null,
  now = null,
} = {}) {
  const query = store?.query?.(CURRENT_PRODUCTION_CAMPAIGN_QUERY);
  if (!query?.ok) {
    return Object.freeze({
      status: 'autonomous_research_agenda_authority_unavailable',
      ready: false,
      statusReadOnly: true,
      campaignId: null,
      paperId: null,
      campaignStatus: null,
      campaignRevision: null,
      campaignPlanHash: null,
      preparationHash: null,
      capabilityScopeManifestHash: null,
      researchAgendaProducerReceiptHash: null,
      researchAgendaProducerReceipt: null,
      researchAgendaIr: null,
      priorArtEvidenceReceipt: null,
      priorArtClaimAlignmentReceipt: null,
      priorArtClaimAlignmentReady: false,
      blockers: Object.freeze(['autonomous_research_agenda_authority_query_failed']),
    });
  }
  const selectedRow = query.rows?.[0] || null;
  const inspectedAuthority = verifiedAgendaAuthority(selectedRow, {
    currentPriorArtAuthorityTrustConfiguration,
    currentExternalCapabilityTrustInspection,
    now,
  });
  const snapshotMismatch = expectedAgendaAuthorityInspection !== null
    && expectedAgendaAuthorityInspection !== undefined
    && !sameAgendaAuthoritySnapshot(
      expectedAgendaAuthorityInspection,
      inspectedAuthority,
    );
  const authority = snapshotMismatch ? null : inspectedAuthority;
  const blockers = authority ? [] : [
    snapshotMismatch
      ? 'autonomous_research_agenda_authority_snapshot_mismatch'
      : selectedRow
        ? 'autonomous_research_current_agenda_authority_invalid'
        : 'autonomous_research_current_production_campaign_not_persisted',
  ];
  return Object.freeze({
    status: authority
      ? 'autonomous_research_agenda_authority_verified'
      : 'autonomous_research_agenda_authority_not_persisted',
    ready: Boolean(authority),
    statusReadOnly: true,
    campaignId: authority?.campaignId || null,
    paperId: authority?.paperId || null,
    campaignStatus: authority?.campaignStatus || null,
    campaignRevision: authority?.campaignRevision ?? null,
    campaignPlanHash: authority?.campaignPlanHash || null,
    preparationHash: authority?.preparationHash || null,
    capabilityScopeManifestHash: authority?.capabilityScopeManifestHash || null,
    researchAgendaProducerReceiptHash:
      authority?.researchAgendaProducerReceiptHash || null,
    researchAgendaProducerReceipt: authority?.receipt || null,
    researchAgendaIr: authority?.researchAgendaIr || null,
    priorArtEvidenceReceipt: authority?.priorArtEvidenceReceipt || null,
    priorArtClaimAlignmentReceipt:
      authority?.priorArtClaimAlignmentReceipt || null,
    priorArtClaimAlignmentReady:
      authority?.priorArtClaimAlignmentReady === true,
    blockers: Object.freeze(blockers),
  });
}
