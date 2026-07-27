import {
  inspectAutonomousResearchCampaignExecutionAdmission,
} from '../../paper-domain/automation/autonomous-research-campaign-execution-admission.mjs';
import {
  verifyAutonomousResearchSupervisorDispatchAuthorization,
} from './autonomous-research-supervisor-dispatch-authorization.mjs';

const MUTATING_ACTIONS = new Set(['launch', 'resume', 'converge']);

function machineIntakeDispatchBinding(campaign, action) {
  if (!MUTATING_ACTIONS.has(action)) return null;
  const inspection = inspectAutonomousResearchCampaignExecutionAdmission(campaign?.spec);
  if (!inspection.present) return null;
  if (!inspection.valid || inspection.binding.campaignId !== campaign?.campaignId) {
    throw new Error('autonomous_research_machine_intake_dispatch_binding_invalid');
  }
  return Object.freeze({
    ...inspection.binding,
    action,
  });
}

export function autonomousResearchCampaignDispatchAuthorizationTime(runtime) {
  const observed = runtime?.clock?.now ? runtime.clock.now() : new Date();
  const now = observed instanceof Date ? observed : new Date(observed);
  if (!Number.isFinite(now.getTime())) {
    throw new Error('autonomous_research_supervisor_dispatch_authorization_clock_invalid');
  }
  return now;
}

export function requireAutonomousResearchCampaignDispatchAuthorization({
  campaign,
  action,
  authorization,
  runtime,
  consume = false,
} = {}) {
  const binding = machineIntakeDispatchBinding(campaign, action);
  if (!binding) return false;
  if (!verifyAutonomousResearchSupervisorDispatchAuthorization({
    authorization,
    ...binding,
    now: autonomousResearchCampaignDispatchAuthorizationTime(runtime),
    consume,
  })) {
    throw new Error('autonomous_research_supervisor_dispatch_authorization_invalid');
  }
  return true;
}
