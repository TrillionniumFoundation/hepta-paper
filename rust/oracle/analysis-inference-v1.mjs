// Test-only adapter over real Node production statistical exports, not copied formulas.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as statistics from '../../paper-domain/automation/analysis-statistics.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { productionOracleProfile } from './production-record-hash-v1.mjs';

function evaluate(request) {
  return {
    kind: 'NativePairedAnalysisReportV1',
    version: 1,
    count: request.values.length,
    sum: statistics.compensatedSum(request.values),
    mean: statistics.arithmeticMean(request.values),
    standardDeviation: statistics.sampleStandardDeviation(request.values),
    standardError: statistics.sampleStandardError(request.values),
    quantiles: request.quantileProbabilities.map((p) => statistics.quantile(request.values, p)),
    winsorized: statistics.winsorizedValues(
      request.values, request.winsorLowerProbability, request.winsorUpperProbability,
    ),
    bootstrap: statistics.deterministicPairedBootstrap(request.values, {
      confidenceLevel: request.confidenceLevel,
      resamples: request.bootstrapResamples,
      seed: request.seed,
      salt: request.salt,
    }),
    signFlip: statistics.deterministicSignFlipInference(request.values, {
      draws: request.signFlipDraws,
      seed: request.seed,
      salt: request.salt,
      exactMaximumObservations: request.exactMaximumObservations,
    }),
    holm: statistics.holmBonferroni(request.hypotheses, request.familyAlpha),
    requiredPairedObservations: request.power
      ? statistics.requiredPairedObservations(request.power) : null,
    seedHash: hashRecord('AnalysisProtocolDeterministicRandomSeed', {
      seed: request.seed, salt: request.salt,
    }),
    scientificAcceptance: false,
    datasetAuthorityVerified: false,
    productionActivation: false,
  };
}

const input = fs.readFileSync(0);
if (input.length > 4 * 1024 * 1024) throw new Error('input bound');
const requests = JSON.parse(input);
if (!Array.isArray(requests) || requests.length > 1000) throw new Error('request bound');
const relative = 'paper-domain/automation/analysis-statistics.mjs';
console.log(JSON.stringify({
  profile: productionOracleProfile(),
  sources: {
    [relative]: createHash('sha256')
      .update(fs.readFileSync(new URL(`../../${relative}`, import.meta.url))).digest('hex'),
  },
  results: requests.map(evaluate),
}));
