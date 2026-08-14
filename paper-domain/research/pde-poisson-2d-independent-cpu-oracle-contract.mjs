import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildPdePoisson2dGpuProducerSpecification,
  verifyPdePoisson2dGpuArtifactManifest,
  verifyPdePoisson2dGpuProducerSpecification,
} from './pde-poisson-2d-gpu-capability-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const OBSERVATION_KEYS = Object.freeze([
  'cpuGpuMaximumAbsoluteError', 'cpuGpuRelativeL2', 'gridSize',
  'relativeContinuousL2Error', 'relativeDiscreteResidual',
]);
const ORDER_KEYS = Object.freeze([
  'coarseGridSize', 'fineGridSize', 'observedOrder',
]);
const RECEIPT_KEYS = Object.freeze([
  'artifactManifestHash', 'artifactReadReceiptHashes', 'blockers',
  'convergenceOrders', 'kind', 'observations', 'oracleAlgorithm',
  'oracleImplementationHash', 'oracleRuntimeIdentityHash',
  'operationalBlockers', 'pdePoisson2dIndependentCpuOracleReceiptHash',
  'producerDiagnosticsUsed', 'producerSpecificationHash', 'productionBlockers',
  'productionQualified', 'profileId', 'promotionEligible',
  'scientificAuthority', 'scientificChecksPassed', 'status', 'version',
]);

function sha(value) {
  const selected = String(value || '').toLowerCase();
  return SHA256.test(selected) ? selected : null;
}

function nonnegativeFinite(value) {
  return Number.isFinite(value) && value >= 0;
}

function canonicalObservations(value, gridSizes) {
  if (!Array.isArray(value) || value.length !== gridSizes.length) {
    throw new Error('pde_poisson_2d_oracle_observations_invalid');
  }
  return Object.freeze(gridSizes.map((gridSize, index) => {
    const row = value[index];
    if (!hasExactObjectKeys(row, OBSERVATION_KEYS)
      || row.gridSize !== gridSize
      || ![
        row.relativeDiscreteResidual,
        row.relativeContinuousL2Error,
        row.cpuGpuRelativeL2,
        row.cpuGpuMaximumAbsoluteError,
      ].every(nonnegativeFinite)) {
      throw new Error('pde_poisson_2d_oracle_observations_invalid');
    }
    return Object.freeze({
      gridSize,
      relativeDiscreteResidual: row.relativeDiscreteResidual,
      relativeContinuousL2Error: row.relativeContinuousL2Error,
      cpuGpuRelativeL2: row.cpuGpuRelativeL2,
      cpuGpuMaximumAbsoluteError: row.cpuGpuMaximumAbsoluteError,
    });
  }));
}

function canonicalOrders(value, gridSizes) {
  if (!Array.isArray(value) || value.length !== gridSizes.length - 1) {
    throw new Error('pde_poisson_2d_oracle_convergence_orders_invalid');
  }
  return Object.freeze(value.map((row, index) => {
    if (!hasExactObjectKeys(row, ORDER_KEYS)
      || row.coarseGridSize !== gridSizes[index]
      || row.fineGridSize !== gridSizes[index + 1]
      || !nonnegativeFinite(row.observedOrder)) {
      throw new Error('pde_poisson_2d_oracle_convergence_orders_invalid');
    }
    return Object.freeze({
      coarseGridSize: gridSizes[index],
      fineGridSize: gridSizes[index + 1],
      observedOrder: row.observedOrder,
    });
  }));
}

function acceptanceBlockers(observations, orders, acceptance) {
  const blockers = [];
  if (observations.some((row) => (
    row.relativeDiscreteResidual > acceptance.maximumRelativeDiscreteResidual
  ))) blockers.push('pde_poisson_2d_relative_discrete_residual_exceeded');
  if (observations.at(-1).relativeContinuousL2Error
    > acceptance.maximumRelativeContinuousL2ErrorAtFinestGrid) {
    blockers.push('pde_poisson_2d_continuous_l2_error_exceeded');
  }
  if (orders.some((row) => (
    row.observedOrder < acceptance.minimumGridConvergenceOrder
  ))) blockers.push('pde_poisson_2d_grid_convergence_order_insufficient');
  if (observations.some((row) => (
    row.cpuGpuRelativeL2 > acceptance.maximumCpuGpuRelativeL2
  ))) blockers.push('pde_poisson_2d_cpu_gpu_relative_l2_exceeded');
  if (observations.some((row) => (
    row.cpuGpuMaximumAbsoluteError > acceptance.maximumCpuGpuAbsoluteError
  ))) blockers.push('pde_poisson_2d_cpu_gpu_absolute_error_exceeded');
  return blockers;
}

export function buildPdePoisson2dIndependentCpuOracleReceipt({
  producerSpecification = buildPdePoisson2dGpuProducerSpecification(),
  artifactManifest,
  oracleImplementationHash,
  oracleRuntimeIdentityHash,
  artifactReadReceiptHashes,
  observations = [],
  convergenceOrders = [],
  operationalBlockers = [],
} = {}) {
  if (!verifyPdePoisson2dGpuProducerSpecification(producerSpecification)
    || !verifyPdePoisson2dGpuArtifactManifest(artifactManifest, {
      producerSpecification,
    })
    || !sha(oracleImplementationHash) || !sha(oracleRuntimeIdentityHash)
    || !Array.isArray(artifactReadReceiptHashes)
    || artifactReadReceiptHashes.length !== artifactManifest.artifacts.length
    || !artifactReadReceiptHashes.every(sha)
    || !Array.isArray(operationalBlockers)
    || operationalBlockers.some((item) => (
      typeof item !== 'string' || !item.length || item.length > 256
    ))) {
    throw new Error('pde_poisson_2d_independent_cpu_oracle_receipt_invalid');
  }
  const uniqueOperationalBlockers = [...new Set(operationalBlockers)].sort();
  let selectedObservations = Object.freeze([]);
  let selectedOrders = Object.freeze([]);
  let metricBlockers = [];
  if (!uniqueOperationalBlockers.length) {
    const gridSizes = producerSpecification.discretization.gridSizes;
    selectedObservations = canonicalObservations(observations, gridSizes);
    selectedOrders = canonicalOrders(convergenceOrders, gridSizes);
    metricBlockers = acceptanceBlockers(
      selectedObservations,
      selectedOrders,
      producerSpecification.acceptance,
    );
  } else if (observations.length || convergenceOrders.length) {
    throw new Error('pde_poisson_2d_blocked_oracle_metrics_forbidden');
  }
  const blockers = Object.freeze([
    ...uniqueOperationalBlockers,
    ...metricBlockers,
  ]);
  const verified = blockers.length === 0;
  const productionBlockers = Object.freeze([
    'pde_poisson_2d_independent_cpu_process_qualification_required',
  ]);
  const payload = {
    version: 1,
    kind: 'PdePoisson2dIndependentCpuOracleReceipt',
    status: verified
      ? 'pde_poisson_2d_independent_cpu_oracle_verified'
      : 'pde_poisson_2d_independent_cpu_oracle_blocked',
    profileId: producerSpecification.profileId,
    producerSpecificationHash:
      producerSpecification.pdePoisson2dGpuProducerSpecificationHash,
    artifactManifestHash: artifactManifest.pdePoisson2dGpuArtifactManifestHash,
    oracleAlgorithm: 'analytic-discrete-cpu-recomputation-v1',
    oracleImplementationHash: sha(oracleImplementationHash),
    oracleRuntimeIdentityHash: sha(oracleRuntimeIdentityHash),
    artifactReadReceiptHashes: Object.freeze(
      artifactReadReceiptHashes.map(sha),
    ),
    observations: selectedObservations,
    convergenceOrders: selectedOrders,
    operationalBlockers: Object.freeze(uniqueOperationalBlockers),
    producerDiagnosticsUsed: false,
    scientificChecksPassed: verified,
    scientificAuthority: verified
      ? 'independent-cpu-recomputation-v1' : 'none-blocked-v1',
    productionQualified: false,
    promotionEligible: false,
    productionBlockers,
    blockers,
  };
  return Object.freeze({
    ...payload,
    pdePoisson2dIndependentCpuOracleReceiptHash:
      hashRecord('PdePoisson2dIndependentCpuOracleReceipt', payload),
  });
}

export function verifyPdePoisson2dIndependentCpuOracleReceipt(value, {
  producerSpecification = buildPdePoisson2dGpuProducerSpecification(),
  artifactManifest,
} = {}) {
  if (!hasExactObjectKeys(value, RECEIPT_KEYS)) return false;
  try {
    const rebuilt = buildPdePoisson2dIndependentCpuOracleReceipt({
      producerSpecification,
      artifactManifest,
      oracleImplementationHash: value.oracleImplementationHash,
      oracleRuntimeIdentityHash: value.oracleRuntimeIdentityHash,
      artifactReadReceiptHashes: value.artifactReadReceiptHashes,
      observations: value.observations,
      convergenceOrders: value.convergenceOrders,
      operationalBlockers: value.operationalBlockers,
    });
    return JSON.stringify(rebuilt) === JSON.stringify(value);
  } catch {
    return false;
  }
}
