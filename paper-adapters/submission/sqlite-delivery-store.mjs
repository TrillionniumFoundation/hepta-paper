import { createSqliteDeliveryConsumptionOperations } from './sqlite-delivery-consumption-operations.mjs';
import { createSqliteDeliveryOutboxOperations } from './sqlite-delivery-outbox-operations.mjs';
import { createSqliteDeliveryPersistence } from './sqlite-delivery-persistence.mjs';
import { createSqliteDeliveryRedriveOperations } from './sqlite-delivery-redrive-operations.mjs';
import { createSqliteDeliveryResponseOperations } from './sqlite-delivery-response-operations.mjs';

export function createSqliteSubmissionDeliveryStore({ store, receiptLedger, clock, executorResponseVerifier = null, providerCapabilityVerifier = null } = {}) {
  if (!store || !receiptLedger || !clock) throw new Error('Delivery store requires store, receiptLedger and clock');
  const persistence = createSqliteDeliveryPersistence({ store });
  let api = null;
  const dependencies = { persistence, receiptLedger, clock, executorResponseVerifier, providerCapabilityVerifier, getApi: () => api };
  api = {
    version: 1,
    kind: 'SqliteSubmissionDeliveryStore',
    ...createSqliteDeliveryOutboxOperations(dependencies),
    ...createSqliteDeliveryResponseOperations(dependencies),
    ...createSqliteDeliveryRedriveOperations(dependencies),
    ...createSqliteDeliveryConsumptionOperations(dependencies),
  };
  return Object.freeze(api);
}
