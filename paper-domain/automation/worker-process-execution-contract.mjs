import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export function verifyWorkerProcessExecutionIdentity(receipt, { requireObservedProcess = false } = {}) {
  const identity = receipt?.executionProcessIdentity;
  if (!identity && !receipt?.executionProcessIdentityHash) return !requireObservedProcess;
  if (!identity || identity.version !== 1 || identity.kind !== 'OsSandboxWorkerProcessIdentity'
    || Object.keys(identity).sort().join('\0') !== ['kind', 'launcherPid', 'processInvocationId', 'version'].sort().join('\0')
    || !SHA256.test(String(identity.processInvocationId || ''))
    || (identity.launcherPid !== null && (!Number.isSafeInteger(identity.launcherPid) || identity.launcherPid < 1))
    || (requireObservedProcess && identity.launcherPid === null)) return false;
  return SHA256.test(String(receipt.executionProcessIdentityHash || ''))
    && receipt.executionProcessIdentityHash === hashRecord('OsSandboxWorkerProcessIdentity', identity);
}
