import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactPlainObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import {
  verifyAutonomousResearchMachineIntakeAdmission,
} from './autonomous-research-machine-intake-admission-contract.mjs';
import {
  verifyAutonomousResearchMachineIntake,
} from './autonomous-research-machine-intake-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const MACHINE_MARKER_KEYS = Object.freeze([
  'autonomousResearchMachineIntake',
  'autonomousResearchMachineIntakeHash',
  'autonomousResearchMachineIntakeAdmission',
  'autonomousResearchMachineIntakeAdmissionHash',
  'executionAdmission',
]);
const EXECUTION_ADMISSION_KEYS = Object.freeze([
  'autonomousResearchCampaignExecutionAdmissionHash',
  'autonomousResearchMachineIntakeAdmissionHash',
  'autonomousResearchMachineIntakeHash',
  'initialCampaignStatus',
  'kind',
  'launchMode',
  'providerConfigurationHash',
  'status',
  'supervisorDispatchAuthorizationRequired',
  'version',
].sort());

export function inspectAutonomousResearchCampaignExecutionAdmission(spec = null) {
  const markerPresence = MACHINE_MARKER_KEYS.map((key) => Object.hasOwn(spec || {}, key));
  const preparationMachineBindingPresent = Object.hasOwn(
    spec?.autonomousResearchPreparation || {},
    'autonomousResearchMachineIntakeAdmissionHash',
  );
  const present = markerPresence.some(Boolean) || preparationMachineBindingPresent;
  if (!present) return Object.freeze({ present: false, valid: true, binding: null });
  const intake = spec?.autonomousResearchMachineIntake;
  const intakeAdmission = spec?.autonomousResearchMachineIntakeAdmission;
  const executionAdmission = spec?.executionAdmission;
  const preparation = spec?.autonomousResearchPreparation;
  const { autonomousResearchCampaignExecutionAdmissionHash: claimedHash, ...payload } =
    executionAdmission || {};
  const { campaignPlanHash, ...planPayload } = spec || {};
  const valid = markerPresence.every(Boolean)
    && verifyAutonomousResearchMachineIntake(intake)
    && verifyAutonomousResearchMachineIntakeAdmission(intakeAdmission, { intake })
    && spec.autonomousResearchMachineIntakeHash === intake.intakeHash
    && spec.autonomousResearchMachineIntakeAdmissionHash
      === intakeAdmission.autonomousResearchMachineIntakeAdmissionHash
    && exactKeys(executionAdmission, EXECUTION_ADMISSION_KEYS)
    && executionAdmission.version === 1
    && executionAdmission.kind === 'AutonomousResearchCampaignExecutionAdmission'
    && executionAdmission.status === 'autonomous_research_campaign_admitted_not_authorized'
    && executionAdmission.initialCampaignStatus === 'paused'
    && executionAdmission.supervisorDispatchAuthorizationRequired === true
    && ['golden-bootstrap', 'production-run'].includes(executionAdmission.launchMode)
    && executionAdmission.autonomousResearchMachineIntakeHash === intake.intakeHash
    && executionAdmission.autonomousResearchMachineIntakeAdmissionHash
      === intakeAdmission.autonomousResearchMachineIntakeAdmissionHash
    && executionAdmission.launchMode === intake.launchMode
    && executionAdmission.launchMode === preparation?.launchMode
    && executionAdmission.providerConfigurationHash === intake.providerConfigurationHash
    && executionAdmission.providerConfigurationHash
      === preparation?.autonomousResearchProviderConfigurationHash
    && preparation?.autonomousResearchMachineIntakeAdmissionHash
      === intakeAdmission.autonomousResearchMachineIntakeAdmissionHash
    && intake.campaignId === spec?.campaignId && intake.paperId === spec?.paperId
    && SHA256.test(String(claimedHash || ''))
    && hashRecord('AutonomousResearchCampaignExecutionAdmission', payload) === claimedHash
    && SHA256.test(String(campaignPlanHash || ''))
    && hashRecord('PaperCampaignPlan', planPayload) === campaignPlanHash;
  return Object.freeze({
    present: true,
    valid,
    binding: valid ? Object.freeze({
      campaignId: spec.campaignId,
      campaignPlanHash,
      launchMode: executionAdmission.launchMode,
      providerConfigurationHash: executionAdmission.providerConfigurationHash,
      executionAdmissionHash: claimedHash,
    }) : null,
  });
}
