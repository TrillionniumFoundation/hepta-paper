import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAutonomousResearchMachineIntake,
} from './autonomous-research-machine-intake-contract.mjs';
import {
  verifyAutonomousResearchMachineIntakeAdmission,
} from './autonomous-research-machine-intake-admission-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export function createAutonomousResearchGlobalGoldenQualificationAuthority({
  campaignId,
  paperId,
  campaignPlanHash,
  preparation,
  machineIntake = null,
  machineIntakeAdmission = null,
} = {}) {
  if (preparation?.launchMode !== 'golden-bootstrap') return null;
  if (!machineIntake && !machineIntakeAdmission) return null;
  const provenance = machineIntake?.recurringGoldenProvenance || null;
  if (!verifyAutonomousResearchMachineIntake(machineIntake)
    || !verifyAutonomousResearchMachineIntakeAdmission(
      machineIntakeAdmission,
      { intake: machineIntake },
    )
    || machineIntake.launchMode !== 'golden-bootstrap'
    || machineIntake.campaignId !== campaignId
    || machineIntake.paperId !== paperId
    || machineIntake.providerConfigurationHash
      !== preparation?.autonomousResearchProviderConfigurationHash
    || preparation?.autonomousResearchMachineIntakeAdmissionHash
      !== machineIntakeAdmission.autonomousResearchMachineIntakeAdmissionHash
    || machineIntakeAdmission.sourceKind !== 'recurring-golden'
    || !provenance
    || machineIntakeAdmission.sourceAuthorityHash !== provenance.sourceAuthorityHash) {
    throw new Error('autonomous_research_global_golden_qualification_authority_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchGlobalGoldenQualificationAuthority',
    status: 'autonomous_research_global_golden_qualification_authority_bound',
    campaignId,
    paperId,
    campaignPlanHash,
    launchMode: 'golden-bootstrap',
    providerConfigurationHash: machineIntake.providerConfigurationHash,
    autonomousResearchMachineIntakeHash: machineIntake.intakeHash,
    autonomousResearchMachineIntakeAdmissionHash:
      machineIntakeAdmission.autonomousResearchMachineIntakeAdmissionHash,
    sourceKind: machineIntakeAdmission.sourceKind,
    sourceAuthorityHash: machineIntakeAdmission.sourceAuthorityHash,
    configurationAuthorityHash: provenance.sourceAuthorityHash,
    recurringGoldenTemplateId: provenance.templateId,
    recurringGoldenTemplateHash: provenance.templateHash,
    recurringGoldenEpochStart: provenance.epochStart,
    recurringGoldenEpochDurationMs: provenance.epochDurationMs,
  });
  if (!['campaignPlanHash', 'providerConfigurationHash',
    'autonomousResearchMachineIntakeHash',
    'autonomousResearchMachineIntakeAdmissionHash', 'sourceAuthorityHash',
    'configurationAuthorityHash', 'recurringGoldenTemplateHash']
    .every((field) => SHA256.test(String(payload[field] || '')))) {
    throw new Error('autonomous_research_global_golden_qualification_authority_invalid');
  }
  return Object.freeze({
    ...payload,
    autonomousResearchGlobalGoldenQualificationAuthorityHash: hashRecord(
      'AutonomousResearchGlobalGoldenQualificationAuthority',
      payload,
    ),
  });
}

export function verifyAutonomousResearchGlobalGoldenQualificationAuthority(
  authority,
  expected = {},
) {
  const {
    autonomousResearchGlobalGoldenQualificationAuthorityHash: claimedHash,
    ...payload
  } = authority || {};
  const blockers = [];
  if (authority?.version !== 1
    || authority?.kind !== 'AutonomousResearchGlobalGoldenQualificationAuthority'
    || authority?.status
      !== 'autonomous_research_global_golden_qualification_authority_bound'
    || authority?.launchMode !== 'golden-bootstrap'
    || authority?.sourceKind !== 'recurring-golden'
    || authority?.sourceAuthorityHash !== authority?.configurationAuthorityHash
    || !SHA256.test(String(claimedHash || ''))
    || hashRecord('AutonomousResearchGlobalGoldenQualificationAuthority', payload)
      !== claimedHash) {
    blockers.push('autonomous_research_global_golden_qualification_authority_record_invalid');
  }
  for (const field of [
    'campaignId', 'paperId', 'campaignPlanHash', 'launchMode',
    'providerConfigurationHash', 'autonomousResearchMachineIntakeHash',
    'autonomousResearchMachineIntakeAdmissionHash', 'sourceKind',
    'sourceAuthorityHash', 'configurationAuthorityHash',
    'recurringGoldenTemplateId', 'recurringGoldenTemplateHash',
    'recurringGoldenEpochStart', 'recurringGoldenEpochDurationMs',
  ]) {
    if (expected[field] !== undefined && authority?.[field] !== expected[field]) {
      blockers.push(`autonomous_research_global_golden_qualification_authority_${field}_mismatch`);
    }
  }
  if (!['campaignPlanHash', 'providerConfigurationHash',
    'autonomousResearchMachineIntakeHash',
    'autonomousResearchMachineIntakeAdmissionHash', 'sourceAuthorityHash',
    'configurationAuthorityHash', 'recurringGoldenTemplateHash']
    .every((field) => SHA256.test(String(authority?.[field] || '')))) {
    blockers.push('autonomous_research_global_golden_qualification_authority_hash_fields_invalid');
  }
  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

export function inspectAutonomousResearchGlobalGoldenQualificationAuthority({
  campaign,
  campaignReleaseAuthority,
  preparation = null,
} = {}) {
  const blockers = [];
  const plan = campaign?.spec || null;
  const persistedPreparation = plan?.autonomousResearchPreparation || null;
  const effectivePreparation = preparation || persistedPreparation;
  const { campaignPlanHash: claimedPlanHash, ...planPayload } = plan || {};
  if (!plan || !SHA256.test(String(claimedPlanHash || ''))
    || hashRecord('PaperCampaignPlan', planPayload) !== claimedPlanHash
    || effectivePreparation?.autonomousResearchLoopPreparationReportHash
      !== persistedPreparation?.autonomousResearchLoopPreparationReportHash) {
    blockers.push('autonomous_research_global_golden_campaign_plan_invalid');
  }
  let expectedAuthority = null;
  try {
    expectedAuthority = createAutonomousResearchGlobalGoldenQualificationAuthority({
      campaignId: campaign?.campaignId,
      paperId: campaign?.paperId,
      campaignPlanHash: claimedPlanHash,
      preparation: effectivePreparation,
      machineIntake: plan?.autonomousResearchMachineIntake || null,
      machineIntakeAdmission: plan?.autonomousResearchMachineIntakeAdmission || null,
    });
  } catch {
    blockers.push('autonomous_research_global_golden_machine_intake_authority_invalid');
  }
  if (!expectedAuthority) {
    blockers.push('autonomous_research_global_golden_recurring_machine_intake_required');
  }
  const releaseBundle = campaignReleaseAuthority?.releaseBundle || null;
  const releaseBinding = releaseBundle?.autonomousResearchReleaseBinding || null;
  const releaseBindingInspection = verifyAutonomousResearchReleaseBinding(
    releaseBinding,
    {
      campaignId: campaign?.campaignId,
      paperId: campaign?.paperId,
      campaignPlanHash: claimedPlanHash,
      launchMode: 'golden-bootstrap',
      globalGoldenQualificationAuthorityHash:
        expectedAuthority?.autonomousResearchGlobalGoldenQualificationAuthorityHash,
    },
  );
  if (campaign?.status !== 'completed'
    || campaignReleaseAuthority?.status !== 'current_completed_release'
    || campaignReleaseAuthority?.campaignStatus !== 'completed'
    || campaignReleaseAuthority?.packageNodeStatus !== 'completed'
    || campaignReleaseAuthority?.campaignId !== campaign?.campaignId
    || campaignReleaseAuthority?.paperId !== campaign?.paperId
    || !SHA256.test(String(campaignReleaseAuthority?.campaignReleaseBundleHash || ''))
    || releaseBundle?.campaignReleaseBundleHash
      !== campaignReleaseAuthority?.campaignReleaseBundleHash
    || releaseBundle?.campaignPlanHash !== claimedPlanHash
    || releaseBundle?.autonomousResearchReleaseBindingHash
      !== releaseBinding?.autonomousResearchReleaseBindingHash
    || releaseBindingInspection.valid !== true
    || releaseBinding?.globalGoldenQualificationAuthorityHash
      !== expectedAuthority?.autonomousResearchGlobalGoldenQualificationAuthorityHash) {
    blockers.push('autonomous_research_global_golden_current_release_authority_mismatch');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchGlobalGoldenQualificationAuthorityInspection',
    status: blockers.length
      ? 'autonomous_research_global_golden_qualification_authority_blocked'
      : 'autonomous_research_global_golden_qualification_authority_verified',
    ready: blockers.length === 0,
    campaignId: campaign?.campaignId || null,
    paperId: campaign?.paperId || null,
    campaignPlanHash: claimedPlanHash || null,
    campaignReleaseBundleHash:
      campaignReleaseAuthority?.campaignReleaseBundleHash || null,
    globalGoldenQualificationAuthorityHash:
      expectedAuthority?.autonomousResearchGlobalGoldenQualificationAuthorityHash || null,
    authority: blockers.length ? null : expectedAuthority,
    blockers: Object.freeze([...new Set([
      ...blockers,
      ...releaseBindingInspection.blockers,
    ])]),
  });
  return Object.freeze({
    ...payload,
    autonomousResearchGlobalGoldenQualificationAuthorityInspectionHash: hashRecord(
      'AutonomousResearchGlobalGoldenQualificationAuthorityInspection',
      payload,
    ),
  });
}

export function createAutonomousResearchReleaseBinding({
  campaignId,
  paperId,
  campaignPlanHash,
  preparation,
  machineIntake = null,
  machineIntakeAdmission = null,
} = {}) {
  if (!preparation) return null;
  const globalGoldenQualificationAuthority =
    createAutonomousResearchGlobalGoldenQualificationAuthority({
      campaignId,
      paperId,
      campaignPlanHash,
      preparation,
      machineIntake,
      machineIntakeAdmission,
    });
  const payload = {
    version: 1,
    kind: 'AutonomousResearchReleaseBinding',
    campaignId: String(campaignId || ''),
    paperId: String(paperId || ''),
    campaignPlanHash: String(campaignPlanHash || ''),
    launchMode: preparation?.launchMode || null,
    proposalHash: preparation?.proposal?.machineProposedScientificClaimSetHash || null,
    policyAuthorizationHash:
      preparation?.policyAuthorization?.autonomousResearchPolicyAuthorizationHash || null,
    seedBindingHash: preparation?.seedBinding?.autonomousResearchSeedBindingHash || null,
    globalGoldenQualificationAuthorityHash:
      globalGoldenQualificationAuthority
        ?.autonomousResearchGlobalGoldenQualificationAuthorityHash || null,
    globalGoldenQualificationAuthority,
  };
  if (!payload.campaignId || !payload.paperId
    || !['golden-bootstrap', 'production-run'].includes(payload.launchMode)
    || !['campaignPlanHash', 'proposalHash', 'policyAuthorizationHash', 'seedBindingHash']
      .every((field) => SHA256.test(String(payload[field] || '')))) {
    throw new Error('autonomous_research_release_binding_input_invalid');
  }
  return Object.freeze({
    ...payload,
    autonomousResearchReleaseBindingHash:
      hashRecord('AutonomousResearchReleaseBinding', payload),
  });
}

export function verifyAutonomousResearchReleaseBinding(binding, expected = {}) {
  const blockers = [];
  const { autonomousResearchReleaseBindingHash: claimedHash, ...payload } = binding || {};
  if (binding?.version !== 1 || binding?.kind !== 'AutonomousResearchReleaseBinding'
    || !SHA256.test(String(claimedHash || ''))
    || hashRecord('AutonomousResearchReleaseBinding', payload) !== claimedHash) {
    blockers.push('autonomous_research_release_binding_record_invalid');
  }
  for (const field of [
    'campaignId', 'paperId', 'campaignPlanHash', 'launchMode', 'proposalHash',
    'policyAuthorizationHash', 'seedBindingHash',
    'globalGoldenQualificationAuthorityHash',
  ]) {
    if (expected[field] !== undefined && binding?.[field] !== expected[field]) {
      blockers.push(`autonomous_research_release_binding_${field}_mismatch`);
    }
  }
  if (!['campaignPlanHash', 'proposalHash', 'policyAuthorizationHash', 'seedBindingHash']
    .every((field) => SHA256.test(String(binding?.[field] || '')))) {
    blockers.push('autonomous_research_release_binding_hash_fields_invalid');
  }
  const globalAuthority = binding?.globalGoldenQualificationAuthority || null;
  if (Boolean(globalAuthority)
      !== Boolean(binding?.globalGoldenQualificationAuthorityHash)
    || (globalAuthority && (
      verifyAutonomousResearchGlobalGoldenQualificationAuthority(globalAuthority, {
        campaignId: binding.campaignId,
        paperId: binding.paperId,
        campaignPlanHash: binding.campaignPlanHash,
        launchMode: binding.launchMode,
      }).valid !== true
      || binding.globalGoldenQualificationAuthorityHash
        !== globalAuthority.autonomousResearchGlobalGoldenQualificationAuthorityHash
    ))) {
    blockers.push('autonomous_research_release_binding_global_golden_authority_invalid');
  }
  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}
