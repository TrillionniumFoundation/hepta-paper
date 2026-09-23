export function assertUnitOfWorkPort(unitOfWork) {
  if (Number(unitOfWork?.version || 0) < 1) throw new Error('UnitOfWorkPort.version 1 is required');
  if (typeof unitOfWork?.run !== 'function') throw new Error('UnitOfWorkPort.run is required');
  return unitOfWork;
}
