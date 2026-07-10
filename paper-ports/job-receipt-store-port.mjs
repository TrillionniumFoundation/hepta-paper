export function assertJobReceiptStorePort(store) {
  for (const method of ['get', 'put', 'list']) {
    if (typeof store?.[method] !== 'function') throw new Error(`JobReceiptStorePort.${method} is required`);
  }
  return store;
}

