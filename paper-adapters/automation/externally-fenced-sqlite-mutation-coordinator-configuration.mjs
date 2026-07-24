import {
  assertExternallyFencedSqliteMutationCoordinatorPort,
} from '../../paper-ports/autonomous-research-online-mutation-port.mjs';

const READY_STATUS = 'externally_fenced_sqlite_mutation_coordinator_ready';

export function validateExternallyFencedSqliteMutationCoordinatorConfiguration({
  mutationCoordinator,
  requireExternallyFencedMutations,
  offlineProvision,
  databaseRole,
  requiredErrorCode,
}) {
  if (mutationCoordinator !== null) {
    assertExternallyFencedSqliteMutationCoordinatorPort(mutationCoordinator);
  }
  if (!requireExternallyFencedMutations) return mutationCoordinator;

  const status = mutationCoordinator?.inspectStatus();
  if (offlineProvision
    || mutationCoordinator?.implemented !== true
    || status?.implemented !== true
    || status.status !== READY_STATUS
    || !Array.isArray(status.blockers)
    || status.blockers.length !== 0
    || !mutationCoordinator.coveredDatabaseRoles?.includes(databaseRole)
    || !status.coveredDatabaseRoles?.includes(databaseRole)) {
    throw new Error(requiredErrorCode);
  }
  return mutationCoordinator;
}
