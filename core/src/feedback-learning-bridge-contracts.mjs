import { digest } from './hash-utils.mjs';

export const FEEDBACK_LEARNING_BRIDGE_CONTRACT_VERSION = 1;

export const FEEDBACK_LEARNING_BRIDGE_SAFETY = Object.freeze({
  localContractOnly: true,
  readsFiles: false,
  writesFiles: false,
  callsProviderOrModel: false,
  fetchesChannelState: false,
  mutatesChannelState: false,
  uploads: false,
  submits: false,
  sendsMessages: false,
  acceptsDelivery: false,
  pays: false,
  grantsExecutionPermission: false,
});

function compactText(value, max = 220) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function uniqueStrings(values = [], limit = 24) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const normalized = compactText(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function numericOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function outcomePatterns(outcomeScore = null) {
  const patterns = outcomeScore?.patterns || {};
  return {
    successPatterns: uniqueStrings(patterns.successPatterns || patterns.success || outcomeScore?.successPatterns || [], 16),
    rejectedPatterns: uniqueStrings(patterns.rejectedPatterns || patterns.rejected || outcomeScore?.rejectedPatterns || [], 16),
    buyerCorrections: uniqueStrings(patterns.buyerCorrections || patterns.corrections || outcomeScore?.buyerCorrections || [], 16),
  };
}

export function normalizeFeedbackLearningCandidate(candidate = {}) {
  const successPatterns = uniqueStrings(candidate.successPatterns || [], 12);
  const rejectedPatterns = uniqueStrings(candidate.rejectedPatterns || [], 12);
  const buyerCorrections = uniqueStrings(candidate.buyerCorrections || [], 12);
  const patternCount = successPatterns.length + rejectedPatterns.length + buyerCorrections.length;
  const normalized = {
    candidateHash: candidate.candidateHash || null,
    taskId: candidate.taskId || null,
    orderId: candidate.orderId || null,
    workflowId: candidate.workflowId || null,
    industryId: candidate.industryId || null,
    designReferenceId: candidate.designReferenceId || null,
    outcome: candidate.outcome || null,
    eligibleForLedger: candidate.eligibleForLedger !== false && patternCount > 0,
    confidence: numericOrNull(candidate.confidence),
    sourceWeight: numericOrNull(candidate.sourceWeight),
    score: numericOrNull(candidate.score),
    successPatterns,
    rejectedPatterns,
    buyerCorrections,
  };
  normalized.learningCandidateHash = digest({
    candidateHash: normalized.candidateHash,
    taskId: normalized.taskId,
    orderId: normalized.orderId,
    workflowId: normalized.workflowId,
    industryId: normalized.industryId,
    designReferenceId: normalized.designReferenceId,
    outcome: normalized.outcome,
    successPatterns,
    rejectedPatterns,
    buyerCorrections,
  });
  return normalized;
}

function candidateMatches(candidate, { workflowId = null, industryId = null, refpackId = null } = {}) {
  if (!candidate?.eligibleForLedger) return false;
  if (workflowId && candidate.workflowId && candidate.workflowId !== workflowId) return false;
  if (industryId && candidate.industryId && candidate.industryId !== industryId) return false;
  if (refpackId && candidate.designReferenceId && candidate.designReferenceId !== refpackId) return false;
  return true;
}

export function buildFeedbackLearningBridge({
  industryId = null,
  workflowId = null,
  designReferenceSpec = null,
  caseLedgerGuidance = null,
  refpackOutcomeScore = null,
  feedbackCandidates = [],
  source = 'local_ledger',
} = {}) {
  const effectiveIndustryId = industryId || designReferenceSpec?.industryId || null;
  const effectiveWorkflowId = workflowId || designReferenceSpec?.workflowId || null;
  const refpackId = designReferenceSpec?.id || null;
  const normalizedCandidates = (Array.isArray(feedbackCandidates) ? feedbackCandidates : [])
    .map(normalizeFeedbackLearningCandidate);
  const matchingCandidates = normalizedCandidates
    .filter((candidate) => candidateMatches(candidate, {
      workflowId: effectiveWorkflowId,
      industryId: effectiveIndustryId,
      refpackId,
    }))
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
  const outcome = outcomePatterns(refpackOutcomeScore);
  const successPatterns = uniqueStrings([
    ...(caseLedgerGuidance?.successPatterns || []),
    ...outcome.successPatterns,
    ...matchingCandidates.flatMap((item) => item.successPatterns),
  ], 18);
  const rejectedPatterns = uniqueStrings([
    ...(caseLedgerGuidance?.rejectedPatterns || []),
    ...outcome.rejectedPatterns,
    ...matchingCandidates.flatMap((item) => item.rejectedPatterns),
  ], 18);
  const buyerCorrections = uniqueStrings([
    ...(caseLedgerGuidance?.buyerCorrections || []),
    ...outcome.buyerCorrections,
    ...matchingCandidates.flatMap((item) => item.buyerCorrections),
  ], 18);
  const learningSignalCount = successPatterns.length + rejectedPatterns.length + buyerCorrections.length;
  const bridge = {
    version: FEEDBACK_LEARNING_BRIDGE_CONTRACT_VERSION,
    kind: 'FeedbackLearningBridgeContract',
    ok: true,
    status: learningSignalCount > 0 ? 'feedback_learning_ready' : 'feedback_learning_cold_start',
    source,
    industryId: effectiveIndustryId,
    workflowId: effectiveWorkflowId,
    refpackId,
    patterns: {
      successPatterns,
      rejectedPatterns,
      buyerCorrections,
    },
    counts: {
      caseCount: Number(caseLedgerGuidance?.caseCount || 0),
      inheritedCaseCount: Number(caseLedgerGuidance?.inheritedCaseCount || 0),
      feedbackCandidateCount: normalizedCandidates.length,
      eligibleFeedbackCandidateCount: matchingCandidates.length,
      learningSignalCount,
      refpackOutcomeCaseCount: Number(refpackOutcomeScore?.counts?.caseCount || 0),
      refpackOutcomeLearningSignalCount: Number(refpackOutcomeScore?.counts?.learningSignalCount || 0),
    },
    outcomeScore: refpackOutcomeScore ? {
      status: refpackOutcomeScore.status || null,
      score: refpackOutcomeScore.score ?? null,
      successRate: refpackOutcomeScore.successRate ?? null,
      counts: refpackOutcomeScore.counts || {},
      blockers: refpackOutcomeScore.blockers || [],
      recommendations: refpackOutcomeScore.recommendations || [],
    } : null,
    feedbackCandidates: matchingCandidates.slice(0, 12),
    recommendations: uniqueStrings([
      ...(refpackOutcomeScore?.recommendations || []),
      ...(rejectedPatterns.length ? ['avoid learned rejected patterns in prompt and QA'] : []),
      ...(buyerCorrections.length ? ['surface buyer corrections as explicit QA checks'] : []),
      ...(successPatterns.length ? ['promote proven success patterns as prompt guidance'] : []),
    ], 12),
    safety: FEEDBACK_LEARNING_BRIDGE_SAFETY,
  };
  bridge.bridgeHash = digest({
    version: bridge.version,
    industryId: bridge.industryId,
    workflowId: bridge.workflowId,
    refpackId: bridge.refpackId,
    patterns: bridge.patterns,
    counts: bridge.counts,
    outcomeScore: bridge.outcomeScore,
    feedbackCandidateHashes: bridge.feedbackCandidates.map((item) => item.learningCandidateHash),
  });
  return bridge;
}

export function applyFeedbackLearningToDesignReferenceSpec(designReferenceSpec = {}, { bridge = null } = {}) {
  if (!bridge) return designReferenceSpec;
  const successPatterns = bridge.patterns?.successPatterns || [];
  const rejectedPatterns = bridge.patterns?.rejectedPatterns || [];
  const buyerCorrections = bridge.patterns?.buyerCorrections || [];
  return {
    ...designReferenceSpec,
    negativePatterns: uniqueStrings([
      ...(designReferenceSpec.negativePatterns || []),
      ...rejectedPatterns,
    ], 36),
    qaChecks: uniqueStrings([
      ...(designReferenceSpec.qaChecks || []),
      ...buyerCorrections.map((item) => 'case-ledger correction respected: ' + item),
    ], 36),
    qaBlockers: uniqueStrings([
      ...(designReferenceSpec.qaBlockers || []),
      ...rejectedPatterns.map((item) => 'avoid learned rejected pattern: ' + item),
    ], 36),
    promptHints: uniqueStrings([
      ...(designReferenceSpec.promptHints || []),
      ...successPatterns.map((item) => 'learned success pattern: ' + item),
      ...buyerCorrections.map((item) => 'learned buyer correction: ' + item),
      ...(bridge.recommendations || []).map((item) => 'learning bridge recommendation: ' + item),
    ], 40),
    successPatterns: uniqueStrings([
      ...(designReferenceSpec.successPatterns || []),
      ...successPatterns,
    ], 24),
    rejectedPatterns: uniqueStrings([
      ...(designReferenceSpec.rejectedPatterns || []),
      ...rejectedPatterns,
    ], 24),
    buyerCorrections: uniqueStrings([
      ...(designReferenceSpec.buyerCorrections || []),
      ...buyerCorrections,
    ], 24),
    outcomeScore: bridge.outcomeScore || designReferenceSpec.outcomeScore || null,
    learnedFrom: {
      ...(designReferenceSpec.learnedFrom || {}),
      caseCount: bridge.counts?.caseCount || designReferenceSpec.learnedFrom?.caseCount || 0,
      inheritedCaseCount: bridge.counts?.inheritedCaseCount || designReferenceSpec.learnedFrom?.inheritedCaseCount || 0,
      feedbackCandidateCount: bridge.counts?.eligibleFeedbackCandidateCount || 0,
      refpackOutcomeCaseCount: bridge.counts?.refpackOutcomeCaseCount || 0,
    },
    feedbackLearningBridge: {
      version: bridge.version,
      status: bridge.status,
      source: bridge.source,
      counts: bridge.counts,
      bridgeHash: bridge.bridgeHash,
    },
    feedbackLearningBridgeHash: bridge.bridgeHash,
  };
}

export function feedbackLearningBridgeHashFor(value = null) {
  if (!value) return null;
  return value.feedbackLearningBridgeHash
    || value.feedbackLearningBridge?.bridgeHash
    || value.designReferenceSpec?.feedbackLearningBridgeHash
    || value.designReferenceSpec?.feedbackLearningBridge?.bridgeHash
    || null;
}

function continuityTarget(label, value) {
  return { label, value, hash: feedbackLearningBridgeHashFor(value) };
}

export function validateFeedbackLearningContinuity({
  plan = null,
  manifest = null,
  finalReview = null,
  requests = null,
} = {}) {
  const expectedHash = feedbackLearningBridgeHashFor(plan);
  const issues = [];
  if (!expectedHash) {
    return {
      ok: true,
      required: false,
      status: 'feedback_learning_not_bound',
      expectedHash: null,
      actual: {},
      issues,
      safety: FEEDBACK_LEARNING_BRIDGE_SAFETY,
    };
  }
  const actual = {};
  for (const target of [
    continuityTarget('manifest', manifest),
    continuityTarget('finalReview', finalReview),
  ]) {
    if (!target.value) continue;
    actual[target.label] = target.hash || null;
    if (!target.hash) {
      issues.push({
        code: `${target.label}_feedback_learning_bridge_hash_missing`,
        message: `${target.label} is missing feedbackLearningBridgeHash`,
        expectedHash,
      });
    } else if (target.hash !== expectedHash) {
      issues.push({
        code: `${target.label}_feedback_learning_bridge_hash_stale`,
        message: `${target.label} feedbackLearningBridgeHash differs from production plan`,
        expectedHash,
        actualHash: target.hash,
      });
    }
  }
  const requestRows = Array.isArray(requests) ? requests : (Array.isArray(manifest?.requests) ? manifest.requests : []);
  const staleRequests = [];
  for (const request of requestRows) {
    const requestHash = feedbackLearningBridgeHashFor(request);
    if (!requestHash || requestHash !== expectedHash) {
      staleRequests.push({
        requestId: request?.id || null,
        artifactIndex: request?.artifactIndex ?? null,
        filename: request?.filename || null,
        actualHash: requestHash || null,
      });
    }
  }
  if (staleRequests.length) {
    issues.push({
      code: 'request_feedback_learning_bridge_hash_stale',
      message: 'one or more generation requests are missing or stale against production plan feedbackLearningBridgeHash',
      expectedHash,
      requests: staleRequests.slice(0, 20),
    });
  }
  return {
    ok: issues.length === 0,
    required: true,
    status: issues.length ? 'feedback_learning_stale' : 'feedback_learning_current',
    expectedHash,
    actual,
    issues,
    continuityHash: digest({
      expectedHash,
      actual,
      requestHashes: requestRows.map((request) => ({
        id: request?.id || null,
        artifactIndex: request?.artifactIndex ?? null,
        hash: feedbackLearningBridgeHashFor(request),
      })),
      issueCodes: issues.map((item) => item.code),
    }),
    safety: FEEDBACK_LEARNING_BRIDGE_SAFETY,
  };
}

export function feedbackLearningBridgeContractsSelftest() {
  const bridge = buildFeedbackLearningBridge({
    industryId: 'general_business_service',
    workflowId: 'logo_brand',
    designReferenceSpec: { id: 'refpack_general_business_service_v1', industryId: 'general_business_service', workflowId: 'logo_brand' },
    caseLedgerGuidance: {
      caseCount: 2,
      inheritedCaseCount: 1,
      successPatterns: ['large buyer brand mark first'],
      rejectedPatterns: ['generic stationery-only board'],
      buyerCorrections: ['keep exact buyer Chinese name'],
    },
    refpackOutcomeScore: {
      status: 'outcome_learning_strong',
      score: 72,
      counts: { caseCount: 3, learningSignalCount: 4 },
      patterns: { successPatterns: ['industry-specific application proof'] },
      recommendations: ['use learned outcomes during prompt assembly'],
    },
    feedbackCandidates: [{
      taskId: 7001,
      workflowId: 'logo_brand',
      industryId: 'general_business_service',
      designReferenceId: 'refpack_general_business_service_v1',
      outcome: 'buyer_correction',
      eligibleForLedger: true,
      score: 44,
      rejectedPatterns: ['text typo in hero title'],
      buyerCorrections: ['make first board less template-like'],
    }],
  });
  const spec = applyFeedbackLearningToDesignReferenceSpec({
    id: 'refpack_general_business_service_v1',
    promptHints: ['base hint'],
    qaChecks: ['base check'],
  }, { bridge });
  const continuity = validateFeedbackLearningContinuity({
    plan: { feedbackLearningBridgeHash: bridge.bridgeHash },
    manifest: { feedbackLearningBridgeHash: bridge.bridgeHash },
    finalReview: { feedbackLearningBridgeHash: bridge.bridgeHash },
    requests: [{ id: 'req-1', feedbackLearningBridgeHash: bridge.bridgeHash }],
  });
  const staleContinuity = validateFeedbackLearningContinuity({
    plan: { feedbackLearningBridgeHash: bridge.bridgeHash },
    manifest: { feedbackLearningBridgeHash: 'sha256:stale' },
    requests: [{ id: 'req-1' }],
  });
  return {
    ok: bridge.status === 'feedback_learning_ready'
      && bridge.bridgeHash?.startsWith('sha256:')
      && spec.feedbackLearningBridgeHash === bridge.bridgeHash
      && spec.promptHints.some((item) => item.includes('large buyer brand mark first'))
      && spec.qaBlockers.some((item) => item.includes('generic stationery-only board'))
      && continuity.ok === true
      && staleContinuity.ok === false
      && staleContinuity.issues.some((item) => item.code === 'manifest_feedback_learning_bridge_hash_stale'),
    version: FEEDBACK_LEARNING_BRIDGE_CONTRACT_VERSION,
    safety: FEEDBACK_LEARNING_BRIDGE_SAFETY,
    bridgeHash: bridge.bridgeHash,
    continuityHash: continuity.continuityHash,
  };
}
