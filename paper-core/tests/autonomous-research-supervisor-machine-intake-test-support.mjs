import { buildAutonomousResearchMachineIntake } from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export const supervisorMachineIntakeTestHash = (label) => (
  hashRecord('SupervisorMachineIntakeTestHash', { label })
);

export function machineIntakeTestScheduler() {
  return Object.freeze({
    async sleep() {},
    setInterval() { return {}; },
    clearInterval() {},
    unref() {},
  });
}

export function machineIntakeResidentLeaseContext() {
  const lease = Object.freeze({
    ownerId: 'resident:test',
    leaseToken: 'resident-lease:test',
    leaseGeneration: 1,
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  return Object.freeze({ lease, assertCurrent() { return lease; } });
}

export function buildSupervisorMachineIntake(label, now) {
  return buildAutonomousResearchMachineIntake({
    intakeId: `intake:${label}`,
    paperId: `paper:${label}`,
    campaignId: `autonomous-research:paper:${label}`,
    launchMode: 'production-run',
    admissionCreatedAt: now.toISOString(),
    objective: `Evaluate the bounded ${label} supervisor intake.`,
    protocolFamily: 'ml_algorithm_benchmark',
    datasetMounts: [{
      name: `dataset-${label}`,
      source: `/datasets/${label}`,
      readOnly: true,
      manifestHash: supervisorMachineIntakeTestHash(`dataset:${label}`),
      licenseId: 'CC0-1.0',
      benchmarkFamily: 'ml_algorithm_benchmark',
    }],
    budgets: {
      maxWallTimeMs: 60 * 60 * 1000,
      maxAgentCalls: 10,
      maxCpuJobs: 10,
      maxGpuJobs: 0,
      maxTokenCount: 10_000,
      maxCostUsd: 10,
      maxMemoryMiB: 2048,
    },
    providerConfigurationHash: supervisorMachineIntakeTestHash('provider'),
    recurringGoldenProvenance: null,
    revisionRounds: 1,
    refereeCount: 2,
  });
}

export function fullyAutonomousConstructorDependencies(scheduler) {
  return {
    campaignStore: { listCampaigns() { return []; } },
    stateRepository: { registerCampaign() {} },
    async dispatchCampaign() {},
    async readQualificationState() {},
    async ensureRuntimeReproducibility() {},
    async runProviderCanary() {},
    async renewQualification() {},
    scheduler,
    requireFullyAutonomous: true,
    inspectFullyAutonomousPrerequisites() {},
  };
}

export function fullyAutonomousResidentInstanceRepository() {
  return {
    acquireInstanceLease() {},
    markStartupReconciled() {},
    markMachineIntakeReconciled() {},
    markMachineIntakeReconciliationFailed() {},
    heartbeatInstanceLease() {},
    assertInstanceLease() {},
    releaseInstanceLease() {},
  };
}
