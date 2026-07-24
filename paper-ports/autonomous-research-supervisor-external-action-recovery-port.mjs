import {
  AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_RECOVERY_ACTION_KINDS,
} from '../paper-domain/automation/autonomous-research-supervisor-external-action-recovery-contract.mjs';

export function assertAutonomousResearchSupervisorExternalActionRecoveryPort(value, {
  now = new Date(),
} = {}) {
  if (!value
    || value.version !== 1
    || value.kind !== 'AutonomousResearchSupervisorExternalActionRecoveryPort'
    || typeof value.inspectCapabilities !== 'function'
    || typeof value.lookup !== 'function'
    || typeof value.resume !== 'function') {
    throw new Error('autonomous_research_supervisor_external_action_recovery_port_invalid');
  }
  const inspection = value.inspectCapabilities({ now });
  if (!inspection || typeof inspection.then === 'function'
    || inspection.ready !== true
    || inspection.signedCapabilityVerified !== true
    || inspection.authoritativeSignedLookupSupported !== true
    || inspection.definitiveNotFoundSupported !== true
    || inspection.idempotentResumeSupported !== true
    || JSON.stringify(inspection.actionKinds)
      !== JSON.stringify(AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_RECOVERY_ACTION_KINDS)
    || typeof inspection.configurationIdentityHash !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(inspection.configurationIdentityHash)) {
    throw new Error('autonomous_research_supervisor_external_action_recovery_port_not_ready');
  }
  return value;
}
