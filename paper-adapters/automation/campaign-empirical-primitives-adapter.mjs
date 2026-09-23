import {
  evaluateDatasetConsumptionContract,
  writeExperimentRunEvidenceBundle,
} from './empirical-contract-reader.mjs';
import { sanitizeGeneratedLatex } from './generated-latex-sanitizer.mjs';
import { buildCampaignEmpiricalResultContract } from './campaign-empirical-result-authority.mjs';
import { readEmpiricalClaimUniverse } from '../research-verify/empirical-claim-universe-reader.mjs';
import { resolveSystemBenchmarkArmAdapterSet } from './system-benchmark-arm-adapter-repository.mjs';

export function createCampaignEmpiricalPrimitivesAdapter({ empiricalExecutor, artifactRepositoryFactory = null, runtimeRoot } = {}) {
  if (!empiricalExecutor || !runtimeRoot) throw new Error('empiricalExecutor and runtimeRoot are required');
  return Object.freeze({
    version: 1,
    kind: 'CampaignEmpiricalPrimitivesAdapter',
    execute: (spec) => empiricalExecutor.execute(spec),
    evaluateDatasetConsumption: (input) => evaluateDatasetConsumptionContract(input),
    sanitizeLatex: (input) => sanitizeGeneratedLatex(input),
    buildResultContract: (input) => buildCampaignEmpiricalResultContract({
      artifactRepositoryFactory,
      runtimeRoot,
      ...input,
    }),
    writeEvidenceBundle: (input) => writeExperimentRunEvidenceBundle(input),
    readEmpiricalClaimUniverse: (input) => readEmpiricalClaimUniverse(input),
    resolveBenchmarkArmAdapterSet: (input) => resolveSystemBenchmarkArmAdapterSet(input),
  });
}
