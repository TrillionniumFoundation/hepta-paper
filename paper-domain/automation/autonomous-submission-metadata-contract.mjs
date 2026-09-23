import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAutonomousConfigurationAuthorityProof,
} from './autonomous-configuration-authority-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const ORCID = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;
const AUTHOR_KEYS = Object.freeze([
  'affiliations', 'authorId', 'correspondingAuthor', 'displayName', 'orcid',
]);
const PROFILE_KEYS = Object.freeze([
  'authors', 'codeAvailabilityStatement', 'conflictOfInterestStatement',
  'dataAvailabilityStatement', 'defaultKeywords', 'fundingStatement', 'kind',
  'profileAuthorityReceiptHash', 'profileHash', 'profileId', 'version',
]);

function id(value) {
  const candidate = String(value || '').trim();
  return SAFE_ID.test(candidate) ? candidate : null;
}

function sha(value) {
  const candidate = String(value || '').toLowerCase();
  return SHA256.test(candidate) ? candidate : null;
}

function text(value, maximum = 4_000) {
  const candidate = String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  return candidate && candidate.length <= maximum ? candidate : null;
}

function texts(values, { minimum = 1, maximum = 64, maximumLength = 1_000 } = {}) {
  if (!Array.isArray(values) || values.length < minimum || values.length > maximum) return null;
  const selected = values.map((value) => text(value, maximumLength));
  if (selected.some((value) => !value) || new Set(selected).size !== selected.length) return null;
  return Object.freeze([...selected]);
}

function author(value) {
  if (!hasExactObjectKeys(value, AUTHOR_KEYS)) return null;
  const selected = Object.freeze({
    authorId: id(value.authorId),
    displayName: text(value.displayName, 500),
    affiliations: texts(value.affiliations, { maximum: 16, maximumLength: 1_000 }),
    orcid: value.orcid === null ? null : String(value.orcid || '').trim(),
    correspondingAuthor: value.correspondingAuthor === true,
  });
  return selected.authorId && selected.displayName && selected.affiliations
    && (selected.orcid === null || ORCID.test(selected.orcid)) ? selected : null;
}

export function buildAutonomousSubmissionMetadataProfile({
  profileId,
  authors,
  defaultKeywords,
  conflictOfInterestStatement,
  fundingStatement,
  dataAvailabilityStatement,
  codeAvailabilityStatement,
  profileAuthorityReceiptHash,
} = {}) {
  const selectedAuthors = Array.isArray(authors) ? authors.map(author) : [];
  const payload = {
    version: 1,
    kind: 'AutonomousSubmissionMetadataProfile',
    profileId: id(profileId),
    authors: Object.freeze(selectedAuthors.filter(Boolean)),
    defaultKeywords: texts(defaultKeywords, { minimum: 1, maximum: 32, maximumLength: 200 }),
    conflictOfInterestStatement: text(conflictOfInterestStatement),
    fundingStatement: text(fundingStatement),
    dataAvailabilityStatement: text(dataAvailabilityStatement),
    codeAvailabilityStatement: text(codeAvailabilityStatement),
    profileAuthorityReceiptHash: sha(profileAuthorityReceiptHash),
  };
  if (!payload.profileId || !Array.isArray(authors) || !selectedAuthors.length
    || selectedAuthors.some((value) => !value)
    || new Set(selectedAuthors.map((value) => value.authorId)).size !== selectedAuthors.length
    || selectedAuthors.filter((value) => value.correspondingAuthor).length !== 1
    || !payload.defaultKeywords || !payload.conflictOfInterestStatement
    || !payload.fundingStatement || !payload.dataAvailabilityStatement
    || !payload.codeAvailabilityStatement || !payload.profileAuthorityReceiptHash) {
    throw new Error('autonomous_submission_metadata_profile_invalid');
  }
  return Object.freeze({
    ...payload,
    profileHash: hashRecord('AutonomousSubmissionMetadataProfile', payload),
  });
}

export function verifyAutonomousSubmissionMetadataProfile(profile) {
  if (!hasExactObjectKeys(profile, PROFILE_KEYS)) return false;
  try { return JSON.stringify(buildAutonomousSubmissionMetadataProfile(profile)) === JSON.stringify(profile); }
  catch { return false; }
}

export function buildAutonomousSubmissionMetadataReceipt({
  paperId,
  protocolFamily,
  profile,
  profileAuthorityProof = null,
  selectedAt = null,
  authorityObservedAt = null,
} = {}) {
  const strongAuthority = profileAuthorityProof !== null;
  if (!id(paperId) || !id(protocolFamily)
    || !verifyAutonomousSubmissionMetadataProfile(profile)
    || (selectedAt !== null && (!Number.isFinite(Date.parse(String(selectedAt)))
      || new Date(selectedAt).toISOString() !== selectedAt))
    || (strongAuthority && (!selectedAt
      || !verifyAutonomousConfigurationAuthorityProof(profileAuthorityProof, {
        subjectKind: 'AutonomousSubmissionMetadataProfile',
        subjectHash: profile.profileHash,
        requiredRole: 'submission_metadata_authority',
        observedAt: authorityObservedAt,
      })))) {
    throw new Error('autonomous_submission_metadata_receipt_invalid');
  }
  const keywords = Object.freeze([...new Set([
    ...profile.defaultKeywords,
    protocolFamily.replace(/_/g, '-'),
  ])].sort());
  const payload = {
    version: strongAuthority ? 2 : 1,
    kind: 'AutonomousSubmissionMetadataReceipt',
    status: 'autonomous_submission_metadata_verified',
    paperId,
    protocolFamily,
    profileId: profile.profileId,
    profileHash: profile.profileHash,
    profile,
    ...(strongAuthority ? {
      profileAuthorityProof,
      submissionMetadataAuthorityConfigurationHash:
        profileAuthorityProof.configurationHash,
      submissionMetadataAuthorityTrustSetHash: profileAuthorityProof.trustSetHash,
      submissionMetadataAuthoritySignatureVerificationPolicyHash:
        profileAuthorityProof.signatureVerificationPolicyHash,
    } : {}),
    keywords,
    authorCount: profile.authors.length,
    correspondingAuthorId:
      profile.authors.find((candidate) => candidate.correspondingAuthor).authorId,
    machineSelected: true,
    humanApprovalPerformed: false,
    selectedAt,
  };
  return Object.freeze({
    ...payload,
    autonomousSubmissionMetadataReceiptHash:
      hashRecord('AutonomousSubmissionMetadataReceipt', payload),
  });
}

export function verifyAutonomousSubmissionMetadataReceipt(receipt, expected = {}) {
  const { authorityObservedAt = null, ...fieldExpected } = expected;
  let rebuilt = null;
  try { rebuilt = buildAutonomousSubmissionMetadataReceipt({
    ...receipt,
    profile: receipt?.profile,
    authorityObservedAt: receipt?.version === 2 ? authorityObservedAt : null,
  }); } catch { return false; }
  return JSON.stringify(rebuilt) === JSON.stringify(receipt)
    && Object.entries(fieldExpected).every(([field, value]) => (
      value === undefined || value === null || receipt[field] === value
    ));
}
