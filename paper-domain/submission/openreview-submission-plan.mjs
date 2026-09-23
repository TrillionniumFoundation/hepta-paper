import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const PLAN_KEYS = Object.freeze([
  'abstract', 'authorNames', 'authorProfiles', 'compiledPdfHash', 'content', 'idempotencyKey',
  'invitation', 'keywords', 'kind', 'requestHash', 'status', 'title',
  'venueId', 'version',
]);

function text(value, code, maximum) {
  const result = String(value || '').trim();
  if (!result || result.length > maximum) throw new Error(code);
  return result;
}

function uniqueTextArray(value, code, { minimum = 1, maximum = 64 } = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(code);
  }
  const result = value.map((entry) => text(entry, code, 512));
  if (new Set(result).size !== result.length) throw new Error(code);
  return Object.freeze(result);
}

function contentValue(value) {
  if (typeof value === 'string') {
    return text(value, 'openreview_content_value_invalid', 8_000);
  }
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return uniqueTextArray(
      value,
      'openreview_content_value_invalid',
      { minimum: 1, maximum: 256 },
    );
  }
  throw new Error('openreview_content_value_invalid');
}

export function buildOpenReviewSubmissionPlan({
  request,
  invitation,
  title,
  abstract,
  authorNames,
  authorProfiles,
  keywords,
  content = {},
} = {}) {
  if (request?.kind !== 'AutonomousSubmissionRequest'
    || !SHA256.test(String(request?.requestHash || ''))
    || !SHA256.test(String(request?.compiledPdfHash || ''))
    || !SHA256.test(String(request?.idempotencyKey || ''))
    || !ID.test(String(request?.venueId || ''))) {
    throw new Error('openreview_submission_request_invalid');
  }
  const selectedInvitation = text(invitation, 'openreview_invitation_invalid', 512);
  if (!selectedInvitation.includes('/-/')) throw new Error('openreview_invitation_invalid');
  const selectedAuthors = uniqueTextArray(
    authorProfiles, 'openreview_author_profiles_invalid', { maximum: 256 },
  );
  const selectedAuthorNames = uniqueTextArray(
    authorNames, 'openreview_author_names_invalid', { maximum: 256 },
  );
  if (selectedAuthorNames.length !== selectedAuthors.length) {
    throw new Error('openreview_author_identity_alignment_invalid');
  }
  if (selectedAuthors.some((profile) => !/^~[A-Za-z0-9][A-Za-z0-9_.-]*\d+$/.test(profile))) {
    throw new Error('openreview_author_profiles_invalid');
  }
  const extra = Object.freeze(Object.fromEntries(
    Object.entries(content || {}).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [
        text(key, 'openreview_content_key_invalid', 128),
        contentValue(value),
      ]),
  ));
  if (['title', 'abstract', 'authors', 'authorids', 'keywords', 'pdf']
    .some((key) => Object.hasOwn(extra, key))) {
    throw new Error('openreview_reserved_content_key_invalid');
  }
  const payload = {
    version: 1,
    kind: 'OpenReviewSubmissionPlan',
    status: 'openreview_submission_plan_ready',
    requestHash: request.requestHash,
    idempotencyKey: request.idempotencyKey,
    venueId: request.venueId,
    invitation: selectedInvitation,
    title: text(title, 'openreview_title_invalid', 1_000),
    abstract: text(abstract, 'openreview_abstract_invalid', 20_000),
    authorNames: selectedAuthorNames,
    authorProfiles: selectedAuthors,
    keywords: uniqueTextArray(keywords, 'openreview_keywords_invalid'),
    compiledPdfHash: request.compiledPdfHash,
    content: extra,
  };
  return Object.freeze({
    ...payload,
    openReviewSubmissionPlanHash: hashRecord('OpenReviewSubmissionPlan', payload),
  });
}

export function verifyOpenReviewSubmissionPlan(value, { request } = {}) {
  const { openReviewSubmissionPlanHash: claimedHash, ...payload } = value || {};
  if (!hasExactObjectKeys(payload, PLAN_KEYS)
    || !SHA256.test(String(claimedHash || ''))
    || claimedHash !== hashRecord('OpenReviewSubmissionPlan', payload)
    || payload.requestHash !== request?.requestHash
    || payload.idempotencyKey !== request?.idempotencyKey
    || payload.compiledPdfHash !== request?.compiledPdfHash
    || payload.venueId !== request?.venueId) return false;
  try {
    return JSON.stringify(buildOpenReviewSubmissionPlan({
      request,
      invitation: payload.invitation,
      title: payload.title,
      abstract: payload.abstract,
      authorNames: payload.authorNames,
      authorProfiles: payload.authorProfiles,
      keywords: payload.keywords,
      content: payload.content,
    })) === JSON.stringify(value);
  } catch { return false; }
}

export function openReviewNoteEditFromPlan(plan, {
  pdfUrl,
  allowedContentFields = null,
  includeHeptaMetadata = true,
} = {}) {
  if (!SHA256.test(String(plan?.openReviewSubmissionPlanHash || ''))) {
    throw new Error('openreview_submission_plan_invalid');
  }
  const selectedPdfUrl = text(pdfUrl, 'openreview_pdf_url_invalid', 2_048);
  if (!/^https:\/\/[^?#]+(?:[?#].*)?$/.test(selectedPdfUrl)) {
    throw new Error('openreview_pdf_url_invalid');
  }
  const baseContent = {
    title: Object.freeze({ value: plan.title }),
    abstract: Object.freeze({ value: plan.abstract }),
    authors: Object.freeze({ value: [...plan.authorNames] }),
    authorids: Object.freeze({ value: [...plan.authorProfiles] }),
    keywords: Object.freeze({ value: [...plan.keywords] }),
    pdf: Object.freeze({ value: selectedPdfUrl }),
    ...Object.fromEntries(Object.entries(plan.content)
      .map(([key, value]) => [key, Object.freeze({
        value: Array.isArray(value) ? [...value] : value,
      })])),
    ...(includeHeptaMetadata ? {
      hepta_submission_idempotency_key:
        Object.freeze({ value: plan.idempotencyKey }),
      hepta_submission_plan_hash:
        Object.freeze({ value: plan.openReviewSubmissionPlanHash }),
    } : {}),
  };
  if (allowedContentFields !== null) {
    const allowed = new Set(allowedContentFields);
    const unexpected = Object.keys(baseContent).filter((key) => !allowed.has(key));
    if (unexpected.length) {
      throw new Error(`openreview_invitation_field_not_declared:${unexpected.sort().join(',')}`);
    }
  }
  return Object.freeze({
    invitation: plan.invitation,
    signatures: plan.authorProfiles,
    readers: Object.freeze([...plan.authorProfiles]),
    writers: Object.freeze([...plan.authorProfiles]),
    content: Object.freeze(baseContent),
  });
}
