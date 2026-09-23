import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SOURCE_HASH = hashBytes(fs.readFileSync(fileURLToPath(import.meta.url)));

export const PDE_POISSON_2D_INDEPENDENT_CPU_ALGORITHM_IMPLEMENTATION =
  Object.freeze({
    version: 1,
    kind: 'PdePoisson2dIndependentCpuAlgorithmImplementation',
    algorithm: 'analytic-discrete-cpu-recomputation-v1',
    sourceHash: SOURCE_HASH,
    implementationHash: hashRecord(
      'PdePoisson2dIndependentCpuAlgorithmImplementation',
      {
        version: 1,
        kind: 'PdePoisson2dIndependentCpuAlgorithmImplementation',
        algorithm: 'analytic-discrete-cpu-recomputation-v1',
        sourceHash: SOURCE_HASH,
      },
    ),
  });

function decodeFloat64LittleEndian(bytes, elements) {
  if (!Buffer.isBuffer(bytes)
    || bytes.length !== elements * Float64Array.BYTES_PER_ELEMENT) {
    throw new Error('pde_poisson_2d_solution_byte_length_invalid');
  }
  const values = new Float64Array(elements);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < elements; index += 1) {
    values[index] = view.getFloat64(
      index * Float64Array.BYTES_PER_ELEMENT,
      true,
    );
    if (!Number.isFinite(values[index])) {
      throw new Error('pde_poisson_2d_solution_nonfinite');
    }
  }
  return values;
}

function fields(gridSize, modes) {
  const elements = gridSize * gridSize;
  const spacing = 1 / (gridSize + 1);
  const exact = new Float64Array(elements);
  const forcing = new Float64Array(elements);
  const discreteReference = new Float64Array(elements);
  for (let row = 0; row < gridSize; row += 1) {
    const y = (row + 1) * spacing;
    for (let column = 0; column < gridSize; column += 1) {
      const x = (column + 1) * spacing;
      const index = row * gridSize + column;
      for (const { amplitude, kx, ky } of modes) {
        const basis = Math.sin(kx * Math.PI * x)
          * Math.sin(ky * Math.PI * y);
        const continuousEigenvalue = Math.PI ** 2 * (kx ** 2 + ky ** 2);
        const discreteEigenvalue = 4 / spacing ** 2 * (
          Math.sin(kx * Math.PI * spacing / 2) ** 2
          + Math.sin(ky * Math.PI * spacing / 2) ** 2
        );
        exact[index] += amplitude * basis;
        forcing[index] += amplitude * continuousEigenvalue * basis;
        discreteReference[index] += amplitude * continuousEigenvalue
          / discreteEigenvalue * basis;
      }
    }
  }
  return { spacing, exact, forcing, discreteReference };
}

function l2(values) {
  let squared = 0;
  for (const value of values) squared += value * value;
  return Math.sqrt(squared);
}

function differenceMetrics(left, right) {
  const difference = new Float64Array(left.length);
  let maximumAbsoluteError = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference[index] = left[index] - right[index];
    maximumAbsoluteError = Math.max(
      maximumAbsoluteError,
      Math.abs(difference[index]),
    );
  }
  return {
    relativeL2: l2(difference) / l2(right),
    maximumAbsoluteError,
  };
}

function relativeResidual(solution, forcing, gridSize, spacing) {
  const residual = new Float64Array(solution.length);
  const inverseSpacingSquared = 1 / spacing ** 2;
  for (let row = 0; row < gridSize; row += 1) {
    for (let column = 0; column < gridSize; column += 1) {
      const index = row * gridSize + column;
      const left = column ? solution[index - 1] : 0;
      const right = column + 1 < gridSize ? solution[index + 1] : 0;
      const down = row ? solution[index - gridSize] : 0;
      const up = row + 1 < gridSize ? solution[index + gridSize] : 0;
      residual[index] = (4 * solution[index] - left - right - down - up)
        * inverseSpacingSquared - forcing[index];
    }
  }
  return l2(residual) / l2(forcing);
}

function observation(solution, gridSize, modes) {
  const { spacing, exact, forcing, discreteReference } = fields(gridSize, modes);
  const continuous = differenceMetrics(solution, exact);
  const cpuGpu = differenceMetrics(solution, discreteReference);
  return Object.freeze({
    gridSize,
    relativeDiscreteResidual:
      relativeResidual(solution, forcing, gridSize, spacing),
    relativeContinuousL2Error: continuous.relativeL2,
    cpuGpuRelativeL2: cpuGpu.relativeL2,
    cpuGpuMaximumAbsoluteError: cpuGpu.maximumAbsoluteError,
  });
}

function convergenceOrders(observations) {
  return Object.freeze(observations.slice(0, -1).map((coarse, index) => {
    const fine = observations[index + 1];
    const coarseSpacing = 1 / (coarse.gridSize + 1);
    const fineSpacing = 1 / (fine.gridSize + 1);
    return Object.freeze({
      coarseGridSize: coarse.gridSize,
      fineGridSize: fine.gridSize,
      observedOrder: Math.log(
        coarse.relativeContinuousL2Error / fine.relativeContinuousL2Error,
      ) / Math.log(coarseSpacing / fineSpacing),
    });
  }));
}

export function recomputePdePoisson2dMetricsFromArtifactBytes({
  producerSpecification,
  artifactManifest,
  artifactBytes,
} = {}) {
  if (!Array.isArray(artifactBytes)
    || artifactBytes.length !== artifactManifest?.artifacts?.length) {
    throw new Error('pde_poisson_2d_artifact_bytes_invalid');
  }
  const observations = Object.freeze(artifactBytes.map((bytes, index) => {
    const artifact = artifactManifest.artifacts[index];
    return observation(
      decodeFloat64LittleEndian(bytes, artifact.elements),
      artifact.gridSize,
      producerSpecification.equation.manufacturedModes,
    );
  }));
  return Object.freeze({
    observations,
    convergenceOrders: convergenceOrders(observations),
  });
}
