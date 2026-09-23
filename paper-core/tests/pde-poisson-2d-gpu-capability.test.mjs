import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  PDE_POISSON_2D_GPU_ARTIFACT_ENCODING,
  buildPdePoisson2dGpuArtifactManifest,
  buildPdePoisson2dGpuProducerSpecification,
  verifyPdePoisson2dGpuArtifactManifest,
  verifyPdePoisson2dGpuProducerSpecification,
} from '../../paper-domain/research/pde-poisson-2d-gpu-capability-contract.mjs';
import {
  buildPdePoisson2dIndependentCpuOracleReceipt,
  verifyPdePoisson2dIndependentCpuOracleReceipt,
} from '../../paper-domain/research/pde-poisson-2d-independent-cpu-oracle-contract.mjs';
import {
  PDE_POISSON_2D_INDEPENDENT_CPU_ALGORITHM_IMPLEMENTATION,
  recomputePdePoisson2dMetricsFromArtifactBytes,
} from '../../paper-adapters/research-verify/pde-poisson-2d-independent-cpu-oracle-algorithm.mjs';
import {
  PDE_POISSON_2D_CPU_ORACLE_DOCKER_IMAGE,
  runProcessIsolatedPdePoisson2dIndependentCpuOracle,
  verifyProcessIsolatedPdePoisson2dCpuOracleAgainstArtifacts,
} from '../../paper-composition/automation/advanced-numerical-plugin-composition.mjs';
import {
  verifyProductionOsSandboxWorkerReceipt,
} from '../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs';
import {
  buildPdePoisson2dCpuOracleWorkerReceipt,
  buildProcessIsolatedPdePoisson2dCpuOracleRequest,
  PDE_POISSON_2D_CPU_ORACLE_RESOURCE_LIMITS,
  verifyPdePoisson2dCpuOracleWorkerImplementation,
  verifyPdePoisson2dCpuOracleWorkerReceipt,
  verifyProcessIsolatedPdePoisson2dCpuOracleAssurance,
} from '../../paper-domain/research/process-isolated-pde-poisson-2d-independent-cpu-oracle-contract.mjs';
import {
  currentPdePoisson2dCpuOracleWorkerImplementation,
} from '../../paper-adapters/research-verify/independent-pde-poisson-2d-cpu-oracle-worker.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';

const H = (label) => hashRecord('PdePoisson2dGpuCapabilityTest', { label });

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

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-pde-poisson-'));
  const solutionRoot = path.join(root, 'solutions');
  fs.mkdirSync(solutionRoot, { mode: 0o700 });
  const producerSpecification = buildPdePoisson2dGpuProducerSpecification();
  const artifacts = producerSpecification.discretization.gridSizes.map((gridSize) => {
    const bytes = discreteReferenceBytes(
      gridSize,
      producerSpecification.equation.manufacturedModes,
    );
    const relativePath = `solutions/n${gridSize}.f64le`;
    fs.writeFileSync(path.join(root, relativePath), bytes, { mode: 0o600 });
    return {
      gridSize,
      relativePath,
      encoding: PDE_POISSON_2D_GPU_ARTIFACT_ENCODING,
      elements: gridSize * gridSize,
      bytes: bytes.length,
      sha256: hashBytes(bytes),
    };
  });
  const artifactManifest = buildPdePoisson2dGpuArtifactManifest({
    producerSpecification,
    requestHash: H('request'),
    workerReceiptHash: H('gpu-worker-receipt'),
    runtimeImageDigest: H('python-gpu-image'),
    runtimePackageClosureHash: H('cupy-package-closure'),
    gpuDeviceIdentityHash: H('pinned-gpu-device'),
    // Deliberately binds a producer report, but that report is never consumed
    // by the independent oracle and has no scientific authority.
    producerDiagnosticsHash: H('producer-self-reported-perfect-diagnostics'),
    artifacts,
  });
  return { root, producerSpecification, artifactManifest };
}

function clone(value) {
  return structuredClone(value);
}

function rehashOsSandboxWorkerReceipt(receipt) {
  receipt.executionProcessInvocationHash = hashRecord(
    'OsSandboxWorkerProcessInvocationBinding',
    receipt.executionProcessInvocation,
  );
  const payload = { ...receipt };
  delete payload.ok;
  delete payload.receiptHash;
  delete payload.blockers;
  receipt.receiptHash = hashRecord('OsSandboxWorkerReceipt', payload);
}

function rehashPdeCpuOracleAssurance(assurance) {
  const attestation = assurance.runtimeAttestation;
  const attestationPayload = { ...attestation };
  delete attestationPayload.pdePoisson2dCpuOracleRuntimeAttestationHash;
  attestation.pdePoisson2dCpuOracleRuntimeAttestationHash = hashRecord(
    'PdePoisson2dCpuOracleRuntimeAttestation', attestationPayload,
  );
  assurance.runtimeAttestationHash =
    attestation.pdePoisson2dCpuOracleRuntimeAttestationHash;
  assurance.osSandboxWorkerReceiptHash = assurance.osSandboxWorkerReceipt.receiptHash;
  const payload = { ...assurance };
  delete payload.pdePoisson2dProcessIsolatedCpuOracleAssuranceHash;
  assurance.pdePoisson2dProcessIsolatedCpuOracleAssuranceHash = hashRecord(
    'ProcessIsolatedPdePoisson2dCpuOracleAssurance', payload,
  );
}

function recomputePdePoisson2dIndependentCpuOracle({
  artifactRoot,
  artifactManifest,
  producerSpecification,
  oracleRuntimeIdentityHash,
}) {
  const reads = artifactManifest.artifacts.map((artifact) => readScopedFileSync({
    scopeRoot: artifactRoot,
    candidate: path.join(artifactRoot, artifact.relativePath),
    maximumBytes: artifact.bytes,
  }));
  const blockers = reads.flatMap((read) => read.blockers.map(
    (blocker) => `pde_oracle_artifact_read:${blocker}`,
  ));
  reads.forEach((read, index) => {
    if (read.status === 'scoped_file_read_verified'
      && read.hash !== artifactManifest.artifacts[index].sha256) {
      blockers.push(
        `pde_oracle_artifact_hash_mismatch:n${artifactManifest.artifacts[index].gridSize}`,
      );
    }
  });
  const metrics = blockers.length ? null
    : recomputePdePoisson2dMetricsFromArtifactBytes({
      producerSpecification,
      artifactManifest,
      artifactBytes: reads.map((read) => read.content),
    });
  return buildPdePoisson2dIndependentCpuOracleReceipt({
    producerSpecification,
    artifactManifest,
    oracleImplementationHash:
      PDE_POISSON_2D_INDEPENDENT_CPU_ALGORITHM_IMPLEMENTATION.implementationHash,
    oracleRuntimeIdentityHash,
    artifactReadReceiptHashes: reads.map(
      (read) => read.scopedFileReadReceiptHash,
    ),
    observations: metrics?.observations || [],
    convergenceOrders: metrics?.convergenceOrders || [],
    operationalBlockers: blockers,
  });
}

function verifyPdePoisson2dIndependentCpuOracleAgainstArtifacts(value, options) {
  try {
    return JSON.stringify(recomputePdePoisson2dIndependentCpuOracle(options))
      === JSON.stringify(value);
  } catch { return false; }
}

test('fixed GPU producer specification and artifact manifest are exact and non-promotable', () => {
  const { producerSpecification, artifactManifest } = fixture();
  assert.equal(verifyPdePoisson2dGpuProducerSpecification(producerSpecification), true);
  assert.deepEqual(producerSpecification.discretization.gridSizes, [31, 63, 127]);
  assert.equal(producerSpecification.runtime.runtimeProfile, 'pythonGpu');
  assert.equal(producerSpecification.runtime.requiresGpu, true);
  assert.equal(producerSpecification.runtime.cpuFallback, 'forbidden');
  assert.equal(artifactManifest.scientificAuthority,
    'none-until-independent-cpu-oracle-v1');
  assert.equal(artifactManifest.promotionEligible, false);
  assert.equal(verifyPdePoisson2dGpuArtifactManifest(artifactManifest, {
    producerSpecification,
  }), true);

  const specificationWithExtraKey = clone(producerSpecification);
  specificationWithExtraKey.unregisteredSolver = true;
  assert.equal(verifyPdePoisson2dGpuProducerSpecification(
    specificationWithExtraKey,
  ), false);

  const escaped = clone(artifactManifest);
  escaped.artifacts[0].relativePath = '../n31.f64le';
  const { pdePoisson2dGpuArtifactManifestHash: _oldHash, ...payload } = escaped;
  escaped.pdePoisson2dGpuArtifactManifestHash = hashRecord(
    'PdePoisson2dGpuArtifactManifest',
    payload,
  );
  assert.equal(verifyPdePoisson2dGpuArtifactManifest(escaped, {
    producerSpecification,
  }), false);
});

test('independent CPU oracle recomputes all scientific metrics from raw fields', () => {
  const { root, producerSpecification, artifactManifest } = fixture();
  try {
    const receipt = recomputePdePoisson2dIndependentCpuOracle({
      artifactRoot: root,
      producerSpecification,
      artifactManifest,
      oracleRuntimeIdentityHash: H('independent-node-runtime'),
      producerReportedMetrics: {
        relativeDiscreteResidual: 1e100,
        gridConvergenceOrder: 0,
      },
    });
    assert.equal(receipt.status, 'pde_poisson_2d_independent_cpu_oracle_verified');
    assert.equal(receipt.scientificChecksPassed, true);
    assert.equal(receipt.producerDiagnosticsUsed, false);
    assert.equal(receipt.productionQualified, false);
    assert.equal(receipt.promotionEligible, false);
    assert.deepEqual(receipt.productionBlockers, [
      'pde_poisson_2d_independent_cpu_process_qualification_required',
    ]);
    assert.equal(receipt.observations.length, 3);
    assert.equal(receipt.convergenceOrders.length, 2);
    assert.ok(receipt.observations.every((row) => (
      row.relativeDiscreteResidual < 1e-10
      && row.cpuGpuRelativeL2 === 0
      && row.cpuGpuMaximumAbsoluteError === 0
    )));
    assert.ok(receipt.convergenceOrders.every((row) => row.observedOrder > 1.99));
    assert.equal(verifyPdePoisson2dIndependentCpuOracleReceipt(receipt, {
      producerSpecification,
      artifactManifest,
    }), true);
    assert.equal(verifyPdePoisson2dIndependentCpuOracleAgainstArtifacts(receipt, {
      artifactRoot: root,
      producerSpecification,
      artifactManifest,
      oracleRuntimeIdentityHash: H('independent-node-runtime'),
    }), true);

    const forged = clone(receipt);
    forged.observations[0].relativeDiscreteResidual = 0;
    const { pdePoisson2dIndependentCpuOracleReceiptHash: _claimed, ...payload } = forged;
    forged.pdePoisson2dIndependentCpuOracleReceiptHash = hashRecord(
      'PdePoisson2dIndependentCpuOracleReceipt',
      payload,
    );
    assert.equal(verifyPdePoisson2dIndependentCpuOracleAgainstArtifacts(forged, {
      artifactRoot: root,
      producerSpecification,
      artifactManifest,
      oracleRuntimeIdentityHash: H('independent-node-runtime'),
    }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('independent CPU oracle fails closed on content tampering', () => {
  const { root, producerSpecification, artifactManifest } = fixture();
  try {
    const target = path.join(root, artifactManifest.artifacts[0].relativePath);
    const bytes = fs.readFileSync(target);
    bytes[0] ^= 0xff;
    fs.writeFileSync(target, bytes);
    const receipt = recomputePdePoisson2dIndependentCpuOracle({
      artifactRoot: root,
      producerSpecification,
      artifactManifest,
      oracleRuntimeIdentityHash: H('independent-node-runtime'),
    });
    assert.equal(receipt.status, 'pde_poisson_2d_independent_cpu_oracle_blocked');
    assert.equal(receipt.scientificChecksPassed, false);
    assert.ok(receipt.blockers.includes('pde_oracle_artifact_hash_mismatch:n31'));
    assert.deepEqual(receipt.observations, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('independent CPU oracle rejects symlinked and hard-linked artifact paths', async (t) => {
  await t.test('symlink', () => {
    const { root, producerSpecification, artifactManifest } = fixture();
    try {
      const target = path.join(root, artifactManifest.artifacts[0].relativePath);
      const replacement = path.join(root, 'replacement.f64le');
      fs.renameSync(target, replacement);
      fs.symlinkSync(replacement, target);
      const receipt = recomputePdePoisson2dIndependentCpuOracle({
        artifactRoot: root,
        producerSpecification,
        artifactManifest,
        oracleRuntimeIdentityHash: H('independent-node-runtime'),
      });
      assert.equal(receipt.status, 'pde_poisson_2d_independent_cpu_oracle_blocked');
      assert.ok(receipt.blockers.some((item) => item.includes('symlink_forbidden')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('hardlink', () => {
    const { root, producerSpecification, artifactManifest } = fixture();
    try {
      const target = path.join(root, artifactManifest.artifacts[0].relativePath);
      fs.linkSync(target, path.join(root, 'additional-link.f64le'));
      const receipt = recomputePdePoisson2dIndependentCpuOracle({
        artifactRoot: root,
        producerSpecification,
        artifactManifest,
        oracleRuntimeIdentityHash: H('independent-node-runtime'),
      });
      assert.equal(receipt.status, 'pde_poisson_2d_independent_cpu_oracle_blocked');
      assert.ok(receipt.blockers.some((item) => item.includes('hardlink_forbidden')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test('process worker cannot qualify a structurally valid but scientifically blocked oracle', () => {
  const { root, producerSpecification, artifactManifest } = fixture();
  try {
    const reads = artifactManifest.artifacts.map((artifact) => readScopedFileSync({
      scopeRoot: root,
      candidate: path.join(root, artifact.relativePath),
      maximumBytes: artifact.bytes,
    }));
    const workerImplementation =
      currentPdePoisson2dCpuOracleWorkerImplementation();
    const request = buildProcessIsolatedPdePoisson2dCpuOracleRequest({
      producerSpecification,
      artifactManifest,
      artifactPayloads: reads.map((read, index) => Object.freeze({
        gridSize: artifactManifest.artifacts[index].gridSize,
        bytes: read.bytes,
        sha256: read.hash,
        contentBase64: read.content.toString('base64'),
      })),
      artifactReadReceiptHashes: reads.map(
        (read) => read.scopedFileReadReceiptHash,
      ),
      workerImplementation,
      oracleRuntimeIdentityHash: H('cpu-runtime'),
      resourceBudget: PDE_POISSON_2D_CPU_ORACLE_RESOURCE_LIMITS,
    });
    const oracleReceipt = buildPdePoisson2dIndependentCpuOracleReceipt({
      producerSpecification,
      artifactManifest,
      oracleImplementationHash:
        PDE_POISSON_2D_INDEPENDENT_CPU_ALGORITHM_IMPLEMENTATION.implementationHash,
      oracleRuntimeIdentityHash: H('cpu-runtime'),
      artifactReadReceiptHashes: reads.map(
        (read) => read.scopedFileReadReceiptHash,
      ),
      observations: producerSpecification.discretization.gridSizes.map(
        (gridSize) => ({
          gridSize,
          relativeDiscreteResidual: 1,
          relativeContinuousL2Error: 1,
          cpuGpuRelativeL2: 1,
          cpuGpuMaximumAbsoluteError: 1,
        }),
      ),
      convergenceOrders: [
        { coarseGridSize: 31, fineGridSize: 63, observedOrder: 0 },
        { coarseGridSize: 63, fineGridSize: 127, observedOrder: 0 },
      ],
    });
    assert.equal(oracleReceipt.status,
      'pde_poisson_2d_independent_cpu_oracle_blocked');
    const workerReceipt = buildPdePoisson2dCpuOracleWorkerReceipt({
      request,
      workerImplementation,
      oracleReceipt,
      workerPid: 1,
      parentPid: 0,
    });
    assert.equal(workerReceipt.status, 'pde_poisson_2d_cpu_oracle_worker_blocked');
    assert.equal(workerReceipt.oracleReceipt, null);
    assert.ok(workerReceipt.blockers.includes(
      'pde_cpu_oracle_worker_scientific_receipt_invalid',
    ));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('process worker fails closed when the oracle receipt claims another implementation or runtime', () => {
  const { root, producerSpecification, artifactManifest } = fixture();
  try {
    const reads = artifactManifest.artifacts.map((artifact) => readScopedFileSync({
      scopeRoot: root,
      candidate: path.join(root, artifact.relativePath),
      maximumBytes: artifact.bytes,
    }));
    const workerImplementation =
      currentPdePoisson2dCpuOracleWorkerImplementation();
    const oracleRuntimeIdentityHash = H('bound-cpu-runtime');
    const request = buildProcessIsolatedPdePoisson2dCpuOracleRequest({
      producerSpecification,
      artifactManifest,
      artifactPayloads: reads.map((read, index) => Object.freeze({
        gridSize: artifactManifest.artifacts[index].gridSize,
        bytes: read.bytes,
        sha256: read.hash,
        contentBase64: read.content.toString('base64'),
      })),
      artifactReadReceiptHashes: reads.map(
        (read) => read.scopedFileReadReceiptHash,
      ),
      workerImplementation,
      oracleRuntimeIdentityHash,
      resourceBudget: PDE_POISSON_2D_CPU_ORACLE_RESOURCE_LIMITS,
    });
    const metrics = recomputePdePoisson2dMetricsFromArtifactBytes({
      producerSpecification,
      artifactManifest,
      artifactBytes: reads.map((read) => read.content),
    });
    const identities = [
      {
        oracleImplementationHash: H('substitute-oracle-implementation'),
        oracleRuntimeIdentityHash,
      },
      {
        oracleImplementationHash:
          workerImplementation.independentAlgorithmImplementationHash,
        oracleRuntimeIdentityHash: H('substitute-oracle-runtime'),
      },
      {
        oracleImplementationHash: H('substitute-oracle-implementation'),
        oracleRuntimeIdentityHash: H('substitute-oracle-runtime'),
      },
    ];
    for (const identity of identities) {
      const oracleReceipt = buildPdePoisson2dIndependentCpuOracleReceipt({
        producerSpecification,
        artifactManifest,
        ...identity,
        artifactReadReceiptHashes: reads.map(
          (read) => read.scopedFileReadReceiptHash,
        ),
        observations: metrics.observations,
        convergenceOrders: metrics.convergenceOrders,
      });
      assert.equal(oracleReceipt.status,
        'pde_poisson_2d_independent_cpu_oracle_verified');
      const workerReceipt = buildPdePoisson2dCpuOracleWorkerReceipt({
        request,
        workerImplementation,
        oracleReceipt,
        workerPid: 1,
        parentPid: 0,
      });
      assert.equal(workerReceipt.status,
        'pde_poisson_2d_cpu_oracle_worker_blocked');
      assert.equal(workerReceipt.oracleReceipt, null);
      assert.ok(workerReceipt.blockers.includes(
        'pde_cpu_oracle_worker_scientific_receipt_invalid',
      ));
      assert.equal(verifyPdePoisson2dCpuOracleWorkerReceipt(workerReceipt, {
        request,
        workerImplementation,
      }), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('process worker implementation binds the complete local import closure', () => {
  const implementation = currentPdePoisson2dCpuOracleWorkerImplementation();
  assert.equal(implementation.version, 2);
  assert.equal(verifyPdePoisson2dCpuOracleWorkerImplementation(implementation), true);
  const transitiveRoles = implementation.sourceRecords.slice(5).map(
    ({ role }) => role,
  );
  assert.ok(transitiveRoles.length > 5);
  assert.deepEqual(transitiveRoles, [...transitiveRoles].sort());
  assert.ok(transitiveRoles.includes(
    'transitive:workflow-kernel/record-hash.mjs',
  ));

  const changedDependency = currentPdePoisson2dCpuOracleWorkerImplementation({
    readSource(sourcePath) {
      const bytes = fs.readFileSync(sourcePath);
      return sourcePath.endsWith(`${path.sep}workflow-kernel${path.sep}record-hash.mjs`)
        ? Buffer.concat([bytes, Buffer.from('\n// closure-tamper\n')]) : bytes;
    },
  });
  assert.notEqual(changedDependency.sourceManifestHash,
    implementation.sourceManifestHash);
  assert.notEqual(changedDependency.workerImplementationHash,
    implementation.workerImplementationHash);
});

test('canonical process-isolated CPU oracle binds the fixed runtime and remains non-promotable without qualified GPU production', (t) => {
  const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const image = spawnSync('docker', ['image', 'inspect',
    PDE_POISSON_2D_CPU_ORACLE_DOCKER_IMAGE, '--format', '{{.Id}}'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (docker.status !== 0 || image.status !== 0) {
    t.skip('pinned CPU oracle container unavailable');
    return;
  }
  const { root, producerSpecification, artifactManifest } = fixture();
  try {
    const assurance = runProcessIsolatedPdePoisson2dIndependentCpuOracle({
      artifactRoot: root,
      artifactManifest,
      producerSpecification,
      absoluteDeadlineEpochMs: Date.now() + 300_000,
    });
    assert.equal(assurance.status,
      'process_isolated_pde_poisson_2d_cpu_oracle_verified',
      JSON.stringify(assurance.blockers));
    assert.equal(assurance.productionQualified, true);
    assert.equal(assurance.promotionEligible, false);
    assert.deepEqual(assurance.productionBlockers, [
      'pde_poisson_2d_gpu_producer_qualification_required',
    ]);
    assert.equal(assurance.producerDiagnosticsUsed, false);
    assert.equal(assurance.processIndependent, true);
    assert.equal(assurance.workerReceipt.workerPid, 1);
    assert.equal(assurance.workerReceipt.parentPid, 0);
    assert.deepEqual(
      assurance.workerImplementation.sourceRecords.slice(0, 5)
        .map(({ role }) => role),
      [
        'oracle-algorithm',
        'process-assurance-contract',
        'producer-artifact-contract',
        'scientific-receipt-contract',
        'worker-entry',
      ],
    );
    assert.ok(assurance.workerImplementation.sourceRecords.length > 10);
    assert.equal(assurance.osSandboxBackend, 'docker');
    assert.equal(assurance.runtimeImageDigest,
      assurance.osSandboxWorkerReceipt.containerImageDigest);
    assert.equal(assurance.runtimePackageClosureHash,
      assurance.runtimeImageDigest);
    assert.equal(
      verifyProductionOsSandboxWorkerReceipt(assurance.osSandboxWorkerReceipt),
      true,
    );
    assert.equal(
      verifyProcessIsolatedPdePoisson2dCpuOracleAgainstArtifacts(assurance, {
        artifactRoot: root,
        artifactManifest,
        producerSpecification,
      }),
      true,
    );
    assert.equal(
      verifyProcessIsolatedPdePoisson2dCpuOracleAssurance(assurance),
      true,
    );
    assert.equal(assurance.version, 2);
    assert.equal(assurance.absoluteDeadlineEpochMs > Date.now(), true);
    assert.equal(assurance.request.requestHash, assurance.requestHash);

    for (const mutate of [
      (receipt) => { receipt.executionProcessInvocation.executableTarget = '/usr/local/bin/node'; },
      (receipt) => { receipt.executionProcessInvocation.arguments.push('--unregistered'); },
      (receipt) => { receipt.executionProcessInvocation.workingDirectory = '/work/unregistered'; },
      (receipt) => {
        receipt.executionProcessInvocation.standardInput.sha256 = H('unrelated-stdin');
        receipt.executionProcessInvocation.standardInput.byteLength += 1;
      },
    ]) {
      const repackaged = clone(assurance);
      mutate(repackaged.osSandboxWorkerReceipt);
      rehashOsSandboxWorkerReceipt(repackaged.osSandboxWorkerReceipt);
      const invocation = repackaged.osSandboxWorkerReceipt.executionProcessInvocation;
      repackaged.runtimeAttestation.executableTarget = invocation.executableTarget;
      repackaged.runtimeAttestation.arguments = invocation.arguments;
      repackaged.runtimeAttestation.workingDirectory = invocation.workingDirectory;
      repackaged.runtimeAttestation.standardInputHash = invocation.standardInput.sha256;
      repackaged.runtimeAttestation.standardInputByteLength =
        invocation.standardInput.byteLength;
      repackaged.runtimeAttestation.executionProcessInvocationHash =
        repackaged.osSandboxWorkerReceipt.executionProcessInvocationHash;
      rehashPdeCpuOracleAssurance(repackaged);
      assert.equal(
        verifyProductionOsSandboxWorkerReceipt(repackaged.osSandboxWorkerReceipt),
        true,
        'generic production receipt remains structurally valid after repackaging',
      );
      assert.equal(
        verifyProcessIsolatedPdePoisson2dCpuOracleAssurance(repackaged),
        false,
        'PDE assurance rejects a generic receipt with a non-canonical invocation',
      );
    }

    const forged = clone(assurance);
    forged.osSandboxWorkerReceipt.backend = 'fixture';
    const osPayload = { ...forged.osSandboxWorkerReceipt };
    delete osPayload.ok;
    delete osPayload.receiptHash;
    delete osPayload.blockers;
    forged.osSandboxWorkerReceipt.receiptHash = hashRecord(
      'OsSandboxWorkerReceipt',
      osPayload,
    );
    forged.osSandboxBackend = 'fixture';
    forged.osSandboxWorkerReceiptHash = forged.osSandboxWorkerReceipt.receiptHash;
    const {
      pdePoisson2dProcessIsolatedCpuOracleAssuranceHash: _assuranceHash,
      ...assurancePayload
    } = forged;
    forged.pdePoisson2dProcessIsolatedCpuOracleAssuranceHash = hashRecord(
      'ProcessIsolatedPdePoisson2dCpuOracleAssurance',
      assurancePayload,
    );
    assert.equal(
      verifyProcessIsolatedPdePoisson2dCpuOracleAgainstArtifacts(forged, {
        artifactRoot: root,
        artifactManifest,
        producerSpecification,
      }),
      false,
    );

    const forgedSource = clone(assurance);
    forgedSource.workerSourceManifestHash = H('unrelated-oracle-source');
    const {
      pdePoisson2dProcessIsolatedCpuOracleAssuranceHash: _sourceHash,
      ...sourcePayload
    } = forgedSource;
    forgedSource.pdePoisson2dProcessIsolatedCpuOracleAssuranceHash = hashRecord(
      'ProcessIsolatedPdePoisson2dCpuOracleAssurance',
      sourcePayload,
    );
    assert.equal(
      verifyProcessIsolatedPdePoisson2dCpuOracleAgainstArtifacts(forgedSource, {
        artifactRoot: root,
        artifactManifest,
        producerSpecification,
      }),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
