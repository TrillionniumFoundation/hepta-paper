import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAutonomousResearchMachineIntake,
} from './autonomous-research-machine-intake-contract.mjs';
import {
  verifyAutonomousResearchMachineIntakeAdmission,
} from './autonomous-research-machine-intake-admission-contract.mjs';
import {
  verifyAutonomousResearchCapabilityScopeManifest,
} from './autonomous-research-capability-scope-manifest.mjs';

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
  const capabilityScopeManifestHash = preparation?.capabilityScopeManifest
    ?.autonomousResearchCapabilityScopeManifestHash || null;
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
    || !verifyAutonomousResearchCapabilityScopeManifest(
      preparation?.capabilityScopeManifest,
    )
    || preparation?.capabilityScopeManifestHash !== capabilityScopeManifestHash
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
    autonomousResearchLoopPreparationReportHash:
      preparation.autonomousResearchLoopPreparationReportHash,
    capabilityScopeManifestHash,
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
    'autonomousResearchLoopPreparationReportHash', 'capabilityScopeManifestHash',
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
    'providerConfigurationHash', 'autonomousResearchLoopPreparationReportHash',
    'capabilityScopeManifestHash', 'autonomousResearchMachineIntakeHash',
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
    'autonomousResearchLoopPreparationReportHash', 'capabilityScopeManifestHash',
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
