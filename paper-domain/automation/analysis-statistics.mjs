import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function compensatedSum(values) {
  let sum = 0;
  let correction = 0;
  for (const value of values) {
    const next = sum + value;
    correction += Math.abs(sum) >= Math.abs(value)
      ? (sum - next) + value
      : (value - next) + sum;
    sum = next;
  }
  return sum + correction;
}

export function arithmeticMean(values) {
  return values.length ? compensatedSum(values) / values.length : Number.NaN;
}

export function sampleStandardDeviation(values) {
  if (values.length < 2) return Number.NaN;
  let count = 0;
  let mean = 0;
  let secondMoment = 0;
  for (const value of values) {
    count += 1;
    const delta = value - mean;
    mean += delta / count;
    secondMoment += delta * (value - mean);
  }
  return Math.sqrt(Math.max(0, secondMoment) / (count - 1));
}

export function sampleStandardError(values) {
  return sampleStandardDeviation(values) / Math.sqrt(values.length);
}

export function quantile(values, probability) {
  if (!values.length || !(probability >= 0 && probability <= 1)) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const position = probability * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * (position - lower));
}

function seededGenerator(seed, salt) {
  const mixed = hashRecord('AnalysisProtocolDeterministicRandomSeed', { seed, salt });
  let state = Number.parseInt(mixed.slice('sha256:'.length, 'sha256:'.length + 8), 16) >>> 0;
  if (state === 0) state = 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

export function deterministicPairedBootstrap(values, {
  confidenceLevel,
  resamples,
  seed,
  salt,
  method = 'deterministic-paired-percentile-bootstrap-v1',
} = {}) {
  const random = seededGenerator(seed, salt);
  const means = [];
  for (let draw = 0; draw < resamples; draw += 1) {
    const sample = [];
    for (let index = 0; index < values.length; index += 1) {
      sample.push(values[Math.floor(random() * values.length)]);
    }
    means.push(arithmeticMean(sample));
  }
  const tail = (1 - confidenceLevel) / 2;
  return Object.freeze({
    method,
    confidenceLevel,
    resamples,
    seed,
    lower: quantile(means, tail),
    upper: quantile(means, 1 - tail),
  });
}

export function deterministicSignFlipInference(values, {
  draws,
  seed,
  salt,
  exactMaximumObservations = 16,
} = {}) {
  const observed = arithmeticMean(values);
  if (values.length <= exactMaximumObservations) {
    const exactDraws = 2 ** values.length;
    let atLeastObserved = 0;
    for (let mask = 0; mask < exactDraws; mask += 1) {
      const randomized = values.map((value, index) => (
        (mask & (2 ** index)) === 0 ? -value : value
      ));
      if (arithmeticMean(randomized) >= observed) atLeastObserved += 1;
    }
    return Object.freeze({
      method: 'exact-paired-sign-flip-enumeration-v1',
      pValue: atLeastObserved / exactDraws,
      draws: exactDraws,
      monteCarloStandardError: 0,
    });
  }
  const random = seededGenerator(seed, salt);
  let atLeastObserved = 0;
  for (let draw = 0; draw < draws; draw += 1) {
    const randomized = values.map((value) => (random() < 0.5 ? -value : value));
    if (arithmeticMean(randomized) >= observed) atLeastObserved += 1;
  }
  const pValue = (atLeastObserved + 1) / (draws + 1);
  return Object.freeze({
    method: 'deterministic-monte-carlo-sign-flip-v1',
    pValue,
    draws,
    monteCarloStandardError: Math.sqrt((pValue * (1 - pValue)) / draws),
  });
}

export function deterministicSignFlipPValue(values, options = {}) {
  return deterministicSignFlipInference(values, options).pValue;
}

export function winsorizedValues(values, lowerProbability, upperProbability) {
  const lower = quantile(values, lowerProbability);
  const upper = quantile(values, upperProbability);
  return values.map((value) => Math.max(lower, Math.min(upper, value)));
}

export function inverseNormalCdf(probability) {
  if (!(probability > 0 && probability < 1)) return Number.NaN;
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  if (probability < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (probability > 0.97575) return -inverseNormalCdf(1 - probability);
  const q = probability - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export function requiredPairedObservations({ alpha, targetPower, standardizedEffect, hypothesisCount }) {
  if (!(alpha > 0 && alpha < 1) || !(targetPower > 0.5 && targetPower < 1)
    || !(standardizedEffect > 0) || !Number.isSafeInteger(hypothesisCount) || hypothesisCount < 1) return Number.NaN;
  const strictFamilyAlpha = alpha / hypothesisCount;
  const critical = inverseNormalCdf(1 - strictFamilyAlpha);
  const powerQuantile = inverseNormalCdf(targetPower);
  return Math.ceil(((critical + powerQuantile) / standardizedEffect) ** 2);
}

export function holmBonferroni(rows, familyAlpha) {
  const ordered = [...rows].sort((left, right) => (
    left.pValue - right.pValue || left.hypothesisId.localeCompare(right.hypothesisId)
  ));
  let previousAdjusted = 0;
  let precedingAccepted = true;
  return ordered.map((row, index) => {
    const remaining = ordered.length - index;
    const threshold = familyAlpha / remaining;
    const adjustedPValue = Math.min(1, Math.max(previousAdjusted, row.pValue * remaining));
    previousAdjusted = adjustedPValue;
    const multiplicityAccepted = precedingAccepted && row.pValue <= threshold;
    precedingAccepted = multiplicityAccepted;
    return Object.freeze({
      ...row,
      holmRank: index + 1,
      holmThreshold: threshold,
      adjustedPValue,
      multiplicityAccepted,
    });
  });
}
