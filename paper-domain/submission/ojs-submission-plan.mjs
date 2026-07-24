import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifySubmissionEnvelope } from './submission-envelope.mjs';
import { verifySubmissionPortalBinding } from './submission-portal-binding.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const LOCALE = /^[a-z]{2,3}(?:_[A-Z]{2})?$/;
const PLAN_KEYS = Object.freeze([
  'assetManifestHash',
  'authorTemplates',
  'commitAuthorizationHash',
  'declarationAnswers',
  'dynamicAnswers',
  'fileTemplates',
  'kind',
  'locale',
  'metadataHash',
  'operation',
  'portalBindingHash',
  'publicationMetadata',
  'remotePublicationId',
  'remoteSubmissionId',
  'remoteVersionToken',
  'requestHash',
  'sectionId',
  'status',
  'submissionEnvelopeHash',
  'targetInstanceId',
  'userGroupId',
  'venueId',
  'version',
]);

function authorTemplate(author, sequence) {
  return Object.freeze({
    authorId: author.authorId,
    sequence,
    givenName: author.givenName,
    familyName: author.familyName,
    preferredPublicName: author.displayName,
    emailReference: author.emailReference,
    orcid: author.orcid,
    affiliations: author.affiliations,
    creditRoles: author.creditRoles,
    primaryContact: author.correspondingAuthor,
    submittingAuthor: author.submittingAuthor,
  });
}

export function buildOjsSubmissionPlan({
  envelope,
  baseTargetProfile,
  portalBinding,
  locale = 'en',
  sectionId,
  userGroupId = null,
  operation = 'validate',
  remoteSubmissionId = null,
  remotePublicationId = null,
  remoteVersionToken = null,
  commitAuthorizationHash = null,
} = {}) {
  if (!verifySubmissionPortalBinding(portalBinding, {
    baseTargetProfile,
    observedAt: envelope?.createdAt,
  })
    || portalBinding.connectorFamily !== 'ojs-rest-v1'
    || !verifySubmissionEnvelope(envelope, {
      portalBindingHash: portalBinding.submissionPortalBindingHash,
    })
    || envelope.venueId !== portalBinding.venueId
    || envelope.dynamicAnswers.some((answer) => (
      answer.schemaFingerprintHash !== portalBinding.schemaFingerprintHash
    ))
    || !LOCALE.test(String(locale || ''))
    || !Number.isSafeInteger(sectionId) || sectionId < 1
    || (userGroupId !== null
      && (!Number.isSafeInteger(userGroupId) || userGroupId < 1))
    || !['validate', 'draft', 'commit'].includes(operation)) {
    throw new Error('ojs_submission_plan_input_invalid');
  }
  const commit = operation === 'commit';
  if (commit && (
    !Number.isSafeInteger(remoteSubmissionId) || remoteSubmissionId < 1
    || !Number.isSafeInteger(remotePublicationId) || remotePublicationId < 1
    || !SHA256.test(String(remoteVersionToken || '').toLowerCase())
    || !SHA256.test(String(commitAuthorizationHash || '').toLowerCase())
    || envelope.unknownDeclarationIds.length
    || envelope.unknownDynamicFieldIds.length
  )) throw new Error('ojs_commit_binding_invalid');
  if (!commit && [remoteSubmissionId, remotePublicationId, remoteVersionToken]
    .some((value) => value !== null)) {
    throw new Error('ojs_remote_identity_unexpected');
  }
  const authorTemplates = Object.freeze(envelope.authors.map((author, index) => (
    authorTemplate(author, index + 1)
  )));
  const fileTemplates = Object.freeze(envelope.files.map((file) => Object.freeze({
    fileId: file.fileId,
    genreRole: file.role,
    filename: file.filename,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    sequence: file.order,
  })));
  const dynamicAnswers = Object.freeze(Object.fromEntries(
    envelope.dynamicAnswers.map((answer) => [answer.fieldId, Object.freeze({
      valueType: answer.valueType,
      valueStatus: answer.valueStatus,
      value: answer.value,
    })]).sort(([left], [right]) => left.localeCompare(right)),
  ));
  const declarationAnswers = Object.freeze(Object.fromEntries(
    envelope.declarations.map((declaration) => [
      declaration.declarationId, declaration.value,
    ]).sort(([left], [right]) => left.localeCompare(right)),
  ));
  const publicationMetadata = Object.freeze({
    title: Object.freeze({ [locale]: envelope.title }),
    abstract: Object.freeze({ [locale]: envelope.abstract }),
    keywords: Object.freeze({ [locale]: envelope.keywords }),
  });
  const payload = {
    version: 1,
    kind: 'OjsSubmissionPlan',
    status: commit
      ? 'ojs_commit_plan_ready'
      : operation === 'draft'
        ? 'ojs_draft_plan_ready'
        : 'ojs_validation_plan_ready',
    operation,
    venueId: envelope.venueId,
    targetInstanceId: portalBinding.targetInstanceId,
    requestHash: envelope.requestHash,
    portalBindingHash: portalBinding.submissionPortalBindingHash,
    submissionEnvelopeHash: envelope.submissionEnvelopeHash,
    metadataHash: envelope.metadataHash,
    assetManifestHash: envelope.assetManifestHash,
    locale,
    sectionId,
    userGroupId,
    remoteSubmissionId: commit ? remoteSubmissionId : null,
    remotePublicationId: commit ? remotePublicationId : null,
    remoteVersionToken: commit ? remoteVersionToken.toLowerCase() : null,
    commitAuthorizationHash: commit
      ? commitAuthorizationHash.toLowerCase() : null,
    publicationMetadata,
    authorTemplates,
    fileTemplates,
    declarationAnswers,
    dynamicAnswers,
  };
  return Object.freeze({
    ...payload,
    ojsSubmissionPlanHash: hashRecord('OjsSubmissionPlan', payload),
  });
}

export function verifyOjsSubmissionPlan(value, {
  envelope,
  baseTargetProfile,
  portalBinding,
} = {}) {
  if (!hasExactObjectKeys(value, [...PLAN_KEYS, 'ojsSubmissionPlanHash'])
    || !SHA256.test(String(value?.ojsSubmissionPlanHash || ''))) return false;
  try {
    return JSON.stringify(buildOjsSubmissionPlan({
      envelope,
      baseTargetProfile,
      portalBinding,
      locale: value.locale,
      sectionId: value.sectionId,
      userGroupId: value.userGroupId,
      operation: value.operation,
      remoteSubmissionId: value.remoteSubmissionId,
      remotePublicationId: value.remotePublicationId,
      remoteVersionToken: value.remoteVersionToken,
      commitAuthorizationHash: value.commitAuthorizationHash,
    })) === JSON.stringify(value);
  } catch { return false; }
}

export function materializeOjsContributors(plan, { resolvedAuthors } = {}) {
  if (!Array.isArray(resolvedAuthors)
    || resolvedAuthors.length !== plan?.authorTemplates?.length) {
    throw new Error('ojs_resolved_authors_invalid');
  }
  const byId = new Map(resolvedAuthors.map((author) => [author.authorId, author]));
  if (byId.size !== resolvedAuthors.length) {
    throw new Error('ojs_resolved_authors_invalid');
  }
  return Object.freeze(plan.authorTemplates.map((template) => {
    const identity = byId.get(template.authorId);
    const email = String(identity?.email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
      || identity.emailReference !== template.emailReference) {
      throw new Error('ojs_resolved_author_identity_invalid');
    }
    return Object.freeze({
      ...template,
      email,
      emailReference: undefined,
    });
  }).map((contributor) => Object.freeze(Object.fromEntries(
    Object.entries(contributor).filter(([, value]) => value !== undefined),
  ))));
}
