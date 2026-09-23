import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildAutonomousResearchMachineIntake,
  buildAutonomousResearchRecurringGoldenTemplate,
  materializeAutonomousResearchRecurringGoldenIntake,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import {
  buildAutonomousResearchMachineIntakeAdmission,
} from '../../paper-domain/automation/autonomous-research-machine-intake-admission-contract.mjs';

const H = (label) => hashRecord('AutonomousSupervisorTestHash', { label });

export function buildExecutionAdmittedSupervisorCampaign({
  launchMode = 'production-run',
  suffix = 'initial-admission',
} = {}) {
  const providerConfigurationHash = H(`provider:${suffix}`);
  const sourceAuthorityHash = H(`source:${suffix}`);
  const datasetMounts = Object.freeze([Object.freeze({
    name: `dataset-${suffix}`,
    source: `/datasets/${suffix}`,
    readOnly: true,
    manifestHash: H(`dataset:${suffix}`),
    licenseId: 'CC0-1.0',
    benchmarkFamily: 'ml_algorithm_benchmark',
  })]);
  const intake = launchMode === 'golden-bootstrap'
    ? materializeAutonomousResearchRecurringGoldenIntake({
      template: buildAutonomousResearchRecurringGoldenTemplate({
        templateId: `supervisor-${suffix}`,
        epochDurationMs: 12 * 60 * 60 * 1000,
        objective: `Run the execution-admitted campaign for ${suffix}.`,
        protocolFamily: 'ml_algorithm_benchmark',
        datasetMounts,
        providerConfigurationHash,
        revisionRounds: 1,
        refereeCount: 2,
      }),
      now: new Date('2026-07-17T00:00:00.000Z'),
      sourceAuthorityHash,
    })
    : buildAutonomousResearchMachineIntake({
      intakeId: `intake:${suffix}`,
      paperId: `paper-${suffix}`,
      campaignId: `autonomous-research:paper-${suffix}`,
      launchMode,
      admissionCreatedAt: '2026-07-17T00:00:00.000Z',
      objective: `Run the execution-admitted campaign for ${suffix}.`,
      protocolFamily: 'ml_algorithm_benchmark',
      datasetMounts,
      budgets: {
        maxWallTimeMs: 60 * 60 * 1000,
        maxAgentCalls: 10,
        maxCpuJobs: 10,
        maxGpuJobs: 0,
        maxTokenCount: 10_000,
        maxCostUsd: 10,
        maxMemoryMiB: 2048,
      },
      providerConfigurationHash,
      revisionRounds: 1,
      refereeCount: 2,
    });
  const sourceKind = launchMode === 'golden-bootstrap' ? 'recurring-golden' : 'machine';
  const admission = buildAutonomousResearchMachineIntakeAdmission({
    intake,
    sourceKind,
    sourceAuthorityHash,
  });
  const preparationPayload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchLoopPreparationReport',
    launchMode,
    autonomousResearchProviderConfigurationHash: providerConfigurationHash,
    autonomousResearchMachineIntakeAdmissionHash:
      admission.autonomousResearchMachineIntakeAdmissionHash,
    proposal: Object.freeze({ paperId: intake.paperId }),
  });
  const preparation = Object.freeze({
    ...preparationPayload,
    autonomousResearchLoopPreparationReportHash: hashRecord(
      'AutonomousResearchLoopPreparationReport', preparationPayload,
    ),
  });
  const executionAdmissionPayload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchCampaignExecutionAdmission',
    status: 'autonomous_research_campaign_admitted_not_authorized',
    initialCampaignStatus: 'paused',
    launchMode,
    supervisorDispatchAuthorizationRequired: true,
    autonomousResearchMachineIntakeHash: intake.intakeHash,
    autonomousResearchMachineIntakeAdmissionHash:
      admission.autonomousResearchMachineIntakeAdmissionHash,
    providerConfigurationHash,
  });
  const planPayload = Object.freeze({
    version: 4,
    kind: 'PaperCampaignPlan',
    campaignId: intake.campaignId,
    paperId: intake.paperId,
    budgets: intake.budgets,
    autonomousResearchPreparation: preparation,
    autonomousResearchMachineIntake: intake,
    autonomousResearchMachineIntakeHash: intake.intakeHash,
    autonomousResearchMachineIntakeAdmission: admission,
    autonomousResearchMachineIntakeAdmissionHash:
      admission.autonomousResearchMachineIntakeAdmissionHash,
    executionAdmission: Object.freeze({
      ...executionAdmissionPayload,
      autonomousResearchCampaignExecutionAdmissionHash: hashRecord(
        'AutonomousResearchCampaignExecutionAdmission', executionAdmissionPayload,
      ),
    }),
  });
  return Object.freeze({
    campaignId: intake.campaignId,
    paperId: intake.paperId,
    status: 'paused',
    effectiveStatus: 'paused',
    currentPhase: 'admitted-not-authorized',
    stopReason: null,
    costKnown: true,
    costUsd: 0,
    spec: Object.freeze({
      ...planPayload,
      campaignPlanHash: hashRecord('PaperCampaignPlan', planPayload),
    }),
  });
}

export function buildMachineIntakeExecutionAdmission(executionAdmissionHash) {
  return Object.freeze({
    initialCampaignStatus: 'paused',
    supervisorDispatchAuthorizationRequired: true,
    autonomousResearchCampaignExecutionAdmissionHash: executionAdmissionHash,
  });
}

export function buildCanonicalAdmissionPreflightExecutionInspection() {
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchAdmissionPreflightExecutionInspection',
    sandbox: 'bubblewrap-unshare-net-read-only-root-v1',
    processCount: 8,
    localDockerDaemonProbeCount: 2,
    localProcessActionPerformed: true,
    localDaemonActionPerformed: true,
    networkActionPerformed: false,
    externalActionPerformed: false,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchAdmissionPreflightExecutionInspectionHash: hashRecord(
      'AutonomousResearchAdmissionPreflightExecutionInspection', payload,
    ),
  });
}
