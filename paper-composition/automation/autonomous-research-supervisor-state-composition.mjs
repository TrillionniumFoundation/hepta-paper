import {
  createAutonomousResearchSupervisorStateRepository,
} from '../../paper-adapters/automation/autonomous-research-supervisor-state-repository.mjs';
import {
  createAutonomousResearchSupervisorInstanceRepository,
  inspectAutonomousResearchSupervisorInstanceStatus,
  inspectAutonomousResearchStrictMachineIntakeReconciliation,
  publishAutonomousResearchStrictMachineIntakeReconciliation,
} from '../../paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs';
import {
  createAutonomousResearchRuntimeRefreshStateRepository,
} from '../../paper-adapters/automation/autonomous-research-runtime-refresh-state-repository.mjs';
import {
  inspectAutonomousResearchResidentCycleReceipt,
  publishAutonomousResearchResidentCycleIntent,
} from '../../paper-adapters/automation/autonomous-research-resident-cycle-intent-repository.mjs';
import {
  assertExternallyFencedSqliteMutationCoordinatorPort,
} from '../../paper-ports/autonomous-research-online-mutation-port.mjs';
import {
  AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_DATABASE_INSTANCE_ID,
  AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_SCHEMA_CONTRACT_ID,
  AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_WRITER_ID,
} from '../../paper-adapters/automation/autonomous-research-supervisor-instance-mutation-plan.mjs';
import {
  AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_DATABASE_INSTANCE_ID,
  AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_SCHEMA_CONTRACT_ID,
  AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_WRITER_ID,
} from '../../paper-adapters/automation/autonomous-research-runtime-refresh-mutation-plan.mjs';
import {
  AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_DATABASE_INSTANCE_ID,
  AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_SCHEMA_CONTRACT_ID,
  AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_WRITER_ID,
} from '../../paper-adapters/automation/autonomous-research-supervisor-state-mutation-plan.mjs';

function assertReadyMutationCoordinator(coordinator, databaseRole, blocker) {
  try { assertExternallyFencedSqliteMutationCoordinatorPort(coordinator); }
  catch { throw new Error(blocker); }
  const status = coordinator.inspectStatus();
  if (coordinator.implemented !== true
    || status?.implemented !== true
    || status.status !== 'externally_fenced_sqlite_mutation_coordinator_ready'
    || !Array.isArray(status.blockers)
    || status.blockers.length !== 0
    || !coordinator.coveredDatabaseRoles?.includes(databaseRole)
    || !status.coveredDatabaseRoles?.includes(databaseRole)) {
    throw new Error(blocker);
  }
  return coordinator;
}

export function composeAutonomousResearchSupervisorState({
  runtimeRoot,
  runtimeRefreshPolicy,
  runtimeRefreshStateRepository = null,
  supervisorStateMutationCoordinator = null,
  supervisorStateDatabaseInstanceId =
    AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_DATABASE_INSTANCE_ID,
  supervisorStateSchemaContractId =
    AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_SCHEMA_CONTRACT_ID,
  supervisorStateWriterId = AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_WRITER_ID,
  requireExternallyFencedSupervisorState = false,
  residentInstanceMutationCoordinator = null,
  residentInstanceDatabaseInstanceId =
    AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_DATABASE_INSTANCE_ID,
  residentInstanceSchemaContractId =
    AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_SCHEMA_CONTRACT_ID,
  residentInstanceWriterId = AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_WRITER_ID,
  requireExternallyFencedResidentInstance = false,
  runtimeRefreshMutationCoordinator = null,
  runtimeRefreshDatabaseInstanceId =
    AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_DATABASE_INSTANCE_ID,
  runtimeRefreshSchemaContractId =
    AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_SCHEMA_CONTRACT_ID,
  runtimeRefreshWriterId = AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_WRITER_ID,
  requireExternallyFencedRuntimeRefresh = false,
} = {}) {
  if (!runtimeRoot) throw new Error('autonomous_research_supervisor_state_root_required');
  if (requireExternallyFencedSupervisorState) {
    assertReadyMutationCoordinator(
      supervisorStateMutationCoordinator,
      'supervisor-state',
      'autonomous_research_supervisor_state_external_mutation_coordinator_required',
    );
  }
  if (requireExternallyFencedResidentInstance) {
    assertReadyMutationCoordinator(
      residentInstanceMutationCoordinator,
      'resident-instance',
      'autonomous_research_supervisor_instance_external_mutation_coordinator_required',
    );
  }
  if (requireExternallyFencedRuntimeRefresh) {
    assertReadyMutationCoordinator(
      runtimeRefreshMutationCoordinator,
      'runtime-reproducibility-refresh',
      'runtime_reproducibility_refresh_external_mutation_coordinator_required',
    );
    if (runtimeRefreshStateRepository !== null) {
      throw new Error('runtime_reproducibility_refresh_external_repository_override_forbidden');
    }
  }
  const lifecycle = createAutonomousResearchSupervisorStateRepository({
    runtimeRoot,
    offlineProvision: !requireExternallyFencedSupervisorState,
    mutationCoordinator: supervisorStateMutationCoordinator,
    databaseInstanceId: supervisorStateDatabaseInstanceId,
    schemaContractId: supervisorStateSchemaContractId,
    writerId: supervisorStateWriterId,
    requireExternallyFencedMutations: requireExternallyFencedSupervisorState,
  });
  const residentInstance = createAutonomousResearchSupervisorInstanceRepository({
    runtimeRoot,
    offlineProvision: !requireExternallyFencedResidentInstance,
    mutationCoordinator: residentInstanceMutationCoordinator,
    databaseInstanceId: residentInstanceDatabaseInstanceId,
    schemaContractId: residentInstanceSchemaContractId,
    writerId: residentInstanceWriterId,
    requireExternallyFencedMutations: requireExternallyFencedResidentInstance,
  });
  const runtimeRefresh = runtimeRefreshStateRepository
    || createAutonomousResearchRuntimeRefreshStateRepository({
      runtimeRoot,
      policy: runtimeRefreshPolicy,
      offlineProvision: !requireExternallyFencedRuntimeRefresh,
      mutationCoordinator: runtimeRefreshMutationCoordinator,
      databaseInstanceId: runtimeRefreshDatabaseInstanceId,
      schemaContractId: runtimeRefreshSchemaContractId,
      writerId: runtimeRefreshWriterId,
      requireExternallyFencedMutations: requireExternallyFencedRuntimeRefresh,
    });
  return Object.freeze({ lifecycle, residentInstance, runtimeRefresh });
}

export function queryAutonomousResearchSupervisorInstanceStatus(options = {}) {
  return inspectAutonomousResearchSupervisorInstanceStatus(options);
}

export function publishStrictMachineIntakeReconciliation(options = {}) {
  return publishAutonomousResearchStrictMachineIntakeReconciliation(options);
}

export function queryStrictMachineIntakeReconciliation(options = {}) {
  return inspectAutonomousResearchStrictMachineIntakeReconciliation(options);
}

export function publishResidentCycleIntent(options = {}) {
  return publishAutonomousResearchResidentCycleIntent(options);
}

export function queryResidentCycleReceipt(options = {}) {
  return inspectAutonomousResearchResidentCycleReceipt(options);
}
