import { failClosedStoreQueries, sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import { mapDeliveryRow, mapDeliveryRows } from './sqlite-delivery-row-mappers.mjs';

export { sqlJson, sqlText };

export function createSqliteDeliveryPersistence({ store: suppliedStore } = {}) {
  if (!suppliedStore) throw new Error('submission delivery persistence requires store');
  const store = failClosedStoreQueries(suppliedStore);
  const query = (sql) => store.query(sql);
  return Object.freeze({
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
    rollback() {
      return store.execute('ROLLBACK;');
    },
  });
}
