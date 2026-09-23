import {
  evaluateAutonomousResearchStateSafetyReadiness,
  unavailableAutonomousResearchOnlineAntiRollbackInspection,
} from '../../paper-domain/automation/autonomous-research-state-safety-contract.mjs';
import {
  composeAutonomousResearchStateBackupService,
} from '../bootstrap/autonomous-research-state-backup-composition.mjs';
import {
  inspectAutonomousResearchOnlineMutationPassiveEvidence,
} from '../../paper-adapters/automation/autonomous-research-online-mutation-passive-inspection.mjs';
import {
  createUnavailableExternallyFencedSqliteMutationCoordinator,
} from '../../paper-application/automation/unavailable-externally-fenced-sqlite-mutation-coordinator.mjs';
import {
  composeAutonomousResearchOnlineMutationCoordinator,
} from '../bootstrap/autonomous-research-online-mutation-composition.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';

function unavailableOnlineAntiRollbackInspection() {
  return unavailableAutonomousResearchOnlineAntiRollbackInspection({
    writerManifest: AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
  });
}

function blockedReadInspection(kind, status, blocker) {
  return Object.freeze({
    version: 1,
    kind,
    status,
    blockers: Object.freeze([blocker]),
  });
}

export function inspectAutonomousResearchStateSafety({
  workspaceRoot,
  runtimeRoot,
  now,
  environment = {},
  stateBackupService = null,
  composeStateBackupService = composeAutonomousResearchStateBackupService,
  onlineAntiRollbackInspection = null,
  inspectOnlineAntiRollback = inspectAutonomousResearchOnlineMutationPassiveEvidence,
  mutationCoordinator = null,
  composeMutationCoordinator = composeAutonomousResearchOnlineMutationCoordinator,
} = {}) {
  let service = stateBackupService;
  let inventory;
  let latestRestoreDrill;
  try {
    service ||= composeStateBackupService({
      workspaceRoot,
      runtimeRoot,
      authorityConfigurationPath:
        environment.HEPTA_AUTONOMOUS_RESEARCH_STATE_BACKUP_AUTHORITY_CONFIG || null,
    });
    inventory = service.inventory();
  } catch (error) {
    inventory = blockedReadInspection(
      'AutonomousResearchStateDatabaseInventory',
      'autonomous_research_state_database_inventory_blocked',
      `autonomous_research_state_database_inventory_inspection_failed:${error.message}`,
    );
  }
  try {
    if (!service) throw new Error('state_backup_service_unavailable');
    latestRestoreDrill = service.offhostSources();
    if (service.authorityConfigured !== true) {
      latestRestoreDrill = blockedReadInspection(
        'AutonomousResearchStateBackupSources',
        'autonomous_research_state_backup_sources_blocked',
        'autonomous_research_state_restore_authority_trust_configuration_required',
      );
    }
  } catch (error) {
    latestRestoreDrill = blockedReadInspection(
      'AutonomousResearchStateBackupSources',
      'autonomous_research_state_backup_sources_blocked',
      `autonomous_research_state_latest_restore_drill_inspection_failed:${error.message}`,
    );
  }
  let coordinator = mutationCoordinator;
  let coordinatorFailure = null;
  if (!coordinator
    && environment.HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_PROCESS_CONFIG
    && inventory?.status === 'autonomous_research_state_database_inventory_ready') {
    try {
      coordinator = composeMutationCoordinator({
        inventory,
        authorityProcessConfigurationPath:
          environment.HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_PROCESS_CONFIG,
        clock: { now: () => now },
      });
    } catch (error) {
      coordinatorFailure =
        `autonomous_research_online_mutation_coordinator_composition_failed:${error.message}`;
    }
  }
  coordinator ||= createUnavailableExternallyFencedSqliteMutationCoordinator();
  const coordinatorStatus = coordinator.inspectStatus();
  let observedOnlineAntiRollback = onlineAntiRollbackInspection;
  if (!observedOnlineAntiRollback
    && environment.HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_CONFIG
    && inventory?.status === 'autonomous_research_state_database_inventory_ready') {
    try {
      observedOnlineAntiRollback = inspectOnlineAntiRollback({
        workspaceRoot,
        runtimeRoot,
        inventory,
        authorityConfigurationPath:
          environment.HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_CONFIG,
        now,
        coordinatorStatus,
      });
    } catch (error) {
      const unavailable = unavailableOnlineAntiRollbackInspection();
      observedOnlineAntiRollback = Object.freeze({
        ...unavailable,
        blockers: Object.freeze([...new Set([
          ...unavailable.blockers,
          `autonomous_research_online_anti_rollback_inspection_failed:${error.message}`,
        ])].sort()),
      });
    }
  }
  if (!observedOnlineAntiRollback) {
    observedOnlineAntiRollback = unavailableOnlineAntiRollbackInspection();
  }
  if (coordinatorFailure) {
    const unavailable = observedOnlineAntiRollback
      || unavailableOnlineAntiRollbackInspection();
    observedOnlineAntiRollback = Object.freeze({
      ...unavailable,
      blockers: Object.freeze([...new Set([
        ...(unavailable.blockers || []),
        coordinatorFailure,
      ])].sort()),
    });
  }
  const inspection = evaluateAutonomousResearchStateSafetyReadiness({
    inventory,
    latestRestoreDrill,
    onlineAntiRollback: observedOnlineAntiRollback,
    now,
  });
  return Object.freeze({
    ...inspection,
    restoreAuthorityConfigured: service?.authorityConfigured === true,
    restoreAuthorityConfigurationHash:
      service?.authorityConfigurationHash || null,
    onlineMutationCoordinatorStatus: coordinatorStatus,
  });
}
