import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const ORCID = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;
const EMAIL_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const COUNTRY = /^[A-Z]{2}$/;
const FILE_ROLES = new Set([
  'manuscript', 'title_page', 'cover_letter', 'figure', 'table', 'supplement',
  'source', 'reporting_checklist', 'response_to_reviewers', 'other',
]);
const DECLARATION_VALUES = new Set(['yes', 'no', 'not_applicable', 'unknown']);
const ANSWER_STATUSES = new Set(['answered', 'unknown']);
const ANSWER_VALUE_TYPES = new Set([
  'boolean', 'file_reference', 'string', 'string_array',
]);
const ENVELOPE_KEYS = Object.freeze([
  'abstract',
  'articleType',
  'assetManifestHash',
  'authors',
  'campaignId',
  'compiledPdfHash',
  'createdAt',
  'declarations',
  'dynamicAnswers',
  'files',
  'kind',
  'keywords',
  'metadataHash',
  'paperId',
  'portalBindingHash',
  'requestHash',
  'reviewerPreferences',
  'status',
  'title',
  'unknownDeclarationIds',
  'unknownDynamicFieldIds',
  'venueId',
  'version',
]);
const AUTHOR_KEYS = Object.freeze([
  'affiliations', 'authorId', 'correspondingAuthor', 'creditRoles',
  'displayName', 'emailReference', 'familyName', 'givenName', 'orcid',
  'submittingAuthor',
]);
const AFFILIATION_KEYS = Object.freeze([
  'affiliationId', 'countryCode', 'displayName', 'ringgoldId', 'rorId',
]);
const FILE_KEYS = Object.freeze([
  'fileId', 'filename', 'mimeType', 'order', 'role', 'sha256', 'sizeBytes',
]);
const DECLARATION_KEYS = Object.freeze([
  'declarationId', 'evidenceReference', 'statement', 'value',
]);
const REVIEWER_KEYS = Object.freeze([
  'disposition', 'rationale', 'reviewerIdentityReference',
]);
const DYNAMIC_ANSWER_KEYS = Object.freeze([
  'fieldId', 'schemaFingerprintHash', 'value', 'valueStatus', 'valueType',
]);

function id(value, code = 'submission_envelope_id_invalid') {
  const selected = String(value || '').trim();
  if (!SAFE_ID.test(selected)) throw new Error(code);
  return selected;
}

function text(value, code, maximum = 20_000) {
  const selected = String(value || '').normalize('NFKC').trim();
  if (!selected || selected.length > maximum) throw new Error(code);
  return selected;
}

function canonicalInstant(value) {
  const selected = String(value || '');
  const milliseconds = Date.parse(selected);
  if (!Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== selected) {
    throw new Error('submission_envelope_created_at_invalid');
  }
  return selected;
}

function uniqueTexts(values, code, { minimum = 1, maximum = 128 } = {}) {
  if (!Array.isArray(values) || values.length < minimum || values.length > maximum) {
    throw new Error(code);
  }
  const selected = values.map((value) => text(value, code, 1_000));
  if (new Set(selected).size !== selected.length) throw new Error(code);
  return Object.freeze(selected);
}

function affiliation(value) {
  if (!hasExactObjectKeys(value, AFFILIATION_KEYS)) {
    throw new Error('submission_envelope_affiliation_invalid');
  }
  const selected = {
    affiliationId: id(value.affiliationId, 'submission_envelope_affiliation_invalid'),
    displayName: text(
      value.displayName, 'submission_envelope_affiliation_invalid', 2_000,
    ),
    rorId: value.rorId === null ? null : String(value.rorId || '').trim(),
    ringgoldId: value.ringgoldId === null
      ? null : String(value.ringgoldId || '').trim(),
    countryCode: String(value.countryCode || '').trim().toUpperCase(),
  };
  if ((selected.rorId !== null
      && !/^https:\/\/ror\.org\/[0-9a-hj-km-np-tv-z]{9}$/.test(selected.rorId))
    || (selected.ringgoldId !== null
      && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(selected.ringgoldId))
    || !COUNTRY.test(selected.countryCode)) {
    throw new Error('submission_envelope_affiliation_invalid');
  }
  return Object.freeze(selected);
}

function author(value) {
  if (!hasExactObjectKeys(value, AUTHOR_KEYS)) {
    throw new Error('submission_envelope_author_invalid');
  }
  const affiliations = Array.isArray(value.affiliations)
    ? value.affiliations.map(affiliation) : [];
  if (!affiliations.length || affiliations.length > 32
    || new Set(affiliations.map((entry) => entry.affiliationId)).size
      !== affiliations.length) {
    throw new Error('submission_envelope_author_affiliations_invalid');
  }
  const selected = {
    authorId: id(value.authorId, 'submission_envelope_author_invalid'),
    givenName: text(value.givenName, 'submission_envelope_author_invalid', 500),
    familyName: text(value.familyName, 'submission_envelope_author_invalid', 500),
    displayName: text(value.displayName, 'submission_envelope_author_invalid', 1_000),
    emailReference: String(value.emailReference || '').trim(),
    orcid: value.orcid === null ? null : String(value.orcid || '').trim(),
    affiliations: Object.freeze(affiliations),
    creditRoles: uniqueTexts(
      value.creditRoles, 'submission_envelope_credit_roles_invalid',
      { maximum: 32 },
    ),
    correspondingAuthor: value.correspondingAuthor === true,
    submittingAuthor: value.submittingAuthor === true,
  };
  if (!EMAIL_REFERENCE.test(selected.emailReference)
    || (selected.orcid !== null && !ORCID.test(selected.orcid))) {
    throw new Error('submission_envelope_author_identity_invalid');
  }
  return Object.freeze(selected);
}

function file(value) {
  if (!hasExactObjectKeys(value, FILE_KEYS)
    || !FILE_ROLES.has(value.role)
    || !SHA256.test(String(value.sha256 || '').toLowerCase())
    || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1
    || !Number.isSafeInteger(value.order) || value.order < 1) {
    throw new Error('submission_envelope_file_invalid');
  }
  const filename = text(value.filename, 'submission_envelope_file_invalid', 512);
  if (filename.includes('/') || filename.includes('\\')
    || !/^[a-z0-9][a-z0-9.+-]+\/[a-z0-9][a-z0-9.+-]+$/i.test(value.mimeType)) {
    throw new Error('submission_envelope_file_invalid');
  }
  return Object.freeze({
    fileId: id(value.fileId, 'submission_envelope_file_invalid'),
    role: value.role,
    filename,
    mimeType: value.mimeType.toLowerCase(),
    sizeBytes: value.sizeBytes,
    sha256: value.sha256.toLowerCase(),
    order: value.order,
  });
}

function declaration(value) {
  if (!hasExactObjectKeys(value, DECLARATION_KEYS)
    || !DECLARATION_VALUES.has(value.value)) {
    throw new Error('submission_envelope_declaration_invalid');
  }
  return Object.freeze({
    declarationId: id(
      value.declarationId, 'submission_envelope_declaration_invalid',
    ),
    statement: text(
      value.statement, 'submission_envelope_declaration_invalid', 8_000,
    ),
    value: value.value,
    evidenceReference: value.evidenceReference === null
      ? null
      : id(value.evidenceReference, 'submission_envelope_declaration_invalid'),
  });
}

function reviewerPreference(value) {
  if (!hasExactObjectKeys(value, REVIEWER_KEYS)
    || !['recommend', 'avoid'].includes(value.disposition)) {
    throw new Error('submission_envelope_reviewer_preference_invalid');
  }
  return Object.freeze({
    reviewerIdentityReference: id(
      value.reviewerIdentityReference,
      'submission_envelope_reviewer_preference_invalid',
    ),
    disposition: value.disposition,
    rationale: text(
      value.rationale, 'submission_envelope_reviewer_preference_invalid', 4_000,
    ),
  });
}

function answerValue(value, valueType) {
  if (valueType === 'string') {
    return text(value, 'submission_envelope_dynamic_answer_invalid', 20_000);
  }
  if (valueType === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new Error('submission_envelope_dynamic_answer_invalid');
    }
    return value;
  }
  if (valueType === 'string_array') {
    return uniqueTexts(
      value, 'submission_envelope_dynamic_answer_invalid', { maximum: 256 },
    );
  }
  if (valueType === 'file_reference') {
    return id(value, 'submission_envelope_dynamic_answer_invalid');
  }
  throw new Error('submission_envelope_dynamic_answer_invalid');
}

function dynamicAnswer(value) {
  if (!hasExactObjectKeys(value, DYNAMIC_ANSWER_KEYS)
    || !ANSWER_STATUSES.has(value.valueStatus)
    || !SHA256.test(String(value.schemaFingerprintHash || '').toLowerCase())) {
    throw new Error('submission_envelope_dynamic_answer_invalid');
  }
  const valueType = String(value.valueType || '');
  if (!ANSWER_VALUE_TYPES.has(valueType)) {
    throw new Error('submission_envelope_dynamic_answer_invalid');
  }
  return Object.freeze({
    fieldId: id(value.fieldId, 'submission_envelope_dynamic_answer_invalid'),
    schemaFingerprintHash: value.schemaFingerprintHash.toLowerCase(),
    valueType,
    valueStatus: value.valueStatus,
    value: value.valueStatus === 'unknown'
      ? null : answerValue(value.value, valueType),
  });
}

export function buildSubmissionEnvelope({
  campaignId,
  paperId,
  venueId,
  requestHash,
  portalBindingHash,
  compiledPdfHash,
  title,
  abstract,
  articleType,
  keywords,
  authors,
  declarations,
  reviewerPreferences = [],
  files,
  dynamicAnswers = [],
  createdAt,
} = {}) {
  if (![requestHash, portalBindingHash, compiledPdfHash]
    .every((value) => SHA256.test(String(value || '').toLowerCase()))) {
    throw new Error('submission_envelope_binding_hash_invalid');
  }
  const selectedAuthors = Array.isArray(authors) ? authors.map(author) : [];
  const selectedDeclarations = Array.isArray(declarations)
    ? declarations.map(declaration) : [];
  const selectedFiles = Array.isArray(files) ? files.map(file) : [];
  const selectedReviewers = Array.isArray(reviewerPreferences)
    ? reviewerPreferences.map(reviewerPreference) : [];
  const selectedAnswers = Array.isArray(dynamicAnswers)
    ? dynamicAnswers.map(dynamicAnswer) : [];
  if (!selectedAuthors.length || selectedAuthors.length > 512
    || selectedAuthors.filter((entry) => entry.correspondingAuthor).length !== 1
    || selectedAuthors.filter((entry) => entry.submittingAuthor).length !== 1
    || new Set(selectedAuthors.map((entry) => entry.authorId)).size
      !== selectedAuthors.length
    || !selectedDeclarations.length
    || new Set(selectedDeclarations.map((entry) => entry.declarationId)).size
      !== selectedDeclarations.length
    || !selectedFiles.length
    || new Set(selectedFiles.map((entry) => entry.fileId)).size !== selectedFiles.length
    || new Set(selectedFiles.map((entry) => entry.order)).size !== selectedFiles.length
    || new Set(selectedAnswers.map((entry) => entry.fieldId)).size
      !== selectedAnswers.length
    || selectedReviewers.some((entry, index) => (
      selectedReviewers.findIndex((candidate) => (
        candidate.reviewerIdentityReference === entry.reviewerIdentityReference
      )) !== index
    ))) {
    throw new Error('submission_envelope_collection_invalid');
  }
  const selectedCompiledPdfHash = compiledPdfHash.toLowerCase();
  if (!selectedFiles.some((entry) => (
    entry.role === 'manuscript' && entry.sha256 === selectedCompiledPdfHash
  ))) {
    throw new Error('submission_envelope_compiled_pdf_not_in_manifest');
  }
  const sortedFiles = Object.freeze([...selectedFiles].sort((left, right) => (
    left.order - right.order || left.fileId.localeCompare(right.fileId)
  )));
  const selectedKeywords = uniqueTexts(
    keywords, 'submission_envelope_keywords_invalid', { maximum: 64 },
  );
  const selectedTitle = text(title, 'submission_envelope_title_invalid', 2_000);
  const selectedAbstract = text(
    abstract, 'submission_envelope_abstract_invalid', 40_000,
  );
  const selectedArticleType = id(
    articleType, 'submission_envelope_article_type_invalid',
  );
  const metadata = {
    title: selectedTitle,
    abstract: selectedAbstract,
    articleType: selectedArticleType,
    keywords: selectedKeywords,
    authors: selectedAuthors,
    declarations: selectedDeclarations,
    reviewerPreferences: selectedReviewers,
    dynamicAnswers: selectedAnswers,
  };
  const payload = {
    version: 1,
    kind: 'CanonicalSubmissionEnvelope',
    status: 'submission_envelope_preflight_required',
    campaignId: id(campaignId, 'submission_envelope_campaign_invalid'),
    paperId: id(paperId, 'submission_envelope_paper_invalid'),
    venueId: id(venueId, 'submission_envelope_venue_invalid'),
    requestHash: requestHash.toLowerCase(),
    portalBindingHash: portalBindingHash.toLowerCase(),
    compiledPdfHash: selectedCompiledPdfHash,
    title: selectedTitle,
    abstract: selectedAbstract,
    articleType: selectedArticleType,
    keywords: selectedKeywords,
    authors: Object.freeze(selectedAuthors),
    declarations: Object.freeze(selectedDeclarations),
    reviewerPreferences: Object.freeze(selectedReviewers),
    files: sortedFiles,
    dynamicAnswers: Object.freeze(selectedAnswers),
    unknownDeclarationIds: Object.freeze(selectedDeclarations
      .filter((entry) => entry.value === 'unknown')
      .map((entry) => entry.declarationId)
      .sort()),
    unknownDynamicFieldIds: Object.freeze(selectedAnswers
      .filter((entry) => entry.valueStatus === 'unknown')
      .map((entry) => entry.fieldId)
      .sort()),
    metadataHash: hashRecord('CanonicalSubmissionMetadata', metadata),
    assetManifestHash: hashRecord('CanonicalSubmissionAssetManifest', {
      files: sortedFiles,
    }),
    createdAt: canonicalInstant(createdAt),
  };
  return Object.freeze({
    ...payload,
    submissionEnvelopeHash: hashRecord('CanonicalSubmissionEnvelope', payload),
  });
}

export function verifySubmissionEnvelope(value, {
  requestHash = null,
  portalBindingHash = null,
} = {}) {
  const { submissionEnvelopeHash: claimedHash, ...payload } = value || {};
  if (!hasExactObjectKeys(payload, ENVELOPE_KEYS)
    || claimedHash !== hashRecord('CanonicalSubmissionEnvelope', payload)
    || (requestHash !== null && value.requestHash !== requestHash)
    || (portalBindingHash !== null && value.portalBindingHash !== portalBindingHash)) {
    return false;
  }
  try {
    return JSON.stringify(buildSubmissionEnvelope(payload)) === JSON.stringify(value);
  } catch { return false; }
}

export function buildSubmissionEnvelopePreflight({
  envelope,
  portalBinding,
  stage = 'draft',
  observedAt,
  commitAuthorizationHash = null,
} = {}) {
  const blockers = [];
  if (!verifySubmissionEnvelope(envelope, {
    portalBindingHash: portalBinding?.submissionPortalBindingHash,
  })) blockers.push('submission_envelope_invalid');
  if (envelope?.venueId !== portalBinding?.venueId) {
    blockers.push('submission_envelope_target_mismatch');
  }
  if (envelope?.dynamicAnswers?.some((answer) => (
    answer.schemaFingerprintHash !== portalBinding?.schemaFingerprintHash
  ))) {
    blockers.push('submission_dynamic_answer_schema_mismatch');
  }
  const observedAtMs = Date.parse(String(observedAt || ''));
  if (!Number.isFinite(observedAtMs)
    || observedAtMs < Date.parse(String(portalBinding?.verifiedAt || ''))
    || observedAtMs >= Date.parse(String(portalBinding?.expiresAt || ''))) {
    blockers.push('submission_portal_binding_expired_or_not_yet_valid');
  }
  if (!['draft', 'review', 'commit'].includes(stage)) {
    blockers.push('submission_preflight_stage_invalid');
  }
  if (stage === 'review' || stage === 'commit') {
    if (envelope?.unknownDeclarationIds?.length) {
      blockers.push('submission_declarations_unresolved');
    }
    if (envelope?.unknownDynamicFieldIds?.length) {
      blockers.push('submission_dynamic_answers_unresolved');
    }
    if (!portalBinding?.enabledOperations?.includes('preview')) {
      blockers.push('submission_preview_capability_missing');
    }
  }
  if (stage === 'draft'
    && !portalBinding?.enabledOperations?.includes('createDraft')) {
    blockers.push('submission_create_draft_capability_missing');
  }
  if (stage === 'commit') {
    if (!portalBinding?.enabledOperations?.includes('commit')
      || portalBinding?.termsAutomationPermitted !== true) {
      blockers.push('submission_commit_capability_or_policy_missing');
    }
    if (!SHA256.test(String(commitAuthorizationHash || '').toLowerCase())) {
      blockers.push('submission_commit_authorization_missing');
    }
  }
  const payload = {
    version: 1,
    kind: 'SubmissionEnvelopePreflight',
    status: blockers.length
      ? 'submission_envelope_preflight_blocked'
      : `submission_envelope_preflight_${stage}_ready`,
    stage,
    submissionEnvelopeHash: envelope?.submissionEnvelopeHash || null,
    portalBindingHash: portalBinding?.submissionPortalBindingHash || null,
    metadataHash: envelope?.metadataHash || null,
    assetManifestHash: envelope?.assetManifestHash || null,
    commitAuthorizationHash: commitAuthorizationHash
      ? String(commitAuthorizationHash).toLowerCase() : null,
    blockers: Object.freeze(blockers),
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    submissionEnvelopePreflightHash:
      hashRecord('SubmissionEnvelopePreflight', payload),
  });
}
