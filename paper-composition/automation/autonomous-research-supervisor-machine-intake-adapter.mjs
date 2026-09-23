export function createAutonomousResearchSupervisorMachineIntakeAdapter({
  repository,
  plane = null,
  loadFallback,
  enqueueIntake,
} = {}) {
  if (!repository) return null;
  if (typeof loadFallback !== 'function' || typeof enqueueIntake !== 'function'
    || (plane && typeof plane.loadConfiguredIntakes !== 'function')) {
    throw new Error('autonomous_research_supervisor_machine_intake_adapter_invalid');
  }
  return Object.freeze({
    repository,
    loadConfiguredIntakes({
      now,
      residentLeaseContext,
      operationMode = 'full',
      assertAutonomyCurrent,
    }) {
      const input = Object.freeze({
        now,
        residentLeaseContext,
        operationMode,
        assertAutonomyCurrent,
      });
      return plane ? plane.loadConfiguredIntakes(input) : loadFallback(input);
    },
    enqueueIntake,
  });
}
