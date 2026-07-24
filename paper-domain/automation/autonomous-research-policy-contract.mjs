import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { normalizeText } from '../../workflow-kernel/runtime/text-utils.mjs';
import {
  AUTONOMOUS_EMPIRICAL_PLUGIN_PROTOCOL_FAMILIES,
} from './autonomous-empirical-family-plugin-registry.mjs';
import { verifyMachineProposedScientificClaimSet } from './autonomous-research-proposal-contract.mjs';
import {
  verifyDynamicFormalClaimSeed,
} from '../research/dynamic-formal-claim-seed-contract.mjs';

const ALLOWED_CAPABILITIES = Object.freeze([
  'draft_manuscript',
  'formalize_claims',
  'attempt_kernel_checked_proofs',
  'generate_experiment_code',
  'execute_preregistered_empirical_protocol',
  'run_independent_replay',
  'run_referee_revision_loop',
  'prepare_external_qualification_request',
]);

export const AUTONOMOUS_RESEARCH_POLICY_PROFILE = Object.freeze({
  version: 1,
  policyId: 'hepta-bounded-autonomous-research-v1',
  allowedProtocolFamilies: AUTONOMOUS_EMPIRICAL_PLUGIN_PROTOCOL_FAMILIES,
  allowedCapabilities: ALLOWED_CAPABILITIES,
  minimumRefereeCount: 2,
  minimumRevisionRounds: 1,
  maximumRevisionRounds: 10,
  externalSubmissionEnabled: false,
  humanSubjectsAllowed: false,
  privateDataWithoutExternalAuthorityAllowed: false,
  externalReleaseAttestationRequired: true,
});

function recordHashValid(record, kind, hashField) {
  if (!record || typeof record !== 'object' || !record[hashField]) return false;
  const { [hashField]: claimedHash, ...payload } = record;
  return hashRecord(kind, payload) === claimedHash;
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];
}

export function evaluateAutonomousResearchPolicy({
  proposal,
  requestedCapabilities = ALLOWED_CAPABILITIES,
  humanSubjects = false,
  privateData = false,
  externalDatasetAuthorityVerified = false,
  externalSubmissionRequested = false,
  requestedRevisionRounds = 3,
  requestedRefereeCount = 3,
  evaluatedAt = null,
} = {}) {
  const proposalVerification = verifyMachineProposedScientificClaimSet(proposal);
  const capabilities = unique(requestedCapabilities);
  const blockers = [...proposalVerification.blockers];
  if (!AUTONOMOUS_RESEARCH_POLICY_PROFILE.allowedProtocolFamilies.includes(proposal?.protocolFamily)) {
    blockers.push('autonomous_research_policy_protocol_family_not_allowed');
  }
  if (!capabilities.length
    || capabilities.some((capability) => !ALLOWED_CAPABILITIES.includes(capability))) {
    blockers.push('autonomous_research_policy_capability_not_allowed');
  }
  if (humanSubjects) blockers.push('autonomous_research_policy_human_subjects_forbidden');
  if (privateData && !externalDatasetAuthorityVerified) {
    blockers.push('autonomous_research_policy_private_data_external_authority_required');
  }
  if (externalSubmissionRequested) {
    blockers.push('autonomous_research_policy_external_submission_forbidden');
  }
  const revisionRounds = Number(requestedRevisionRounds);
  if (!Number.isInteger(revisionRounds)
    || revisionRounds < AUTONOMOUS_RESEARCH_POLICY_PROFILE.minimumRevisionRounds
    || revisionRounds > AUTONOMOUS_RESEARCH_POLICY_PROFILE.maximumRevisionRounds) {
    blockers.push('autonomous_research_policy_revision_rounds_invalid');
  }
  const refereeCount = Number(requestedRefereeCount);
  if (!Number.isInteger(refereeCount)
    || refereeCount < AUTONOMOUS_RESEARCH_POLICY_PROFILE.minimumRefereeCount
    || refereeCount > 7) {
    blockers.push('autonomous_research_policy_referee_count_invalid');
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const payload = {
    version: 1,
    kind: 'AutonomousResearchPolicyAuthorization',
    status: uniqueBlockers.length
      ? 'machine_proposal_policy_blocked'
      : 'machine_proposal_policy_authorized',
    decision: uniqueBlockers.length
      ? 'deny_bounded_research_execution'
      : 'authorize_bounded_research_execution',
    approvalRepresentation: 'system-policy-authorization-not-operator-approval',
    claimAuthorityType: 'machine-policy-authorized',
    policyId: AUTONOMOUS_RESEARCH_POLICY_PROFILE.policyId,
    policyProfileHash: hashRecord('AutonomousResearchPolicyProfile', AUTONOMOUS_RESEARCH_POLICY_PROFILE),
    proposalHash: proposal?.machineProposedScientificClaimSetHash || null,
    paperId: proposal?.paperId || null,
    protocolFamily: proposal?.protocolFamily || null,
    authorizedCapabilities: Object.freeze(capabilities),
    requestedRevisionRounds: revisionRounds,
    requestedRefereeCount: refereeCount,
    dataScope: Object.freeze({
      humanSubjects: Boolean(humanSubjects),
      privateData: Boolean(privateData),
      externalDatasetAuthorityVerified: Boolean(externalDatasetAuthorityVerified),
    }),
    safety: Object.freeze({
      operatorApprovalClaimed: false,
      operatorSignatureCreated: false,
      selfSignedExternalTrustClaimed: false,
      scientificNoveltyVerified: false,
      scientificCorrectnessVerified: false,
      universalResearchValidityClaimed: false,
      naturalLanguageToLeanEquivalenceMachineProven: false,
      externalSubmissionAuthorized: false,
      externalReleaseAttestationRequired: true,
    }),
    blockers: uniqueBlockers,
    evaluatedAt: evaluatedAt || null,
  };
  return Object.freeze({
    ...payload,
    autonomousResearchPolicyAuthorizationHash:
      hashRecord('AutonomousResearchPolicyAuthorization', payload),
  });
}

export function verifyAutonomousResearchPolicyAuthorization(value, { proposal = null } = {}) {
  const blockers = [];
  if (value?.version !== 1 || value?.kind !== 'AutonomousResearchPolicyAuthorization'
    || value?.status !== 'machine_proposal_policy_authorized'
    || value?.decision !== 'authorize_bounded_research_execution'
    || value?.approvalRepresentation !== 'system-policy-authorization-not-operator-approval'
    || value?.claimAuthorityType !== 'machine-policy-authorized') {
    blockers.push('autonomous_research_policy_authorization_shape_invalid');
  }
  if (value?.policyId !== AUTONOMOUS_RESEARCH_POLICY_PROFILE.policyId
    || value?.policyProfileHash
      !== hashRecord('AutonomousResearchPolicyProfile', AUTONOMOUS_RESEARCH_POLICY_PROFILE)) {
    blockers.push('autonomous_research_policy_profile_mismatch');
  }
  if (!Array.isArray(value?.authorizedCapabilities) || !value.authorizedCapabilities.length
    || value.authorizedCapabilities.some((capability) => !ALLOWED_CAPABILITIES.includes(capability))) {
    blockers.push('autonomous_research_policy_authorized_capabilities_invalid');
  }
  if (typeof value?.dataScope?.humanSubjects !== 'boolean'
    || typeof value?.dataScope?.privateData !== 'boolean'
    || typeof value?.dataScope?.externalDatasetAuthorityVerified !== 'boolean') {
    blockers.push('autonomous_research_policy_data_scope_invalid');
  }
  if (proposal) {
    const verification = verifyMachineProposedScientificClaimSet(proposal);
    blockers.push(...verification.blockers);
    if (value?.proposalHash !== proposal.machineProposedScientificClaimSetHash
      || value?.paperId !== proposal.paperId
      || value?.protocolFamily !== proposal.protocolFamily) {
      blockers.push('autonomous_research_policy_proposal_lineage_mismatch');
    }
  }
  const safety = value?.safety;
  if (safety?.operatorApprovalClaimed !== false
    || safety?.operatorSignatureCreated !== false
    || safety?.selfSignedExternalTrustClaimed !== false
    || safety?.scientificNoveltyVerified !== false
    || safety?.scientificCorrectnessVerified !== false
    || safety?.universalResearchValidityClaimed !== false
    || safety?.naturalLanguageToLeanEquivalenceMachineProven !== false
    || safety?.externalSubmissionAuthorized !== false
    || safety?.externalReleaseAttestationRequired !== true) {
    blockers.push('autonomous_research_policy_safety_claims_invalid');
  }
  if (!Array.isArray(value?.blockers) || value.blockers.length !== 0) {
    blockers.push('autonomous_research_policy_authorization_contains_blockers');
  }
  if (!recordHashValid(
    value,
    'AutonomousResearchPolicyAuthorization',
    'autonomousResearchPolicyAuthorizationHash',
  )) blockers.push('autonomous_research_policy_authorization_hash_invalid');
  const replay = evaluateAutonomousResearchPolicy({
    proposal,
    requestedCapabilities: value?.authorizedCapabilities,
    humanSubjects: value?.dataScope?.humanSubjects,
    privateData: value?.dataScope?.privateData,
    externalDatasetAuthorityVerified: value?.dataScope?.externalDatasetAuthorityVerified,
    externalSubmissionRequested: value?.safety?.externalSubmissionAuthorized,
    requestedRevisionRounds: value?.requestedRevisionRounds,
    requestedRefereeCount: value?.requestedRefereeCount,
    evaluatedAt: value?.evaluatedAt,
  });
  if (replay.status !== 'machine_proposal_policy_authorized'
    || replay.autonomousResearchPolicyAuthorizationHash
      !== value?.autonomousResearchPolicyAuthorizationHash) {
    blockers.push('autonomous_research_policy_authorization_replay_invalid');
    blockers.push(...replay.blockers);
  }
  return Object.freeze({
    valid: blockers.length === 0,
    status: blockers.length
      ? 'autonomous_research_policy_authorization_blocked'
      : 'autonomous_research_policy_authorization_verified',
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

export function buildAutonomousResearchSeedContractBundle({
  proposal,
  policyAuthorization,
  evidencePlan = [],
  reproducibilityPlan = [],
  createdAt = null,
} = {}) {
  const proposalVerification = verifyMachineProposedScientificClaimSet(proposal);
  const policyVerification = verifyAutonomousResearchPolicyAuthorization(policyAuthorization, { proposal });
  const blockers = [...proposalVerification.blockers, ...policyVerification.blockers];
  const dynamicFormalClaimSeed = proposal?.version === 2
    ? proposal.dynamicFormalClaimSeed : null;
  const dynamicFormalVerification = dynamicFormalClaimSeed
    ? verifyDynamicFormalClaimSeed(dynamicFormalClaimSeed, {
      claimKey: `${proposal?.paperId}:formal-support:1`,
    })
    : Object.freeze({ valid: true, blockers: Object.freeze([]) });
  blockers.push(...(dynamicFormalVerification.blockers || []));
  const claims = (proposal?.claims || []).map((claim, index) => Object.freeze({
    id: `${proposal.paperId}:autonomous_claim:${index + 1}`,
    kind: 'machine_proposed_claim_seed',
    status: 'machine_proposed_policy_authorized_for_bounded_execution',
    text: claim.statement,
    scientificClaimKey: claim.claimKey,
    verificationMode: claim.verificationMode,
    assumptions: claim.assumptions,
    quantifiers: claim.quantifiers,
    negativeBoundaries: claim.negativeBoundaries,
    proofObligations: claim.proofObligations,
    empiricalObligations: claim.empiricalObligations,
    machineProposedScientificClaimSetHash: proposal.machineProposedScientificClaimSetHash,
    ...(claim.verificationMode === 'formal_kernel' && dynamicFormalClaimSeed ? {
      dynamicFormalClaimSeedHash: dynamicFormalClaimSeed.dynamicFormalClaimSeedHash,
      leanDeclarationName: dynamicFormalClaimSeed.leanDeclarationName,
      leanTypeSource: dynamicFormalClaimSeed.leanTypeSource,
      leanTypeSourceHash: dynamicFormalClaimSeed.leanTypeSourceHash,
      leanNormalizedTypeHash: dynamicFormalClaimSeed.leanNormalizedTypeHash,
      allowedImports: dynamicFormalClaimSeed.allowedImports,
      formalClaimCapabilityScopeManifestHash:
        dynamicFormalClaimSeed.capabilityScopeManifestHash,
      formalClaimGeneratorReceiptHash: dynamicFormalClaimSeed.generatorReceiptHash,
    } : {}),
  }));
  if (!claims.length) blockers.push('autonomous_research_seed_claims_missing');
  const payload = {
    version: dynamicFormalClaimSeed ? 2 : 1,
    kind: 'AutonomousResearchSeedContractBundle',
    status: blockers.length
      ? 'autonomous_research_seed_contracts_blocked'
      : 'autonomous_research_seed_contracts_ready',
    paperId: proposal?.paperId || null,
    protocolFamily: proposal?.protocolFamily || null,
    formalSupportRegistryHash: proposal?.formalSupportRegistryHash || null,
    formalSupportTemplateId: proposal?.formalSupportTemplateId || null,
    formalSupportTemplateHash: proposal?.formalSupportTemplateHash || null,
    ...(dynamicFormalClaimSeed ? {
      formalSupportMode: 'dynamic-lean-type-v1',
      dynamicFormalClaimSeed,
      dynamicFormalClaimSeedHash: dynamicFormalClaimSeed.dynamicFormalClaimSeedHash,
    } : {}),
    claimAuthorityType: 'machine-policy-authorized',
    proposalHash: proposal?.machineProposedScientificClaimSetHash || null,
    policyAuthorizationHash: policyAuthorization?.autonomousResearchPolicyAuthorizationHash || null,
    scientificClaimInputHash: proposal?.machineProposedScientificClaimSetHash || null,
    claims: Object.freeze(claims),
    proof_obligations: Object.freeze(claims.flatMap((claim, claimIndex) => (
      claim.proofObligations.map((text, obligationIndex) => Object.freeze({
        id: `${proposal.paperId}:autonomous_proof:${claimIndex + 1}:${obligationIndex + 1}`,
        text,
        claimId: claim.id,
      }))
    ))),
    evidence: Object.freeze(unique(evidencePlan)),
    reproducibility: Object.freeze(unique(reproducibilityPlan)),
    blockers: Object.freeze([...new Set(blockers)]),
    warnings: Object.freeze([
      'machine_proposed_claims_require_kernel_and_empirical_verification',
      'machine_policy_authorization_is_not_operator_or_release_approval',
    ]),
    safety: Object.freeze({
      operatorApprovalClaimed: false,
      externalReleaseAttestationRequired: true,
      universalResearchValidityClaimed: false,
      naturalLanguageToLeanEquivalenceMachineProven: false,
    }),
    createdAt: createdAt || null,
  };
  return Object.freeze({
    ...payload,
    autonomousResearchSeedContractBundleHash:
      hashRecord('AutonomousResearchSeedContractBundle', payload),
  });
}

export function buildAutonomousResearchSeedBinding({
  seedBundle,
  contractPath = 'AUTONOMOUS_RESEARCH_SEED_CONTRACTS.json',
} = {}) {
  const blockers = [];
  if (!recordHashValid(
    seedBundle,
    'AutonomousResearchSeedContractBundle',
    'autonomousResearchSeedContractBundleHash',
  ) || seedBundle?.status !== 'autonomous_research_seed_contracts_ready'
    || seedBundle?.claimAuthorityType !== 'machine-policy-authorized') {
    blockers.push('autonomous_research_seed_bundle_invalid');
  }
  const normalizedPath = normalizeText(contractPath);
  if (!normalizedPath || normalizedPath.startsWith('/') || normalizedPath.includes('..')) {
    blockers.push('autonomous_research_seed_contract_path_invalid');
  }
  const payload = {
    version: 1,
    kind: 'AutonomousResearchSeedBinding',
    status: blockers.length ? 'autonomous_research_seed_blocked' : 'autonomous_research_seed_bound',
    claimAuthorityType: 'machine-policy-authorized',
    contractPath: normalizedPath || null,
    paperId: seedBundle?.paperId || null,
    proposalHash: seedBundle?.proposalHash || null,
    policyAuthorizationHash: seedBundle?.policyAuthorizationHash || null,
    seedBundleHash: seedBundle?.autonomousResearchSeedContractBundleHash || null,
    blockers: Object.freeze(blockers),
  };
  return Object.freeze({
    ...payload,
    autonomousResearchSeedBindingHash: hashRecord('AutonomousResearchSeedBinding', payload),
  });
}
