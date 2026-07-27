import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const ADMISSION_PREFLIGHT_INSPECTION_KEYS = Object.freeze([
  'autonomousResearchAdmissionPreflightExecutionInspectionHash',
  'externalActionPerformed',
  'kind',
  'localDaemonActionPerformed',
  'localDockerDaemonProbeCount',
  'localProcessActionPerformed',
  'networkActionPerformed',
  'processCount',
  'sandbox',
  'version',
].sort());

export function hasExplicitBudgetConfiguration(budgets) {
  return budgets && typeof budgets === 'object' && !Array.isArray(budgets)
    && Object.values(budgets).some((value) => value !== undefined);
}

export function loopPreparationFrom(report) {
  return report?.kind === 'AutonomousResearchReadinessCompositionReport'
    ? report.loopPreparation
    : report;
}

export function requireCampaignStore(campaignStore) {
  for (const method of ['createCampaign', 'getCampaign', 'listNodes', 'resumeCampaign']) {
    if (typeof campaignStore?.[method] !== 'function') {
      throw new Error('autonomous_research_campaign_store_required');
    }
  }
  return campaignStore;
}

export function requireAutonomousResearchAdmissionPreflightExecutionInspection(inspection) {
  const {
    autonomousResearchAdmissionPreflightExecutionInspectionHash: claimedHash,
    ...payload
  } = inspection || {};
  const processCount = Number(inspection?.processCount);
  const localDockerDaemonProbeCount = Number(inspection?.localDockerDaemonProbeCount);
  if (!inspection || Object.getPrototypeOf(inspection) !== Object.prototype
    || JSON.stringify(Object.keys(inspection).sort()) !== JSON.stringify(ADMISSION_PREFLIGHT_INSPECTION_KEYS)
    || inspection.version !== 1
    || inspection.kind !== 'AutonomousResearchAdmissionPreflightExecutionInspection'
    || inspection.sandbox !== 'bubblewrap-unshare-net-read-only-root-v1'
    || !Number.isSafeInteger(inspection.processCount) || processCount !== 8
    || !Number.isSafeInteger(inspection.localDockerDaemonProbeCount) || localDockerDaemonProbeCount !== 2
    || inspection.localProcessActionPerformed !== true
    || inspection.localDaemonActionPerformed !== true
    || inspection.networkActionPerformed !== false
    || inspection.externalActionPerformed !== false
    || hashRecord('AutonomousResearchAdmissionPreflightExecutionInspection', payload) !== claimedHash) {
    throw new Error('autonomous_research_admission_preflight_execution_inspection_invalid');
  }
  return inspection;
}
