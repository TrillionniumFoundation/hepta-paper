import { failClosedStoreQueries, sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import {
  NATIVE_STORE_SUBMISSION_DELIVERY_MUTATION_PLANS,
} from '../persistence/native-store-submission-delivery-mutation-plan.mjs';
import { mapDeliveryRow, mapDeliveryRows } from './sqlite-delivery-row-mappers.mjs';

export { sqlJson, sqlText };

export function createSqliteDeliveryPersistence({ store: suppliedStore } = {}) {
  if (!suppliedStore) throw new Error('submission delivery persistence requires store');
  const store = failClosedStoreQueries(suppliedStore);
  const query = (sql) => store.query(sql);
  return Object.freeze({
    externallyFencedMutations: typeof suppliedStore.mutate === 'function',
    ...(typeof suppliedStore.mutate === 'function' ? {
      mutate(input = {}) {
        const plan = NATIVE_STORE_SUBMISSION_DELIVERY_MUTATION_PLANS[input.operationId];
        if (!plan || input.databaseRole !== 'native-store'
          || typeof input.mutate !== 'function'
          || !Array.isArray(input.authorizationReceiptHashes)
          || !Array.isArray(input.sideEffectReservationHashes)) {
          throw new Error('submission_delivery_mutation_input_invalid');
        }
        const receipt = suppliedStore.mutate(input);
        if (![
          'externally_fenced_sqlite_mutation_finalized',
          'externally_fenced_sqlite_mutation_no_change',
        ].includes(receipt?.status)) {
          throw new Error('submission_delivery_external_mutation_receipt_invalid');
        }
        return receipt.value;
      },
    } : {}),
    transaction(work) {
      if (typeof work !== 'function') throw new Error('submission delivery transaction callback is required');
      if (typeof suppliedStore.transaction !== 'function') throw new Error('submission delivery requires a transactional StorePort');
      return suppliedStore.transaction((transactionStore) => work(createSqliteDeliveryPersistence({ store: transactionStore })));
    },
    execute(sql) {
      const result = store.execute(sql);
      if (!result.ok) throw new Error(result.error || result.stderr || 'submission_delivery_store_failed');
      return result;
    },
    query(sql) {
      return query(sql);
    },
    one(sql) {
      return mapDeliveryRow(query(sql).rows[0]);
    },
    rows(sql) {
      return mapDeliveryRows(query(sql).rows);
    },
  });
}
