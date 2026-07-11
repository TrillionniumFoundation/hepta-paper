export function assertEmpiricalCachePort(cache) {
  for (const method of ['get', 'put']) {
    if (typeof cache?.[method] !== 'function') throw new Error(`EmpiricalCachePort.${method} is required`);
  }
  return cache;
}
