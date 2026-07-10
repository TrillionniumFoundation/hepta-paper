import {
  CHANNEL_IDS,
  EXTERNAL_ACTIONS,
  PRODUCT_LINE_IDS,
  normalizeText,
  uniqueStrings,
} from './contracts.mjs';
import { digest } from './hash-utils.mjs';

export const HUMAN_FEEDBACK_EVIDENCE_CONTRACT_VERSION = 1;

export const HUMAN_FEEDBACK_EVIDENCE_STATUS = Object.freeze({
  READY: 'ready',
  READY_WITH_ALLOWED_GAPS: 'ready_with_allowed_gaps',
  BLOCKED_MISSING_MESSAGES: 'blocked_missing_messages',
  BLOCKED_MISSING_MEDIA: 'blocked_missing_media',
  BLOCKED_ATTACHMENT_INTEGRITY: 'blocked_attachment_integrity',
  BLOCKED_MANUAL_REVIEW: 'blocked_manual_review',
  BLOCKED_SOURCE_POLICY: 'blocked_source_policy',
  BLOCKED: 'blocked',
});

export const HUMAN_FEEDBACK_EVIDENCE_SOURCE_TYPES = Object.freeze([
  'human_feedback_evidence',
  'wechat_feedback_evidence',
  'im_feedback_evidence',
  'manual_feedback_evidence',
]);

function text(value) {
  return normalizeText(value || '') || null;
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function bool(value) {
  return value === undefined || value === null ? false : Boolean(value);
}

function normalizeChannelId(channelId) {
  const normalized = normalizeText(channelId || CHANNEL_IDS.ZBJ).toLowerCase();
  return Object.values(CHANNEL_IDS).includes(normalized) ? normalized : CHANNEL_IDS.MANUAL;
}

function normalizeSourceType(sourceType) {
  const normalized = normalizeText(sourceType || 'human_feedback_evidence')
    .toLowerCase()
    .replace(/[ -]+/g, '_');
  return HUMAN_FEEDBACK_EVIDENCE_SOURCE_TYPES.includes(normalized)
    ? normalized
    : 'human_feedback_evidence';
}

function normalizeIssue(item, fallbackCode = 'human_feedback_evidence_issue') {
  if (typeof item === 'string') {
    return { code: normalizeText(item), severity: 'blocker', details: null };
  }
  return {
    code: normalizeText(item?.code || fallbackCode),
    severity: normalizeText(item?.severity || item?.level || 'blocker') || 'blocker',
    details: text(item?.details || item?.notes || item?.message || item?.ref),
  };
}

function normalizeIssues(values = [], fallbackCode) {
  return (values || [])
    .map((item) => normalizeIssue(item, fallbackCode))
    .filter((item) => item.code);
}

function normalizeCoverage(input = {}) {
  const coverage = input.coverage || {};
  const manualMediaBindingCount = numberOrZero(
    coverage.manualMediaBindingCount
      ?? coverage.acceptedManualBindingCount
      ?? input.acceptedManualBindingMessageIds?.length,
  );
  const mediaSelectionExcludedCount = numberOrZero(
    coverage.mediaSelectionExcludedCount
      ?? coverage.excludedMediaCount
      ?? input.excludedMediaMessageIds?.length,
  );
  return {
    messageCount: numberOrZero(coverage.messageCount ?? input.messageCount),
    mediaMessageCount: numberOrZero(coverage.mediaMessageCount ?? input.mediaMessageCount),
    attachmentCount: numberOrZero(coverage.attachmentCount ?? input.attachmentCount),
    missingMediaCount: numberOrZero(coverage.missingMediaCount ?? input.missingMediaCount),
    manualMediaBindingCount,
    mediaSelectionExcludedCount,
    byType: coverage.byType && typeof coverage.byType === 'object' ? { ...coverage.byType } : {},
  };
}

function normalizeRefs(values = []) {
  return (values || []).map((item) => {
    if (typeof item === 'string') return { kind: 'path', ref: normalizeText(item), hash: null, notes: null };
    return {
      kind: normalizeText(item?.kind || 'path') || 'path',
      ref: normalizeText(item?.ref || item?.path || item?.url || item?.id || ''),
      hash: text(item?.hash),
      notes: text(item?.notes),
    };
  }).filter((item) => item.ref);
}

function blockerCodes(blockers = []) {
  return blockers.map((item) => item.code).filter(Boolean);
}

function hasCode(codes, pattern) {
  return codes.some((code) => pattern.test(code));
}

function deriveStatus(input, coverage, blockers) {
  const explicit = normalizeText(input.status || input.evidenceStatus || '').toLowerCase();
  if (Object.values(HUMAN_FEEDBACK_EVIDENCE_STATUS).includes(explicit)) return explicit;
  const codes = blockerCodes(blockers);
  const hasBlockers = blockers.length > 0 || input.ok === false || input.ready === false;
  if (!coverage.messageCount || hasCode(codes, /messages?_required|message_count|missing_messages/i)) {
    return HUMAN_FEEDBACK_EVIDENCE_STATUS.BLOCKED_MISSING_MESSAGES;
  }
  if (hasCode(codes, /manual_media_binding|manual_binding|manual_review|android_image_binding/i)) {
    return HUMAN_FEEDBACK_EVIDENCE_STATUS.BLOCKED_MANUAL_REVIEW;
  }
  if (hasCode(codes, /cloud_transcription|backend|source_policy/i)) {
    return HUMAN_FEEDBACK_EVIDENCE_STATUS.BLOCKED_SOURCE_POLICY;
  }
  if (hasCode(codes, /attachment_.*(sha256|hash|file|path|missing|mismatch)|file_missing|hash_mismatch/i)) {
    return HUMAN_FEEDBACK_EVIDENCE_STATUS.BLOCKED_ATTACHMENT_INTEGRITY;
  }
  if (hasCode(codes, /missing_media|media_message_unaccounted|media_unaccounted|original_required|thumbnail|ambiguous/i)) {
    return HUMAN_FEEDBACK_EVIDENCE_STATUS.BLOCKED_MISSING_MEDIA;
  }
  const accountedMedia = coverage.attachmentCount
    + coverage.missingMediaCount
    + coverage.manualMediaBindingCount
    + coverage.mediaSelectionExcludedCount;
  if (coverage.mediaMessageCount > 0 && accountedMedia <= 0) {
    return HUMAN_FEEDBACK_EVIDENCE_STATUS.BLOCKED_MISSING_MEDIA;
  }
  if (hasBlockers) return HUMAN_FEEDBACK_EVIDENCE_STATUS.BLOCKED;
  if (coverage.missingMediaCount > 0) return HUMAN_FEEDBACK_EVIDENCE_STATUS.READY_WITH_ALLOWED_GAPS;
  return HUMAN_FEEDBACK_EVIDENCE_STATUS.READY;
}

export function humanFeedbackEvidenceRecommendation(contract = {}) {
  const status = contract.status || contract.evidenceStatus;
  if (status === HUMAN_FEEDBACK_EVIDENCE_STATUS.READY) return 'build_human_feedback_revision_contract';
  if (status === HUMAN_FEEDBACK_EVIDENCE_STATUS.READY_WITH_ALLOWED_GAPS) return 'review_allowed_evidence_gaps_before_revision';
  if (status === HUMAN_FEEDBACK_EVIDENCE_STATUS.BLOCKED_MISSING_MESSAGES) return 'refresh_human_feedback_message_export';
  if (status === HUMAN_FEEDBACK_EVIDENCE_STATUS.BLOCKED_MISSING_MEDIA) return 'recover_or_exclude_missing_feedback_media';
  if (status === HUMAN_FEEDBACK_EVIDENCE_STATUS.BLOCKED_ATTACHMENT_INTEGRITY) return 'repair_attachment_hashes_or_files';
  if (status === HUMAN_FEEDBACK_EVIDENCE_STATUS.BLOCKED_MANUAL_REVIEW) return 'complete_manual_feedback_media_review';
  if (status === HUMAN_FEEDBACK_EVIDENCE_STATUS.BLOCKED_SOURCE_POLICY) return 'rebuild_evidence_with_allowed_local_source';
  return 'review_feedback_evidence_blockers';
}

export function normalizeHumanFeedbackEvidenceContract(input = {}, {
  channelId = input.channelId || CHANNEL_IDS.ZBJ,
  sourceType = input.sourceType || 'human_feedback_evidence',
} = {}) {
  const coverage = normalizeCoverage(input);
  const blockers = normalizeIssues(input.blockers, 'human_feedback_evidence_blocked');
  const warnings = normalizeIssues(input.warnings, 'human_feedback_evidence_warning');
  const status = deriveStatus(input, coverage, blockers);
  const ready = status === HUMAN_FEEDBACK_EVIDENCE_STATUS.READY
    || status === HUMAN_FEEDBACK_EVIDENCE_STATUS.READY_WITH_ALLOWED_GAPS;
  const evidenceHash = text(input.evidenceHash || input.bundleHash || input.sourceHash || input.hash);
  const messagesHash = text(input.messagesHash || input.messagesSha256 || input.messagesDigest);
  const attachmentHashes = uniqueStrings(input.attachmentHashes || input.attachmentSha256s || [], 256);
  const acceptedManualBindingMessageIds = uniqueStrings(input.acceptedManualBindingMessageIds || [], 128);
  const excludedMediaMessageIds = uniqueStrings(input.excludedMediaMessageIds || [], 128);
  const contract = {
    version: HUMAN_FEEDBACK_EVIDENCE_CONTRACT_VERSION,
    kind: 'HumanFeedbackEvidenceContract',
    productLineId: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
    action: EXTERNAL_ACTIONS.NONE,
    channelId: normalizeChannelId(channelId),
    sourceType: normalizeSourceType(sourceType),
    taskId: text(input.taskId),
    orderId: text(input.orderId),
    status,
    ready,
    recommendation: humanFeedbackEvidenceRecommendation({ status }),
    evidenceHash,
    bundleHash: text(input.bundleHash) || evidenceHash,
    messagesHash,
    attachmentHashes,
    coverage,
    acceptedManualBindingMessageIds,
    excludedMediaMessageIds,
    blockers,
    warnings,
    evidenceRefs: normalizeRefs(input.evidenceRefs || input.refs),
    safety: {
      localContractOnly: true,
      executesExternalAction: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      fetchesChannelState: false,
      callsProviderOrModel: false,
      grantsExecutionPermission: false,
    },
  };
  return {
    ...contract,
    contractHash: digest(contract),
  };
}

export function validateHumanFeedbackEvidenceContract(contract = {}) {
  const normalized = contract.version === HUMAN_FEEDBACK_EVIDENCE_CONTRACT_VERSION
    ? contract
    : normalizeHumanFeedbackEvidenceContract(contract);
  const blockers = [];
  if (normalized.version !== HUMAN_FEEDBACK_EVIDENCE_CONTRACT_VERSION) blockers.push('human_feedback_evidence_contract_version_mismatch');
  if (normalized.productLineId !== PRODUCT_LINE_IDS.HUMAN_FEEDBACK) blockers.push('human_feedback_evidence_product_line_required');
  if (normalized.action !== EXTERNAL_ACTIONS.NONE) blockers.push('human_feedback_evidence_action_must_be_none');
  if (!Object.values(CHANNEL_IDS).includes(normalized.channelId)) blockers.push('human_feedback_evidence_channel_invalid');
  if (!HUMAN_FEEDBACK_EVIDENCE_SOURCE_TYPES.includes(normalized.sourceType)) blockers.push('human_feedback_evidence_source_type_invalid');
  if (!Object.values(HUMAN_FEEDBACK_EVIDENCE_STATUS).includes(normalized.status)) blockers.push('human_feedback_evidence_status_invalid');
  if (normalized.ready && normalized.blockers.length) blockers.push('human_feedback_evidence_ready_conflicts_with_blockers');
  if (normalized.ready && !normalized.coverage.messageCount) blockers.push('human_feedback_evidence_ready_requires_messages');
  if (normalized.ready && !normalized.evidenceHash) blockers.push('human_feedback_evidence_ready_requires_hash');
  return {
    ok: blockers.length === 0,
    status: blockers.length ? 'blocked_human_feedback_evidence_contract' : 'pass_human_feedback_evidence_contract',
    blockers,
    normalized,
    safety: {
      localContractOnly: true,
      executesExternalAction: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      fetchesChannelState: false,
      callsProviderOrModel: false,
      grantsExecutionPermission: false,
    },
  };
}

export function humanFeedbackEvidenceContractsSelftest() {
  const ready = normalizeHumanFeedbackEvidenceContract({
    sourceType: 'wechat_feedback_evidence',
    ok: true,
    bundleHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    messagesSha256: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    attachmentHashes: ['sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'],
    coverage: { messageCount: 3, mediaMessageCount: 1, attachmentCount: 1, missingMediaCount: 0 },
  });
  const missingMedia = normalizeHumanFeedbackEvidenceContract({
    sourceType: 'wechat_feedback_evidence',
    ok: false,
    bundleHash: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    coverage: { messageCount: 2, mediaMessageCount: 1, attachmentCount: 0, missingMediaCount: 1 },
    blockers: [{ code: 'wechat_feedback_missing_media_blocks_human_feedback', details: 'm2:image' }],
  });
  const allowedGap = normalizeHumanFeedbackEvidenceContract({
    sourceType: 'wechat_feedback_evidence',
    ok: true,
    bundleHash: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    coverage: { messageCount: 2, mediaMessageCount: 1, attachmentCount: 0, missingMediaCount: 1 },
    acceptedManualBindingMessageIds: ['m2'],
  });
  const validation = validateHumanFeedbackEvidenceContract(ready);
  return {
    ok: ready.ready === true
      && ready.status === HUMAN_FEEDBACK_EVIDENCE_STATUS.READY
      && validation.ok === true
      && missingMedia.ready === false
      && missingMedia.status === HUMAN_FEEDBACK_EVIDENCE_STATUS.BLOCKED_MISSING_MEDIA
      && missingMedia.recommendation === 'recover_or_exclude_missing_feedback_media'
      && allowedGap.ready === true
      && allowedGap.status === HUMAN_FEEDBACK_EVIDENCE_STATUS.READY_WITH_ALLOWED_GAPS,
    ready,
    missingMedia,
    allowedGap,
    validation,
    safety: {
      localContractOnly: true,
      executesExternalAction: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      fetchesChannelState: false,
      callsProviderOrModel: false,
      grantsExecutionPermission: false,
    },
  };
}
