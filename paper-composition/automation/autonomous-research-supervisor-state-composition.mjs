import {
  createAutonomousResearchSupervisorStateRepository,
} from '../../paper-adapters/automation/autonomous-research-supervisor-state-repository.mjs';
import {
  createAutonomousResearchSupervisorInstanceRepository,
  inspectAutonomousResearchSupervisorInstanceStatus,
} from '../../paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs';
import {
  createAutonomousResearchRuntimeRefreshStateRepository,
} from '../../paper-adapters/automation/autonomous-research-runtime-refresh-state-repository.mjs';

export function composeAutonomousResearchSupervisorState({
  runtimeRoot,
  runtimeRefreshPolicy,
  runtimeRefreshStateRepository = null,
} = {}) {
  if (!runtimeRoot) throw new Error('autonomous_research_supervisor_state_root_required');
  const lifecycle = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  const residentInstance = createAutonomousResearchSupervisorInstanceRepository({ runtimeRoot });
  const runtimeRefresh = runtimeRefreshStateRepository
    || createAutonomousResearchRuntimeRefreshStateRepository({
      runtimeRoot,
      policy: runtimeRefreshPolicy,
    });
  return Object.freeze({ lifecycle, residentInstance, runtimeRefresh });
}

export function queryAutonomousResearchSupervisorInstanceStatus(options = {}) {
  return inspectAutonomousResearchSupervisorInstanceStatus(options);
}
