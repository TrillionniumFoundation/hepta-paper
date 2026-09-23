import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAutonomousVenueProfile,
  verifyAutonomousVenueProfileSelection,
} from './autonomous-venue-profile-contract.mjs';
import { verifyResearchAgendaIr } from './research-agenda-ir.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const IR_KEYS = Object.freeze([
  'anonymousReview', 'artifactPolicy', 'artifactRequired',
  'disclosureRequirements', 'kind', 'paperId', 'researchAgendaIrHash',
  'reviewMode', 'sectionLimits', 'sourceVenueProfileHash',
  'sourceVenueProfileSelection', 'sourceVenueProfileSelectionReceiptHash',
  'sourceVenueRegistryHash', 'supplementPolicy', 'templateAssetHash', 'venueId',
  'venueRequirementAuthorityReceiptHash', 'venueRequirementIrHash', 'version',
  'wordLimit',
]);

function agendaConstraintsCovered(researchAgendaIr, selection, requirementSpecification) {
  const constraints = researchAgendaIr?.venueConstraints;
  const sections = new Set(requirementSpecification?.sectionLimits?.map((entry) => (
    entry.section
  )) || []);
  return constraints?.paperType === selection?.paperType
    && (constraints.anonymousReviewRequired !== true
      || requirementSpecification?.anonymousReview === true)
    && (constraints.artifactRequired !== true
      || requirementSpecification?.artifactRequired === true)
    && constraints.requiredSections.every((section) => sections.has(section));
}

export function buildVenueRequirementIr({
  researchAgendaIr,
  venueProfileSelection,
} = {}) {
  const selection = venueProfileSelection || null;
  const venueProfile = selection?.profile || null;
  const requirements = venueProfile?.requirementSpecification || null;
  if (!verifyResearchAgendaIr(researchAgendaIr)
    || selection?.version !== 2
    || !verifyAutonomousVenueProfileSelection(selection, {
      authorityObservedAt: selection?.selectedAt || null,
    })
    || !verifyAutonomousVenueProfile(venueProfile)
    || venueProfile.version !== 3
    || selection.paperId !== researchAgendaIr.paperId
    || selection.protocolFamily !== researchAgendaIr.protocolFamily
    || !venueProfile.protocolFamilies.includes(researchAgendaIr.protocolFamily)
    || !agendaConstraintsCovered(researchAgendaIr, selection, requirements)
    || !SHA256.test(String(selection.venueAuthorityConfigurationHash || ''))) {
    throw new Error('venue_requirement_ir_invalid');
  }
  const payload = {
    version: 2,
    kind: 'VenueRequirementIR',
    paperId: researchAgendaIr.paperId,
    researchAgendaIrHash: researchAgendaIr.researchAgendaIrHash,
    venueId: venueProfile.venueId,
    sourceVenueProfileHash: venueProfile.venueProfileHash,
    sourceVenueRegistryHash: selection.registryHash,
    sourceVenueProfileSelectionReceiptHash:
      selection.autonomousVenueProfileSelectionReceiptHash,
    sourceVenueProfileSelection: selection,
    venueRequirementAuthorityReceiptHash: selection.venueAuthorityConfigurationHash,
    anonymousReview: requirements.anonymousReview,
    reviewMode: requirements.reviewMode,
    wordLimit: requirements.wordLimit,
    sectionLimits: requirements.sectionLimits,
    templateAssetHash: requirements.templateAssetHash,
    supplementPolicy: requirements.supplementPolicy,
    artifactRequired: requirements.artifactRequired,
    artifactPolicy: requirements.artifactPolicy,
    disclosureRequirements: requirements.disclosureRequirements,
  };
  return Object.freeze({
    ...payload,
    venueRequirementIrHash: hashRecord('VenueRequirementIR', payload),
  });
}

export function verifyVenueRequirementIr(ir, {
  researchAgendaIr,
  venueProfile = null,
  venueProfileSelection = null,
  expectedVenueProfileRegistryHash = null,
  expectedVenueAuthorityConfigurationHash = null,
} = {}) {
  if (!hasExactObjectKeys(ir, IR_KEYS) || ir?.version !== 2
    || ir?.kind !== 'VenueRequirementIR') return false;
  const selection = venueProfileSelection || ir.sourceVenueProfileSelection;
  let rebuilt = null;
  try {
    rebuilt = buildVenueRequirementIr({ researchAgendaIr, venueProfileSelection: selection });
  } catch { return false; }
  return JSON.stringify(rebuilt) === JSON.stringify(ir)
    && (!venueProfile || venueProfile.venueProfileHash === ir.sourceVenueProfileHash)
    && (expectedVenueProfileRegistryHash === null
      || expectedVenueProfileRegistryHash === ir.sourceVenueRegistryHash)
    && (expectedVenueAuthorityConfigurationHash === null
      || expectedVenueAuthorityConfigurationHash
        === ir.venueRequirementAuthorityReceiptHash)
    && (!venueProfileSelection
      || venueProfileSelection.autonomousVenueProfileSelectionReceiptHash
        === ir.sourceVenueProfileSelectionReceiptHash);
}
