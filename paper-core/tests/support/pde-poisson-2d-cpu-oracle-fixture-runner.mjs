import { fileURLToPath } from 'node:url';

import {
  AUTOMATION_RUNTIME_IMAGES,
} from '../../../paper-adapters/automation/runtime-image-registry.mjs';
import {
  runIndependentPdePoisson2dCpuOracleWorker,
} from '../../../paper-adapters/research-verify/independent-pde-poisson-2d-cpu-oracle-worker.mjs';
import {
  PDE_POISSON_2D_CPU_ORACLE_DOCKER_IMAGE,
} from '../../../paper-adapters/research-verify/pde-poisson-2d-cpu-oracle-sandbox-runner-factory.mjs';
import {
  PDE_POISSON_2D_CPU_ORACLE_RESOURCE_LIMITS,
} from '../../../paper-domain/research/process-isolated-pde-poisson-2d-independent-cpu-oracle-contract.mjs';
import {
  PDE_POISSON_2D_CPU_ORACLE_EXECUTABLE_TARGET,
} from '../../../paper-domain/research/pde-poisson-2d-cpu-oracle-runtime-attestation.mjs';
import { hashRecord } from '../../../workflow-kernel/record-hash.mjs';
import {
  createOsSandboxedWorkerRunnerForTest,
} from './os-sandboxed-worker-runner-test-driver.mjs';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

function promoteWorkerReceipt(receipt) {
  const promoted = structuredClone(receipt);
  promoted.evidenceClass = 'production-runtime-observation-v1';
  promoted.productionEvidenceEligible = true;
  const payload = { ...promoted };
  delete payload.ok;
  delete payload.receiptHash;
  delete payload.blockers;
  promoted.receiptHash = hashRecord('OsSandboxWorkerReceipt', payload);
  return promoted;
}

function productionClassSynchronousRunner(runner) {
  return Object.freeze({
    ...runner,
    capabilities: (...args) => runner.capabilities(...args),
    resolveExecutionRuntimeIdentity: (...args) => (
      runner.resolveExecutionRuntimeIdentity(...args)
    ),
    inspectGpuDeviceCapacity: (...args) => (
      runner.inspectGpuDeviceCapacity(...args)
    ),
    prepareEnvironmentBom: (...args) => runner.prepareEnvironmentBom(...args),
    run(input) {
      return promoteWorkerReceipt(runner.run(input));
    },
  });
}

export function createPdePoisson2dCpuOracleFixtureRunner({ runtimeRoot } = {}) {
  const resourceBudget = PDE_POISSON_2D_CPU_ORACLE_RESOURCE_LIMITS;
  return productionClassSynchronousRunner(createOsSandboxedWorkerRunnerForTest({
    allowedExecutables: [PDE_POISSON_2D_CPU_ORACLE_EXECUTABLE_TARGET],
    allowedRoots: [repositoryRoot],
    allowedContainerImages: [PDE_POISSON_2D_CPU_ORACLE_DOCKER_IMAGE],
    dockerImage: PDE_POISSON_2D_CPU_ORACLE_DOCKER_IMAGE,
    runtimeRoot,
    maximumTimeoutMs: resourceBudget.timeoutMs,
    maximumMemoryBytes: resourceBudget.memoryBytes,
    maximumCpuSeconds: resourceBudget.cpuSeconds,
    maximumPids: resourceBudget.maximumProcesses,
    maximumOutputBytes: 4 * 1024 ** 2,
    maximumCapturedBytes: 4 * 1024 ** 2,
    maximumInputBytes: 4 * 1024 ** 2,
    probe: {
      available: true,
      backend: 'docker',
      status: 'os_sandbox_available',
      image: PDE_POISSON_2D_CPU_ORACLE_DOCKER_IMAGE,
      imageDigest: AUTOMATION_RUNTIME_IMAGES.python.imageDigest,
    },
    imageDigestResolver: (image) => (
      image === PDE_POISSON_2D_CPU_ORACLE_DOCKER_IMAGE
        ? AUTOMATION_RUNTIME_IMAGES.python.imageDigest : null
    ),
    executor(_launcher, _args, options) {
      let workerReceipt = null;
      const receipt = runIndependentPdePoisson2dCpuOracleWorker({
        readRequestBytes: () => Buffer.from(options.input),
        writeReceipt: (value) => { workerReceipt = value; },
        workerPid: 1,
        parentPid: 0,
      });
      if (workerReceipt !== receipt) {
        return {
          status: 2,
          stdout: '',
          stderr: 'fixture_worker_receipt_mismatch',
          pid: 1,
        };
      }
      return {
        status: receipt.blockers.length ? 2 : 0,
        stdout: `${JSON.stringify(receipt)}\n`,
        stderr: '',
        pid: 1,
      };
    },
  }));
}
