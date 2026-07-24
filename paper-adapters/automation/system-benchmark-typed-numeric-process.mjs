import {
  autonomousEmpiricalFamilyPluginProfileFor,
} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';
import {
  buildTypedNumericOracleProduction,
} from '../../paper-domain/research/typed-numeric-oracle-production.mjs';
import {
  buildVersionedExperimentIr,
  verifyVersionedExperimentIr,
} from '../../paper-domain/automation/versioned-experiment-ir.mjs';
import {
  runProcessIsolatedTypedNumericOracleRecomputation,
} from '../research-verify/process-isolated-typed-numeric-oracle-recomputation.mjs';

export function runSystemBenchmarkTypedNumericProcess({
  benchmarkFamily,
  observations,
  analysisProtocol,
  independentRawEventRecomputationAssurance,
  experimentIr: prebuiltExperimentIr = null,
} = {}, {
  pluginProfileFor = autonomousEmpiricalFamilyPluginProfileFor,
  buildExperimentIr = buildVersionedExperimentIr,
  buildProduction = buildTypedNumericOracleProduction,
  runRecomputation = runProcessIsolatedTypedNumericOracleRecomputation,
} = {}) {
  const pluginProfile = pluginProfileFor(benchmarkFamily);
  let experimentIr = null;
  try {
    experimentIr = prebuiltExperimentIr || buildExperimentIr(pluginProfile);
    if (!verifyVersionedExperimentIr(experimentIr, { profile: pluginProfile })
      || experimentIr.benchmarkFamily !== benchmarkFamily) {
      throw new Error('typed_numeric_oracle_experiment_ir_invalid');
    }
  } catch (error) {
    return Object.freeze({
      typedNumericOracleProduction: null,
      typedNumericOracleRecomputationReceipt: null,
      experimentIr: null,
      blockers: Object.freeze([
        `typed_numeric_oracle_process:${String(error?.message || error)}`,
      ]),
    });
  }
  const advancedOracleTypes = experimentIr.oracleAbi.requiredOracleTypes.filter((type) => (
    !['property-oracle-v1', 'residual-bound-v1'].includes(type)
  ));
  if (!advancedOracleTypes.length) {
    return Object.freeze({
      typedNumericOracleProduction: null,
      typedNumericOracleRecomputationReceipt: null,
      experimentIr,
      blockers: Object.freeze([]),
    });
  }
  if (independentRawEventRecomputationAssurance?.status
      !== 'independent_raw_event_recomputation_assurance_verified') {
    return Object.freeze({
      typedNumericOracleProduction: null,
      typedNumericOracleRecomputationReceipt: null,
      experimentIr,
      blockers: Object.freeze([
        'typed_numeric_oracle_process:independent_raw_event_recomputation_assurance_required',
      ]),
    });
  }
  try {
    const numericInputs = {
      observations, analysisProtocol, pluginProfile, experimentIr,
    };
    const typedNumericOracleProduction = buildProduction(numericInputs);
    const typedNumericOracleRecomputationReceipt =
      runRecomputation({
        ...numericInputs,
        production: typedNumericOracleProduction,
      });
    return Object.freeze({
      typedNumericOracleProduction,
      typedNumericOracleRecomputationReceipt,
      experimentIr,
      blockers: Object.freeze(typedNumericOracleRecomputationReceipt.blockers.map((blocker) => (
        `typed_numeric_oracle_process:${blocker}`
      ))),
    });
  } catch (error) {
    return Object.freeze({
      typedNumericOracleProduction: null,
      typedNumericOracleRecomputationReceipt: null,
      experimentIr,
      blockers: Object.freeze([
        `typed_numeric_oracle_process:${String(error?.message || error)}`,
      ]),
    });
  }
}
