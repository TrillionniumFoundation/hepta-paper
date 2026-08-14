import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { AUTOMATION_RUNTIME_IMAGES } from '../../paper-adapters/automation/runtime-image-registry.mjs';
import { createOsSandboxedWorkerRunnerForTest } from './support/os-sandboxed-worker-runner-test-driver.mjs';
import {
  PDE_POISSON_2D_GPU_ARTIFACT_ENCODING,
  buildPdePoisson2dGpuArtifactManifest,
  buildPdePoisson2dGpuProducerSpecification,
  verifyPdePoisson2dGpuArtifactManifest,
} from '../../paper-domain/research/pde-poisson-2d-gpu-capability-contract.mjs';
import {
  verifyProductionOsSandboxWorkerReceipt,
} from '../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  importCanonicalCupyPdePoisson2dExecutorForTest,
  withCanonicalCupyPdePoisson2dSandboxRunnerForTest,
} from './support/canonical-cupy-pde-poisson-2d-sandbox-test-seam.mjs';

const {
  CANONICAL_CUPY_PDE_POISSON_2D_OUTPUT_PATHS,
  CANONICAL_CUPY_PDE_POISSON_2D_WORKER_ROOT,
  createCanonicalCupyPdePoisson2dExecutor,
} = await importCanonicalCupyPdePoisson2dExecutorForTest();

function gpuSelector() {
  const result = spawnSync('/usr/bin/nvidia-smi', [
    '--query-gpu=uuid', '--format=csv,noheader',
  ], { encoding: 'utf8', timeout: 5_000 });
  return result.status === 0
    ? String(result.stdout || '').trim().split(/\r?\n/)[0]
    : null;
}

function discreteReferenceBytes(gridSize, modes) {
  const spacing = 1 / (gridSize + 1);
  const buffer = Buffer.alloc(gridSize * gridSize * Float64Array.BYTES_PER_ELEMENT);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let row = 0; row < gridSize; row += 1) {
    const y = (row + 1) * spacing;
    for (let column = 0; column < gridSize; column += 1) {
      const x = (column + 1) * spacing;
      let solution = 0;
      for (const { amplitude, kx, ky } of modes) {
        const basis = Math.sin(kx * Math.PI * x) * Math.sin(ky * Math.PI * y);
        const continuousEigenvalue = Math.PI ** 2 * (kx ** 2 + ky ** 2);
        const discreteEigenvalue = 4 / spacing ** 2 * (
          Math.sin(kx * Math.PI * spacing / 2) ** 2
          + Math.sin(ky * Math.PI * spacing / 2) ** 2
        );
        solution += amplitude * continuousEigenvalue / discreteEigenvalue * basis;
      }
      view.setFloat64(
        (row * gridSize + column) * Float64Array.BYTES_PER_ELEMENT,
        solution,
        true,
      );
    }
  }
  return buffer;
}

function rehashOsSandboxWorkerReceipt(receipt) {
  const resourceLimitPayload = { ...receipt.environmentBom.limits };
  delete resourceLimitPayload.resourceLimitsHash;
  receipt.environmentBom.limits.resourceLimitsHash = hashRecord(
    'EmpiricalEnvironmentResourceLimits', resourceLimitPayload,
  );
  const environmentBomPayload = { ...receipt.environmentBom };
  delete environmentBomPayload.environmentBomHash;
  receipt.environmentBom.environmentBomHash = hashRecord(
    'EmpiricalEnvironmentBOM', environmentBomPayload,
  );
  receipt.environmentBomHash = receipt.environmentBom.environmentBomHash;
  const payload = { ...receipt };
  delete payload.ok;
  delete payload.receiptHash;
  delete payload.blockers;
  receipt.receiptHash = hashRecord('OsSandboxWorkerReceipt', payload);
}

function fixtureRunner(outputRoot, selectedGpu, mutateDiagnostics = null) {
  return createOsSandboxedWorkerRunnerForTest({
    allowedExecutables: [AUTOMATION_RUNTIME_IMAGES.pythonGpu.executable],
    allowedRoots: [CANONICAL_CUPY_PDE_POISSON_2D_WORKER_ROOT],
    allowedOutputRoots: [outputRoot],
    allowedContainerImages: [AUTOMATION_RUNTIME_IMAGES.pythonGpu.image],
    dockerImage: AUTOMATION_RUNTIME_IMAGES.pythonGpu.image,
    runtimeRoot: path.join(outputRoot, '.runtime'),
    allowGpu: true,
    maximumTimeoutMs: 60_000,
    maximumMemoryBytes: 128 * 1024 * 1024,
    maximumCpuSeconds: 60,
    maximumPids: 16,
    maximumOutputBytes: 8 * 1024 * 1024,
    maximumInputBytes: 1024 * 1024,
    probe: {
      available: true,
      backend: 'docker',
      status: 'os_sandbox_available',
      image: AUTOMATION_RUNTIME_IMAGES.pythonGpu.image,
    },
    imageDigestResolver: (image) => image === AUTOMATION_RUNTIME_IMAGES.pythonGpu.image
      ? AUTOMATION_RUNTIME_IMAGES.pythonGpu.imageDigest : null,
    executor(_launcher, args, options) {
      const outputVolume = args.find((value) => String(value).endsWith(':/output:rw'));
      const outputDirectory = String(outputVolume || '').slice(0, -':/output:rw'.length);
      const request = JSON.parse(Buffer.from(options.input).toString('utf8'));
      const solutionRoot = path.join(outputDirectory, 'solutions');
      fs.mkdirSync(solutionRoot, { mode: 0o700 });
      for (const gridSize of request.producerSpecification.discretization.gridSizes) {
        fs.writeFileSync(
          path.join(solutionRoot, `n${gridSize}.f64le`),
          discreteReferenceBytes(
            gridSize,
            request.producerSpecification.equation.manufacturedModes,
          ),
          { mode: 0o600 },
        );
      }
      const diagnostics = {
        version: 1,
        kind: 'CanonicalCupyPoisson2dProducerDiagnostics',
        requestHash: request.requestHash,
        visibleGpuUuid: selectedGpu,
        observations: request.producerSpecification.discretization.gridSizes.map(
          (gridSize) => ({
            gridSize,
            iterations: 1,
            relativeContinuousL2Error: 0,
            relativeDiscreteResidual: 0,
          }),
        ),
        scientificAuthority: 'non-authoritative-self-report-v1',
      };
      mutateDiagnostics?.(diagnostics);
      fs.writeFileSync(
        path.join(outputDirectory, 'producer-diagnostics.json'),
        `${JSON.stringify(diagnostics)}\n`,
        { mode: 0o600 },
      );
      return { status: 0, stdout: '', stderr: '' };
    },
  });
}

test('canonical PDE producer refuses to turn fixture sandbox evidence into a production manifest', async (t) => {
  const selectedGpu = gpuSelector();
  if (!selectedGpu) {
    t.skip('NVIDIA GPU UUID unavailable');
    return;
  }
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-pde-producer-'));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const receipt = await withCanonicalCupyPdePoisson2dSandboxRunnerForTest(
    fixtureRunner(outputRoot, selectedGpu),
    async () => createCanonicalCupyPdePoisson2dExecutor({
      outputRoot,
      timeoutMs: 60_000,
      memoryBytes: 128 * 1024 * 1024,
      cpuSeconds: 60,
      maximumProcesses: 16,
      maximumOutputBytes: 8 * 1024 * 1024,
    }).execute({
      runId: 'pde-producer-fixture',
      gpuDeviceSelector: selectedGpu,
      absoluteDeadlineEpochMs: Date.now() + 120_000,
    }),
  );
  assert.equal(receipt.status, 'canonical_cupy_pde_poisson_2d_blocked');
  assert.equal(receipt.productionPromotionEligible, false);
  assert.deepEqual(receipt.blockers, [
    'canonical_cupy_pde_poisson_2d_artifact_invalid:pde_poisson_2d_gpu_production_worker_receipt_invalid',
  ]);
  assert.equal(receipt.workerReceipt.evidenceClass, 'verification-fixture-v1');
  assert.deepEqual(CANONICAL_CUPY_PDE_POISSON_2D_OUTPUT_PATHS, [
    'solutions/n31.f64le', 'solutions/n63.f64le', 'solutions/n127.f64le',
    'producer-diagnostics.json',
  ]);

  const productionWorkerReceipt = structuredClone(receipt.workerReceipt);
  const producerRequestHash = productionWorkerReceipt.executionBindings.HEPTA_SEED;
  productionWorkerReceipt.evidenceClass = 'production-runtime-observation-v1';
  productionWorkerReceipt.productionEvidenceEligible = true;
  rehashOsSandboxWorkerReceipt(productionWorkerReceipt);
  assert.equal(
    verifyProductionOsSandboxWorkerReceipt(productionWorkerReceipt), true,
  );
  const producerSpecification = buildPdePoisson2dGpuProducerSpecification();
  const workerResourceLimits = Object.freeze({
    timeoutMs: productionWorkerReceipt.limits.timeoutMs,
    memoryBytes: productionWorkerReceipt.limits.memoryBytes,
    cpuSeconds: productionWorkerReceipt.limits.cpuSeconds,
    maximumProcesses: productionWorkerReceipt.limits.maximumPids,
    maximumOutputBytes: productionWorkerReceipt.limits.maximumOutputBytes,
  });
  const manifest = buildPdePoisson2dGpuArtifactManifest({
    producerSpecification,
    requestHash: producerRequestHash,
    workerReceiptHash: productionWorkerReceipt.receiptHash,
    runtimeImageDigest: productionWorkerReceipt.containerImageDigest,
    runtimePackageClosureHash:
      productionWorkerReceipt.environmentBom.runtime.packageClosure.identityHash,
    gpuDeviceIdentityHash: hashRecord('PdePoisson2dGpuDeviceUuid', {
      gpuDeviceSelector: selectedGpu,
    }),
    producerDiagnosticsHash: productionWorkerReceipt.artifacts.find(
      ({ path: selectedPath }) => selectedPath === 'producer-diagnostics.json',
    ).sha256,
    producerImplementationMerkleHash:
      productionWorkerReceipt.expectedSourceMerkleHash,
    producerImplementationWorkspaceManifestHash:
      productionWorkerReceipt.expectedSourceWorkspaceManifestHash,
    requestStandardInputHash:
      productionWorkerReceipt.executionProcessInvocation.standardInput.sha256,
    requestStandardInputByteLength:
      productionWorkerReceipt.executionProcessInvocation.standardInput.byteLength,
    workerResourceLimits,
    osSandboxWorkerReceipt: productionWorkerReceipt,
    artifacts: producerSpecification.discretization.gridSizes.map((gridSize) => {
      const selectedPath = `solutions/n${gridSize}.f64le`;
      const artifact = productionWorkerReceipt.artifacts.find(
        ({ path: artifactPath }) => artifactPath === selectedPath,
      );
      return {
        gridSize,
        relativePath: selectedPath,
        encoding: PDE_POISSON_2D_GPU_ARTIFACT_ENCODING,
        elements: gridSize * gridSize,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      };
    }),
  });
  assert.equal(verifyPdePoisson2dGpuArtifactManifest(manifest, {
    producerSpecification,
  }), true);

  for (const nestedLimit of [
    'timeoutMs', 'memoryBytes', 'cpuSeconds', 'maximumPids', 'maximumOutputBytes',
  ]) {
    const forgedLimits = structuredClone(manifest);
    forgedLimits.osSandboxWorkerReceipt.limits[nestedLimit] += 1;
    forgedLimits.osSandboxWorkerReceipt.environmentBom.limits[nestedLimit] += 1;
    rehashOsSandboxWorkerReceipt(forgedLimits.osSandboxWorkerReceipt);
    assert.equal(verifyProductionOsSandboxWorkerReceipt(
      forgedLimits.osSandboxWorkerReceipt,
    ), true);
    forgedLimits.workerReceiptHash = forgedLimits.osSandboxWorkerReceipt.receiptHash;
    const forgedManifestPayload = { ...forgedLimits };
    delete forgedManifestPayload.pdePoisson2dGpuArtifactManifestHash;
    forgedLimits.pdePoisson2dGpuArtifactManifestHash = hashRecord(
      'PdePoisson2dGpuArtifactManifest', forgedManifestPayload,
    );
    assert.equal(verifyPdePoisson2dGpuArtifactManifest(forgedLimits, {
      producerSpecification,
    }), false);
  }
});

test('canonical PDE producer diagnostics reject exact-schema and numeric drift', async (t) => {
  const selectedGpu = gpuSelector();
  if (!selectedGpu) {
    t.skip('NVIDIA GPU UUID unavailable');
    return;
  }
  const mutations = [
    ['extra-key', (value) => { value.untrusted = true; }],
    ['grid-order', (value) => { value.observations.reverse(); }],
    ['iteration-range', (value) => { value.observations[0].iterations = 0; }],
    ['metric-type', (value) => {
      value.observations[0].relativeDiscreteResidual = '0';
    }],
  ];
  for (const [label, mutateDiagnostics] of mutations) {
    await t.test(label, async (subtest) => {
      const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), `hepta-pde-diagnostics-${label}-`));
      subtest.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
      const receipt = await withCanonicalCupyPdePoisson2dSandboxRunnerForTest(
        fixtureRunner(outputRoot, selectedGpu, mutateDiagnostics),
        async () => createCanonicalCupyPdePoisson2dExecutor({
          outputRoot,
          timeoutMs: 60_000,
          memoryBytes: 128 * 1024 * 1024,
          cpuSeconds: 60,
          maximumProcesses: 16,
          maximumOutputBytes: 8 * 1024 * 1024,
        }).execute({
          runId: `pde-diagnostics-${label}`,
          gpuDeviceSelector: selectedGpu,
          absoluteDeadlineEpochMs: Date.now() + 120_000,
        }),
      );
      assert.equal(receipt.status, 'canonical_cupy_pde_poisson_2d_blocked');
      assert.ok(receipt.blockers.includes(
        'canonical_cupy_pde_poisson_2d_artifact_invalid:pde_gpu_producer_diagnostics_contract_invalid',
      ));
    });
  }
});

test('canonical PDE producer rejects dependency injection and expired deadline', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-pde-producer-blocked-'));
  try {
    assert.throws(() => createCanonicalCupyPdePoisson2dExecutor({
      outputRoot: root,
      workerRunner: {},
    }), /options_invalid/);
    const runner = fixtureRunner(root, 'GPU-a33875b7-7eb7-679e-df08-19227d3decee');
    const receipt = await withCanonicalCupyPdePoisson2dSandboxRunnerForTest(
      runner,
      () => createCanonicalCupyPdePoisson2dExecutor({ outputRoot: root }).execute({
        runId: 'expired-pde',
        gpuDeviceSelector: 'GPU-a33875b7-7eb7-679e-df08-19227d3decee',
        absoluteDeadlineEpochMs: 1,
      }),
    );
    assert.deepEqual(receipt.blockers,
      ['canonical_cupy_pde_poisson_2d_input_invalid']);
    assert.equal(receipt.productionPromotionEligible, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
