import crypto from 'node:crypto';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function beginWorkerProcessIdentity() {
  return `sha256:${crypto.randomBytes(32).toString('hex')}`;
}

export function completeWorkerProcessIdentity({ processInvocationId, result } = {}) {
  const launcherPid = Number.isSafeInteger(result?.pid) && result.pid > 0 ? result.pid : null;
  const identity = Object.freeze({
    version: 1,
    kind: 'OsSandboxWorkerProcessIdentity',
    processInvocationId,
    launcherPid,
  });
  return Object.freeze({
    executionProcessIdentity: identity,
    executionProcessIdentityHash: hashRecord('OsSandboxWorkerProcessIdentity', identity),
  });
}
