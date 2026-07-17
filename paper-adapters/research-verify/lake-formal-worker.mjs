import path from 'node:path';
import {
  PRODUCTION_LEAN_TOOLCHAIN_ROOT_MERKLE_HASHES,
  SYSTEM_ALLOWED_FORMAL_AXIOMS,
} from '../../paper-domain/research/formal-verifier-policy.mjs';
import { inspectScopedPathSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { createOsSandboxedWorkerRunner } from '../runtime/os-sandboxed-worker-runner.mjs';
import { createLakeFormalVerifier } from './lake-formal-verifier.mjs';
import { createLeanToolchainIdentityProvider } from './lean-toolchain-identity.mjs';
import { resolvePinnedLakeExecutable } from './pinned-lake-executable-resolver.mjs';

export const DEFAULT_LAKE_FORMAL_BUILD_TIMEOUT_MS = 60 * 60 * 1000;
export const MAXIMUM_LAKE_FORMAL_BUILD_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function positiveSafeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function resolveLakeFormalBuildTimeout({
  requestedTimeoutMs = null,
  configuredDefaultTimeoutMs = process.env.HEPTA_LAKE_FORMAL_BUILD_TIMEOUT_MS ?? null,
} = {}) {
  const requestSpecified = requestedTimeoutMs !== null && requestedTimeoutMs !== undefined && requestedTimeoutMs !== '';
  const configured = configuredDefaultTimeoutMs === null || configuredDefaultTimeoutMs === undefined || configuredDefaultTimeoutMs === ''
    ? DEFAULT_LAKE_FORMAL_BUILD_TIMEOUT_MS
    : positiveSafeInteger(configuredDefaultTimeoutMs);
  const requested = !requestSpecified
    ? configured
    : positiveSafeInteger(requestedTimeoutMs);
  const blockers = [];
  if (configured === null) blockers.push('formal_build_timeout_configuration_invalid');
  else if (configured > MAXIMUM_LAKE_FORMAL_BUILD_TIMEOUT_MS) blockers.push('formal_build_timeout_configuration_exceeds_limit');
  if (requestSpecified && requested === null) blockers.push('formal_build_timeout_request_invalid');
  else if (requestSpecified && requested > MAXIMUM_LAKE_FORMAL_BUILD_TIMEOUT_MS) blockers.push('formal_build_timeout_request_exceeds_limit');
  const payload = {
    status: blockers.length ? 'formal_build_timeout_blocked' : 'formal_build_timeout_verified',
    timeoutMs: blockers.length ? null : requested,
    maximumTimeoutMs: MAXIMUM_LAKE_FORMAL_BUILD_TIMEOUT_MS,
    blockers: [...new Set(blockers)],
  };
  return Object.freeze(payload);
}

export async function executeLakeFormalWorker({ worker, inputRecords, sourceRoot, signal = null } = {}) {
  const relativeProjectRoot = String(worker?.parameters?.projectRoot || '.');
  const projectRoot = path.resolve(sourceRoot, relativeProjectRoot);
  const projectIdentity = inspectScopedPathSync({
    scopeRoot: sourceRoot,
    candidate: projectRoot,
    expect: 'directory',
    forbidHardlinks: false,
  });
  if (projectIdentity.status !== 'scoped_file_identity_verified') {
    return { status: 'formal_verifier_blocked', blockers: ['formal_project_root_outside_source_workspace'] };
  }
  if (Object.hasOwn(worker.parameters || {}, 'executable') && worker.parameters.executable !== 'lake') {
    return { status: 'formal_verifier_blocked', blockers: ['formal_verifier_executable_override_forbidden'] };
  }
  const pinnedRuntime = resolvePinnedLakeExecutable();
  if (pinnedRuntime.status !== 'formal_pinned_lake_resolved') {
    return { status: 'formal_verifier_blocked', blockers: pinnedRuntime.blockers };
  }
  const timeoutPolicy = resolveLakeFormalBuildTimeout({ requestedTimeoutMs: worker.parameters?.timeoutMs });
  if (timeoutPolicy.status !== 'formal_build_timeout_verified') {
    return { status: 'formal_verifier_blocked', blockers: timeoutPolicy.blockers };
  }
  const timeoutMs = timeoutPolicy.timeoutMs;
  const executable = pinnedRuntime.executable;
  const commandRunnerFactory = (executionRoot) => createOsSandboxedWorkerRunner({
    allowedExecutables: [executable],
    allowedRoots: [executionRoot],
    maximumTimeoutMs: timeoutMs,
    maximumCpuSeconds: Math.ceil(timeoutMs / 1000),
  });
  const verifier = createLakeFormalVerifier({
    projectRoot,
    dependencyScopeRoot: sourceRoot,
    commandRunner: commandRunnerFactory(projectRoot),
    commandRunnerFactory,
    executable,
    trustedAllowedAxioms: SYSTEM_ALLOWED_FORMAL_AXIOMS,
    toolchainIdentityProvider: createLeanToolchainIdentityProvider({
      toolchain: pinnedRuntime.toolchain,
      toolchainRoot: pinnedRuntime.toolchainRoot,
      leanExecutable: pinnedRuntime.leanExecutable,
      lakeExecutable: pinnedRuntime.lakeExecutable,
      expectedToolchainRootMerkleHash: PRODUCTION_LEAN_TOOLCHAIN_ROOT_MERKLE_HASHES[pinnedRuntime.toolchain] || null,
    }),
  });
  const expectedInputs = inputRecords.map((record) => ({
    path: path.relative(projectRoot, record.absolutePath),
    hash: record.hash,
  }));
  if (expectedInputs.some((input) => input.path.startsWith('..'))) {
    return { status: 'formal_verifier_blocked', blockers: ['formal_input_outside_project_root'] };
  }
  const certificateBundle = await verifier.verify({
    expectedInputs,
    timeoutMs,
    claimBindings: Array.isArray(worker.parameters?.claimBindings) ? worker.parameters.claimBindings : [],
    signal,
  });
  if (certificateBundle.status !== 'formal_claim_verified') return certificateBundle;
  const replayReceipt = await verifier.replay({ certificateBundle, timeoutMs, signal });
  return replayReceipt.status === 'formal_claim_replay_verified'
    ? { ...certificateBundle, replayReceipt, formalCertificateReplayReceiptHash: replayReceipt.formalCertificateReplayReceiptHash }
    : {
      ...certificateBundle,
      status: 'formal_claim_replay_blocked',
      replayReceipt,
      blockers: [...new Set([...(certificateBundle.blockers || []), ...(replayReceipt.blockers || [])])],
    };
}
