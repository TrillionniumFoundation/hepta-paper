export function assertReceiptLedgerPort(ledger) {
  for (const method of ['record', 'get', 'list']) {
    if (typeof ledger?.[method] !== 'function') throw new Error(`ReceiptLedgerPort.${method} is required`);
  }
  return ledger;
}
