import fs from 'node:fs';
import path from 'node:path';
import {
  PRODUCTION_LEAN_TOOLCHAIN_ROOT_MERKLE_HASHES,
  SYSTEM_ALLOWED_FORMAL_AXIOMS,
} from '../../paper-domain/research/formal-verifier-policy.mjs';
import { inspectScopedPathSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { createOsSandboxedWorkerRunner } from '../runtime/os-sandboxed-worker-runner.mjs';
import { normalizeContainerImageDigest } from '../runtime/sandbox-backend-probe.mjs';
import {
  createPinnedFormalSandboxRuntime,
} from './pinned-formal-sandbox-runtime-contract.mjs';
import { createLakeFormalVerifier } from './lake-formal-verifier.mjs';
import { createLeanToolchainIdentityProvider } from './lean-toolchain-identity.mjs';
import { resolvePinnedLakeExecutable } from './pinned-lake-executable-resolver.mjs';
import {
  assertCurrentDynamicFormalExecutionAuthority,
} from './dynamic-formal-project-closure-readiness.mjs';
import {
  createFormalProofSearchWorkspaceRepository,
} from './formal-proof-search-workspace-repository.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';
import {
  buildFormalReadableProofExplanationBundle,
} from '../../paper-domain/research/formal-readable-proof-contract.mjs';

export const DEFAULT_LAKE_FORMAL_BUILD_TIMEOUT_MS = 60 * 60 * 1000;
export const MAXIMUM_LAKE_FORMAL_BUILD_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export { createPinnedFormalSandboxRuntime } from './pinned-formal-sandbox-runtime-contract.mjs';

function normalizePinnedSandboxRuntime(runtime) {
  if (runtime === null || runtime === undefined) return null;
  if (runtime?.version !== 1 || runtime?.kind !== 'PinnedFormalSandboxRuntime') {
    throw new Error('formal_sandbox_runtime_invalid:formal_sandbox_runtime_shape_invalid');
  }
  return createPinnedFormalSandboxRuntime(runtime);
}

function sandboxRuntimeBlockers(runner, runtime) {
  if (!runtime || runner?.availability?.backend !== 'docker') return [];
  const blockers = [];
  if (runner.availability.image !== runtime.image) {
    blockers.push('formal_sandbox_runtime_image_identity_mismatch');
  }
  if (normalizeContainerImageDigest(runner.availability.imageDigest) !== runtime.imageDigest) {
    blockers.push('formal_sandbox_runtime_image_digest_mismatch');
  }
  return blockers;
}

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

export async function executeLakeFormalWorker({
  worker,
  inputRecords,
  sourceRoot,
  signal = null,
  trustedSandboxRuntime = null,
  workerRunnerFactory = createOsSandboxedWorkerRunner,
  dynamicFormalExecutionAuthority = null,
  dynamicFormalExecutionEnvironment = process.env,
  dynamicFormalExecutionSpawnSync = undefined,
} = {}) {
  const relativeProjectRoot = String(worker?.parameters?.projectRoot || '.');
  const sourceProjectRoot = path.resolve(sourceRoot, relativeProjectRoot);
  const projectIdentity = inspectScopedPathSync({
    scopeRoot: sourceRoot,
    candidate: sourceProjectRoot,
    expect: 'directory',
    forbidHardlinks: false,
  });
  if (projectIdentity.status !== 'scoped_file_identity_verified') {
    return { status: 'formal_verifier_blocked', blockers: ['formal_project_root_outside_source_workspace'] };
  }
  if (Object.hasOwn(worker.parameters || {}, 'executable') && worker.parameters.executable !== 'lake') {
    return { status: 'formal_verifier_blocked', blockers: ['formal_verifier_executable_override_forbidden'] };
  }
  const authorityOptions = {
    environment: dynamicFormalExecutionEnvironment,
    ...(dynamicFormalExecutionSpawnSync
      ? { spawnSyncImpl: dynamicFormalExecutionSpawnSync } : {}),
  };
  let executionProject = null;
  let projectRoot = sourceProjectRoot;
  let dependencyScopeRoot = sourceRoot;
  let expectedInputs = inputRecords.map((record) => ({
    path: path.relative(sourceProjectRoot, record.absolutePath),
    hash: record.hash,
  }));
  let initialFormalExecutionSnapshotReceipt = null;
  if (dynamicFormalExecutionAuthority) {
    const activeAuthority = assertCurrentDynamicFormalExecutionAuthority(
      dynamicFormalExecutionAuthority,
      authorityOptions,
    ).authority;
    if (!trustedSandboxRuntime
      || trustedSandboxRuntime.image !== activeAuthority.formalSandboxRuntimeImage
      || trustedSandboxRuntime.imageDigest
        !== activeAuthority.formalSandboxRuntimeImageDigest) {
      throw new Error('dynamic_formal_execution_sandbox_authority_mismatch');
    }
    const repository = createFormalProofSearchWorkspaceRepository();
    executionProject = await repository.materialize({
      workspace: activeAuthority.projectRoot,
      dependencyScopeRoot: activeAuthority.projectScopeRoot,
      expectedFormalProjectClosureHash: activeAuthority.formalProjectClosureHash,
      imports: activeAuthority.imports,
    });
    projectRoot = executionProject.root;
    dependencyScopeRoot = executionProject.scopeRoot;
    try {
      expectedInputs = inputRecords.map((record) => {
        const relative = path.relative(sourceProjectRoot, record.absolutePath)
          .replace(/\\/g, '/');
        const bytes = fs.readFileSync(record.absolutePath);
        if (hashBytes(bytes) !== record.hash) {
          throw new Error('dynamic_formal_worker_input_changed_before_snapshot');
        }
        repository.stageLeanSource({
          projectRoot,
          relative,
          source: bytes.toString('utf8'),
        });
        return Object.freeze({ path: relative, hash: record.hash });
      });
      repository.sealExecutionSnapshot({ projectRoot });
      initialFormalExecutionSnapshotReceipt =
        repository.assertExecutionSnapshotCurrent({ projectRoot });
    } catch (error) {
      executionProject.cleanup();
      throw error;
    }
    executionProject = Object.freeze({ ...executionProject, repository });
  }
  const finish = (result) => {
    try {
      if (!dynamicFormalExecutionAuthority) {
        return result;
      }
      assertCurrentDynamicFormalExecutionAuthority(
        dynamicFormalExecutionAuthority,
        authorityOptions,
      );
      const finalFormalExecutionSnapshotReceipt =
        executionProject.repository.assertExecutionSnapshotCurrent({ projectRoot });
      return {
        ...result,
        dynamicFormalExecutionAuthority,
        initialFormalExecutionSnapshotReceipt,
        finalFormalExecutionSnapshotReceipt,
      };
    } finally {
      executionProject?.cleanup();
    }
  };
  const pinnedRuntime = resolvePinnedLakeExecutable({
    environment: dynamicFormalExecutionEnvironment,
    ...(dynamicFormalExecutionSpawnSync
      ? { spawnSyncImpl: dynamicFormalExecutionSpawnSync } : {}),
  });
  if (pinnedRuntime.status !== 'formal_pinned_lake_resolved') {
    return finish({ status: 'formal_verifier_blocked', blockers: pinnedRuntime.blockers });
  }
  const timeoutPolicy = resolveLakeFormalBuildTimeout({ requestedTimeoutMs: worker.parameters?.timeoutMs });
  if (timeoutPolicy.status !== 'formal_build_timeout_verified') {
    return finish({ status: 'formal_verifier_blocked', blockers: timeoutPolicy.blockers });
  }
  const timeoutMs = timeoutPolicy.timeoutMs;
  const executable = pinnedRuntime.executable;
  let sandboxRuntime;
  try {
    sandboxRuntime = normalizePinnedSandboxRuntime(trustedSandboxRuntime);
  } catch (error) {
    return finish({
      status: 'formal_verifier_blocked',
      blockers: [error?.message || 'formal_sandbox_runtime_invalid'],
    });
  }
  const commandRunnerFactory = (executionRoot, executionScopeRoot = executionRoot) => workerRunnerFactory({
    allowedExecutables: [executable],
    allowedRoots: [executionScopeRoot],
    ...(sandboxRuntime ? {
      dockerImage: sandboxRuntime.image,
      allowedContainerImages: [sandboxRuntime.image],
    } : {}),
    maximumTimeoutMs: timeoutMs,
    maximumCpuSeconds: Math.ceil(timeoutMs / 1000),
  });
  const commandRunner = commandRunnerFactory(projectRoot);
  const runtimeBlockers = sandboxRuntimeBlockers(commandRunner, sandboxRuntime);
  if (runtimeBlockers.length) {
    return finish({ status: 'formal_verifier_blocked', blockers: runtimeBlockers });
  }
  const verifier = createLakeFormalVerifier({
    projectRoot,
    dependencyScopeRoot,
    commandRunner,
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
    executionEnvironment: dynamicFormalExecutionEnvironment,
    requireImmutableExecutionClosure: Boolean(dynamicFormalExecutionAuthority),
  });
  if (expectedInputs.some((input) => input.path.startsWith('..'))) {
    return finish({ status: 'formal_verifier_blocked', blockers: ['formal_input_outside_project_root'] });
  }
  const certificateBundle = await verifier.verify({
    expectedInputs,
    timeoutMs,
    claimBindings: Array.isArray(worker.parameters?.claimBindings) ? worker.parameters.claimBindings : [],
    signal,
  });
  if (certificateBundle.status !== 'formal_claim_verified') return finish(certificateBundle);
  const replayReceipt = await verifier.replay({ certificateBundle, timeoutMs, signal });
  const readableProofExplanationBundle = replayReceipt.status === 'formal_claim_replay_verified'
    ? buildFormalReadableProofExplanationBundle({ certificateBundle, replayReceipt }) : null;
  const result = replayReceipt.status === 'formal_claim_replay_verified'
    ? {
      ...certificateBundle,
      replayReceipt,
      formalCertificateReplayReceiptHash: replayReceipt.formalCertificateReplayReceiptHash,
      readableProofExplanationBundle,
      formalReadableProofExplanationBundleHash:
        readableProofExplanationBundle.formalReadableProofExplanationBundleHash,
      productionReadableProofExplanationReady:
        readableProofExplanationBundle.productionReadableProofReady === true,
    }
    : {
      ...certificateBundle,
      status: 'formal_claim_replay_blocked',
      replayReceipt,
      blockers: [...new Set([...(certificateBundle.blockers || []), ...(replayReceipt.blockers || [])])],
    };
  return finish(result);
}
