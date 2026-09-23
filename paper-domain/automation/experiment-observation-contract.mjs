import { REQUIRED_SYSTEM_BENCHMARK_ARMS } from './system-benchmark-schedule.mjs';

export function finiteExperimentMetrics(value, requiredMetrics) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const metrics = {};
  for (const metric of requiredMetrics) {
    const numeric = Number(value[metric]);
    if (!Number.isFinite(numeric)) return null;
    metrics[metric] = numeric;
  }
  return metrics;
}

export function experimentObservationKey(observation) {
  return `${observation.seed}\0${observation.repetition}\0${observation.arm}`;
}

export function canonicalExperimentObservation(value, requiredMetrics) {
  const seed = Number(value?.seed);
  const repetition = Number(value?.repetition);
  const arm = String(value?.arm || '');
  const metrics = finiteExperimentMetrics(value?.metrics, requiredMetrics);
  if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(repetition) || repetition < 1
    || !REQUIRED_SYSTEM_BENCHMARK_ARMS.includes(arm) || !metrics) return null;
  return { seed, repetition, arm, metrics };
}

export function aggregateExperimentObservations(observations, requiredMetrics) {
  return Object.fromEntries(REQUIRED_SYSTEM_BENCHMARK_ARMS.map((arm) => [arm, Object.fromEntries(requiredMetrics.map((metric) => {
    const values = observations.filter((item) => item.arm === arm).map((item) => item.metrics[metric]);
    return [metric, values.reduce((sum, value) => sum + value, 0) / values.length];
  }))]));
}

export function csvExperimentObservation(row, requiredMetrics) {
  return canonicalExperimentObservation({
    seed: row.seed,
    repetition: row.repetition,
    arm: row.arm,
    metrics: Object.fromEntries(requiredMetrics.map((metric) => [metric, row[metric]])),
  }, requiredMetrics);
}
