const MINTED_CAPABILITIES = new WeakSet();

export function createExperimentRegistryAuthorityVerifierCapability(verifier) {
  if (typeof verifier !== 'function') {
    throw new Error('ExperimentRegistryAuthorityVerifierPort verifier function is required');
  }
  const capability = function verifyExperimentRegistryAuthority(experiment, context) {
    return verifier(experiment, context);
  };
  Object.defineProperties(capability, {
    kind: { value: 'ExperimentRegistryAuthorityVerifierPort', enumerable: true },
    version: { value: 1, enumerable: true },
  });
  MINTED_CAPABILITIES.add(capability);
  return Object.freeze(capability);
}

export function assertExperimentRegistryAuthorityVerifierPort(verifier) {
  if (typeof verifier !== 'function'
    || verifier.kind !== 'ExperimentRegistryAuthorityVerifierPort'
    || verifier.version !== 1
    || !MINTED_CAPABILITIES.has(verifier)) {
    throw new Error('ExperimentRegistryAuthorityVerifierPort trusted capability is required');
  }
  return verifier;
}
