export function assertResearchExecutionReleaseAttestorPort(port) {
  if (!port || port.version !== 1 || port.kind !== 'ResearchExecutionReleaseAttestorPort'
    || typeof port.attestCapsuleManifest !== 'function'
    || typeof port.verifyAttestation !== 'function'
    || typeof port.verifyDetachedSignature !== 'function'
    || typeof port.inspectConfiguration !== 'function') {
    throw new Error('ResearchExecutionReleaseAttestorPort v1 is required');
  }
  return port;
}
