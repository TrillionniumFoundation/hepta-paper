import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAutonomousResearchAgendaProductionReceipt,
} from '../../paper-domain/automation/autonomous-research-agenda-production-contract.mjs';
import {
  verifyAutonomousResearchCapabilityScopeManifest,
} from '../../paper-domain/automation/autonomous-research-capability-scope-manifest.mjs';
import {
  verifyAutonomousVenueProfileSelection,
} from '../../paper-domain/automation/autonomous-venue-profile-contract.mjs';
import { verifyResearchAgendaIr } from '../../paper-domain/automation/research-agenda-ir.mjs';
import { verifyVenueRequirementIr } from '../../paper-domain/automation/venue-requirement-ir.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function verifiedVenueRequirementAuthority(row, {
  expectedVenueProfileRegistryHash,
  expectedVenueAuthorityConfigurationHash,
  expectedSubmissionMetadataAuthorityConfigurationHash,
  expectedAgendaAuthorityInspection,
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
  const venueProfileSelection = preparation?.venueProfileSelection || null;
  const venueProfile = venueProfileSelection?.profile || null;
  const venueRequirementIr = preparation?.venueRequirementIr || null;
  const manifest = preparation?.capabilityScopeManifest || null;
  if (spec?.kind !== 'PaperCampaignPlan'
    || row?.campaign_id !== spec?.campaignId
    || row?.paper_id !== spec?.paperId
    || hashRecord('PaperCampaignPlan', planPayload) !== claimedPlanHash
    || preparation?.kind !== 'AutonomousResearchLoopPreparationReport'
    || preparation?.launchMode !== 'production-run'
    || hashRecord('AutonomousResearchLoopPreparationReport', preparationPayload)
      !== claimedPreparationHash
    || !verifyAutonomousResearchCapabilityScopeManifest(manifest)
    || manifest.venueMode !== 'submission-enabled-v1'
    || receipt?.version !== 3
    || !verifyAutonomousResearchAgendaProductionReceipt(receipt).valid
    || !verifyResearchAgendaIr(researchAgendaIr, { agendaProductionReceipt: receipt })
    || venueProfileSelection?.version !== 2
    || venueProfile?.version !== 3
    || !verifyAutonomousVenueProfileSelection(venueProfileSelection, {
      authorityObservedAt: venueProfileSelection?.selectedAt || null,
      expectedVenueAuthorityConfigurationHash,
      expectedSubmissionMetadataAuthorityConfigurationHash,
    })
    || venueProfileSelection.registryHash !== expectedVenueProfileRegistryHash
    || venueProfileSelection.venueAuthorityConfigurationHash
      !== expectedVenueAuthorityConfigurationHash
    || venueProfileSelection.submissionMetadataAuthorityProof?.configurationHash
      !== expectedSubmissionMetadataAuthorityConfigurationHash
    || row.campaign_id !== expectedAgendaAuthorityInspection?.campaignId
    || row.paper_id !== expectedAgendaAuthorityInspection?.paperId
    || claimedPlanHash !== expectedAgendaAuthorityInspection?.campaignPlanHash
    || researchAgendaIr?.researchAgendaIrHash
      !== expectedAgendaAuthorityInspection?.researchAgendaIr?.researchAgendaIrHash
    || !verifyVenueRequirementIr(venueRequirementIr, {
      researchAgendaIr,
      venueProfile,
      venueProfileSelection,
      expectedVenueProfileRegistryHash,
      expectedVenueAuthorityConfigurationHash,
    })
    || venueRequirementIr.paperId !== row.paper_id
    || venueRequirementIr.venueRequirementAuthorityReceiptHash
      !== expectedVenueAuthorityConfigurationHash) return null;
  return Object.freeze({
    campaignId: row.campaign_id,
    paperId: row.paper_id,
    campaignPlanHash: claimedPlanHash,
    preparationHash: claimedPreparationHash,
    capabilityScopeManifestHash:
      manifest.autonomousResearchCapabilityScopeManifestHash,
    venueProfileSelection,
    venueProfile,
    venueRequirementIr,
  });
}

export function inspectPersistedAutonomousResearchVenueRequirementAuthority({
  store,
  expectedVenueProfileRegistryHash = null,
  expectedVenueAuthorityConfigurationHash = null,
  expectedSubmissionMetadataAuthorityConfigurationHash = null,
  expectedAgendaAuthorityInspection = null,
} = {}) {
  const configuredAuthorityReady = SHA256.test(String(
    expectedVenueProfileRegistryHash || '',
  )) && SHA256.test(String(expectedVenueAuthorityConfigurationHash || ''))
    && SHA256.test(String(
      expectedSubmissionMetadataAuthorityConfigurationHash || '',
    ))
    && expectedAgendaAuthorityInspection?.ready === true;
  if (!configuredAuthorityReady) {
    return Object.freeze({
      status: 'autonomous_research_venue_requirement_authority_unavailable',
      ready: false,
      statusReadOnly: true,
      campaignId: null,
      paperId: null,
      campaignPlanHash: null,
      preparationHash: null,
      capabilityScopeManifestHash: null,
      venueProfileSelection: null,
      venueProfile: null,
      venueRequirementIr: null,
      blockers: Object.freeze([
        'autonomous_research_venue_requirement_configured_authority_required',
      ]),
    });
  }
  const query = store?.query?.(`SELECT campaign_id,paper_id,spec_json,updated_at
    FROM paper_campaigns
    WHERE json_extract(spec_json,'$.autonomousResearchPreparation.venueRequirementIr')
      IS NOT NULL
    ORDER BY updated_at DESC,campaign_id ASC LIMIT 128;`);
  if (!query?.ok) {
    return Object.freeze({
      status: 'autonomous_research_venue_requirement_authority_unavailable',
      ready: false,
      statusReadOnly: true,
      campaignId: null,
      paperId: null,
      campaignPlanHash: null,
      preparationHash: null,
      capabilityScopeManifestHash: null,
      venueProfileSelection: null,
      venueProfile: null,
      venueRequirementIr: null,
      blockers: Object.freeze([
        'autonomous_research_venue_requirement_authority_query_failed',
      ]),
    });
  }
  const candidates = query.rows.map((row) => verifiedVenueRequirementAuthority(row, {
    expectedVenueProfileRegistryHash,
    expectedVenueAuthorityConfigurationHash,
    expectedSubmissionMetadataAuthorityConfigurationHash,
    expectedAgendaAuthorityInspection,
  })).filter(Boolean);
  const authority = candidates[0] || null;
  return Object.freeze({
    status: authority
      ? 'autonomous_research_venue_requirement_authority_verified'
      : 'autonomous_research_venue_requirement_authority_not_persisted',
    ready: Boolean(authority),
    statusReadOnly: true,
    campaignId: authority?.campaignId || null,
    paperId: authority?.paperId || null,
    campaignPlanHash: authority?.campaignPlanHash || null,
    preparationHash: authority?.preparationHash || null,
    capabilityScopeManifestHash: authority?.capabilityScopeManifestHash || null,
    venueProfileSelection: authority?.venueProfileSelection || null,
    venueProfile: authority?.venueProfile || null,
    venueRequirementIr: authority?.venueRequirementIr || null,
    blockers: Object.freeze(authority
      ? [] : ['autonomous_research_venue_requirement_authority_not_persisted']),
  });
}
