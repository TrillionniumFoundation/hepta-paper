import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function variance(values, mean) {
  return values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / Math.max(1, values.length);
}

export function evaluateRefereeConvergence({
  paperId,
  roundIndex,
  reviews = [],
  minimumReviewers = 3,
  minimumMeanScore = 0.8,
  minimumAcceptRatio = 2 / 3,
  maximumVariance = 0.04,
} = {}) {
  const normalized = reviews.map((review) => ({
    reviewerId: String(review.reviewerId || 'unknown'),
    verdict: review.verdict === 'accept' ? 'accept' : 'revise',
    score: Math.max(0, Math.min(1, Number(review.score || 0))),
    criticalFindingCount: Math.max(0, Number(review.criticalFindingCount || 0)),
    reviewHash: review.reviewHash || null,
  }));
  const scores = normalized.map((review) => review.score);
  const meanScore = scores.reduce((sum, score) => sum + score, 0) / Math.max(1, scores.length);
  const scoreVariance = variance(scores, meanScore);
  const acceptCount = normalized.filter((review) => review.verdict === 'accept').length;
  const acceptRatio = acceptCount / Math.max(1, normalized.length);
  const criticalFindingCount = normalized.reduce((sum, review) => sum + review.criticalFindingCount, 0);
  const accepted = normalized.length >= minimumReviewers
    && meanScore >= minimumMeanScore
    && acceptRatio >= minimumAcceptRatio
    && scoreVariance <= maximumVariance
    && criticalFindingCount === 0;
  const payload = {
    version: 1,
    kind: 'RefereeConvergenceDecision',
    paperId,
    roundIndex: Number(roundIndex || 1),
    status: accepted ? 'referee_convergence_reached' : 'referee_revision_required',
    accepted,
    reviewerCount: normalized.length,
    acceptCount,
    acceptRatio,
    meanScore,
    scoreVariance,
    criticalFindingCount,
    reviews: normalized,
    thresholds: { minimumReviewers, minimumMeanScore, minimumAcceptRatio, maximumVariance },
    academicAcceptanceGranted: false,
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, refereeConvergenceDecisionHash: hashRecord('RefereeConvergenceDecision', payload) });
}

export function requiredRevalidationForChanges(paths = []) {
  const values = paths.map(String);
  const code = values.some((value) => /\.(py|r|R|jl|mjs|js|ts|lean)$/.test(value));
  const empirical = code || values.some((value) => /(data|experiment|result|table|figure)/i.test(value));
  const compile = values.some((value) => /\.(tex|bib|cls|sty)$/.test(value)) || empirical;
  return Object.freeze({ code, empirical, compile, citationCheck: compile, required: [
    ...(code ? ['revalidate-code'] : []),
    ...(empirical ? ['revalidate-empirical'] : []),
    ...(compile ? ['revalidate-compile'] : []),
  ] });
}
