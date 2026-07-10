export function assertHasherPort(hasher) {
  for (const method of ['hashText', 'hashFile', 'hashRecord']) {
    if (typeof hasher?.[method] !== 'function') throw new Error(`HasherPort.${method} is required`);
  }
  return hasher;
}
