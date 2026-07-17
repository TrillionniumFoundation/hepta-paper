import { runManuscriptQualityChecks } from './manuscript-quality-checks.mjs';
import { runTheoremManuscriptReadinessCheck } from './theorem-manuscript-readiness-check.mjs';

export function createCampaignQualityPrimitivesAdapter({ theoremQualityRevisionSink = null } = {}) {
  return Object.freeze({
    version: 1,
    kind: 'CampaignQualityPrimitivesAdapter',
    theoremReadiness: (input) => runTheoremManuscriptReadinessCheck(input),
    manuscriptQuality: (input) => runManuscriptQualityChecks(input),
    recordRevision: (input) => theoremQualityRevisionSink?.record?.(input) || null,
  });
}
