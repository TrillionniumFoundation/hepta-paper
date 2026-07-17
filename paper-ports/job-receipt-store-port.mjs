export function assertJobReceiptStorePort(store) {
  for (const method of ['createJob', 'acquireLease', 'recordAttempt', 'renewAttemptLease', 'completeJob', 'failJob', 'get', 'list']) {
    if (typeof store?.[method] !== 'function') throw new Error(`JobReceiptStorePort.${method} is required`);
  }
  return store;
}
