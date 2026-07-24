import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import {
  autonomousEmpiricalFamilyPluginProfileFor,
} from './autonomous-empirical-family-plugin-registry.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export const ACADEMIC_ANALYSIS_INFERENCE_PROFILE_VERSION = 1;

function familyMode(benchmarkFamily) {
  const profile = autonomousEmpiricalFamilyPluginProfileFor(benchmarkFamily);
  if (profile) return profile.inferenceMode;
  throw new Error('academic_analysis_inference_profile_family_unsupported');
}

function canonicalProfile(benchmarkFamily) {
  const mode = familyMode(benchmarkFamily);
  const clustered = mode === 'seed-cluster';
  return Object.freeze({
    version: ACADEMIC_ANALYSIS_INFERENCE_PROFILE_VERSION,
    kind: 'AcademicAnalysisInferenceProfile',
    profileId: `${benchmarkFamily}:${mode}:v${ACADEMIC_ANALYSIS_INFERENCE_PROFILE_VERSION}`,
    benchmarkFamily,
    independentUnit: clustered ? 'seed-cluster-v1' : 'seed-repetition-cell-v1',
    withinSeedAggregation: clustered
      ? 'arithmetic-mean-per-arm-metric-before-inference-v1'
      : 'none-each-complete-seed-repetition-cell-v1',
    bootstrapUnit: clustered ? 'seed-cluster-mean-difference-v1' : 'seed-repetition-cell-difference-v1',
    signFlipUnit: clustered ? 'seed-cluster-mean-difference-v1' : 'seed-repetition-cell-difference-v1',
    powerCountingUnit: clustered ? 'independent-seed-cluster-v1' : 'independent-seed-repetition-cell-v1',
    balanceRequirements: Object.freeze({
      completeArms: 'treatment-baseline-ablation-per-seed-repetition-v1',
      repetitionSchedule: 'identical-repetition-index-set-across-seeds-v1',
      clusterSize: 'equal-complete-repetition-count-per-seed-v1',
      failureMode: 'fail-closed-v1',
    }),
    assumptions: Object.freeze({
      independentAcross: clustered
        ? 'predeclared-seed-clusters-v1'
        : 'predeclared-seed-repetition-cells-v1',
      dependenceWithinSeed: clustered
        ? 'repetitions-may-be-dependent-and-are-not-independent-samples-v1'
        : 'no-additional-within-seed-cluster-independence-claim-v1',
      resamplingExchangeability: clustered
        ? 'exchangeable-seed-cluster-aggregates-v1'
        : 'exchangeable-complete-seed-repetition-cells-v1',
      signSymmetry: clustered
        ? 'seed-cluster-aggregate-differences-v1'
        : 'seed-repetition-cell-differences-v1',
    }),
  });
}

export function buildAcademicAnalysisInferenceProfile({ benchmarkFamily } = {}) {
  const inferenceProfile = canonicalProfile(String(benchmarkFamily || ''));
  return Object.freeze({
    ...inferenceProfile,
    inferenceProfileHash: hashRecord('AcademicAnalysisInferenceProfile', inferenceProfile),
  });
}

export function validateAcademicAnalysisInferenceProfile(value, { benchmarkFamily = null } = {}) {
  if (!exactKeys(value, [
    'version', 'kind', 'profileId', 'benchmarkFamily', 'independentUnit', 'withinSeedAggregation',
    'bootstrapUnit', 'signFlipUnit', 'powerCountingUnit', 'balanceRequirements', 'assumptions',
  ]) || value.version !== ACADEMIC_ANALYSIS_INFERENCE_PROFILE_VERSION
    || value.kind !== 'AcademicAnalysisInferenceProfile') {
    throw new Error('academic_analysis_inference_profile_shape_invalid');
  }
  const family = String(value.benchmarkFamily || '');
  if (benchmarkFamily && family !== benchmarkFamily) {
    throw new Error('academic_analysis_inference_profile_family_mismatch');
  }
  const expected = canonicalProfile(family);
  if (hashRecord('AcademicAnalysisInferenceProfileExpected', value)
    !== hashRecord('AcademicAnalysisInferenceProfileExpected', expected)) {
    throw new Error('academic_analysis_inference_profile_policy_tampered');
  }
  return Object.freeze({
    inferenceProfile: expected,
    inferenceProfileHash: hashRecord('AcademicAnalysisInferenceProfile', expected),
  });
}

export function verifyAcademicAnalysisInferenceProfile(value, { benchmarkFamily = null } = {}) {
  if (!value || !SHA256.test(String(value.inferenceProfileHash || ''))) return false;
  const { inferenceProfileHash, ...document } = value;
  try {
    const validated = validateAcademicAnalysisInferenceProfile(document, { benchmarkFamily });
    return validated.inferenceProfileHash === String(inferenceProfileHash).toLowerCase();
  } catch { return false; }
}

export function isSeedClusterInferenceProfile(value) {
  return value?.kind === 'AcademicAnalysisInferenceProfile'
    && value?.independentUnit === 'seed-cluster-v1';
}

export function academicAnalysisIndependentUnitCount({
  inferenceProfile,
  seedSchedule = [],
  minimumRepetitions = 0,
} = {}) {
  if (!verifyAcademicAnalysisInferenceProfile(inferenceProfile, {
    benchmarkFamily: inferenceProfile?.benchmarkFamily,
  })) return 0;
  const seeds = [...new Set((Array.isArray(seedSchedule) ? seedSchedule : []).map(Number))];
  const repetitions = Number(minimumRepetitions);
  if (!seeds.length || seeds.some((seed) => !Number.isSafeInteger(seed))
    || !Number.isSafeInteger(repetitions) || repetitions < 1) return 0;
  return isSeedClusterInferenceProfile(inferenceProfile) ? seeds.length : seeds.length * repetitions;
}

export function academicAnalysisInferenceProfileForFamily(benchmarkFamily) {
  return buildAcademicAnalysisInferenceProfile({ benchmarkFamily });
}
