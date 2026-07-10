import { digest } from './hash-utils.mjs';

export const DESIGN_PRODUCTION_CORE_VERSION = 1;

export const CHANNEL_IDS = Object.freeze({
  ZBJ: 'zbj',
  EPWK: 'epwk',
  HEPTA: 'hepta',
  MANUAL: 'manual',
});

export const PRODUCT_LINE_IDS = Object.freeze({
  LOGO_BRAND: 'logo_brand',
  PACKAGING_DESIGN: 'packaging_design',
  PROPOSAL_BOARD: 'proposal_board',
  PRESENTATION_DECK: 'presentation_deck',
  CATALOG_BROCHURE: 'catalog_brochure',
  POSTER_DESIGN: 'poster_design',
  PRODUCT_DESIGN: 'product_design',
  NAMING_TEXT: 'naming_text',
  VECTORIZATION: 'vectorization',
  HUMAN_FEEDBACK: 'human_feedback',
  POST_SUBMISSION_REVISION: 'post_submission_revision',
  ACCEPTANCE_DELIVERY: 'acceptance_delivery',
  GENERIC_DESIGN: 'generic_design',
});

export const OUTPUT_MODES = Object.freeze({
  IMAGE_SET: 'image_set',
  PDF_DECK: 'pdf_deck',
  TEXT_FORM: 'text_form',
  VECTOR_PACKAGE: 'vector_package',
  MIXED: 'mixed',
});

export const EXTERNAL_ACTIONS = Object.freeze({
  NONE: 'none',
  PROVIDER_SPEND: 'provider_spend',
  MODEL_SPEND: 'model_spend',
  LIVE_PREPARE: 'live_prepare',
  LIVE_SUBMIT: 'live_submit',
  ACCEPTANCE_APPLY: 'acceptance_apply',
  CUSTOMER_MESSAGE: 'customer_message',
  DEPLOYMENT: 'deployment',
});
const SHA256_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const HUMAN_FEEDBACK_CUSTOMER_FACING_ACTIONS = new Set([
  EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  EXTERNAL_ACTIONS.LIVE_SUBMIT,
  EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
]);

export const CORE_STAGES = Object.freeze({
  CHANNEL_DISCOVERED: 'channel_discovered',
  BRIEF_NORMALIZED: 'brief_normalized',
  PLAN_READY: 'plan_ready',
  GENERATION_READY: 'generation_ready',
  PACKAGE_READY: 'package_ready',
  REVIEW_READY: 'review_ready',
  PREPARE_READY: 'prepare_ready',
  SUBMIT_READY: 'submit_ready',
  SUBMITTED_VERIFIED: 'submitted_verified',
  DELIVERY_READY: 'delivery_ready',
  BLOCKED: 'blocked',
});

export const CHANNEL_CAPABILITY_KEYS = Object.freeze({
  DISCOVERY: 'discovery',
  DETAIL_FETCH: 'detail_fetch',
  ATTACHMENT_FETCH: 'attachment_fetch',
  DUPLICATE_PREFLIGHT: 'duplicate_preflight',
  LIVE_RULES: 'live_rules',
  PREPARE_ONLY: 'prepare_only',
  SUBMIT: 'submit',
  MESSAGE: 'message',
  ACCEPTANCE: 'acceptance',
  DELIVERY: 'delivery',
});

const CHANNEL_CAPABILITIES = Object.freeze({
  [CHANNEL_IDS.ZBJ]: Object.freeze({
    discovery: true,
    detail_fetch: true,
    attachment_fetch: true,
    duplicate_preflight: true,
    live_rules: true,
    prepare_only: true,
    submit: true,
    message: true,
    acceptance: true,
    delivery: true,
  }),
  [CHANNEL_IDS.EPWK]: Object.freeze({
    discovery: true,
    detail_fetch: true,
    attachment_fetch: true,
    duplicate_preflight: 'partial',
    live_rules: true,
    prepare_only: 'partial',
    submit: 'partial',
    message: 'partial',
    acceptance: 'partial',
    delivery: 'partial',
  }),
  [CHANNEL_IDS.HEPTA]: Object.freeze({
    discovery: false,
    detail_fetch: true,
    attachment_fetch: true,
    duplicate_preflight: false,
    live_rules: false,
    prepare_only: false,
    submit: false,
    message: 'partial',
    acceptance: false,
    delivery: true,
  }),
  [CHANNEL_IDS.MANUAL]: Object.freeze({
    discovery: false,
    detail_fetch: true,
    attachment_fetch: true,
    duplicate_preflight: false,
    live_rules: false,
    prepare_only: false,
    submit: false,
    message: false,
    acceptance: false,
    delivery: true,
  }),
});

export function normalizeText(value) {
  return String(value || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export function computeCustomerMessagePreviewHash(messagePreview) {
  const preview = normalizeText(messagePreview || '') || null;
  return preview ? digest({ kind: 'CustomerMessagePreview', messagePreview: preview }) : null;
}

export function computeCustomerMessagePreviewHashFromFields(value = null) {
  if (typeof value === 'string') return computeCustomerMessagePreviewHash(value);
  return computeCustomerMessagePreviewHash(value?.messagePreview || value?.previewText || value?.messageText);
}

function isSha256Hash(value) {
  return SHA256_HASH_PATTERN.test(normalizeText(value || ''));
}

function camelToDelimited(value, delimiter) {
  return normalizeText(value || '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, `$1${delimiter}$2`)
    .replace(/([a-z0-9])([A-Z])/g, `$1${delimiter}$2`)
    .toLowerCase();
}

function aliasLookupCandidates(value) {
  const id = normalizeText(value || '');
  if (!id) return [];
  return uniqueStrings([
    id,
    id.toLowerCase(),
    camelToDelimited(id, '_'),
    camelToDelimited(id, '-'),
    camelToDelimited(id, ' '),
  ], 8);
}

function lookupCanonicalAlias(aliases, value, canonicalValues = null) {
  const id = normalizeText(value || '');
  if (!id) return id;
  for (const candidate of aliasLookupCandidates(id)) {
    if (aliases[candidate]) return aliases[candidate];
    if (canonicalValues?.has(candidate)) return candidate;
  }
  return id;
}

const PRODUCT_LINE_ALIASES = Object.freeze({
  'human-feedback': PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  'human feedback': PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  humanFeedback: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  humanfeedback: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  [PRODUCT_LINE_IDS.POST_SUBMISSION_REVISION]: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  'post-submission-revision': PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  'post submission revision': PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  postSubmissionRevision: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  postsubmissionrevision: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  consumer_feedback: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  'consumer-feedback': PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  'consumer feedback': PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  consumerFeedback: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  consumerfeedback: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  buyer_feedback: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  'buyer-feedback': PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  'buyer feedback': PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  buyerFeedback: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  buyerfeedback: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  human_feedback_revision: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  'human-feedback-revision': PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  'human feedback revision': PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  humanFeedbackRevision: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  humanfeedbackrevision: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  human_feedback_review: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  'human-feedback-review': PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  'human feedback review': PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  humanFeedbackReview: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  humanfeedbackreview: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  human_feedback_referee: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  'human-feedback-referee': PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  'human feedback referee': PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  humanFeedbackReferee: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  humanfeedbackreferee: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  feedback_revision: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  'feedback-revision': PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  'feedback revision': PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  feedbackRevision: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  feedbackrevision: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  post_submission: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  'post-submission': PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  'post submission': PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  postSubmission: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  postsubmission: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  post_win: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  'post-win': PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  'post win': PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  postWin: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  postwin: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  shortlisted_revision: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  'shortlisted-revision': PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  'shortlisted revision': PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  shortlistedRevision: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  shortlistedrevision: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  won_revision: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  'won-revision': PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  'won revision': PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  wonRevision: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  wonrevision: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
});

export const HUMAN_FEEDBACK_PRODUCT_LINE_IDS = Object.freeze([
  PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
  ...Object.keys(PRODUCT_LINE_ALIASES)
    .filter((alias) => PRODUCT_LINE_ALIASES[alias] === PRODUCT_LINE_IDS.HUMAN_FEEDBACK),
]);

const EXTERNAL_ACTION_ALIASES = Object.freeze({
  none: EXTERNAL_ACTIONS.NONE,
  provider_spend: EXTERNAL_ACTIONS.PROVIDER_SPEND,
  'provider-spend': EXTERNAL_ACTIONS.PROVIDER_SPEND,
  'provider spend': EXTERNAL_ACTIONS.PROVIDER_SPEND,
  model_spend: EXTERNAL_ACTIONS.MODEL_SPEND,
  'model-spend': EXTERNAL_ACTIONS.MODEL_SPEND,
  'model spend': EXTERNAL_ACTIONS.MODEL_SPEND,
  live_prepare: EXTERNAL_ACTIONS.LIVE_PREPARE,
  'live-prepare': EXTERNAL_ACTIONS.LIVE_PREPARE,
  'live prepare': EXTERNAL_ACTIONS.LIVE_PREPARE,
  prepare_only: EXTERNAL_ACTIONS.LIVE_PREPARE,
  'prepare-only': EXTERNAL_ACTIONS.LIVE_PREPARE,
  'prepare only': EXTERNAL_ACTIONS.LIVE_PREPARE,
  live_submit: EXTERNAL_ACTIONS.LIVE_SUBMIT,
  'live-submit': EXTERNAL_ACTIONS.LIVE_SUBMIT,
  'live submit': EXTERNAL_ACTIONS.LIVE_SUBMIT,
  liveSubmit: EXTERNAL_ACTIONS.LIVE_SUBMIT,
  livesubmit: EXTERNAL_ACTIONS.LIVE_SUBMIT,
  submit_live: EXTERNAL_ACTIONS.LIVE_SUBMIT,
  'submit-live': EXTERNAL_ACTIONS.LIVE_SUBMIT,
  'submit live': EXTERNAL_ACTIONS.LIVE_SUBMIT,
  submit: EXTERNAL_ACTIONS.LIVE_SUBMIT,
  bid_submit_live: EXTERNAL_ACTIONS.LIVE_SUBMIT,
  'bid-submit-live': EXTERNAL_ACTIONS.LIVE_SUBMIT,
  'bid submit live': EXTERNAL_ACTIONS.LIVE_SUBMIT,
  bidSubmitLive: EXTERNAL_ACTIONS.LIVE_SUBMIT,
  bidsubmitlive: EXTERNAL_ACTIONS.LIVE_SUBMIT,
  'epwk.bidsubmitlive': EXTERNAL_ACTIONS.LIVE_SUBMIT,
  'epwk.bidSubmitLive': EXTERNAL_ACTIONS.LIVE_SUBMIT,
  work_modify_live: EXTERNAL_ACTIONS.LIVE_SUBMIT,
  'work-modify-live': EXTERNAL_ACTIONS.LIVE_SUBMIT,
  'work modify live': EXTERNAL_ACTIONS.LIVE_SUBMIT,
  workModifyLive: EXTERNAL_ACTIONS.LIVE_SUBMIT,
  workmodifylive: EXTERNAL_ACTIONS.LIVE_SUBMIT,
  'epwk.workmodifylive': EXTERNAL_ACTIONS.LIVE_SUBMIT,
  'epwk.workModifyLive': EXTERNAL_ACTIONS.LIVE_SUBMIT,
  submitLive: EXTERNAL_ACTIONS.LIVE_SUBMIT,
  submitlive: EXTERNAL_ACTIONS.LIVE_SUBMIT,
  'epwk.submitlive': EXTERNAL_ACTIONS.LIVE_SUBMIT,
  'epwk.submitLive': EXTERNAL_ACTIONS.LIVE_SUBMIT,
  pitch_submit_live: EXTERNAL_ACTIONS.LIVE_SUBMIT,
  'pitch-submit-live': EXTERNAL_ACTIONS.LIVE_SUBMIT,
  'pitch submit live': EXTERNAL_ACTIONS.LIVE_SUBMIT,
  pitchSubmitLive: EXTERNAL_ACTIONS.LIVE_SUBMIT,
  pitchsubmitlive: EXTERNAL_ACTIONS.LIVE_SUBMIT,
  'zbj.pitchsubmitlive': EXTERNAL_ACTIONS.LIVE_SUBMIT,
  'zbj.pitchSubmitLive': EXTERNAL_ACTIONS.LIVE_SUBMIT,
  acceptance_apply: EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
  'acceptance-apply': EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
  'acceptance apply': EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
  acceptanceApply: EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
  acceptanceapply: EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
  acceptance_apply_live: EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
  'acceptance-apply-live': EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
  'acceptance apply live': EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
  acceptanceApplyLive: EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
  acceptanceapplylive: EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
  'zbj.acceptanceapplylive': EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
  'zbj.acceptanceApplyLive': EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
  'epwk.acceptanceapplylive': EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
  'epwk.acceptanceApplyLive': EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
  customer_message: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  'customer-message': EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  'customer message': EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  customerMessage: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  customermessage: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  customer_message_preview: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  'customer-message-preview': EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  'customer message preview': EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  customerMessagePreview: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  customermessagepreview: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  'zbj.customermessagepreview': EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  'zbj.customerMessagePreview': EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  customer_message_live: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  'customer-message-live': EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  'customer message live': EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  customerMessageLive: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  customermessagelive: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  'epwk.customermessagelive': EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  'epwk.customerMessageLive': EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  human_feedback_message: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  'human-feedback-message': EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  'human feedback message': EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  humanFeedbackMessage: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  humanfeedbackmessage: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  consumer_feedback_message: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  'consumer-feedback-message': EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  'consumer feedback message': EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  consumerFeedbackMessage: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  consumerfeedbackmessage: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  buyer_feedback_message: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  'buyer-feedback-message': EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  'buyer feedback message': EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  buyerFeedbackMessage: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  buyerfeedbackmessage: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  im_send: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  'im-send': EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  'im send': EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  message: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
});

export const HUMAN_FEEDBACK_CUSTOMER_FACING_ACTION_IDS = Object.freeze([...new Set([
  EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  EXTERNAL_ACTIONS.LIVE_SUBMIT,
  EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
  ...Object.keys(EXTERNAL_ACTION_ALIASES)
    .filter((alias) => HUMAN_FEEDBACK_CUSTOMER_FACING_ACTIONS.has(EXTERNAL_ACTION_ALIASES[alias])),
])]);

export const CUSTOMER_MESSAGE_ACTION_IDS = Object.freeze([
  EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  ...Object.keys(EXTERNAL_ACTION_ALIASES)
    .filter((alias) => EXTERNAL_ACTION_ALIASES[alias] === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE),
]);

export const HUMAN_FEEDBACK_MESSAGE_ACTION_IDS = Object.freeze([
  'human_feedback_message',
  'human-feedback-message',
  'human feedback message',
  'humanFeedbackMessage',
  'humanfeedbackmessage',
  'consumer_feedback_message',
  'consumer-feedback-message',
  'consumer feedback message',
  'consumerFeedbackMessage',
  'consumerfeedbackmessage',
  'buyer_feedback_message',
  'buyer-feedback-message',
  'buyer feedback message',
  'buyerFeedbackMessage',
  'buyerfeedbackmessage',
]);

const HUMAN_FEEDBACK_MESSAGE_ACTION_ALIASES = new Set(HUMAN_FEEDBACK_MESSAGE_ACTION_IDS);

const HUMAN_FEEDBACK_PACKAGE_ROLE_ALIASES = Object.freeze({
  human_feedback: 'human_feedback_revision',
  'human-feedback': 'human_feedback_revision',
  'human feedback': 'human_feedback_revision',
  humanFeedback: 'human_feedback_revision',
  humanfeedback: 'human_feedback_revision',
  consumer_feedback: 'human_feedback_revision',
  'consumer-feedback': 'human_feedback_revision',
  'consumer feedback': 'human_feedback_revision',
  consumerFeedback: 'human_feedback_revision',
  consumerfeedback: 'human_feedback_revision',
  buyer_feedback: 'human_feedback_revision',
  'buyer-feedback': 'human_feedback_revision',
  'buyer feedback': 'human_feedback_revision',
  buyerFeedback: 'human_feedback_revision',
  buyerfeedback: 'human_feedback_revision',
  human_feedback_revision: 'human_feedback_revision',
  'human-feedback-revision': 'human_feedback_revision',
  'human feedback revision': 'human_feedback_revision',
  humanFeedbackRevision: 'human_feedback_revision',
  humanfeedbackrevision: 'human_feedback_revision',
  feedback_revision: 'human_feedback_revision',
  'feedback-revision': 'human_feedback_revision',
  'feedback revision': 'human_feedback_revision',
  feedbackRevision: 'human_feedback_revision',
  feedbackrevision: 'human_feedback_revision',
  post_submission_revision: 'human_feedback_revision',
  'post-submission-revision': 'human_feedback_revision',
  'post submission revision': 'human_feedback_revision',
  postSubmissionRevision: 'human_feedback_revision',
  postsubmissionrevision: 'human_feedback_revision',
  post_submission: 'human_feedback_revision',
  'post-submission': 'human_feedback_revision',
  'post submission': 'human_feedback_revision',
  postSubmission: 'human_feedback_revision',
  postsubmission: 'human_feedback_revision',
  post_win: 'human_feedback_revision',
  'post-win': 'human_feedback_revision',
  'post win': 'human_feedback_revision',
  postWin: 'human_feedback_revision',
  postwin: 'human_feedback_revision',
  shortlisted_revision: 'human_feedback_revision',
  'shortlisted-revision': 'human_feedback_revision',
  'shortlisted revision': 'human_feedback_revision',
  shortlistedRevision: 'human_feedback_revision',
  shortlistedrevision: 'human_feedback_revision',
  won_revision: 'human_feedback_revision',
  'won-revision': 'human_feedback_revision',
  'won revision': 'human_feedback_revision',
  wonRevision: 'human_feedback_revision',
  wonrevision: 'human_feedback_revision',
  human_feedback_review: 'human_feedback_review',
  'human-feedback-review': 'human_feedback_review',
  'human feedback review': 'human_feedback_review',
  humanFeedbackReview: 'human_feedback_review',
  humanfeedbackreview: 'human_feedback_review',
  human_feedback_referee: 'human_feedback_referee',
  'human-feedback-referee': 'human_feedback_referee',
  'human feedback referee': 'human_feedback_referee',
  humanFeedbackReferee: 'human_feedback_referee',
  humanfeedbackreferee: 'human_feedback_referee',
});

export const HUMAN_FEEDBACK_PACKAGE_ROLE_IDS = Object.freeze([
  ...new Set([
    'human_feedback_revision',
    'human_feedback_review',
    'human_feedback_referee',
    ...Object.keys(HUMAN_FEEDBACK_PACKAGE_ROLE_ALIASES),
  ]),
]);

export const HUMAN_FEEDBACK_WORKFLOW_IDS = Object.freeze([
  ...new Set([
    ...HUMAN_FEEDBACK_PRODUCT_LINE_IDS,
    ...HUMAN_FEEDBACK_PACKAGE_ROLE_IDS,
  ]),
]);

export function canonicalProductLineId(value) {
  return lookupCanonicalAlias(PRODUCT_LINE_ALIASES, value, new Set(Object.values(PRODUCT_LINE_IDS)));
}

export function canonicalPackageRole(value) {
  return lookupCanonicalAlias(HUMAN_FEEDBACK_PACKAGE_ROLE_ALIASES, value);
}

export function isHumanFeedbackIdentityValue(value) {
  return canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
    || canonicalProductLineId(canonicalPackageRole(value)) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK;
}

export function canonicalExternalAction(value) {
  const action = normalizeText(value);
  if (!action) return EXTERNAL_ACTIONS.NONE;
  return lookupCanonicalAlias(EXTERNAL_ACTION_ALIASES, action, new Set(Object.values(EXTERNAL_ACTIONS)));
}

export function canonicalExternalActionOrNull(value) {
  const action = canonicalExternalAction(value);
  return action === EXTERNAL_ACTIONS.NONE ? null : action;
}

export function canonicalProductLineIdOrNull(value) {
  return canonicalProductLineId(value || '') || null;
}

export function isHumanFeedbackMessageActionAlias(value) {
  return aliasLookupCandidates(value).some((action) => HUMAN_FEEDBACK_MESSAGE_ACTION_ALIASES.has(action));
}

export function isHumanFeedbackCustomerFacingAction(value) {
  return HUMAN_FEEDBACK_CUSTOMER_FACING_ACTIONS.has(canonicalExternalAction(value || EXTERNAL_ACTIONS.NONE));
}

function canonicalWorkflowId(value) {
  const id = normalizeText(value);
  const canonical = canonicalProductLineId(id);
  return Object.values(PRODUCT_LINE_IDS).includes(canonical) ? canonical : id;
}

export function uniqueStrings(values = [], limit = 32) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function nowIso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function normalizedId(value, fallback) {
  const text = normalizeText(value);
  return text || fallback;
}

function normalizeEvidenceRefs(values = []) {
  return (values || []).map((item) => {
    if (typeof item === 'string') return { kind: 'path', ref: item };
    return {
      kind: item?.kind || 'path',
      ref: normalizeText(item?.ref || item?.path || item?.url || item?.id || ''),
      hash: normalizeText(item?.hash || '') || null,
      notes: normalizeText(item?.notes || '') || null,
    };
  }).filter((item) => item.ref);
}

export function channelCapabilities(channelId) {
  return CHANNEL_CAPABILITIES[channelId] || CHANNEL_CAPABILITIES[CHANNEL_IDS.MANUAL];
}

export function createChannelTask({
  channelId,
  externalId,
  title = null,
  status = null,
  url = null,
  budget = null,
  deadline = null,
  rawCategory = null,
  accountProfile = null,
  sourceSnapshot = null,
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  if (!channelId) throw new Error('ChannelTask requires channelId');
  if (!externalId) throw new Error('ChannelTask requires externalId');
  return {
    version: DESIGN_PRODUCTION_CORE_VERSION,
    kind: 'ChannelTask',
    channelId,
    externalId: normalizeText(externalId),
    taskKey: `${channelId}:${normalizeText(externalId)}`,
    title: normalizeText(title) || null,
    status: normalizeText(status) || null,
    url: normalizeText(url) || null,
    budget,
    deadline: normalizeText(deadline) || null,
    rawCategory: normalizeText(rawCategory) || null,
    accountProfile: normalizeText(accountProfile) || null,
    sourceSnapshot: sourceSnapshot || null,
    channelCapabilities: channelCapabilities(channelId),
    evidenceRefs: normalizeEvidenceRefs(evidenceRefs),
    createdAt: createdAt || nowIso(),
  };
}

export function createCreativeBrief({
  channelTask,
  productLineId,
  requirementText,
  subject = {},
  industrySpec = null,
  attachmentRefs = [],
  buyerConstraints = [],
  referencePolicy = null,
  semanticContract = null,
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  if (!channelTask?.taskKey) throw new Error('CreativeBrief requires channelTask');
  if (!productLineId) throw new Error('CreativeBrief requires productLineId');
  if (!requirementText) throw new Error('CreativeBrief requires requirementText');
  return {
    version: DESIGN_PRODUCTION_CORE_VERSION,
    kind: 'CreativeBrief',
    taskKey: channelTask.taskKey,
    channelId: channelTask.channelId,
    externalId: channelTask.externalId,
    productLineId: canonicalProductLineId(productLineId),
    title: channelTask.title,
    requirementText: normalizeText(requirementText),
    subject: {
      projectText: normalizeText(subject.projectText || channelTask.title || '') || null,
      brandText: normalizeText(subject.brandText || '') || null,
      productText: normalizeText(subject.productText || '') || null,
      mustUseText: uniqueStrings(subject.mustUseText || [], 24),
      forbiddenText: uniqueStrings(subject.forbiddenText || [], 24),
    },
    industrySpec,
    attachmentRefs: normalizeEvidenceRefs(attachmentRefs),
    buyerConstraints: uniqueStrings(buyerConstraints, 32),
    referencePolicy: referencePolicy || {
      use: 'structure_and_design_grammar_only',
      digestOnly: true,
      mustNotCopy: ['third-party marks', 'exact layouts', 'proprietary fonts', 'official trade dress'],
    },
    semanticContract,
    evidenceRefs: normalizeEvidenceRefs(evidenceRefs),
    createdAt: createdAt || nowIso(),
  };
}

export function createProductionPlanEnvelope({
  brief,
  workflowId,
  outputMode,
  artifactCount = null,
  workflowProfile = null,
  humanFeedbackRevisionContract = null,
  designReferenceSpec = null,
  liveRules = null,
  providerPolicy = null,
  qualityGates = [],
  externalActionPolicy = {},
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  if (!brief?.taskKey) throw new Error('ProductionPlanEnvelope requires brief');
  if (!workflowId) throw new Error('ProductionPlanEnvelope requires workflowId');
  if (!outputMode) throw new Error('ProductionPlanEnvelope requires outputMode');
  return {
    version: DESIGN_PRODUCTION_CORE_VERSION,
    kind: 'ProductionPlanEnvelope',
    taskKey: brief.taskKey,
    channelId: brief.channelId,
    externalId: brief.externalId,
    productLineId: brief.productLineId,
    workflowId: canonicalWorkflowId(workflowId),
    outputMode,
    artifactCount: Number.isFinite(Number(artifactCount)) ? Number(artifactCount) : null,
    workflowProfile,
    humanFeedbackRevisionContract,
    designReferenceSpec,
    liveRules,
    providerPolicy: providerPolicy || {
      provider: 'auto',
      spendRequiresApproval: true,
      modelCacheAllowed: true,
    },
    qualityGates: uniqueStrings(qualityGates, 32),
    externalActionPolicy: {
      providerSpendRequiresApproval: externalActionPolicy.providerSpendRequiresApproval !== false,
      modelSpendRequiresApproval: externalActionPolicy.modelSpendRequiresApproval !== false,
      prepareRequiresApproval: externalActionPolicy.prepareRequiresApproval !== false,
      submitRequiresApproval: externalActionPolicy.submitRequiresApproval !== false,
      messageRequiresApproval: externalActionPolicy.messageRequiresApproval !== false,
      acceptanceRequiresApproval: externalActionPolicy.acceptanceRequiresApproval !== false,
    },
    evidenceRefs: normalizeEvidenceRefs(evidenceRefs),
    createdAt: createdAt || nowIso(),
  };
}

export function createArtifactPackage({
  plan,
  artifacts = [],
  packageRole = 'submit_candidate',
  submitReady = false,
  humanFeedbackRevisionContract = null,
  provenance = null,
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  if (!plan?.taskKey) throw new Error('ArtifactPackage requires plan');
  const normalizedPackageRole = canonicalPackageRole(packageRole);
  return {
    version: DESIGN_PRODUCTION_CORE_VERSION,
    kind: 'ArtifactPackage',
    taskKey: plan.taskKey,
    channelId: plan.channelId,
    externalId: plan.externalId || null,
    productLineId: plan.productLineId,
    workflowId: plan.workflowId,
    packageRole: normalizedPackageRole,
    outputMode: plan.outputMode,
    humanFeedbackRevisionContract: humanFeedbackRevisionContract || plan.humanFeedbackRevisionContract || null,
    artifactCount: artifacts.length,
    artifacts: artifacts.map((artifact, index) => ({
      id: normalizedId(artifact.id, `${plan.taskKey}:artifact:${index + 1}`),
      role: normalizeText(artifact.role || 'artifact'),
      filename: normalizeText(artifact.filename || artifact.name || ''),
      path: normalizeText(artifact.path || '') || null,
      mimeType: normalizeText(artifact.mimeType || '') || null,
      sizeBytes: Number.isFinite(Number(artifact.sizeBytes)) ? Number(artifact.sizeBytes) : null,
      hash: normalizeText(artifact.hash || '') || null,
      sourceRequestId: normalizeText(artifact.sourceRequestId || '') || null,
    })).filter((artifact) => artifact.filename || artifact.path),
    submitReady: Boolean(submitReady),
    provenance: provenance || {
      providerId: null,
      manualProvider: false,
      generatedByCore: false,
    },
    evidenceRefs: normalizeEvidenceRefs(evidenceRefs),
    createdAt: createdAt || nowIso(),
  };
}

export function createReviewReport({
  artifactPackage,
  decision,
  reviewer = 'core',
  checks = [],
  blockers = [],
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  if (!artifactPackage?.taskKey) throw new Error('ReviewReport requires artifactPackage');
  if (!decision) throw new Error('ReviewReport requires decision');
  return {
    version: DESIGN_PRODUCTION_CORE_VERSION,
    kind: 'ReviewReport',
    taskKey: artifactPackage.taskKey,
    channelId: artifactPackage.channelId,
    externalId: artifactPackage.externalId || null,
    productLineId: artifactPackage.productLineId,
    workflowId: artifactPackage.workflowId,
    packageRole: artifactPackage.packageRole,
    humanFeedbackRevisionContract: artifactPackage.humanFeedbackRevisionContract || null,
    artifactHashes: artifactPackage.artifacts.map((artifact) => ({
      filename: artifact.filename,
      hash: artifact.hash || null,
      sizeBytes: artifact.sizeBytes,
    })),
    decision,
    reviewer,
    ok: decision === 'pass',
    checks: (checks || []).map((check) => ({
      id: normalizeText(check.id || check.name || 'check'),
      status: normalizeText(check.status || check.decision || ''),
      severity: normalizeText(check.severity || '') || null,
      notes: normalizeText(check.notes || '') || null,
    })),
    blockers: uniqueStrings(blockers, 32),
    evidenceRefs: normalizeEvidenceRefs(evidenceRefs),
    createdAt: createdAt || nowIso(),
  };
}

export function createChannelSubmission({
  channelTask,
  artifactPackage,
  reviewReport,
  action = EXTERNAL_ACTIONS.NONE,
  mode = null,
  status = 'planned',
  approval = null,
  prepareEvidence = null,
  externalResult = null,
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  if (!channelTask?.taskKey) throw new Error('ChannelSubmission requires channelTask');
  if (!artifactPackage?.taskKey) throw new Error('ChannelSubmission requires artifactPackage');
  if (channelTask.taskKey !== artifactPackage.taskKey) throw new Error('ChannelSubmission taskKey mismatch');
  if (reviewReport && reviewReport.taskKey !== artifactPackage.taskKey) throw new Error('ChannelSubmission reviewReport taskKey mismatch');
  const normalizedAction = canonicalExternalAction(action);
  return {
    version: DESIGN_PRODUCTION_CORE_VERSION,
    kind: 'ChannelSubmission',
    taskKey: channelTask.taskKey,
    channelId: channelTask.channelId,
    externalId: channelTask.externalId,
    action: normalizedAction,
    mode,
    status,
    requiresApproval: normalizedAction !== EXTERNAL_ACTIONS.NONE,
    approval,
    prepareEvidence,
    artifactPackage: {
      packageRole: artifactPackage.packageRole,
      outputMode: artifactPackage.outputMode,
      submitReady: artifactPackage.submitReady,
      artifactCount: artifactPackage.artifactCount,
      artifacts: artifactPackage.artifacts.map((artifact) => ({
        filename: artifact.filename,
        hash: artifact.hash,
        sizeBytes: artifact.sizeBytes,
      })),
    },
    review: reviewReport
      ? {
        decision: reviewReport.decision,
        ok: reviewReport.ok,
        blockerCount: reviewReport.blockers.length,
      }
      : null,
    externalResult,
    evidenceRefs: normalizeEvidenceRefs(evidenceRefs),
    createdAt: createdAt || nowIso(),
  };
}

function humanFeedbackContractHash(record = {}) {
  return normalizeText(
    record?.humanFeedbackRevisionContract?.contractHash
      || record?.feedbackRevisionContract?.contractHash
      || record?.humanFeedbackContract?.contractHash
      || '',
  );
}

function humanFeedbackContractFor(record = {}) {
  return record?.humanFeedbackRevisionContract
    || record?.feedbackRevisionContract
    || record?.humanFeedbackContract
    || null;
}

function humanFeedbackEmbeddedContractBindingHashInput(contract = {}) {
  if (!contract || typeof contract !== 'object') return null;
  return {
    activeAtomicChange: contract.activeAtomicChange
      ? {
        id: normalizeText(contract.activeAtomicChange.id || ''),
        description: normalizeText(contract.activeAtomicChange.description || '') || null,
      }
      : null,
    targetArtifact: contract.targetArtifact || null,
  };
}

function humanFeedbackReviewGateHashInput(reviewGate) {
  if (!reviewGate || typeof reviewGate !== 'object') return reviewGate || null;
  const {
    humanFeedbackRevisionContractHash: _humanFeedbackRevisionContractHash,
    contractHash: _contractHash,
    humanFeedbackRevisionContract,
    ...input
  } = reviewGate;
  const hashInput = { ...input };
  for (const field of ['reviewType', 'packageRole', 'role']) {
    if (Object.hasOwn(hashInput, field)) hashInput[field] = canonicalPackageRole(hashInput[field]);
  }
  return {
    ...hashInput,
    humanFeedbackRevisionContractBinding: humanFeedbackEmbeddedContractBindingHashInput(humanFeedbackRevisionContract),
  };
}

function humanFeedbackContractHashInput(contract = {}) {
  if (!contract || typeof contract !== 'object') return {};
  const { contractHash: _contractHash, hash: _hash, reviewGate, ...input } = contract;
  const hashInput = { ...input };
  if (Object.hasOwn(hashInput, 'productLineId')) {
    hashInput.productLineId = canonicalProductLineId(hashInput.productLineId);
  }
  if (Object.hasOwn(hashInput, 'workflowId')) {
    hashInput.workflowId = canonicalProductLineId(hashInput.workflowId);
  }
  if (Object.hasOwn(hashInput, 'exitAction')) {
    hashInput.exitAction = canonicalExternalAction(hashInput.exitAction);
  }
  return {
    ...hashInput,
    reviewGate: humanFeedbackReviewGateHashInput(reviewGate),
  };
}

export function computeHumanFeedbackRevisionContractHash(contract = {}) {
  return digest(humanFeedbackContractHashInput(contract));
}

function hasHumanFeedbackContract(record = {}) {
  return Boolean(
    record?.humanFeedbackRevisionContract
      || record?.feedbackRevisionContract
      || record?.humanFeedbackContract,
  );
}

function isHumanFeedbackSignal(value) {
  return canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
    || canonicalProductLineId(canonicalPackageRole(value)) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK;
}

function packageArtifactName(artifact = {}) {
  return normalizeText(artifact.filename || artifact.path || artifact.id || '');
}

function sameNameSet(left = [], right = []) {
  if (left.length !== right.length) return false;
  const remaining = new Map();
  for (const name of left) remaining.set(name, (remaining.get(name) || 0) + 1);
  for (const name of right) {
    const count = remaining.get(name) || 0;
    if (!count) return false;
    if (count === 1) remaining.delete(name);
    else remaining.set(name, count - 1);
  }
  return remaining.size === 0;
}

function artifactReviewMatchesPackage(reviewReport, artifactPackage) {
  const packageArtifacts = artifactPackage?.artifacts || [];
  const reviewedArtifacts = reviewReport?.artifactHashes || [];
  if (!packageArtifacts.length || !reviewedArtifacts.length) return false;
  const packageNames = packageArtifacts.map(packageArtifactName).filter(Boolean);
  const reviewedNames = reviewedArtifacts.map(packageArtifactName).filter(Boolean);
  if (!sameNameSet(packageNames, reviewedNames)) return false;
  const reviewedByName = new Map(reviewedArtifacts.map((artifact) => [packageArtifactName(artifact), artifact]));
  for (const current of packageArtifacts) {
    const name = packageArtifactName(current);
    const reviewed = reviewedByName.get(name);
    if (!name || !reviewed) return false;
    if (!isSha256Hash(current.hash) || !isSha256Hash(reviewed.hash)) return false;
    if (current.hash !== reviewed.hash) return false;
    if (
      Number.isFinite(Number(current.sizeBytes))
      && Number.isFinite(Number(reviewed.sizeBytes))
      && Number(current.sizeBytes) !== Number(reviewed.sizeBytes)
    ) {
      return false;
    }
  }
  return true;
}

function workflowChainHumanFeedbackContractIntegrityIssues(record, label) {
  const contract = humanFeedbackContractFor(record);
  if (!contract) return [];
  const prefix = `human_feedback_${label}_contract_hash`;
  const issues = [];
  const contractHash = normalizeText(contract.contractHash || '');
  if (!contractHash) {
    issues.push({ level: 'error', code: `${prefix}_required` });
  } else if (!isSha256Hash(contractHash)) {
    issues.push({ level: 'error', code: `${prefix}_invalid` });
  } else if (computeHumanFeedbackRevisionContractHash(contract) !== contractHash) {
    issues.push({ level: 'error', code: `${prefix}_content_mismatch` });
  }
  const embeddedReviewGateContractHash = normalizeText(contract.reviewGate?.humanFeedbackRevisionContract?.contractHash || '');
  if (embeddedReviewGateContractHash && contractHash && embeddedReviewGateContractHash !== contractHash) {
    issues.push({
      level: 'error',
      code: `human_feedback_${label}_contract_review_gate_contract_hash_mismatch`,
      expected: contractHash,
      actual: embeddedReviewGateContractHash,
    });
  }
  return issues;
}

function workflowChainHumanFeedbackIssues({ brief, plan, artifactPackage, reviewReport } = {}) {
  const issues = [];
  const isFeedback = [
    brief?.productLineId,
    plan?.productLineId,
    artifactPackage?.productLineId,
    reviewReport?.productLineId,
    plan?.workflowId,
    artifactPackage?.workflowId,
    reviewReport?.workflowId,
    artifactPackage?.packageRole,
    reviewReport?.packageRole,
  ].some((value) => isHumanFeedbackSignal(value))
    || [plan, artifactPackage, reviewReport].some((record) => hasHumanFeedbackContract(record));
  if (!isFeedback) return issues;
  const planHash = humanFeedbackContractHash(plan);
  const packageHash = humanFeedbackContractHash(artifactPackage);
  const reviewHash = humanFeedbackContractHash(reviewReport);
  if (!planHash) issues.push({ level: 'error', code: 'human_feedback_plan_contract_required' });
  if (artifactPackage && !packageHash) issues.push({ level: 'error', code: 'human_feedback_package_contract_required' });
  if (artifactPackage && !reviewReport) issues.push({ level: 'error', code: 'human_feedback_review_report_required' });
  if (reviewReport && !reviewHash) issues.push({ level: 'error', code: 'human_feedback_review_contract_required' });
  issues.push(...workflowChainHumanFeedbackContractIntegrityIssues(plan, 'plan'));
  issues.push(...workflowChainHumanFeedbackContractIntegrityIssues(artifactPackage, 'package'));
  issues.push(...workflowChainHumanFeedbackContractIntegrityIssues(reviewReport, 'review'));
  if (planHash && packageHash && planHash !== packageHash) {
    issues.push({ level: 'error', code: 'human_feedback_package_contract_hash_mismatch', expected: planHash, actual: packageHash });
  }
  if (planHash && reviewHash && planHash !== reviewHash) {
    issues.push({ level: 'error', code: 'human_feedback_review_contract_hash_mismatch', expected: planHash, actual: reviewHash });
  }
  if (reviewReport && artifactPackage && !artifactReviewMatchesPackage(reviewReport, artifactPackage)) {
    issues.push({ level: 'error', code: 'human_feedback_review_artifact_mismatch' });
  }
  if (reviewReport && artifactPackage) {
    const packageArtifacts = artifactPackage.artifacts || [];
    const reviewedArtifacts = reviewReport.artifactHashes || [];
    if (!packageArtifacts.length || !reviewedArtifacts.length) {
      issues.push({ level: 'error', code: 'human_feedback_review_artifact_hash_required' });
    } else if (
      packageArtifacts.some((artifact) => !isSha256Hash(artifact.hash))
      || reviewedArtifacts.some((artifact) => !isSha256Hash(artifact.hash))
    ) {
      issues.push({ level: 'error', code: 'human_feedback_review_artifact_hash_invalid' });
    }
  }
  return issues;
}

export function validateWorkflowChain({ channelTask, brief, plan, artifactPackage, reviewReport, channelSubmission } = {}) {
  const issues = [];
  const taskKey = channelTask?.taskKey;
  if (!taskKey) issues.push({ level: 'error', code: 'missing_channel_task' });
  for (const [name, item] of Object.entries({ brief, plan, artifactPackage, reviewReport, channelSubmission })) {
    if (!item) continue;
    if (item.taskKey !== taskKey) issues.push({ level: 'error', code: `${name}_task_key_mismatch`, expected: taskKey, actual: item.taskKey });
  }
  if (
    brief
    && plan
    && canonicalProductLineId(brief.productLineId) !== canonicalProductLineId(plan.productLineId)
  ) {
    issues.push({ level: 'error', code: 'product_line_mismatch' });
  }
  if (plan && artifactPackage && plan.outputMode !== artifactPackage.outputMode) issues.push({ level: 'warning', code: 'output_mode_mismatch' });
  if (artifactPackage?.submitReady && reviewReport && reviewReport.decision !== 'pass') issues.push({ level: 'error', code: 'submit_ready_without_pass_review' });
  if (channelSubmission?.action && channelSubmission.action !== EXTERNAL_ACTIONS.NONE && !channelSubmission.approval) {
    issues.push({ level: 'error', code: 'external_action_missing_approval' });
  }
  issues.push(...workflowChainHumanFeedbackIssues({ brief, plan, artifactPackage, reviewReport }));
  return {
    ok: !issues.some((issue) => issue.level === 'error'),
    issues,
  };
}

export function inferProductLineFromWorkflow(workflowId) {
  const id = normalizeText(workflowId);
  const canonical = canonicalProductLineId(id);
  if (Object.values(PRODUCT_LINE_IDS).includes(canonical)) return canonical;
  return PRODUCT_LINE_IDS.GENERIC_DESIGN;
}
