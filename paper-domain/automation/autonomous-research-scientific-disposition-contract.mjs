import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const SCIENTIFIC_VERDICTS = new Set(['positive', 'negative', 'inconclusive']);
const PROOF_EXHAUSTION_FAILURES = new Set([
  'formal_proof_search_exhausted',
  'formal_proof_search_exhausted_without_kernel_verified_candidate',
]);
const FORMAL_VERIFICATION_BLOCKED = /^campaign_formal_verification_blocked:[^\r\n]{1,900}$/;

export const AUTONOMOUS_RESEARCH_SCIENTIFIC_DISPOSITION_TYPES = Object.freeze({
  NEGATIVE_RESULT: 'negative-result',
  FORMAL_PROOF_SEARCH_EXHAUSTED: 'formal-proof-search-exhausted',
  REVIEW_NON_CONVERGENCE: 'review-non-convergence',
  SUBMISSION_EXPLICIT_REJECTION: 'submission-explicit-rejection',
});

const DISPOSITION_POLICY = Object.freeze({
  [AUTONOMOUS_RESEARCH_SCIENTIFIC_DISPOSITION_TYPES.NEGATIVE_RESULT]: Object.freeze({
    nextAction: 'publish-negative-result',
    settlementReason: 'autonomous_research_negative_result_settled',
  }),
  [AUTONOMOUS_RESEARCH_SCIENTIFIC_DISPOSITION_TYPES.FORMAL_PROOF_SEARCH_EXHAUSTED]:
    Object.freeze({
      nextAction: 'retire-claim',
      settlementReason: 'autonomous_research_formal_proof_search_exhausted_settled',
    }),
  [AUTONOMOUS_RESEARCH_SCIENTIFIC_DISPOSITION_TYPES.REVIEW_NON_CONVERGENCE]:
    Object.freeze({
      nextAction: 'retarget-hypothesis',
      settlementReason: 'autonomous_research_review_non_convergence_settled',
    }),
  [AUTONOMOUS_RESEARCH_SCIENTIFIC_DISPOSITION_TYPES.SUBMISSION_EXPLICIT_REJECTION]:
    Object.freeze({
      nextAction: 'venue-retarget-or-terminal-scientific-outcome',
      settlementReason: 'autonomous_research_submission_rejection_settled',
    }),
});

const RECEIPT_KEYS = Object.freeze([
  'automaticBudgetExpansionPerformed',
  'autonomousResearchScientificDispositionReceiptHash',
  'claimPromotionAuthorized',
  'dispositionType',
  'externalActionPerformed',
  'kind',
  'nextAction',
  'requiresHumanIntervention',
  'scientificSuccess',
  'settledAt',
  'settlementReason',
  'source',
  'sourceEvidenceHash',
  'status',
  'successorCampaignCreated',
  'successorCampaignId',
  'version',
].sort());

const SOURCE_KEYS = Object.freeze([
  'campaignId',
  'campaignPlanHash',
  'campaignStatus',
  'evidenceNodes',
  'paperId',
  'stopReason',
  'submissionDeliveryStateReceiptHash',
  'submissionDeliveryStatus',
  'submissionRequestHash',
  'submissionVenueId',
].sort());

const EVIDENCE_NODE_KEYS = Object.freeze([
  'accepted',
  'evidenceKind',
  'evidenceReceiptHash',
  'evidenceStatus',
  'failureClass',
  'failureHash',
  'kind',
  'nodeId',
  'resultHash',
  'roundIndex',
  'scientificVerdict',
  'status',
].sort());

function canonicalInstant(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function nullableHash(value) {
  return value === null || SHA256.test(String(value || ''));
}

function nullableText(value, maximum = 512) {
  return value === null || (typeof value === 'string' && value.length > 0
    && value.length <= maximum);
}

function proofExhaustionFailureClass(value) {
  return PROOF_EXHAUSTION_FAILURES.has(value)
    || FORMAL_VERIFICATION_BLOCKED.test(String(value || ''));
}

function empiricalKind(kind) {
  const value = String(kind || '');
  return /^(?:empirical|revalidate-empirical)(?:$|-)/.test(value);
}

function reproductionKind(kind) {
  return /^(?:empirical-reproduce|revalidate-empirical-reproduce)(?:$|-)/
    .test(String(kind || ''));
}

function scientificVerdict(result) {
  const candidates = [
    result?.scientificVerdict,
    result?.harnessExecutionReceipt?.scientificVerdict,
    result?.harnessExecutionReceipt?.analysisProtocolEvaluation?.scientificVerdict,
  ].filter((value) => value !== undefined && value !== null);
  if (candidates.length === 0 || new Set(candidates).size !== 1) return null;
  const verdict = String(candidates[0]);
  return SCIENTIFIC_VERDICTS.has(verdict) ? verdict : null;
}

function evidenceNode(node, overrides = {}) {
  return Object.freeze({
    nodeId: String(node?.nodeId || ''),
    kind: String(node?.kind || ''),
    status: String(node?.status || ''),
    roundIndex: Number(node?.roundIndex || 0),
    resultHash: node?.resultSha256 || null,
    failureHash: node?.failureSha256 || null,
    failureClass: node?.failureClass || null,
    scientificVerdict: overrides.scientificVerdict ?? null,
    accepted: overrides.accepted ?? null,
    evidenceKind: overrides.evidenceKind ?? null,
    evidenceStatus: overrides.evidenceStatus ?? null,
    evidenceReceiptHash: overrides.evidenceReceiptHash ?? null,
  });
}

function validEvidenceNode(node) {
  return hasExactObjectKeys(node, EVIDENCE_NODE_KEYS)
    && SAFE_ID.test(String(node.nodeId || ''))
    && SAFE_ID.test(String(node.kind || ''))
    && ['completed', 'failed_terminal'].includes(node.status)
    && Number.isSafeInteger(node.roundIndex) && node.roundIndex >= 0
    && nullableHash(node.resultHash)
    && nullableHash(node.failureHash)
    && nullableText(node.failureClass, 1000)
    && (node.scientificVerdict === null
      || SCIENTIFIC_VERDICTS.has(node.scientificVerdict))
    && (node.accepted === null || typeof node.accepted === 'boolean')
    && nullableText(node.evidenceKind)
    && nullableText(node.evidenceStatus)
    && nullableHash(node.evidenceReceiptHash);
}

function sourceShapeValid(source) {
  return hasExactObjectKeys(source, SOURCE_KEYS)
    && SAFE_ID.test(String(source.campaignId || ''))
    && SAFE_ID.test(String(source.paperId || ''))
    && ['completed', 'failed', 'stopped'].includes(source.campaignStatus)
    && nullableText(source.stopReason, 1000)
    && nullableHash(source.campaignPlanHash)
    && Array.isArray(source.evidenceNodes)
    && source.evidenceNodes.length <= 64
    && source.evidenceNodes.every(validEvidenceNode)
    && new Set(source.evidenceNodes.map((node) => node.nodeId)).size
      === source.evidenceNodes.length
    && JSON.stringify(source.evidenceNodes.map((node) => node.nodeId))
      === JSON.stringify(source.evidenceNodes.map((node) => node.nodeId).sort())
    && nullableText(source.submissionDeliveryStatus)
    && nullableHash(source.submissionDeliveryStateReceiptHash)
    && nullableHash(source.submissionRequestHash)
    && nullableText(source.submissionVenueId);
}

function negativeResultSourceValid(source) {
  if (source.campaignStatus !== 'completed' || source.stopReason !== null
    || source.submissionDeliveryStatus === 'autonomous_submission_delivery_explicit_failure'
    || source.evidenceNodes.length < 2) return false;
  const originals = source.evidenceNodes.filter((node) => empiricalKind(node.kind)
    && !reproductionKind(node.kind));
  const reproductions = source.evidenceNodes.filter((node) => reproductionKind(node.kind));
  return originals.length > 0 && reproductions.length > 0
    && source.evidenceNodes.every((node) => node.status === 'completed'
      && SHA256.test(String(node.resultHash || ''))
      && node.scientificVerdict === 'negative'
      && node.failureHash === null && node.failureClass === null);
}

function proofExhaustionSourceValid(source) {
  if (source.campaignStatus !== 'failed' || source.evidenceNodes.length < 1) return false;
  return source.evidenceNodes.every((node) => node.status === 'failed_terminal'
    && proofExhaustionFailureClass(node.failureClass)
    && SHA256.test(String(node.failureHash || ''))
    && node.evidenceKind === 'FormalProofSearchFailureCertificate'
    && node.evidenceStatus === 'formal_proof_search_exhausted'
    && SHA256.test(String(node.evidenceReceiptHash || ''))
    && node.scientificVerdict === null && node.accepted === null);
}

function reviewNonConvergenceSourceValid(source) {
  if (source.campaignStatus !== 'stopped'
    || source.stopReason !== 'referee_convergence_not_reached_within_budget'
    || source.evidenceNodes.length < 1) return false;
  return source.evidenceNodes.every((node) => node.kind === 'convergence'
    && node.status === 'completed'
    && SHA256.test(String(node.resultHash || ''))
    && node.accepted === false
    && node.scientificVerdict === null
    && node.failureHash === null && node.failureClass === null);
}

function submissionRejectionSourceValid(source) {
  return source.campaignStatus === 'completed'
    && source.submissionDeliveryStatus
      === 'autonomous_submission_delivery_explicit_failure'
    && SHA256.test(String(source.submissionDeliveryStateReceiptHash || ''))
    && SHA256.test(String(source.submissionRequestHash || ''))
    && nullableText(source.submissionVenueId)
    && source.submissionVenueId !== null
    && source.evidenceNodes.length === 0;
}

function sourceValidForDisposition(source, dispositionType) {
  if (!sourceShapeValid(source)) return false;
  if (dispositionType === AUTONOMOUS_RESEARCH_SCIENTIFIC_DISPOSITION_TYPES.NEGATIVE_RESULT) {
    return negativeResultSourceValid(source);
  }
  if (dispositionType
    === AUTONOMOUS_RESEARCH_SCIENTIFIC_DISPOSITION_TYPES.FORMAL_PROOF_SEARCH_EXHAUSTED) {
    return proofExhaustionSourceValid(source);
  }
  if (dispositionType
    === AUTONOMOUS_RESEARCH_SCIENTIFIC_DISPOSITION_TYPES.REVIEW_NON_CONVERGENCE) {
    return reviewNonConvergenceSourceValid(source);
  }
  if (dispositionType
    === AUTONOMOUS_RESEARCH_SCIENTIFIC_DISPOSITION_TYPES.SUBMISSION_EXPLICIT_REJECTION) {
    return submissionRejectionSourceValid(source);
  }
  return false;
}

function sourceBase(campaign) {
  return {
    campaignId: String(campaign?.campaignId || ''),
    paperId: String(campaign?.paperId || ''),
    campaignStatus: String(campaign?.status || ''),
    stopReason: campaign?.stopReason || null,
    campaignPlanHash: campaign?.spec?.campaignPlanHash || null,
    evidenceNodes: Object.freeze([]),
    submissionDeliveryStatus: null,
    submissionDeliveryStateReceiptHash: null,
    submissionRequestHash: null,
    submissionVenueId: null,
  };
}

function negativeSource(campaign, nodes) {
  if (campaign?.status !== 'completed') return null;
  const empiricalNodes = (nodes || []).filter((node) => node?.status === 'completed'
    && empiricalKind(node?.kind) && scientificVerdict(node?.result));
  if (empiricalNodes.length < 2) return null;
  const evidenceNodes = empiricalNodes.map((node) => evidenceNode(node, {
    scientificVerdict: scientificVerdict(node.result),
  })).sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const source = Object.freeze({ ...sourceBase(campaign), evidenceNodes: Object.freeze(evidenceNodes) });
  return negativeResultSourceValid(source) ? source : null;
}

function proofExhaustionSource(campaign, nodes) {
  if (campaign?.status !== 'failed') return null;
  const proofNodes = (nodes || []).filter((node) => node?.status === 'failed_terminal'
    && proofExhaustionFailureClass(node?.failureClass)
    && node?.failureDetail?.receiptKind === 'FormalProofSearchFailureCertificate'
    && node?.failureDetail?.receiptStatus === 'formal_proof_search_exhausted'
    && SHA256.test(String(node?.failureDetail?.receiptHash || '')))
    .map((node) => evidenceNode(node, {
      evidenceKind: node.failureDetail.receiptKind,
      evidenceStatus: node.failureDetail.receiptStatus,
      evidenceReceiptHash: node.failureDetail.receiptHash,
    })).sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  if (!proofNodes.length) return null;
  const source = Object.freeze({
    ...sourceBase(campaign),
    evidenceNodes: Object.freeze(proofNodes),
  });
  return proofExhaustionSourceValid(source) ? source : null;
}

function reviewNonConvergenceSource(campaign, nodes) {
  if (campaign?.status !== 'stopped'
    || campaign?.stopReason !== 'referee_convergence_not_reached_within_budget') return null;
  const maximumRound = Number(campaign?.maxRounds || campaign?.spec?.maxRounds || 0);
  const convergenceNodes = (nodes || []).filter((node) => node?.kind === 'convergence'
    && node?.status === 'completed'
    && node?.result?.accepted === false
    && Number(node?.roundIndex || 0) >= maximumRound)
    .map((node) => evidenceNode(node, { accepted: false }))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  if (!maximumRound || !convergenceNodes.length) return null;
  const source = Object.freeze({
    ...sourceBase(campaign),
    evidenceNodes: Object.freeze(convergenceNodes),
  });
  return reviewNonConvergenceSourceValid(source) ? source : null;
}

function deliveryStateReceiptValid(state, campaign) {
  if (!state || state.kind !== 'AutonomousSubmissionDeliveryStateReceipt'
    || state.status !== 'autonomous_submission_delivery_explicit_failure'
    || state.state !== 'explicit_failure' || state.terminal !== true
    || state.campaignId !== campaign?.campaignId || state.paperId !== campaign?.paperId
    || !state.failure || !SHA256.test(String(state.requestHash || ''))
    || !SAFE_ID.test(String(state.venueId || ''))
    || !SHA256.test(String(state.autonomousSubmissionDeliveryStateReceiptHash || ''))) {
    return false;
  }
  const { autonomousSubmissionDeliveryStateReceiptHash: claimedHash, ...payload } = state;
  return hashRecord('AutonomousSubmissionDeliveryStateReceipt', payload) === claimedHash;
}

function submissionRejectionSource(campaign, submissionDelivery) {
  if (campaign?.status !== 'completed'
    || submissionDelivery?.status !== 'autonomous_submission_delivery_explicit_failure'
    || submissionDelivery?.terminal !== true) return null;
  const state = submissionDelivery.deliveryStateReceipt;
  if (!deliveryStateReceiptValid(state, campaign)) return null;
  const source = Object.freeze({
    ...sourceBase(campaign),
    submissionDeliveryStatus: submissionDelivery.status,
    submissionDeliveryStateReceiptHash:
      state.autonomousSubmissionDeliveryStateReceiptHash,
    submissionRequestHash: state.requestHash,
    submissionVenueId: state.venueId,
  });
  return submissionRejectionSourceValid(source) ? source : null;
}

function completedSubmission(delivery) {
  return delivery?.status === 'autonomous_submission_delivery_completed'
    && delivery?.terminal === true;
}

export function buildAutonomousResearchScientificDispositionReceipt({
  dispositionType,
  source,
  settledAt,
} = {}) {
  const policy = DISPOSITION_POLICY[dispositionType];
  if (!policy || !sourceValidForDisposition(source, dispositionType)
    || !canonicalInstant(settledAt)) {
    throw new Error('autonomous_research_scientific_disposition_invalid');
  }
  const sourceEvidenceHash = hashRecord(
    'AutonomousResearchScientificDispositionSource',
    source,
  );
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchScientificDispositionReceipt',
    status: 'autonomous_research_scientific_outcome_settled',
    dispositionType,
    settlementReason: policy.settlementReason,
    nextAction: policy.nextAction,
    source,
    sourceEvidenceHash,
    scientificSuccess: false,
    claimPromotionAuthorized: false,
    successorCampaignCreated: false,
    successorCampaignId: null,
    automaticBudgetExpansionPerformed: false,
    requiresHumanIntervention: false,
    externalActionPerformed: false,
    settledAt,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchScientificDispositionReceiptHash: hashRecord(
      'AutonomousResearchScientificDispositionReceipt',
      payload,
    ),
  });
}

export function verifyAutonomousResearchScientificDispositionReceipt(value) {
  if (!hasExactObjectKeys(value, RECEIPT_KEYS)
    || value?.version !== 1
    || value?.kind !== 'AutonomousResearchScientificDispositionReceipt'
    || value?.status !== 'autonomous_research_scientific_outcome_settled'
    || !canonicalInstant(value?.settledAt)
    || !sourceValidForDisposition(value?.source, value?.dispositionType)
    || value?.sourceEvidenceHash !== hashRecord(
      'AutonomousResearchScientificDispositionSource', value.source)
    || value?.scientificSuccess !== false
    || value?.claimPromotionAuthorized !== false
    || value?.successorCampaignCreated !== false
    || value?.successorCampaignId !== null
    || value?.automaticBudgetExpansionPerformed !== false
    || value?.requiresHumanIntervention !== false
    || value?.externalActionPerformed !== false) return false;
  const policy = DISPOSITION_POLICY[value.dispositionType];
  if (!policy || value.nextAction !== policy.nextAction
    || value.settlementReason !== policy.settlementReason) return false;
  const {
    autonomousResearchScientificDispositionReceiptHash: claimedHash,
    ...payload
  } = value;
  return SHA256.test(String(claimedHash || ''))
    && hashRecord('AutonomousResearchScientificDispositionReceipt', payload) === claimedHash;
}

export function resolveAutonomousResearchScientificDisposition({
  campaign,
  nodes = [],
  submissionRequired = false,
  submissionDelivery = null,
  now,
} = {}) {
  const observedAt = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(observedAt.getTime())) {
    throw new Error('autonomous_research_scientific_disposition_clock_invalid');
  }
  const candidates = [
    [AUTONOMOUS_RESEARCH_SCIENTIFIC_DISPOSITION_TYPES.SUBMISSION_EXPLICIT_REJECTION,
      submissionRejectionSource(campaign, submissionDelivery)],
    [AUTONOMOUS_RESEARCH_SCIENTIFIC_DISPOSITION_TYPES.FORMAL_PROOF_SEARCH_EXHAUSTED,
      proofExhaustionSource(campaign, nodes)],
    [AUTONOMOUS_RESEARCH_SCIENTIFIC_DISPOSITION_TYPES.REVIEW_NON_CONVERGENCE,
      reviewNonConvergenceSource(campaign, nodes)],
  ];
  if (!submissionRequired || completedSubmission(submissionDelivery)) {
    candidates.push([
      AUTONOMOUS_RESEARCH_SCIENTIFIC_DISPOSITION_TYPES.NEGATIVE_RESULT,
      negativeSource(campaign, nodes),
    ]);
  }
  const selected = candidates.find(([, source]) => source);
  if (!selected) return null;
  return buildAutonomousResearchScientificDispositionReceipt({
    dispositionType: selected[0],
    source: selected[1],
    settledAt: observedAt.toISOString(),
  });
}
