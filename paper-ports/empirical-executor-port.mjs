export function assertEmpiricalExecutorPort(executor) {
  if (typeof executor?.execute !== 'function') throw new Error('EmpiricalExecutorPort.execute is required');
  if (typeof executor?.capabilities !== 'function') throw new Error('EmpiricalExecutorPort.capabilities is required');
  return executor;
}
