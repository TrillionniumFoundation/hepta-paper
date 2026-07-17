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
