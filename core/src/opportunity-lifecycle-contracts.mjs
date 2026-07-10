import {
  CHANNEL_IDS,
  EXTERNAL_ACTIONS,
  PRODUCT_LINE_IDS,
  normalizeText,
  uniqueStrings,
} from './contracts.mjs';
import { digest } from './hash-utils.mjs';

export const OPPORTUNITY_LIFECYCLE_CONTRACT_VERSION = 1;

export const OPPORTUNITY_LIFECYCLE_STATUS = Object.freeze({
  SUBMITTABLE: 'submittable',
  ALREADY_SUBMITTED: 'already_submitted',
  SKIPPED_BY_POLICY: 'skipped_by_policy',
  BLOCKED_REFUND: 'blocked_refund',
  BLOCKED_NO_SUBMIT_PATH: 'blocked_no_submit_path',
  BLOCKED_BACKEND_REJECTED: 'blocked_backend_rejected',
  EXPIRED: 'expired',
  UNCERTAIN: 'uncertain',
  BLOCKED: 'blocked',
});

export const OPPORTUNITY_LIFECYCLE_BUCKETS = Object.freeze({
  ACTIONABLE_NOW: 'actionable_now',
  DO_NOT_WORK: 'do_not_work',
  RECHECK_LATER: 'recheck_later',
  BLOCKED: 'blocked',
  UNCERTAIN: 'uncertain',
});

const CATEGORY_PRODUCT_LINE_HINTS = Object.freeze([
  [PRODUCT_LINE_IDS.NAMING_TEXT, /品牌\/企业命名|品牌命名|企业命名|产品命名|中文命名|英文命名|店铺取名|取名|起名|命名/],
  [PRODUCT_LINE_IDS.LOGO_BRAND, /logo|LOGO|标志|商标|VI|品牌升级|企业形象/i],
  [PRODUCT_LINE_IDS.PACKAGING_DESIGN, /包装|瓶贴|标签|礼盒|包装盒|包装袋/],
  [PRODUCT_LINE_IDS.PRESENTATION_DECK, /PPT|演示|幻灯|课件/i],
  [PRODUCT_LINE_IDS.CATALOG_BROCHURE, /画册|宣传册|手册|折页|单页|书封|封面/],
  [PRODUCT_LINE_IDS.POSTER_DESIGN, /海报|主KV|KV|活动视觉|直播背景|电商图/],
  [PRODUCT_LINE_IDS.PROPOSAL_BOARD, /鸟瞰图|效果图|公装|美陈|空间|导视|景观|展厅|园区/],
  [PRODUCT_LINE_IDS.PRODUCT_DESIGN, /工业产品|产品建模|模具|结构|外观设计/],
]);

const REFUND_SIGNAL_PATTERNS = Object.freeze([
  { id: 'employer_refund_requested', pattern: /雇主\s*(?:已)?发起(?:了)?退款(?:申请)?/ },
  { id: 'refund_request_processing', pattern: /退款申请[^。\n]{0,40}(?:工作人员)?处理中/ },
  { id: 'refund_processing', pattern: /退款[^。\n]{0,24}(?:处理中|处理当中|等待处理|审核中)/ },
  { id: 'refund_requested', pattern: /(?:申请退款|退款申请|已发起退款)/ },
  { id: 'refund_english', pattern: /\brefund(?:ed|ing)?\b/i },
]);

const REFUND_NEGATIVE_HINT_RE = /(?:未发起退款|未申请退款|无退款|不涉及退款|退款政策|退款说明|退换货政策)/;

function text(value) {
  return normalizeText(value || '') || null;
}

function compactEvidenceText(value, maxLen = 20000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function excerptAround(textValue, matchText, radius = 48) {
  const compact = compactEvidenceText(textValue);
  if (!compact || !matchText) return '';
  const idx = compact.indexOf(matchText);
  if (idx < 0) return compact.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(compact.length, idx + matchText.length + radius);
  return compact.slice(start, end);
}

function matchRefundSignal(textValue) {
  const compact = compactEvidenceText(textValue);
  if (!compact) return null;
  for (const item of REFUND_SIGNAL_PATTERNS) {
    const match = compact.match(item.pattern);
    const excerpt = match ? excerptAround(compact, match[0]) : '';
    if (match && !REFUND_NEGATIVE_HINT_RE.test(excerpt)) {
      return {
        id: item.id,
        signal: match[0],
        excerpt,
      };
    }
  }
  return null;
}

function pushRefundEvidence(out, source, value) {
  const textValue = compactEvidenceText(value);
  if (!textValue) return;
  out.push({ source, text: textValue });
}

function collectRefundObjectEvidence(out, prefix, value, depth = 0) {
  if (!value || depth > 4) return;
  if (typeof value === 'string' || typeof value === 'number') {
    pushRefundEvidence(out, prefix, value);
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, 40).forEach((item, index) => collectRefundObjectEvidence(out, prefix + '[' + index + ']', item, depth + 1));
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const isLikelyStateField = /(refund|state|status|submit|seller|body|snippet|preview|text|reason|message|title|button|href|url)/i.test(key)
      || /状态|退款|提交|交稿|卖家|正文|页面|按钮|原因|消息/.test(key);
    if (!isLikelyStateField && depth > 0) continue;
    collectRefundObjectEvidence(out, prefix ? prefix + '.' + key : key, child, depth + 1);
  }
}

export function refundBlockerResult(match, meta = {}) {
  if (!match) {
    return {
      blocked: false,
      blockerType: null,
      reason: null,
      status: 'clear',
      checkedAt: meta.checkedAt || new Date().toISOString(),
      evidence: [],
    };
  }
  return {
    blocked: true,
    blockerType: 'employer_refund_requested',
    reason: 'employer_refund_requested',
    status: 'blocked_refund',
    stage: 'entry_refund_gate',
    checkedAt: meta.checkedAt || new Date().toISOString(),
    source: match.source,
    signalId: match.id,
    signal: match.signal,
    excerpt: match.excerpt,
    evidence: [{
      source: match.source,
      signalId: match.id,
      signal: match.signal,
      excerpt: match.excerpt,
    }],
  };
}

export function detectRefundState(...inputs) {
  const evidence = [];
  inputs.flat().forEach((input, index) => collectRefundObjectEvidence(evidence, input?.source || 'input' + (index + 1), input));
  for (const item of evidence) {
    const match = matchRefundSignal(item.text);
    if (match) return refundBlockerResult({ ...match, source: item.source });
  }
  return {
    blocked: false,
    blockerType: null,
    reason: null,
    status: 'clear',
    checkedAt: new Date().toISOString(),
    evidence: [],
  };
}

export function extractRefundText(textValue) {
  const match = matchRefundSignal(textValue);
  return match?.excerpt || null;
}

function bool(value) {
  return value === undefined || value === null ? false : Boolean(value);
}

function amountNumber(value) {
  const raw = normalizeText(value || '').replace(/,/g, '');
  const numbers = raw.match(/\d+(?:\.\d+)?/g)?.map(Number).filter(Number.isFinite) || [];
  return numbers.length ? Math.max(...numbers) : 0;
}

function normalizeChannelId(channelId) {
  const normalized = normalizeText(channelId || CHANNEL_IDS.ZBJ).toLowerCase();
  return Object.values(CHANNEL_IDS).includes(normalized) ? normalized : CHANNEL_IDS.MANUAL;
}

function parseTimeMs(value) {
  if (!value) return null;
  const normalized = String(value).trim().replace(' ', 'T');
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? time : null;
}

function hasText(input, pattern) {
  return [
    input.title,
    input.category1Name,
    input.category2Name,
    input.category3Name,
    input.stateName,
    input.liveBlockerType,
    input.reason,
    input.error,
  ].map((item) => normalizeText(item || '')).join('\n').match(pattern);
}

export function classifyOpportunityProductLine(input = {}) {
  const explicit = normalizeText(input.productLineId || input.workflowId || '');
  if (Object.values(PRODUCT_LINE_IDS).includes(explicit)) return explicit;
  const haystack = [
    input.title,
    input.category1Name,
    input.category2Name,
    input.category3Name,
    input.category3IdName,
  ].map((item) => normalizeText(item || '')).join('\n');
  for (const [productLineId, pattern] of CATEGORY_PRODUCT_LINE_HINTS) {
    if (pattern.test(haystack)) return productLineId;
  }
  return PRODUCT_LINE_IDS.GENERIC_DESIGN;
}

function livePathAvailable(input = {}) {
  const buttons = Array.isArray(input.buttons) ? input.buttons : [];
  const stateName = normalizeText(input.stateName || '');
  if (bool(input.livePathAvailable) || bool(input.hasSubmitButton)) return true;
  return buttons.includes('交稿') || stateName.includes('待交稿');
}

function alreadySubmitted(input = {}) {
  return bool(input.alreadySubmitted)
    || bool(input.sellerVerifiedWorkExists)
    || Number(input.myWorksCount || input.totalMyWorks || 0) > 0
    || /submitted_verified|already_submitted|seller_verified_work_exists|existing_verified_submission/i.test(normalizeText(input.status || input.liveBlockerType || input.lastStep || ''));
}

function refundBlocked(input = {}) {
  return bool(input.refundState?.blocked)
    || /refund|退款|employer_refund_requested/.test(normalizeText(input.liveBlockerType || input.reason || input.error || ''));
}

function backendRejected(input = {}) {
  return /backend_rejected|TRADE-|订单当前状态无法交稿|无法交稿/.test(normalizeText(input.liveBlockerType || input.reason || input.error || ''));
}

function noSubmitPath(input = {}) {
  return /no_submit|missing_seller_submit_entry|submit_entry_missing|public_xq_only|seller_task_page_not_found/.test(normalizeText(input.liveBlockerType || input.reason || input.error || ''));
}

function statusBucket(status) {
  if (status === OPPORTUNITY_LIFECYCLE_STATUS.SUBMITTABLE) return OPPORTUNITY_LIFECYCLE_BUCKETS.ACTIONABLE_NOW;
  if (status === OPPORTUNITY_LIFECYCLE_STATUS.ALREADY_SUBMITTED || status === OPPORTUNITY_LIFECYCLE_STATUS.SKIPPED_BY_POLICY) return OPPORTUNITY_LIFECYCLE_BUCKETS.DO_NOT_WORK;
  if (status === OPPORTUNITY_LIFECYCLE_STATUS.UNCERTAIN) return OPPORTUNITY_LIFECYCLE_BUCKETS.UNCERTAIN;
  if (status === OPPORTUNITY_LIFECYCLE_STATUS.EXPIRED) return OPPORTUNITY_LIFECYCLE_BUCKETS.RECHECK_LATER;
  return OPPORTUNITY_LIFECYCLE_BUCKETS.BLOCKED;
}

function deriveStatus(input, { productLineId, excludedProductLineIds, nowMs }) {
  const explicit = normalizeText(input.opportunityStatus || input.lifecycleStatus || '').toLowerCase();
  if (Object.values(OPPORTUNITY_LIFECYCLE_STATUS).includes(explicit)) return explicit;
  if (alreadySubmitted(input)) return OPPORTUNITY_LIFECYCLE_STATUS.ALREADY_SUBMITTED;
  if (excludedProductLineIds.includes(productLineId)) return OPPORTUNITY_LIFECYCLE_STATUS.SKIPPED_BY_POLICY;
  if (refundBlocked(input)) return OPPORTUNITY_LIFECYCLE_STATUS.BLOCKED_REFUND;
  if (backendRejected(input)) return OPPORTUNITY_LIFECYCLE_STATUS.BLOCKED_BACKEND_REJECTED;
  if (noSubmitPath(input)) return OPPORTUNITY_LIFECYCLE_STATUS.BLOCKED_NO_SUBMIT_PATH;
  if (bool(input.uncertain) || (Array.isArray(input.errors) && input.errors.length > 0)) return OPPORTUNITY_LIFECYCLE_STATUS.UNCERTAIN;
  const deadlineMs = parseTimeMs(input.pubEndTime || input.deadline || input.deadlineAt || input.endTime);
  if (deadlineMs !== null && deadlineMs < nowMs) return OPPORTUNITY_LIFECYCLE_STATUS.EXPIRED;
  if (!livePathAvailable(input)) return OPPORTUNITY_LIFECYCLE_STATUS.BLOCKED_NO_SUBMIT_PATH;
  return OPPORTUNITY_LIFECYCLE_STATUS.SUBMITTABLE;
}

export function opportunityLifecycleRecommendation(contract = {}) {
  const status = contract.status || contract.opportunityStatus;
  if (status === OPPORTUNITY_LIFECYCLE_STATUS.SUBMITTABLE) return 'enter_production_queue';
  if (status === OPPORTUNITY_LIFECYCLE_STATUS.ALREADY_SUBMITTED) return 'do_not_resubmit_without_resubmit_approval';
  if (status === OPPORTUNITY_LIFECYCLE_STATUS.SKIPPED_BY_POLICY) return 'skip_by_business_policy';
  if (status === OPPORTUNITY_LIFECYCLE_STATUS.BLOCKED_REFUND) return 'do_not_work_refund_gate';
  if (status === OPPORTUNITY_LIFECYCLE_STATUS.BLOCKED_BACKEND_REJECTED) return 'recheck_only_after_platform_state_changes';
  if (status === OPPORTUNITY_LIFECYCLE_STATUS.BLOCKED_NO_SUBMIT_PATH) return 'recheck_seller_submit_path_later';
  if (status === OPPORTUNITY_LIFECYCLE_STATUS.EXPIRED) return 'prune_if_no_meaningful_local_work';
  if (status === OPPORTUNITY_LIFECYCLE_STATUS.UNCERTAIN) return 'manual_readonly_recheck';
  return 'hold_blocked_opportunity';
}

export function normalizeOpportunityLifecycle(input = {}, {
  channelId = input.channelId || CHANNEL_IDS.ZBJ,
  excludedProductLineIds = [],
  nowMs = Date.now(),
} = {}) {
  const productLineId = classifyOpportunityProductLine(input);
  const excluded = uniqueStrings(excludedProductLineIds, 16);
  const status = deriveStatus(input, { productLineId, excludedProductLineIds: excluded, nowMs });
  const deadlineMs = parseTimeMs(input.pubEndTime || input.deadline || input.deadlineAt || input.endTime);
  const contract = {
    version: OPPORTUNITY_LIFECYCLE_CONTRACT_VERSION,
    kind: 'OpportunityLifecycleContract',
    action: EXTERNAL_ACTIONS.NONE,
    channelId: normalizeChannelId(channelId),
    taskId: text(input.taskId),
    orderId: text(input.orderId),
    title: text(input.title),
    amount: amountNumber(input.amount ?? input.orderPrice ?? input.price ?? input.reward),
    category1Name: text(input.category1Name),
    category2Name: text(input.category2Name),
    category3Name: text(input.category3Name || input.category3IdName),
    productLineId,
    excludedProductLineIds: excluded,
    status,
    bucket: statusBucket(status),
    eligibleForProduction: status === OPPORTUNITY_LIFECYCLE_STATUS.SUBMITTABLE,
    recommendation: opportunityLifecycleRecommendation({ status }),
    livePathAvailable: livePathAvailable(input),
    alreadySubmitted: alreadySubmitted(input),
    refundBlocked: refundBlocked(input),
    deadlineAt: deadlineMs === null ? null : new Date(deadlineMs).toISOString(),
    deadlineHours: deadlineMs === null ? null : Number(((deadlineMs - nowMs) / 3600000).toFixed(1)),
    blockerType: text(input.liveBlockerType || input.refundState?.blockerType || input.blockerType),
    source: text(input.source),
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

function categoryFit(productLineId) {
  return {
    [PRODUCT_LINE_IDS.LOGO_BRAND]: 2.2,
    [PRODUCT_LINE_IDS.PACKAGING_DESIGN]: 1.8,
    [PRODUCT_LINE_IDS.CATALOG_BROCHURE]: 1.3,
    [PRODUCT_LINE_IDS.POSTER_DESIGN]: 1.2,
    [PRODUCT_LINE_IDS.PRESENTATION_DECK]: 1.1,
    [PRODUCT_LINE_IDS.PROPOSAL_BOARD]: 1.0,
    [PRODUCT_LINE_IDS.PRODUCT_DESIGN]: 1.0,
  }[productLineId] || 1.0;
}

export function scoreOpportunityPriority({
  opportunity = null,
  lifecycle = null,
  localEvidence = {},
  nowMs = Date.now(),
} = {}) {
  const normalized = lifecycle || normalizeOpportunityLifecycle(opportunity || {}, { nowMs });
  const amountScore = normalized.amount / 100.0;
  const daysLeft = normalized.deadlineHours === null ? 999 : normalized.deadlineHours / 24;
  const urgency = Math.max(0.5, 8 - Math.min(7.5, daysLeft));
  const artifacts = Number(localEvidence.artifacts ?? localEvidence.artifactCount ?? 0);
  const readiness = artifacts > 0 ? Math.min(4.0, Math.log2(artifacts + 1)) : 0;
  const fit = categoryFit(normalized.productLineId);
  const eligibilityPenalty = normalized.eligibleForProduction ? 0 : 100;
  const score = Number((amountScore * 10 + urgency * 1.2 + readiness * 0.8 + fit * 0.5 - eligibilityPenalty).toFixed(2));
  const reasons = [];
  if (normalized.amount >= 3000) reasons.push('high_amount');
  else if (normalized.amount >= 1000) reasons.push('solid_amount');
  else if (normalized.amount >= 500) reasons.push('mid_amount');
  if (daysLeft <= 1.5) reasons.push('urgent_deadline');
  else if (daysLeft <= 3) reasons.push('near_deadline');
  if (artifacts >= 20) reasons.push('strong_local_artifact_pool');
  else if (artifacts >= 5) reasons.push('some_local_artifacts');
  if (fit > 1.5) reasons.push('verified_workflow_fit');
  if (!normalized.eligibleForProduction) reasons.push(normalized.status);
  return {
    version: OPPORTUNITY_LIFECYCLE_CONTRACT_VERSION,
    score,
    daysLeft: Number(daysLeft.toFixed(2)),
    artifacts,
    scoreBreakdown: {
      urgency: Number(urgency.toFixed(2)),
      readiness: Number(readiness.toFixed(2)),
      amount: Number(amountScore.toFixed(2)),
      categoryFit: Number(fit.toFixed(2)),
      eligibilityPenalty,
    },
    reasons,
    lifecycleHash: normalized.contractHash,
    priorityHash: digest({
      version: OPPORTUNITY_LIFECYCLE_CONTRACT_VERSION,
      lifecycleHash: normalized.contractHash,
      score,
      artifacts,
      reasons,
    }),
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

export function validateOpportunityLifecycleContract(contract = {}) {
  const normalized = contract.version === OPPORTUNITY_LIFECYCLE_CONTRACT_VERSION
    ? contract
    : normalizeOpportunityLifecycle(contract);
  const blockers = [];
  if (normalized.action !== EXTERNAL_ACTIONS.NONE) blockers.push('opportunity_lifecycle_action_must_be_none');
  if (!Object.values(CHANNEL_IDS).includes(normalized.channelId)) blockers.push('opportunity_lifecycle_channel_invalid');
  if (!Object.values(PRODUCT_LINE_IDS).includes(normalized.productLineId)) blockers.push('opportunity_lifecycle_product_line_invalid');
  if (!Object.values(OPPORTUNITY_LIFECYCLE_STATUS).includes(normalized.status)) blockers.push('opportunity_lifecycle_status_invalid');
  if (!Object.values(OPPORTUNITY_LIFECYCLE_BUCKETS).includes(normalized.bucket)) blockers.push('opportunity_lifecycle_bucket_invalid');
  if (normalized.eligibleForProduction && normalized.status !== OPPORTUNITY_LIFECYCLE_STATUS.SUBMITTABLE) blockers.push('opportunity_lifecycle_eligible_status_mismatch');
  return {
    ok: blockers.length === 0,
    status: blockers.length ? 'blocked_opportunity_lifecycle_contract' : 'pass_opportunity_lifecycle_contract',
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

export function opportunityLifecycleContractsSelftest() {
  const nowMs = Date.parse('2026-06-21T00:00:00.000Z');
  const submittable = normalizeOpportunityLifecycle({
    taskId: 1,
    orderId: 2,
    title: '征集企业LOGO设计',
    category3Name: 'LOGO设计',
    amount: '800.0',
    pubEndTime: '2026-06-22 00:00:00',
    buttons: ['交稿'],
  }, { nowMs, excludedProductLineIds: [PRODUCT_LINE_IDS.NAMING_TEXT] });
  const naming = normalizeOpportunityLifecycle({
    taskId: 3,
    title: '品牌命名',
    category3Name: '品牌/企业命名',
    buttons: ['交稿'],
  }, { nowMs, excludedProductLineIds: [PRODUCT_LINE_IDS.NAMING_TEXT] });
  const refund = normalizeOpportunityLifecycle({
    taskId: 4,
    title: '海报设计',
    liveBlockerType: 'employer_refund_requested',
  }, { nowMs });
  const refundState = detectRefundState({
    source: 'live_page',
    bodySnippet: '项目状态 雇主发起了退款申请，工作人员处理中 暂不能交稿',
  });
  const refundClear = detectRefundState({
    source: 'brief',
    content: '需要设计售后服务图标，退款政策作为页面文案之一',
  });
  const priority = scoreOpportunityPriority({ lifecycle: submittable, localEvidence: { artifacts: 5 }, nowMs });
  const validation = validateOpportunityLifecycleContract(submittable);
  return {
    ok: submittable.status === OPPORTUNITY_LIFECYCLE_STATUS.SUBMITTABLE
      && submittable.eligibleForProduction === true
      && naming.status === OPPORTUNITY_LIFECYCLE_STATUS.SKIPPED_BY_POLICY
      && refund.status === OPPORTUNITY_LIFECYCLE_STATUS.BLOCKED_REFUND
      && refundState.blocked === true
      && refundState.blockerType === 'employer_refund_requested'
      && refundClear.blocked === false
      && priority.score > 0
      && priority.reasons.includes('some_local_artifacts')
      && validation.ok === true,
    submittable,
    naming,
    refund,
    refundState,
    refundClear,
    priority,
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
