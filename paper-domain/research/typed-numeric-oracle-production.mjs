import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyVersionedExperimentIr } from '../automation/versioned-experiment-ir.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ARMS = Object.freeze(['treatment', 'baseline', 'ablation']);
const CORE_ORACLES = new Set(['property-oracle-v1', 'residual-bound-v1']);
const ALGORITHMS = Object.freeze({
  'condition-number-bound-v1': Object.freeze({
    algorithmId: 'normalized-diagonal-covariance-condition-number',
    algorithmVersion: '1.0.0',
  }),
  'convergence-rate-bound-v1': Object.freeze({
    algorithmId: 'finite-sample-running-mean-tail-drift',
    algorithmVersion: '1.0.0',
  }),
  'error-bound-v1': Object.freeze({
    algorithmId: 'bounded-sample-mean-standard-error',
    algorithmVersion: '1.0.0',
  }),
  'optimality-gap-bound-v1': Object.freeze({
    algorithmId: 'registered-comparator-empirical-optimality-gap',
    algorithmVersion: '1.0.0',
  }),
});
const IMPLEMENTATION_PAYLOAD = Object.freeze({
  version: 1,
  kind: 'TypedNumericOracleProducerImplementation',
  algorithms: ALGORITHMS,
  arithmetic: 'deterministic-ieee754-finite-double-v1',
  candidateAuthoredValuesAccepted: false,
});

export const TYPED_NUMERIC_ORACLE_PRODUCER_IMPLEMENTATION = Object.freeze({
  ...IMPLEMENTATION_PAYLOAD,
  typedNumericOracleProducerImplementationHash: hashRecord(
    'TypedNumericOracleProducerImplementation', IMPLEMENTATION_PAYLOAD,
  ),
});

function mean(values) {
  let total = 0;
  let compensation = 0;
  for (const value of values) {
    const adjusted = value - compensation;
    const next = total + adjusted;
    compensation = (next - total) - adjusted;
    total = next;
  }
  return total / values.length;
}

function sampleVariance(values) {
  if (values.length < 2) return Number.NaN;
  const center = mean(values);
  return values.reduce((sum, value) => sum + ((value - center) ** 2), 0)
    / (values.length - 1);
}

function canonicalInputs({ observations, analysisProtocol, pluginProfile }) {
  const metrics = analysisProtocol?.requiredMetrics;
  const specs = analysisProtocol?.metricSpecs;
  const declared = pluginProfile?.typedOracleKinds;
  if (!SHA256.test(String(analysisProtocol?.analysisProtocolHash || ''))
    || !SHA256.test(String(pluginProfile?.autonomousEmpiricalFamilyPluginProfileHash || ''))
    || pluginProfile?.benchmarkFamily !== analysisProtocol?.benchmarkFamily
    || !Array.isArray(metrics) || metrics.length < 1
    || !Array.isArray(declared) || declared.length < 1
    || declared.some((kind) => !CORE_ORACLES.has(kind) && !Object.hasOwn(ALGORITHMS, kind))
    || !Array.isArray(observations) || observations.length < ARMS.length) {
    throw new Error('typed_numeric_oracle_production_input_invalid');
  }
  const selected = observations.map((observation) => {
    const seed = Number(observation?.seed);
    const repetition = Number(observation?.repetition);
    const arm = String(observation?.arm || '');
    const values = Object.fromEntries(metrics.map((metric) => [
      metric, Number(observation?.metrics?.[metric]),
    ]));
    if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(repetition) || repetition < 1
      || !ARMS.includes(arm)
      || Object.keys(observation?.metrics || {}).sort().join('\0')
        !== [...metrics].sort().join('\0')
      || metrics.some((metric) => {
        const spec = specs?.[metric];
        return !spec || !Number.isFinite(values[metric])
          || !Number.isFinite(Number(spec.minimum)) || !Number.isFinite(Number(spec.maximum))
          || Number(spec.minimum) >= Number(spec.maximum)
          || values[metric] < Number(spec.minimum) || values[metric] > Number(spec.maximum);
      })) throw new Error('typed_numeric_oracle_nonfinite_or_unbounded_observation');
    return Object.freeze({ seed, repetition, arm, metrics: Object.freeze(values) });
  }).sort((left, right) => left.seed - right.seed
    || left.repetition - right.repetition || ARMS.indexOf(left.arm) - ARMS.indexOf(right.arm));
  const cellArms = new Map();
  for (const row of selected) {
    const key = `${row.seed}\0${row.repetition}`;
    const arms = cellArms.get(key) || new Set();
    if (arms.has(row.arm)) throw new Error('typed_numeric_oracle_observation_duplicate');
    arms.add(row.arm);
    cellArms.set(key, arms);
  }
  if ([...cellArms.values()].some((arms) => (
    arms.size !== ARMS.length || ARMS.some((arm) => !arms.has(arm))
  ))) throw new Error('typed_numeric_oracle_observation_arm_bijection_invalid');
  const observedSeeds = [...new Set(selected.map((row) => row.seed))].sort((a, b) => a - b);
  const registeredSeeds = [...(pluginProfile.seedSchedule || [])].map(Number).sort((a, b) => a - b);
  const repetitionsBySeed = new Map();
  for (const row of selected) {
    const repetitions = repetitionsBySeed.get(row.seed) || new Set();
    repetitions.add(row.repetition);
    repetitionsBySeed.set(row.seed, repetitions);
  }
  if (observedSeeds.join('\0') !== registeredSeeds.join('\0')
    || [...repetitionsBySeed.values()].some((repetitions) => (
      repetitions.size < Number(pluginProfile.minimumRepetitions)
    ))
    || [...metrics].sort().join('\0')
      !== [...(pluginProfile.requiredMetrics || [])].sort().join('\0')
    || hashRecord('TypedNumericOracleMetricSpecs', specs)
      !== hashRecord('TypedNumericOracleMetricSpecs', pluginProfile.metricSpecs)) {
    throw new Error('typed_numeric_oracle_plugin_protocol_scope_mismatch');
  }
  const manifest = {
    analysisProtocolHash: analysisProtocol.analysisProtocolHash,
    empiricalPluginProfileHash:
      pluginProfile.autonomousEmpiricalFamilyPluginProfileHash,
    observations: selected,
  };
  return Object.freeze({
    observations: Object.freeze(selected),
    metrics: Object.freeze([...metrics]),
    specs,
    declared: Object.freeze([...declared].sort()),
    inputManifestHash: hashRecord('TypedNumericOracleInputManifest', manifest),
    finiteInputCount: selected.length * metrics.length,
    boundsAuthorityHash: hashRecord('TypedNumericOracleBoundsAuthority', {
      analysisProtocolHash: analysisProtocol.analysisProtocolHash,
      empiricalPluginProfileHash:
        pluginProfile.autonomousEmpiricalFamilyPluginProfileHash,
      metricSpecs: specs,
      estimator: analysisProtocol.estimator,
    }),
  });
}

function algorithmConfigurationHash(oracleType, inputs) {
  return hashRecord('TypedNumericOracleAlgorithmConfiguration', {
    oracleType,
    ...ALGORITHMS[oracleType],
    metricNames: inputs.metrics,
    arithmetic: IMPLEMENTATION_PAYLOAD.arithmetic,
    boundSource: 'analysis-protocol-metric-bounds-and-registered-comparators-v1',
  });
}

function output(oracleType, inputs, values) {
  const payload = {
    version: 1,
    kind: 'TypedNumericOracleAlgorithmOutput',
    oracleType,
    ...ALGORITHMS[oracleType],
    algorithmConfigurationHash: algorithmConfigurationHash(oracleType, inputs),
    numericInputManifestHash: inputs.inputManifestHash,
    finiteInputCount: inputs.finiteInputCount,
    finiteInputsVerified: true,
    boundsAuthorityHash: inputs.boundsAuthorityHash,
    ...values,
  };
  if (![payload.observedValue, payload.lowerBound, payload.upperBound]
    .filter((value) => value !== null).every(Number.isFinite)) {
    throw new Error(`typed_numeric_oracle_output_nonfinite:${oracleType}`);
  }
  return Object.freeze({
    ...payload,
    typedNumericOracleAlgorithmOutputHash: hashRecord(
      'TypedNumericOracleAlgorithmOutput', payload,
    ),
  });
}

function conditionNumber(inputs) {
  const variances = inputs.metrics.map((metric) => {
    const spec = inputs.specs[metric];
    const range = Number(spec.maximum) - Number(spec.minimum);
    return sampleVariance(inputs.observations.map((row) => (
      (row.metrics[metric] - Number(spec.minimum)) / range
    )));
  });
  const minimum = Math.min(...variances);
  const maximum = Math.max(...variances);
  if (!Number.isFinite(minimum) || minimum <= Number.EPSILON || !Number.isFinite(maximum)) {
    throw new Error('typed_numeric_oracle_condition_matrix_singular');
  }
  return output('condition-number-bound-v1', inputs, {
    quantity: 'normalized_diagonal_covariance_condition_number',
    observedValue: maximum / minimum,
    relation: 'greater-than-or-equal',
    lowerBound: 1,
    upperBound: null,
    unit: 'ratio',
  });
}

function groupedValues(inputs, metric) {
  return ARMS.map((arm) => inputs.observations
    .filter((row) => row.arm === arm).map((row) => row.metrics[metric]));
}

function convergenceRate(inputs) {
  let maximumDrift = 0;
  let maximumBound = 0;
  for (const metric of inputs.metrics) {
    const spec = inputs.specs[metric];
    const range = Number(spec.maximum) - Number(spec.minimum);
    for (const values of groupedValues(inputs, metric)) {
      if (values.length < 2) throw new Error('typed_numeric_oracle_convergence_sample_small');
      const split = Math.floor(values.length / 2);
      maximumDrift = Math.max(maximumDrift,
        Math.abs(mean(values.slice(0, split)) - mean(values)) / range);
      maximumBound = Math.max(maximumBound, (values.length - split) / values.length);
    }
  }
  return output('convergence-rate-bound-v1', inputs, {
    quantity: 'maximum_normalized_running_mean_tail_drift',
    observedValue: maximumDrift,
    relation: 'less-than-or-equal',
    lowerBound: null,
    upperBound: maximumBound + (32 * Number.EPSILON),
    unit: 'normalized-metric-range',
  });
}

function errorBound(inputs) {
  let maximumError = 0;
  let maximumBound = 0;
  for (const metric of inputs.metrics) {
    const spec = inputs.specs[metric];
    const range = Number(spec.maximum) - Number(spec.minimum);
    for (const values of groupedValues(inputs, metric)) {
      if (values.length < 2) throw new Error('typed_numeric_oracle_error_sample_small');
      maximumError = Math.max(maximumError,
        Math.sqrt(Math.max(0, sampleVariance(values))) / Math.sqrt(values.length) / range);
      maximumBound = Math.max(maximumBound, 1 / (2 * Math.sqrt(values.length - 1)));
    }
  }
  return output('error-bound-v1', inputs, {
    quantity: 'maximum_normalized_sample_mean_standard_error',
    observedValue: maximumError,
    relation: 'less-than-or-equal',
    lowerBound: null,
    upperBound: maximumBound + (32 * Number.EPSILON),
    unit: 'normalized-metric-range',
  });
}

function optimalityGap(inputs, analysisProtocol) {
  const metric = String(analysisProtocol?.hypotheses?.[0]?.metric
    || analysisProtocol?.estimator?.primaryMetric || inputs.metrics[0]);
  if (!inputs.metrics.includes(metric)) {
    throw new Error('typed_numeric_oracle_optimality_metric_unavailable');
  }
  const spec = inputs.specs[metric];
  const byCell = new Map();
  for (const row of inputs.observations) {
    const key = `${row.seed}\0${row.repetition}`;
    const cell = byCell.get(key) || {};
    cell[row.arm] = row.metrics[metric];
    byCell.set(key, cell);
  }
  const gaps = [...byCell.values()].map((cell) => {
    const comparator = spec.direction === 'maximize'
      ? Math.max(cell.treatment, cell.baseline, cell.ablation)
      : Math.min(cell.treatment, cell.baseline, cell.ablation);
    return spec.direction === 'maximize'
      ? comparator - cell.treatment : cell.treatment - comparator;
  });
  return output('optimality-gap-bound-v1', inputs, {
    quantity: 'maximum_registered_arm_empirical_optimality_gap',
    observedValue: Math.max(...gaps),
    relation: 'interval',
    lowerBound: 0,
    upperBound: Number(spec.maximum) - Number(spec.minimum),
    unit: spec.unit,
  });
}

const BUILDERS = Object.freeze({
  'condition-number-bound-v1': conditionNumber,
  'convergence-rate-bound-v1': convergenceRate,
  'error-bound-v1': errorBound,
  'optimality-gap-bound-v1': optimalityGap,
});

export function buildTypedNumericOracleProduction({
  observations,
  analysisProtocol,
  pluginProfile,
  experimentIr,
} = {}) {
  const inputs = canonicalInputs({ observations, analysisProtocol, pluginProfile });
  const requested = inputs.declared.filter((kind) => !CORE_ORACLES.has(kind));
  if (requested.length) {
    const { versionedExperimentIrHash, ...experimentIrPayload } = experimentIr || {};
    if (!verifyVersionedExperimentIr(experimentIr, { profile: pluginProfile })
      || experimentIr?.version !== 1 || experimentIr?.kind !== 'VersionedExperimentIR'
      || experimentIr?.irVersion !== 'experiment-ir-v1'
      || experimentIr?.sourceProfileHash
        !== pluginProfile?.autonomousEmpiricalFamilyPluginProfileHash
      || experimentIr?.benchmarkFamily !== pluginProfile?.benchmarkFamily
      || experimentIr?.experimentId !== pluginProfile?.profileId
      || experimentIr?.design?.seedSchedule?.join('\0')
        !== pluginProfile?.seedSchedule?.join('\0')
      || experimentIr?.design?.repetitionsPerSeed !== pluginProfile?.minimumRepetitions
      || experimentIr?.dataset?.evaluatorDescriptorHash
        !== pluginProfile?.evaluatorDescriptorHash
      || experimentIr?.execution?.adapterId !== pluginProfile?.executionAdapterId
      || experimentIr?.oracleAbi?.requiredOracleTypes?.join('\0')
        !== [...pluginProfile.typedOracleKinds].sort().join('\0')
      || !SHA256.test(String(versionedExperimentIrHash || ''))
      || hashRecord('VersionedExperimentIR', experimentIrPayload)
        !== versionedExperimentIrHash) {
      throw new Error('typed_numeric_oracle_experiment_ir_invalid');
    }
  }
  const outputs = [];
  const blockers = [];
  for (const oracleType of requested) {
    try { outputs.push(BUILDERS[oracleType](inputs, analysisProtocol)); }
    catch (error) { blockers.push(`${oracleType}:${String(error?.message || error)}`); }
  }
  const payload = {
    version: 2,
    kind: 'TypedNumericOracleProduction',
    status: blockers.length
      ? 'typed_numeric_oracle_production_blocked'
      : 'typed_numeric_oracle_production_verified',
    analysisProtocolHash: analysisProtocol.analysisProtocolHash,
    empiricalPluginProfileHash:
      pluginProfile.autonomousEmpiricalFamilyPluginProfileHash,
    experimentIrVersion: experimentIr?.irVersion || null,
    experimentId: experimentIr?.experimentId || null,
    versionedExperimentIrHash: experimentIr?.versionedExperimentIrHash || null,
    requestedOracleTypes: Object.freeze(requested),
    producedOracleTypes: Object.freeze(outputs.map((item) => item.oracleType).sort()),
    numericInputManifestHash: inputs.inputManifestHash,
    finiteInputCount: inputs.finiteInputCount,
    finiteInputsVerified: true,
    producerImplementationHash:
      TYPED_NUMERIC_ORACLE_PRODUCER_IMPLEMENTATION
        .typedNumericOracleProducerImplementationHash,
    outputs: Object.freeze(outputs.sort((left, right) => (
      left.oracleType.localeCompare(right.oracleType)
    ))),
    candidateAuthoredValuesAccepted: false,
    blockers: Object.freeze(blockers),
  };
  return Object.freeze({
    ...payload,
    typedNumericOracleProductionHash: hashRecord('TypedNumericOracleProduction', payload),
  });
}

export function verifyTypedNumericOracleProduction(production, inputs) {
  try {
    return JSON.stringify(buildTypedNumericOracleProduction(inputs))
      === JSON.stringify(production)
      && production.status === 'typed_numeric_oracle_production_verified';
  } catch { return false; }
}

export const TYPED_NUMERIC_ORACLE_ALGORITHMS = ALGORITHMS;
