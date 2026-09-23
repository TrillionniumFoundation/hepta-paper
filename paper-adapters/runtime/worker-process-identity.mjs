import crypto from 'node:crypto';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function sha256Bytes(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

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

export function buildWorkerProcessInvocationBinding({
  arguments: workerArguments,
  executableTarget,
  executionClass,
  processInvocationId,
  sourceMerkleHash,
  sourceWorkspaceManifestHash,
  standardInput,
  workingDirectory,
} = {}) {
  const inputPresent = standardInput !== null;
  const binding = Object.freeze({
    version: 1,
    kind: 'OsSandboxWorkerProcessInvocationBinding',
    processInvocationId,
    executionClass,
    executableTarget,
    arguments: Object.freeze(workerArguments.map(String)),
    workingDirectory,
    sourceMerkleHash,
    sourceWorkspaceManifestHash,
    standardInput: Object.freeze({
      present: inputPresent,
      sha256: inputPresent ? sha256Bytes(standardInput) : null,
      byteLength: inputPresent ? standardInput.byteLength : 0,
    }),
  });
  return Object.freeze({
    executionProcessInvocation: binding,
    executionProcessInvocationHash:
      hashRecord('OsSandboxWorkerProcessInvocationBinding', binding),
  });
}
