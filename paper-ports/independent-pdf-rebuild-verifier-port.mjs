const MINTED_CAPABILITIES = new WeakSet();

export function createIndependentPdfRebuildVerifierCapability(rebuild) {
  if (typeof rebuild !== 'function') throw new Error('IndependentPdfRebuildVerifierPort rebuild function is required');
  const port = Object.freeze({
    version: 1,
    kind: 'IndependentPdfRebuildVerifierPort',
    rebuild,
  });
  MINTED_CAPABILITIES.add(port);
  return port;
}

export function assertIndependentPdfRebuildVerifierPort(port) {
  if (port?.version !== 1 || port?.kind !== 'IndependentPdfRebuildVerifierPort'
    || typeof port?.rebuild !== 'function' || !MINTED_CAPABILITIES.has(port)) {
    throw new Error('IndependentPdfRebuildVerifierPort trusted capability is required');
  }
  return port;
}
