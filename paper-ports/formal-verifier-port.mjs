export function assertFormalVerifierPort(verifier) {
  if (!verifier?.verifierId) throw new Error('FormalVerifierPort.verifierId is required');
  if (typeof verifier.verify !== 'function') throw new Error('FormalVerifierPort.verify is required');
  return verifier;
}

