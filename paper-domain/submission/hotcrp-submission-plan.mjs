import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifySubmissionEnvelope } from './submission-envelope.mjs';
import { verifySubmissionPortalBinding } from './submission-portal-binding.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const PLAN_KEYS = Object.freeze([
  'assetManifestHash',
  'authorTemplates',
  'commitAuthorizationHash',
  'contentFilename',
  'dryRun',
  'dynamicFields',
  'hotCrpSubmissionPlanHash',
  'idempotencyKey',
  'ifUnmodifiedSince',
  'kind',
  'metadataHash',
  'operation',
  'paperObjectTemplate',
  'portalBindingHash',
  'remotePaperId',
  'requestHash',
  'status',
  'submissionEnvelopeHash',
  'targetInstanceId',
  'venueId',
  'version',
]);
const RESERVED_FIELDS = new Set([
  'abstract', 'authors', 'collaborators', 'contacts', 'if_unmodified_since',
  'object', 'pid', 'status', 'submission', 'title',
]);

function authorTemplate(author) {
  return Object.freeze({
    authorId: author.authorId,
    name: author.displayName,
    emailReference: author.emailReference,
    affiliation: author.affiliations.map((item) => item.displayName).join('; '),
    orcid: author.orcid,
    contact: author.correspondingAuthor || author.submittingAuthor,
  });
}

function dynamicFields(envelope) {
  const entries = envelope.dynamicAnswers.map((answer) => {
    if (RESERVED_FIELDS.has(answer.fieldId)
      || answer.valueStatus !== 'answered') {
      throw new Error('hotcrp_dynamic_field_invalid');
    }
    return [answer.fieldId, answer.value];
  }).sort(([left], [right]) => left.localeCompare(right));
  return Object.freeze(Object.fromEntries(entries));
}

export function buildHotCrpSubmissionPlan({
  envelope,
  baseTargetProfile,
  portalBinding,
  operation = 'validate',
  remotePaperId = null,
  ifUnmodifiedSince = null,
  commitAuthorizationHash = null,
} = {}) {
  if (!verifySubmissionPortalBinding(portalBinding, {
    baseTargetProfile,
    observedAt: envelope?.createdAt,
  })
    || portalBinding.connectorFamily !== 'hotcrp-rest-v1'
    || !verifySubmissionEnvelope(envelope, {
      portalBindingHash: portalBinding.submissionPortalBindingHash,
    })
    || envelope.venueId !== portalBinding.venueId
    || envelope.dynamicAnswers.some((answer) => (
      answer.schemaFingerprintHash !== portalBinding.schemaFingerprintHash
    ))
    || !['validate', 'draft', 'commit'].includes(operation)) {
    throw new Error('hotcrp_submission_plan_input_invalid');
  }
  const manuscriptFiles = envelope.files.filter((file) => file.role === 'manuscript');
  if (manuscriptFiles.length !== 1) {
    throw new Error('hotcrp_primary_manuscript_file_invalid');
  }
  const commit = operation === 'commit';
  if (commit && (!Number.isSafeInteger(remotePaperId) || remotePaperId < 1
    || !Number.isSafeInteger(ifUnmodifiedSince) || ifUnmodifiedSince < 1
    || !SHA256.test(String(commitAuthorizationHash || '').toLowerCase())
    || envelope.unknownDeclarationIds.length
    || envelope.unknownDynamicFieldIds.length)) {
    throw new Error('hotcrp_commit_binding_invalid');
  }
  if (!commit && remotePaperId !== null
    && (!Number.isSafeInteger(remotePaperId) || remotePaperId < 1)) {
    throw new Error('hotcrp_remote_paper_id_invalid');
  }
  const authors = Object.freeze(envelope.authors.map(authorTemplate));
  const extras = dynamicFields(envelope);
  const paperObjectTemplate = Object.freeze({
    object: 'paper',
    pid: remotePaperId || 'new',
    title: envelope.title,
    abstract: envelope.abstract,
    authors,
    submission: Object.freeze({
      content_file: manuscriptFiles[0].filename,
    }),
    status: commit ? 'submitted' : 'draft',
    ...(commit ? { if_unmodified_since: ifUnmodifiedSince } : {}),
    ...extras,
  });
  const payload = {
    version: 1,
    kind: 'HotCrpSubmissionPlan',
    status: commit
      ? 'hotcrp_commit_plan_ready'
      : operation === 'draft'
        ? 'hotcrp_draft_plan_ready'
        : 'hotcrp_validation_plan_ready',
    operation,
    venueId: envelope.venueId,
    targetInstanceId: portalBinding.targetInstanceId,
    requestHash: envelope.requestHash,
    portalBindingHash: portalBinding.submissionPortalBindingHash,
    submissionEnvelopeHash: envelope.submissionEnvelopeHash,
    metadataHash: envelope.metadataHash,
    assetManifestHash: envelope.assetManifestHash,
    idempotencyKey: hashRecord('HotCrpSubmissionIdempotencyKey', {
      targetInstanceId: portalBinding.targetInstanceId,
      submissionEnvelopeHash: envelope.submissionEnvelopeHash,
    }),
    remotePaperId,
    ifUnmodifiedSince: commit ? ifUnmodifiedSince : null,
    dryRun: operation === 'validate',
    commitAuthorizationHash: commit
      ? commitAuthorizationHash.toLowerCase() : null,
    contentFilename: manuscriptFiles[0].filename,
    authorTemplates: authors,
    dynamicFields: extras,
    paperObjectTemplate,
  };
  const hash = hashRecord('HotCrpSubmissionPlan', payload);
  return Object.freeze({
    ...payload,
    hotCrpSubmissionPlanHash: hash,
  });
}

export function verifyHotCrpSubmissionPlan(value, {
  envelope,
  baseTargetProfile,
  portalBinding,
} = {}) {
  if (!hasExactObjectKeys(value, PLAN_KEYS)
    || !SHA256.test(String(value?.hotCrpSubmissionPlanHash || ''))) return false;
  try {
    return JSON.stringify(buildHotCrpSubmissionPlan({
      envelope,
      baseTargetProfile,
      portalBinding,
      operation: value.operation,
      remotePaperId: value.remotePaperId,
      ifUnmodifiedSince: value.ifUnmodifiedSince,
      commitAuthorizationHash: value.commitAuthorizationHash,
    })) === JSON.stringify(value);
  } catch { return false; }
}

export function materializeHotCrpPaperObject(plan, {
  resolvedAuthors,
} = {}) {
  if (!Array.isArray(resolvedAuthors)
    || resolvedAuthors.length !== plan?.authorTemplates?.length) {
    throw new Error('hotcrp_resolved_authors_invalid');
  }
  const byId = new Map(resolvedAuthors.map((author) => [author.authorId, author]));
  if (byId.size !== resolvedAuthors.length) {
    throw new Error('hotcrp_resolved_authors_invalid');
  }
  const authors = plan.authorTemplates.map((template) => {
    const identity = byId.get(template.authorId);
    const email = String(identity?.email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
      || identity.emailReference !== template.emailReference) {
      throw new Error('hotcrp_resolved_author_identity_invalid');
    }
    return Object.freeze({
      name: template.name,
      email,
      affiliation: template.affiliation,
      orcid: template.orcid,
      contact: template.contact,
    });
  });
  return Object.freeze({
    ...plan.paperObjectTemplate,
    authors: Object.freeze(authors),
  });
}
