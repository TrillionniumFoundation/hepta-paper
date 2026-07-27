import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function createWorkerExecutionIdentityIssuer(issuedExecutionIdentities) {
  if (!(issuedExecutionIdentities instanceof WeakMap)) {
    throw new TypeError('worker_execution_identity_registry_required');
  }
  return (payload) => {
    const identity = Object.freeze({
      ...payload,
      runtimeIdentityHash: hashRecord('WorkerExecutionRuntimeIdentity', payload),
    });
    issuedExecutionIdentities.set(identity, { identity, consumed: false });
    return identity;
  };
}
