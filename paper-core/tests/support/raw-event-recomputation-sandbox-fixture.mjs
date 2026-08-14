import { spawnSync } from 'node:child_process';

import { buildEmpiricalEnvironmentBom } from '../../../paper-domain/automation/environment-bom-contract.mjs';
import { buildDatasetAuthorizationSet } from '../../../paper-domain/automation/experiment-run-artifact-contract.mjs';
import { selectAndValidateWorkerEnvironment } from '../../../paper-adapters/runtime/worker-environment-policy.mjs';
import { hashRecord } from '../../../workflow-kernel/record-hash.mjs';

const digest = (label) => hashRecord('RawEventRecomputationSandboxFixture', label);

export function createRawEventRecomputationSandboxTestFixture({
  spawnSyncImpl = spawnSync,
} = {}) {
  return Object.freeze({
    run(spec = {}) {
      const result = spawnSyncImpl(spec.executable, spec.args || [], {
        cwd: spec.cwd,
        env: {
          PATH: process.env.PATH || '',
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
          TZ: 'UTC',
          ...(spec.env || {}),
        },
        input: spec.standardInput,
        encoding: 'utf8',
        timeout: Number(spec.timeoutMs || 120_000),
        maxBuffer: 24 * 1024 * 1024,
      });
      if (result?.error || result?.signal || result?.status !== 0) {
        return Object.freeze({
          ok: false,
          status: 'os_sandbox_worker_failed',
          blockers: Object.freeze(['fixture_sandbox_command_failed']),
        });
      }
      const datasetAuthorizationSet = buildDatasetAuthorizationSet([]);
      const environmentSelection = selectAndValidateWorkerEnvironment({
        env: spec.env || {},
        datasetAuthorizationSetHash:
          datasetAuthorizationSet.datasetAuthorizationSetHash,
      });
      const limits = Object.freeze({
        timeoutMs: Number(spec.timeoutMs || 120_000),
        memoryBytes: Number(spec.memoryBytes || 1024 * 1024 * 1024),
        cpuSeconds: Number(spec.cpuSeconds || 120),
        maximumPids: Number(spec.maximumProcesses || 32),
        maximumOutputBytes: Number(spec.requestedMaximumOutputBytes || 24 * 1024 * 1024),
        maximumCapturedBytes: 24 * 1024 * 1024,
      });
      const runtimeIdentityHash = digest('node-runtime');
      const environmentBom = buildEmpiricalEnvironmentBom({
        platform: {
          operatingSystem: process.platform,
          architecture: process.arch,
          kernelReleaseHash: digest('kernel'),
          machineIdentityHash: digest('machine'),
          machineIdentityObservation: 'test-fixture',
          cpu: {
            modelHash: digest('cpu-model'),
            flagsHash: digest('cpu-flags'),
            logicalProcessorCount: 1,
            observation: 'test-fixture',
          },
        },
        runtime: {
          type: 'host',
          identityHash: runtimeIdentityHash,
          language: 'node',
          languageVersionHash: digest(process.version),
          containerImageDigest: null,
          hostExecutableHash: digest('node-executable'),
          packageClosure: {
            basis: 'unobserved',
            identityHash: null,
            manifestHash: null,
            observedPackageCount: 0,
          },
        },
        gpu: { required: false, status: 'not_required', deviceCount: 0 },
        numericRuntime: {
          threads: Object.fromEntries([
            'OMP_NUM_THREADS',
            'OPENBLAS_NUM_THREADS',
            'MKL_NUM_THREADS',
            'NUMEXPR_NUM_THREADS',
            'BLIS_NUM_THREADS',
            'VECLIB_MAXIMUM_THREADS',
          ].map((key) => [key, '1'])),
          dynamicThreadingDisabled: true,
          explicitSingleThreadPolicy: true,
          policyObservation: 'test-fixture',
          blasImplementationHash: digest('blas'),
          blasImplementationObservation: 'test-fixture',
          numericalLibraryBehaviorHash: digest('numeric-behavior'),
          numericalLibraryBehaviorObservation: 'test-fixture',
        },
        limits,
        determinism: {
          classification: 'explicit_deterministic_cpu',
          explicitlyRequested: true,
          deterministicSeedRequired: true,
          deterministicSeedBound: true,
          threadPolicyVerified: true,
          gpuDeterminismVerified: false,
        },
        buildReproducibility: {
          status: 'build_reproducibility_unverified',
          runtimeContentIdentityPinned: false,
          bitwiseRebuildVerified: false,
          definitionHash: null,
          blockers: ['bitwise_rebuild_not_verified'],
        },
        observedClaims: ['test_fixture_runtime_identity'],
        unobservedClaims: ['bitwise_runtime_image_rebuild'],
      });
      const sourceMerkleHash = digest('source-merkle');
      const sourceWorkspaceManifestHash = digest('source-manifest');
      const executionProcessIdentity = Object.freeze({
        version: 1,
        kind: 'OsSandboxWorkerProcessIdentity',
        processInvocationId: digest(`invocation:${result.pid}`),
        launcherPid: result.pid,
      });
      const payload = {
        version: 4,
        kind: 'OsSandboxWorkerReceipt',
        evidenceClass: 'verification-fixture-v1',
        productionEvidenceEligible: false,
        runnerId: 'fixture-kernel-isolation-worker-v4',
        backend: 'fixture',
        status: 'os_sandbox_worker_passed',
        exitCode: result.status,
        signal: result.signal || null,
        stdout: String(result.stdout || ''),
        stderr: String(result.stderr || ''),
        sourceMerkleHashBefore: sourceMerkleHash,
        sourceMerkleHashAfter: sourceMerkleHash,
        sourceWorkspaceManifestHashBefore: sourceWorkspaceManifestHash,
        sourceWorkspaceManifestHashAfter: sourceWorkspaceManifestHash,
        workSourceMerkleHash: sourceMerkleHash,
        workWorkspaceManifestHash: sourceWorkspaceManifestHash,
        limits,
        runtimeIdentityType: 'host',
        runtimeIdentityHash,
        environmentBom,
        environmentBomHash: environmentBom.environmentBomHash,
        environmentBindingHash: environmentSelection.environmentBindingHash,
        executionProcessIdentity,
        executionProcessIdentityHash: hashRecord(
          'OsSandboxWorkerProcessIdentity',
          executionProcessIdentity,
        ),
        executionBindings: Object.freeze({
          HEPTA_DATASET_AUTHORIZATION_SET_HASH:
            datasetAuthorizationSet.datasetAuthorizationSetHash,
        }),
        datasetAuthorizationSetHash:
          datasetAuthorizationSet.datasetAuthorizationSetHash,
        datasetMounts: Object.freeze([]),
        datasetAccessReceipt: null,
        artifacts: Object.freeze([]),
        artifactManifestHash: hashRecord('OsSandboxWorkerArtifactManifest', []),
        isolation: Object.freeze({
          kernelNetworkIsolationVerified: true,
          sourceReadOnlyVerified: true,
          ephemeralWorkRootVerified: true,
          separateOutputRootVerified: true,
          gpuAccessRequested: false,
          memoryLimitVerified: true,
          memoryLimitScope: 'process-address-space-not-descendant-tree-v1',
          cpuLimitVerified: true,
          cpuLimitScope: 'process-thread-group-not-descendant-tree-v1',
          processLimitVerified: true,
          processLimitMechanism: 'rlimit-nproc',
          processLimitScope: 'real-uid-concurrent-processes-not-sandbox-local-v1',
          resourceLimitsVerified: true,
        }),
        externalActionPerformed: false,
      };
      return Object.freeze({
        ok: true,
        ...payload,
        receiptHash: hashRecord('OsSandboxWorkerReceipt', payload),
        blockers: Object.freeze([]),
      });
    },
  });
}
