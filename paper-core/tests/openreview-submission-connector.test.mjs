import assert from 'node:assert/strict';
import test from 'node:test';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  getJournalSubmissionTargetProfile,
} from '../../paper-domain/submission/journal-submission-target-registry.mjs';
import {
  buildSubmissionPortalBinding,
} from '../../paper-domain/submission/submission-portal-binding.mjs';
import {
  buildSubmissionEnvelope,
} from '../../paper-domain/submission/submission-envelope.mjs';
import {
  buildOpenReviewSubmissionPlan,
} from '../../paper-domain/submission/openreview-submission-plan.mjs';
import {
  createOpenReviewSubmissionConnector,
} from '../../paper-adapters/submission/openreview-submission-connector.mjs';

const sha = (character) => `sha256:${character.repeat(64)}`;

function fixture() {
  const invitation = 'ICLR.cc/2027/Conference/-/Submission';
  const schema = Object.freeze({
    invitation,
    contentFields: Object.freeze([
      'abstract', 'artifact_available', 'authorids', 'authors', 'keywords',
      'pdf', 'subject_areas', 'title', 'venueid',
    ]),
    schemaVersion: 2,
  });
  const target = getJournalSubmissionTargetProfile('iclr');
  const binding = buildSubmissionPortalBinding({
    baseTargetProfile: target,
    targetInstanceId: 'ICLR.cc/2027/Conference',
    edition: '2027',
    track: 'Conference',
    connectorFamily: 'openreview-api-v2',
    portalOrigin: 'https://openreview.net',
    submissionRoute: '/group?id=ICLR.cc/2027/Conference',
    authenticationMode: 'api-token',
    authenticationProfileHash: sha('1'),
    schemaFingerprintHash: hashRecord('OpenReviewInvitationSchema', schema),
    schemaEvidenceHashes: [sha('2')],
    automationPolicyEvidenceHash: sha('3'),
    portalBindingEvidenceHashes: [sha('4')],
    statusMappingHash: sha('5'),
    enabledOperations: [
      'commit', 'createDraft', 'discoverProfile', 'fillMetadata', 'getReceipt',
      'getStatus', 'preview', 'reconcile', 'uploadAssets', 'validate',
    ],
    termsAutomationPermitted: true,
    verifiedAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2027-08-01T00:00:00.000Z',
  });
  const pdfBytes = Buffer.from('%PDF-1.7\nopenreview submission connector\n');
  const pdfHash = hashBytes(pdfBytes);
  const envelope = buildSubmissionEnvelope({
    campaignId: 'campaign-openreview',
    paperId: 'paper-openreview',
    venueId: 'iclr',
    requestHash: sha('6'),
    portalBindingHash: binding.submissionPortalBindingHash,
    compiledPdfHash: pdfHash,
    title: 'OpenReview schema-aware fixture',
    abstract: 'Typed dynamic fields are checked against an invitation snapshot.',
    articleType: 'research_article',
    keywords: ['openreview', 'schema'],
    authors: [{
      authorId: 'author-1',
      givenName: 'Ada',
      familyName: 'Lovelace',
      displayName: 'Ada Lovelace',
      emailReference: 'identity:author-1:email',
      orcid: '0000-0002-1825-0097',
      affiliations: [{
        affiliationId: 'affiliation-1',
        displayName: 'Analytical Engine Institute',
        rorId: null,
        ringgoldId: null,
        countryCode: 'GB',
      }],
      creditRoles: ['Conceptualization'],
      correspondingAuthor: true,
      submittingAuthor: true,
    }],
    declarations: [{
      declarationId: 'conflict_of_interest',
      statement: 'No competing interests exist.',
      value: 'no',
      evidenceReference: null,
    }],
    reviewerPreferences: [],
    files: [{
      fileId: 'paper-pdf',
      role: 'manuscript',
      filename: 'paper.pdf',
      mimeType: 'application/pdf',
      sizeBytes: pdfBytes.length,
      sha256: pdfHash,
      order: 1,
    }],
    dynamicAnswers: [],
    createdAt: '2026-07-24T00:00:00.000Z',
  });
  const request = Object.freeze({
    kind: 'AutonomousSubmissionRequest',
    requestHash: envelope.requestHash,
    idempotencyKey: sha('7'),
    compiledPdfHash: envelope.compiledPdfHash,
    venueId: envelope.venueId,
  });
  const plan = buildOpenReviewSubmissionPlan({
    request,
    invitation,
    title: envelope.title,
    abstract: envelope.abstract,
    authorNames: ['Ada Lovelace'],
    authorProfiles: ['~Ada_Lovelace1'],
    keywords: envelope.keywords,
    content: {
      artifact_available: true,
      subject_areas: ['verification', 'automation'],
      venueid: 'ICLR.cc/2027/Conference',
    },
  });
  return { target, binding, envelope, request, plan, schema, pdfBytes };
}

function runtime(schema) {
  const calls = [];
  let posted = null;
  const client = Object.freeze({
    kind: 'OpenReviewClientPort',
    networkPolicy: 'openreview-only',
    credentialIsolation: true,
    async probe() {
      calls.push(['probe']);
      return { profileId: '~Ada_Lovelace1' };
    },
    async getInvitationSchema() {
      calls.push(['schema']);
      return schema;
    },
    async validateContent({ noteEdit }) {
      calls.push(['validate', noteEdit]);
      return { valid: true };
    },
    async findNoteByIdempotencyKey(input) {
      calls.push(['find', input]);
      return null;
    },
    async uploadPdf(input) {
      calls.push(['upload', input]);
      return { url: 'https://openreview.net/pdf/fixture.pdf' };
    },
    async postNoteEdit({ noteEdit }) {
      calls.push(['post', noteEdit]);
      posted = { id: 'note-1', forum: 'note-1', mnumber: 1, content: noteEdit.content };
      return posted;
    },
    async getNote({ noteId }) {
      calls.push(['get', noteId]);
      return posted && posted.id === noteId ? posted : null;
    },
  });
  const permits = [];
  const commitPermitAuthority = Object.freeze({
    kind: 'SubmissionCommitPermitAuthority',
    singleUsePermitConsumption: true,
    durableConsumptionRequired: true,
    consume(input) {
      permits.push(input);
      if (input.permit !== 'single-use-permit') throw new Error('permit_invalid');
    },
  });
  return {
    calls,
    permits,
    connector: createOpenReviewSubmissionConnector({
      client,
      commitPermitAuthority,
      clock: { now: () => new Date('2026-07-24T00:00:00.000Z') },
    }),
  };
}

test('OpenReview connector honors typed invitation fields without injecting undeclared metadata', async () => {
  const value = fixture();
  const runtimeValue = runtime(value.schema);
  const common = {
    plan: value.plan,
    envelope: value.envelope,
    baseTargetProfile: value.target,
    portalBinding: value.binding,
    schema: value.schema,
    pdfUrl: 'https://openreview.net/pdf/fixture.pdf',
  };
  const validation = await runtimeValue.connector.validate(common);
  assert.equal(validation.status, 'openreview_content_validated');
  const metadata = await runtimeValue.connector.fillMetadata(common);
  assert.equal(metadata.noteEdit.content.artifact_available.value, true);
  assert.deepEqual(
    metadata.noteEdit.content.subject_areas.value,
    ['verification', 'automation'],
  );
  assert.equal(
    Object.hasOwn(metadata.noteEdit.content, 'hepta_submission_plan_hash'),
    false,
  );
});

test('OpenReview upload is hash-bound and commit consumes one permit with read-after-write', async () => {
  const value = fixture();
  const runtimeValue = runtime(value.schema);
  const common = {
    plan: value.plan,
    envelope: value.envelope,
    baseTargetProfile: value.target,
    portalBinding: value.binding,
    schema: value.schema,
  };
  const uploaded = await runtimeValue.connector.uploadAssets({
    ...common,
    pdfBytes: value.pdfBytes,
  });
  assert.equal(uploaded.status, 'openreview_pdf_uploaded');
  await assert.rejects(runtimeValue.connector.uploadAssets({
    ...common,
    pdfBytes: Buffer.from('tampered'),
  }), /openreview_submission_asset_hash_mismatch/);

  const committed = await runtimeValue.connector.commit({
    ...common,
    pdfUrl: uploaded.pdfUrl,
    commitPermit: 'single-use-permit',
    commitAuthorizationHash: sha('8'),
  });
  assert.equal(runtimeValue.permits.length, 1);
  assert.equal(committed.noteId, 'note-1');
  assert.equal(committed.readAfterWriteVerified, true);
  assert.equal(committed.productionEligible, false);
  assert.deepEqual(
    runtimeValue.calls.map(([operation]) => operation)
      .filter((operation) => ['find', 'post', 'get'].includes(operation)),
    ['find', 'post', 'get'],
  );
});

test('OpenReview readiness detects invitation drift', async () => {
  const value = fixture();
  const good = runtime(value.schema);
  assert.equal((await good.connector.probeReadiness({
    plan: value.plan,
    portalBinding: value.binding,
    baseTargetProfile: value.target,
  })).productionEligible, false);
  const drift = runtime({ ...value.schema, contentFields: ['title'] });
  await assert.rejects(drift.connector.probeReadiness({
    plan: value.plan,
    portalBinding: value.binding,
    baseTargetProfile: value.target,
  }), /openreview_invitation_schema_drift/);
});
