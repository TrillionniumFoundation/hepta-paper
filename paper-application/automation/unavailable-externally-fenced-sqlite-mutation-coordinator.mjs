import {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {
  assertExternallyFencedSqliteMutationCoordinatorPort,
} from '../../paper-ports/autonomous-research-online-mutation-port.mjs';

function unavailable() {
  throw new Error('externally_fenced_sqlite_mutation_coordinator_unavailable');
}

export function createUnavailableExternallyFencedSqliteMutationCoordinator() {
  return assertExternallyFencedSqliteMutationCoordinatorPort(Object.freeze({
    implemented: false,
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    coveredDatabaseRoles: Object.freeze([]),
    executeMutation: unavailable,
    recoverPendingMutations: unavailable,
    inspectStatus() {
      return Object.freeze({
        version: 1,
        kind: 'ExternallyFencedSqliteMutationCoordinatorStatus',
        status: 'externally_fenced_sqlite_mutation_coordinator_unavailable',
        implemented: false,
        coveredDatabaseRoles: Object.freeze([]),
        blockers: Object.freeze([
          'externally_fenced_sqlite_mutation_coordinator_unavailable',
          'autonomous_research_online_writer_manifest_100_percent_required',
        ]),
      });
    },
  }));
}
