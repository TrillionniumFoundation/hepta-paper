import {
  ADVANCED_NUMERICAL_PLUGIN_ANALYSIS_FAMILIES,
} from '../paper-domain/research/advanced-numerical-plugin-contract.mjs';

export function assertAdvancedNumericalPluginRunnerPort(runner) {
  if (runner?.version !== 1
    || runner?.kind !== 'AdvancedNumericalPluginRunner'
    || typeof runner?.run !== 'function'
    || typeof runner?.capabilities !== 'function') {
    throw new Error('AdvancedNumericalPluginRunnerPort version 1 is required');
  }
  const capabilities = runner.capabilities();
  if (capabilities?.outOfProcess !== true
    || capabilities?.signedPlugins !== true
    || capabilities?.resourceLimits !== true
    || capabilities?.networkPolicy !== 'none'
    || JSON.stringify(capabilities?.analysisFamilies)
      !== JSON.stringify(ADVANCED_NUMERICAL_PLUGIN_ANALYSIS_FAMILIES)) {
    throw new Error('AdvancedNumericalPluginRunnerPort capabilities invalid');
  }
  return runner;
}
