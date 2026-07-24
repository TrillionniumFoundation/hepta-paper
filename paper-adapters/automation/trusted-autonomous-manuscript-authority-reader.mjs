import fs from 'node:fs';
import path from 'node:path';

import {
  verifyMachineProposedScientificClaimSet,
} from '../../paper-domain/automation/autonomous-research-proposal-contract.mjs';
import {
  buildAutonomousFormalSupportSurfaceAuthority,
} from '../../paper-domain/automation/autonomous-formal-support-registry.mjs';
import {
  buildAutonomousResearchSeedContractBundle,
  verifyAutonomousResearchPolicyAuthorization,
} from '../../paper-domain/automation/autonomous-research-policy-contract.mjs';
import {
  buildLimitedPriorArtEvidenceReceipt,
  verifyPriorArtEvidenceReceipt,
} from '../../paper-domain/research/prior-art-evidence-contract.mjs';
import {
  verifyAutonomousVenueProfileSelection,
} from '../../paper-domain/automation/autonomous-venue-profile-contract.mjs';
import {
  verifyAutonomousSubmissionMetadataReceipt,
} from '../../paper-domain/automation/autonomous-submission-metadata-contract.mjs';
import {
  verifyResearchAgendaIr,
} from '../../paper-domain/automation/research-agenda-ir.mjs';
import {
  verifyVenueRequirementIr,
} from '../../paper-domain/automation/venue-requirement-ir.mjs';
import {
  verifyAutonomousVenueTemplateAssetRecord,
} from '../../paper-domain/automation/autonomous-venue-template-asset-contract.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';
import {
  readScopedFileSync,
} from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';

const PROPOSAL_PATH = 'AUTONOMOUS_RESEARCH_PROPOSAL.json';
const POLICY_PATH = 'AUTONOMOUS_RESEARCH_POLICY_AUTHORIZATION.json';
const SEED_PATH = 'AUTONOMOUS_RESEARCH_SEED_CONTRACTS.json';
const PRIOR_ART_PATH = 'AUTONOMOUS_PRIOR_ART_EVIDENCE.json';
const EMPIRICAL_LINEAGE_PATH = 'AUTONOMOUS_EMPIRICAL_CLAIM_LINEAGE.json';
const RESEARCH_AGENDA_IR_PATH = 'AUTONOMOUS_RESEARCH_AGENDA_IR.json';
const VENUE_PROFILE_PATH = 'AUTONOMOUS_VENUE_PROFILE_SELECTION.json';
export const VENUE_REQUIREMENT_IR_PATH = 'AUTONOMOUS_VENUE_REQUIREMENT_IR.json';
const SUBMISSION_METADATA_PATH = 'AUTONOMOUS_SUBMISSION_METADATA.json';

function readJson(root, relative) {
  const read = readScopedFileSync({
    scopeRoot: root,
    candidate: path.join(root, relative),
  });
  if (read.status !== 'scoped_file_read_verified' || read.bytes > 4 * 1024 * 1024) {
    throw new Error(`trusted_autonomous_manuscript_source_invalid:${relative}`);
  }
  try { return JSON.parse(read.content.toString('utf8')); }
  catch { throw new Error(`trusted_autonomous_manuscript_json_invalid:${relative}`); }
}

export function readVerifiedAutonomousManuscriptAuthorityRecords(
  root,
  formalVerificationReceipt = null,
) {
  const proposal = readJson(root, PROPOSAL_PATH);
  const policyAuthorization = readJson(root, POLICY_PATH);
  const seedBundle = readJson(root, SEED_PATH);
  const priorArtPath = path.join(root, PRIOR_ART_PATH);
  const priorArtReceipt = fs.existsSync(priorArtPath)
    ? readJson(root, PRIOR_ART_PATH)
    : buildLimitedPriorArtEvidenceReceipt({
      paperId: proposal.paperId,
      agendaSelectionReceiptHash: proposal.agendaSelectionReceiptHash,
      generatorPrincipalId: proposal.generatorPrincipalId,
      createdAt: proposal.createdAt || '1970-01-01T00:00:00.000Z',
    });
  const empiricalClaimLineage = fs.existsSync(path.join(root, EMPIRICAL_LINEAGE_PATH))
    ? readJson(root, EMPIRICAL_LINEAGE_PATH) : null;
  const venueProfileSelection = fs.existsSync(path.join(root, VENUE_PROFILE_PATH))
    ? readJson(root, VENUE_PROFILE_PATH) : null;
  const researchAgendaIr = fs.existsSync(path.join(root, RESEARCH_AGENDA_IR_PATH))
    ? readJson(root, RESEARCH_AGENDA_IR_PATH) : null;
  const venueRequirementIr = fs.existsSync(path.join(root, VENUE_REQUIREMENT_IR_PATH))
    ? readJson(root, VENUE_REQUIREMENT_IR_PATH) : null;
  const venueTemplateAsset = venueProfileSelection?.venueTemplateAsset || null;
  const submissionMetadataReceipt = fs.existsSync(path.join(root, SUBMISSION_METADATA_PATH))
    ? readJson(root, SUBMISSION_METADATA_PATH) : null;
  const proposalVerification = verifyMachineProposedScientificClaimSet(proposal);
  const policyVerification = verifyAutonomousResearchPolicyAuthorization(
    policyAuthorization,
    { proposal },
  );
  const rebuiltSeed = buildAutonomousResearchSeedContractBundle({
    proposal,
    policyAuthorization,
    evidencePlan: seedBundle.evidence,
    reproducibilityPlan: seedBundle.reproducibility,
    createdAt: seedBundle.createdAt,
  });
  if (!proposalVerification.valid || !policyVerification.valid
    || rebuiltSeed.autonomousResearchSeedContractBundleHash
      !== seedBundle.autonomousResearchSeedContractBundleHash
    || JSON.stringify(rebuiltSeed) !== JSON.stringify(seedBundle)) {
    throw new Error('trusted_autonomous_manuscript_seed_authority_invalid');
  }
  const priorArtVerification = verifyPriorArtEvidenceReceipt(priorArtReceipt, {
    paperId: proposal.paperId,
    agendaSelectionReceiptHash: proposal.agendaSelectionReceiptHash,
  });
  if (!priorArtVerification.valid) {
    throw new Error('trusted_autonomous_manuscript_prior_art_authority_invalid');
  }
  if (!fs.existsSync(priorArtPath)) writeDurableJsonSync(priorArtPath, priorArtReceipt);
  if (venueProfileSelection && !verifyAutonomousVenueProfileSelection(
    venueProfileSelection,
    { authorityObservedAt: proposal.createdAt },
  )) {
    throw new Error('trusted_autonomous_manuscript_venue_profile_invalid');
  }
  if (submissionMetadataReceipt && !verifyAutonomousSubmissionMetadataReceipt(
    submissionMetadataReceipt,
    {
      paperId: proposal.paperId,
      protocolFamily: proposal.protocolFamily,
      authorityObservedAt: proposal.createdAt,
    },
  )) {
    throw new Error('trusted_autonomous_manuscript_submission_metadata_invalid');
  }
  if (venueProfileSelection?.profile?.externalSubmissionEnabled === true
    && !submissionMetadataReceipt) {
    throw new Error('trusted_autonomous_manuscript_submission_metadata_required');
  }
  const venueRequirementIrRequired = venueProfileSelection?.profile?.version === 3;
  if ((venueRequirementIrRequired && (!researchAgendaIr
    || !verifyResearchAgendaIr(researchAgendaIr)
    || !verifyVenueRequirementIr(venueRequirementIr, {
      researchAgendaIr,
      venueProfile: venueProfileSelection.profile,
      venueProfileSelection,
      expectedVenueProfileRegistryHash: venueProfileSelection.registryHash || null,
      expectedVenueAuthorityConfigurationHash:
        venueProfileSelection.venueAuthorityConfigurationHash || null,
    }))) || (!venueRequirementIrRequired && venueRequirementIr !== null)) {
    throw new Error('trusted_autonomous_manuscript_venue_requirement_ir_invalid');
  }
  let venueTemplateAssetFileHash = null;
  if (venueRequirementIrRequired) {
    const asset = verifyAutonomousVenueTemplateAssetRecord(venueTemplateAsset)
      ? readScopedFileSync({
        scopeRoot: root,
        candidate: path.join(root, venueTemplateAsset.relativePath),
      }) : null;
    if (asset?.status !== 'scoped_file_read_verified'
      || asset.hash !== venueTemplateAsset?.templateAssetHash
      || asset.bytes !== venueTemplateAsset?.sizeBytes
      || venueTemplateAsset?.templateAssetHash !== venueRequirementIr?.templateAssetHash) {
      throw new Error('trusted_autonomous_manuscript_venue_template_asset_invalid');
    }
    venueTemplateAssetFileHash = asset.hash;
  }
  const empiricalClaims = seedBundle.claims.filter((claim) => (
    claim.verificationMode === 'empirical_protocol'
  ));
  const formalClaims = seedBundle.claims.filter((claim) => (
    claim.verificationMode === 'formal_kernel'
  ));
  if (empiricalClaims.length !== 1 || formalClaims.length !== 1) {
    throw new Error('trusted_autonomous_manuscript_claim_authority_invalid');
  }
  const formalSupportAuthority = buildAutonomousFormalSupportSurfaceAuthority({
    proposal,
    seedBundle,
    formalVerificationReceipt,
  });
  return Object.freeze({
    proposal,
    policyAuthorization,
    seedBundle,
    empiricalClaim: empiricalClaims[0],
    formalSupportAuthority,
    priorArtReceipt,
    empiricalClaimLineage,
    venueProfileSelection,
    venueRequirementIr,
    venueRequirementIrFileHash: venueRequirementIr
      ? hashBytes(fs.readFileSync(path.join(root, VENUE_REQUIREMENT_IR_PATH))) : null,
    venueTemplateAsset,
    venueTemplateAssetFileHash,
    submissionMetadataReceipt,
  });
}
