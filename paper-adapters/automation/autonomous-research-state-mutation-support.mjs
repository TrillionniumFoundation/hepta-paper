export function autonomousResearchStateMutationValue(receipt) {
  if (!receipt || !Object.prototype.hasOwnProperty.call(receipt, 'value')) {
    throw new Error('autonomous_research_supervisor_state_mutation_receipt_invalid');
  }
  return receipt.value;
}

export function buildAutonomousResearchStateMutationInput({
  database,
  databaseInstanceId,
  schemaContractId,
  writerId,
} = {}) {
  return Object.freeze({
    database,
    databaseInstanceId,
    schemaContractId,
    writerId,
    authorizationReceiptHashes: Object.freeze([]),
    sideEffectReservationHashes: Object.freeze([]),
  });
}
