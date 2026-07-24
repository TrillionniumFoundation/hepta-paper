import {
  createAutonomousResearchSupervisorExternalActionRecoveryController,
} from '../../paper-application/automation/autonomous-research-supervisor-external-action-recovery-controller.mjs';
import {
  createAutonomousResearchSupervisorExternalActionRecoveryProcessAdapter,
  inspectAutonomousResearchSupervisorExternalActionRecoveryConfiguration,
} from '../../paper-adapters/automation/autonomous-research-supervisor-external-action-recovery-process-adapter.mjs';

export function composeAutonomousResearchSupervisorExternalActionRecovery({
  configPath,
  environment,
  clock,
  requireFullyAutonomous,
  stateRepository,
  providerConfiguration,
} = {}) {
  const inspection =
    inspectAutonomousResearchSupervisorExternalActionRecoveryConfiguration({
      configPath,
      environment,
      now: clock.now(),
    });
  if (requireFullyAutonomous && inspection.ready !== true) {
    throw new Error(inspection.blocker
      || 'autonomous_research_supervisor_external_action_recovery_required');
  }
  const externalActionRecoveryPort = inspection.ready
    ? createAutonomousResearchSupervisorExternalActionRecoveryProcessAdapter({
      configPath,
      environment,
      clock,
    }) : null;
  if (externalActionRecoveryPort
    && externalActionRecoveryPort.inspectCapabilities({ now: clock.now() })
      .actionConfigurationIdentityHashes['provider-canary']
      !== providerConfiguration.autonomousResearchProviderConfigurationHash) {
    throw new Error(
      'autonomous_research_supervisor_provider_recovery_configuration_identity_mismatch',
    );
  }
  const externalActionRecoveryController = externalActionRecoveryPort
    ? createAutonomousResearchSupervisorExternalActionRecoveryController({
      stateRepository,
      recoveryPort: externalActionRecoveryPort,
      clock,
    }) : null;
  return Object.freeze({
    externalActionRecoveryPort,
    externalActionRecoveryController,
  });
}
