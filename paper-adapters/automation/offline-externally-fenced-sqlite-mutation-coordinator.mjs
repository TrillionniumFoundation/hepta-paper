import {
  createExternallyFencedSqliteMutationTransaction,
} from './externally-fenced-sqlite-mutation-plan.mjs';

function fail(code) {
  throw new Error(code);
}

export function createOfflineExternallyFencedSqliteMutationCoordinator({
  operationPlans,
  databaseRole,
  databaseInstanceId,
  schemaContractId,
  writerId,
  inputInvalidError,
  asyncMutationError,
  recoveryUnavailableError,
  statusBlocker,
  receiptKind,
} = {}) {
  return Object.freeze({
    implemented: false,
    coveredDatabaseRoles: Object.freeze([]),
    executeMutation(input) {
      const plan = operationPlans[input?.operationId];
      if (!plan
        || input?.databaseRole !== databaseRole
        || input?.databaseInstanceId !== databaseInstanceId
        || input?.schemaContractId !== schemaContractId
        || input?.writerId !== writerId
        || !input?.database
        || typeof input.mutate !== 'function'
        || input.database.isTransaction) {
        fail(inputInvalidError);
      }
      let transaction = null;
      let began = false;
      try {
        input.database.exec('BEGIN IMMEDIATE;');
        began = true;
        transaction = createExternallyFencedSqliteMutationTransaction(
          input.database,
          plan,
        );
        let value;
        try { value = input.mutate(transaction.transaction); }
        finally { transaction.revoke(); }
        if (value && typeof value.then === 'function') {
          fail(asyncMutationError);
        }
        input.database.exec('COMMIT;');
        began = false;
        return Object.freeze({
          version: 1,
          kind: receiptKind,
          status: 'offline_unfenced_compatibility_mutation_committed',
          value,
          sideEffectPermitHash: null,
        });
      } catch (error) {
        if (began && input.database.isTransaction) {
          try { input.database.exec('ROLLBACK;'); }
          catch { /* preserve original failure */ }
        }
        throw error;
      }
    },
    recoverPendingMutations() {
      fail(recoveryUnavailableError);
    },
    inspectStatus() {
      return Object.freeze({
        version: 1,
        kind: 'ExternallyFencedSqliteMutationCoordinatorStatus',
        status: 'externally_fenced_sqlite_mutation_coordinator_unavailable',
        implemented: false,
        coveredDatabaseRoles: Object.freeze([]),
        blockers: Object.freeze([statusBlocker]),
      });
    },
  });
}
