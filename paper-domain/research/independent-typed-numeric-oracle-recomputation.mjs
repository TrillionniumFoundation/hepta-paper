import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildProcessIsolatedTypedNumericOracleRecomputationReceipt,
  buildProcessIsolatedTypedNumericOracleRequest,
  verifyProcessIsolatedTypedNumericOracleRecomputationReceiptShape,
  verifyProcessIsolatedTypedNumericOracleWorkerReceipt,
} from './process-isolated-typed-numeric-oracle-recomputation-contract.mjs';
import { TYPED_NUMERIC_ORACLE_ALGORITHMS } from './typed-numeric-oracle-production.mjs';

const ADVANCED = Object.freeze(Object.keys(TYPED_NUMERIC_ORACLE_ALGORITHMS).sort());
const ARMS = Object.freeze(['treatment', 'baseline', 'ablation']);
const IMPLEMENTATION = Object.freeze({
  version: 1,
  kind: 'IndependentTypedNumericOracleImplementation',
  algorithms: Object.freeze({
    condition: 'welford-normalized-diagonal-covariance-v1',
    convergence: 'direct-prefix-and-full-mean-tail-bound-v1',
    error: 'two-pass-bounded-sample-standard-error-v1',
    optimality: 'registered-arm-cellwise-gap-v1',
  }),
  arithmetic: 'independent-ieee754-finite-double-v1',
  candidateAuthoredValuesAccepted: false,
});

export const INDEPENDENT_TYPED_NUMERIC_ORACLE_IMPLEMENTATION = Object.freeze({
  ...IMPLEMENTATION,
  independentTypedNumericOracleImplementationHash: hashRecord(
    'IndependentTypedNumericOracleImplementation', IMPLEMENTATION,
  ),
});

function rowsFor(observations, protocol) {
  const metrics = protocol.requiredMetrics;
  if (!Array.isArray(observations) || !Array.isArray(metrics)) {
    throw new Error('independent_typed_numeric_oracle_input_invalid');
  }
  return observations.map((row) => ({
    seed: Number(row.seed),
    repetition: Number(row.repetition),
    arm: String(row.arm),
    metrics: Object.fromEntries(metrics.map((metric) => [metric, Number(row.metrics?.[metric])])),
  })).sort((a, b) => a.seed - b.seed || a.repetition - b.repetition
    || ARMS.indexOf(a.arm) - ARMS.indexOf(b.arm));
}

function directMean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function welfordVariance(values) {
  let count = 0;
  let center = 0;
  let m2 = 0;
  for (const value of values) {
    count += 1;
    const delta = value - center;
    center += delta / count;
    m2 += delta * (value - center);
  }
  return m2 / (count - 1);
}

function grouped(rows, metric, arm) {
  return rows.filter((row) => row.arm === arm).map((row) => row.metrics[metric]);
}

function recompute(oracleType, rows, protocol) {
  const metrics = protocol.requiredMetrics;
  const specs = protocol.metricSpecs;
  if (oracleType === 'condition-number-bound-v1') {
    const variances = metrics.map((metric) => {
      const spec = specs[metric];
      const width = Number(spec.maximum) - Number(spec.minimum);
      return welfordVariance(rows.map((row) => (
        (row.metrics[metric] - Number(spec.minimum)) / width
      )));
    });
    const minimum = Math.min(...variances);
    if (!(minimum > Number.EPSILON)) throw new Error('condition_matrix_singular');
    return Object.freeze({
      quantity: 'normalized_diagonal_covariance_condition_number',
      observedValue: Math.max(...variances) / minimum,
      relation: 'greater-than-or-equal',
      lowerBound: 1,
      upperBound: null,
      unit: 'ratio',
    });
  }
  if (oracleType === 'convergence-rate-bound-v1') {
    let result = 0;
    let maximumBound = 0;
    for (const metric of metrics) {
      const width = Number(specs[metric].maximum) - Number(specs[metric].minimum);
      for (const arm of ARMS) {
        const values = grouped(rows, metric, arm);
        const split = Math.floor(values.length / 2);
        result = Math.max(result, Math.abs(
          directMean(values.slice(0, split)) - directMean(values),
        ) / width);
        maximumBound = Math.max(maximumBound, (values.length - split) / values.length);
      }
    }
    return Object.freeze({
      quantity: 'maximum_normalized_running_mean_tail_drift',
      observedValue: result,
      relation: 'less-than-or-equal',
      lowerBound: null,
      upperBound: maximumBound + (32 * Number.EPSILON),
      unit: 'normalized-metric-range',
    });
  }
  if (oracleType === 'error-bound-v1') {
    let result = 0;
    let maximumBound = 0;
    for (const metric of metrics) {
      const width = Number(specs[metric].maximum) - Number(specs[metric].minimum);
      for (const arm of ARMS) {
        const values = grouped(rows, metric, arm);
        const center = directMean(values);
        const variance = values.reduce((sum, value) => (
          sum + ((value - center) ** 2)
        ), 0) / (values.length - 1);
        result = Math.max(result, Math.sqrt(Math.max(0, variance))
          / Math.sqrt(values.length) / width);
        maximumBound = Math.max(maximumBound, 1 / (2 * Math.sqrt(values.length - 1)));
      }
    }
    return Object.freeze({
      quantity: 'maximum_normalized_sample_mean_standard_error',
      observedValue: result,
      relation: 'less-than-or-equal',
      lowerBound: null,
      upperBound: maximumBound + (32 * Number.EPSILON),
      unit: 'normalized-metric-range',
    });
  }
  if (oracleType === 'optimality-gap-bound-v1') {
    const metric = String(protocol.hypotheses?.[0]?.metric || metrics[0]);
    const spec = specs[metric];
    const cells = new Map();
    for (const row of rows) {
      const key = `${row.seed}\0${row.repetition}`;
      const cell = cells.get(key) || {};
      cell[row.arm] = row.metrics[metric];
      cells.set(key, cell);
    }
    const observedValue = Math.max(...[...cells.values()].map((cell) => {
      const comparator = spec.direction === 'maximize'
        ? Math.max(...ARMS.map((arm) => cell[arm]))
        : Math.min(...ARMS.map((arm) => cell[arm]));
      return spec.direction === 'maximize'
        ? comparator - cell.treatment : cell.treatment - comparator;
    }));
    return Object.freeze({
      quantity: 'maximum_registered_arm_empirical_optimality_gap',
      observedValue,
      relation: 'interval',
      lowerBound: 0,
      upperBound: Number(spec.maximum) - Number(spec.minimum),
      unit: spec.unit,
    });
  }
  throw new Error('independent_typed_numeric_oracle_kind_unknown');
}

function tolerance(value) {
  return Math.max(1e-12, Math.abs(Number(value)) * 1e-12);
}

function numericFieldComparison(independent, produced) {
  if (independent === null || produced === null) {
    return Object.freeze({
      difference: independent === produced ? 0 : null,
      allowedDifference: 0,
      match: independent === produced,
    });
  }
  const difference = Math.abs(Number(independent) - Number(produced));
  const allowedDifference = tolerance(produced);
  return Object.freeze({
    difference,
    allowedDifference,
    match: Number.isFinite(Number(independent)) && Number.isFinite(Number(produced))
      && difference <= allowedDifference,
  });
}

export function buildIndependentTypedNumericOracleRecomputation({
  production,
  observations,
  analysisProtocol,
  pluginProfile,
} = {}) {
  const rows = rowsFor(observations, analysisProtocol);
  const blockers = [];
  const comparisons = [];
  if (production?.analysisProtocolHash !== analysisProtocol?.analysisProtocolHash
    || production?.empiricalPluginProfileHash
      !== pluginProfile?.autonomousEmpiricalFamilyPluginProfileHash
    || production?.status !== 'typed_numeric_oracle_production_verified') {
    blockers.push('independent_typed_numeric_oracle_production_invalid');
  }
  for (const produced of production?.outputs || []) {
    if (!ADVANCED.includes(produced.oracleType)) {
      blockers.push(`independent_typed_numeric_oracle_kind_unknown:${produced.oracleType}`);
      continue;
    }
    let independentlyRecomputed = null;
    try { independentlyRecomputed = recompute(produced.oracleType, rows, analysisProtocol); }
    catch (error) {
      blockers.push(`${produced.oracleType}:${String(error?.message || error)}`);
      continue;
    }
    const observedComparison = numericFieldComparison(
      independentlyRecomputed.observedValue,
      produced.observedValue,
    );
    const lowerBoundComparison = numericFieldComparison(
      independentlyRecomputed.lowerBound,
      produced.lowerBound,
    );
    const upperBoundComparison = numericFieldComparison(
      independentlyRecomputed.upperBound,
      produced.upperBound,
    );
    const fieldMatches = Object.freeze({
      quantity: independentlyRecomputed.quantity === produced.quantity,
      observedValue: observedComparison.match,
      relation: independentlyRecomputed.relation === produced.relation,
      lowerBound: lowerBoundComparison.match,
      upperBound: upperBoundComparison.match,
      unit: independentlyRecomputed.unit === produced.unit,
    });
    const match = Object.values(fieldMatches).every(Boolean);
    if (!match) blockers.push(`independent_typed_numeric_oracle_mismatch:${produced.oracleType}`);
    const comparisonPayload = {
      oracleType: produced.oracleType,
      producerOutputHash: produced.typedNumericOracleAlgorithmOutputHash,
      independentlyObserved: independentlyRecomputed.observedValue,
      independentlyRecomputed,
      fieldMatches,
      maximumAbsoluteDifference: observedComparison.difference,
      maximumAllowedDifference: observedComparison.allowedDifference,
      lowerBoundAbsoluteDifference: lowerBoundComparison.difference,
      lowerBoundAllowedDifference: lowerBoundComparison.allowedDifference,
      upperBoundAbsoluteDifference: upperBoundComparison.difference,
      upperBoundAllowedDifference: upperBoundComparison.allowedDifference,
      match,
    };
    comparisons.push(Object.freeze({
      ...comparisonPayload,
      independentTypedNumericOracleComparisonHash: hashRecord(
        'IndependentTypedNumericOracleComparison', comparisonPayload,
      ),
    }));
  }
  if (comparisons.length !== production?.outputs?.length) {
    blockers.push('independent_typed_numeric_oracle_output_bijection_invalid');
  }
  const payload = {
    version: 1,
    kind: 'IndependentTypedNumericOracleRecomputation',
    status: blockers.length
      ? 'independent_typed_numeric_oracle_recomputation_blocked'
      : 'independent_typed_numeric_oracle_recomputation_verified',
    assuranceScope: 'repository-separate-implementation-same-process-v1',
    analysisProtocolHash: analysisProtocol?.analysisProtocolHash || null,
    empiricalPluginProfileHash:
      pluginProfile?.autonomousEmpiricalFamilyPluginProfileHash || null,
    numericInputManifestHash: production?.numericInputManifestHash || null,
    productionHash: production?.typedNumericOracleProductionHash || null,
    producerImplementationHash: production?.producerImplementationHash || null,
    verifierImplementationHash: INDEPENDENT_TYPED_NUMERIC_ORACLE_IMPLEMENTATION
      .independentTypedNumericOracleImplementationHash,
    independentlyRecomputed: true,
    processIndependent: false,
    candidateAuthoredValuesAccepted: false,
    comparisons: Object.freeze(comparisons.sort((a, b) => (
      a.oracleType.localeCompare(b.oracleType)
    ))),
    blockers: Object.freeze([...new Set(blockers)]),
  };
  if (payload.producerImplementationHash === payload.verifierImplementationHash) {
    throw new Error('independent_typed_numeric_oracle_implementation_not_distinct');
  }
  return Object.freeze({
    ...payload,
    independentTypedNumericOracleRecomputationHash: hashRecord(
      'IndependentTypedNumericOracleRecomputation', payload,
    ),
  });
}

export function verifyIndependentTypedNumericOracleRecomputation(
  receipt, inputs,
) {
  if (verifyProcessIsolatedTypedNumericOracleRecomputationReceiptShape(receipt)) {
    try {
      const request = buildProcessIsolatedTypedNumericOracleRequest({
        production: inputs?.production,
        observations: inputs?.observations,
        analysisProtocol: inputs?.analysisProtocol,
        pluginProfile: inputs?.pluginProfile,
        experimentIr: inputs?.experimentIr,
      });
      const workerImplementation = receipt.workerImplementation;
      const workerReceiptVerified = verifyProcessIsolatedTypedNumericOracleWorkerReceipt(
        receipt.workerReceipt,
        {
          request,
          workerImplementation,
          verifyRecomputation: (candidate) => {
            if (candidate?.version !== 1) return false;
            const rebuilt = buildIndependentTypedNumericOracleRecomputation({
              ...inputs,
              production: inputs?.production || candidate?.production,
            });
            return JSON.stringify(rebuilt) === JSON.stringify(candidate)
              && candidate.status
                === 'independent_typed_numeric_oracle_recomputation_verified';
          },
        },
      );
      if (!workerReceiptVerified
        || receipt.status !== 'independent_typed_numeric_oracle_recomputation_verified'
        || receipt.processIndependent !== true
        || receipt.independentlyRecomputed !== true
        || receipt.networkGuardInstalled !== true
        || receipt.networkActionPerformed !== false
        || receipt.externalActionPerformed !== false
        || receipt.parentPid !== receipt.workerReceipt.parentPid
        || receipt.workerPid !== receipt.workerReceipt.workerPid
        || receipt.workerPid === receipt.parentPid
        || receipt.workerReceiptHash !== receipt.workerReceipt.workerReceiptHash
        || receipt.verifierImplementationHash
          !== workerImplementation?.workerImplementationHash
        || receipt.independentAlgorithmImplementationHash
          !== INDEPENDENT_TYPED_NUMERIC_ORACLE_IMPLEMENTATION
            .independentTypedNumericOracleImplementationHash
        || receipt.numericTupleManifestHash
          !== receipt.workerReceipt.numericTupleManifestHash
        || JSON.stringify(receipt.numericTupleManifest)
          !== JSON.stringify(receipt.workerReceipt.numericTupleManifest)
        || JSON.stringify(receipt.comparisons)
          !== JSON.stringify(receipt.recomputation?.comparisons)) return false;
      const rebuilt = buildProcessIsolatedTypedNumericOracleRecomputationReceipt({
        request,
        workerImplementation,
        workerReceipt: receipt.workerReceipt,
        parentPid: receipt.parentPid,
        workerPid: receipt.workerPid,
        blockers: [],
      });
      return JSON.stringify(rebuilt) === JSON.stringify(receipt);
    } catch { return false; }
  }
  try {
    const rebuilt = buildIndependentTypedNumericOracleRecomputation({
      ...inputs, production: inputs?.production || receipt?.production,
    });
    return JSON.stringify(rebuilt) === JSON.stringify(receipt)
      && receipt.status === 'independent_typed_numeric_oracle_recomputation_verified';
  } catch { return false; }
}
