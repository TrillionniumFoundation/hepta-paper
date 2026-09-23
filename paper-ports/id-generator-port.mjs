export function assertIdGeneratorPort(generator) {
  if (Number(generator?.version || 0) < 1) throw new Error('IdGeneratorPort.version 1 is required');
  if (typeof generator?.next !== 'function') throw new Error('IdGeneratorPort.next is required');
  return generator;
}
