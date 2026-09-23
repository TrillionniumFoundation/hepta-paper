export function assertInventoryRepositoryPort(repository) {
  if (Number(repository?.version || 0) < 1) throw new Error('InventoryRepositoryPort.version 1 is required');
  if (typeof repository?.discover !== 'function') throw new Error('InventoryRepositoryPort.discover is required');
  return repository;
}
