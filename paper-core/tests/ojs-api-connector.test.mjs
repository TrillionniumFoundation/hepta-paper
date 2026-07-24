import assert from 'node:assert/strict';
import test from 'node:test';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildSubmissionPortalBinding,
} from '../../paper-domain/submission/submission-portal-binding.mjs';
import {
  buildSubmissionEnvelope,
} from '../../paper-domain/submission/submission-envelope.mjs';
import {
  buildOjsSubmissionPlan,
  verifyOjsSubmissionPlan,
} from '../../paper-domain/submission/ojs-submission-plan.mjs';
import {
  createOjsApiConnector,
} from '../../paper-adapters/submission/ojs-api-connector.mjs';

const sha = (character) => `sha256:${character.repeat(64)}`;

function fixture() {
  const schema = Object.freeze({
    apiVersion: '3.5',
    submissionSchemaVersion: 'fixture-v1',
    requiredFields: Object.freeze(['sectionId', 'title', 'abstract', 'authors']),
  });
  const target = Object.freeze({
    kind: 'JournalSubmissionTargetProfile',
    venueId: 'fixture_ojs_journal',
    venueKind: 'journal',
    candidateConnectorFamilies: Object.freeze(['ojs-rest-v1']),
    journalSubmissionTargetProfileHash: sha('a'),
  });
  const binding = buildSubmissionPortalBinding({
    baseTargetProfile: target,
    targetInstanceId: 'fixture-ojs-journal',
    connectorFamily: 'ojs-rest-v1',
    portalOrigin: 'https://journal.example.test',
    submissionRoute: '/api/v1/submissions',
    authenticationMode: 'api-token',
    authenticationProfileHash: sha('1'),
    schemaFingerprintHash: hashRecord('OjsSubmissionSchema', schema),
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
    expiresAt: '2027-07-01T00:00:00.000Z',
  });
  const pdfBytes = Buffer.from('%PDF-1.7\nojs fixture\n');
  const pdfHash = hashBytes(pdfBytes);
  const envelope = buildSubmissionEnvelope({
    campaignId: 'campaign-ojs',
    paperId: 'paper-ojs',
    venueId: target.venueId,
    requestHash: sha('6'),
    portalBindingHash: binding.submissionPortalBindingHash,
    compiledPdfHash: pdfHash,
    title: 'OJS contract fixture',
    abstract: 'A deterministic OJS workflow fixture.',
    articleType: 'research_article',
    keywords: ['publishing', 'verification'],
    authors: [{
      authorId: 'author-1',
      givenName: 'Grace',
      familyName: 'Hopper',
      displayName: 'Grace Hopper',
      emailReference: 'identity:author-1:email',
      orcid: null,
      affiliations: [{
        affiliationId: 'affiliation-1',
        displayName: 'Compiler Systems Laboratory',
        rorId: null,
        ringgoldId: null,
        countryCode: 'US',
      }],
      creditRoles: ['Software', 'Writing – original draft'],
      correspondingAuthor: true,
      submittingAuthor: true,
    }],
    declarations: [{
      declarationId: 'conflict_of_interest',
      statement: 'No conflict exists.',
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
  return {
    schema,
    target,
    binding,
    envelope,
    assets: [{ fileId: 'paper-pdf', bytes: pdfBytes }],
  };
}

function runtime(schema) {
  const calls = [];
  let isSubmitted = false;
  const observation = () => ({
    id: 101,
    currentPublicationId: 202,
    status: isSubmitted ? 3 : 1,
    submissionProgress: isSubmitted ? null : 'details',
    dateSubmitted: isSubmitted ? '2026-07-24T00:30:00.000Z' : null,
    lastModified: '2026-07-24T00:20:00.000Z',
  });
  const client = Object.freeze({
    kind: 'OjsClientPort',
    networkPolicy: 'ojs-only',
    credentialIsolation: true,
    async probe() {
      calls.push(['probe']);
      return { version: '3.5.0', contextId: 1 };
    },
    async getSubmissionSchema() {
      calls.push(['schema']);
      return schema;
    },
    async validatePlan(input) {
      calls.push(['validate', input]);
      return { valid: true, errors: [] };
    },
    async createSubmission(input) {
      calls.push(['create', input]);
      return observation();
    },
    async updatePublication(input) {
      calls.push(['publication', input]);
      return { id: 202, updated: true };
    },
    async replaceContributors(input) {
      calls.push(['contributors', input]);
      return { count: input.contributors.length };
    },
    async uploadFiles(input) {
      calls.push(['files', input]);
      return { count: input.files.length };
    },
    async saveForLater(input) {
      calls.push(['save', input]);
      return { saved: true };
    },
    async submitSubmission(input) {
      calls.push(['submit', input]);
      isSubmitted = true;
      return { submitted: true };
    },
    async getSubmission(input) {
      calls.push(['get', input]);
      return observation();
    },
  });
  const identityResolver = Object.freeze({
    kind: 'SubmissionIdentityResolverPort',
    credentialIsolation: true,
    piiReleasePolicy: 'target-scoped-short-lived',
    async resolveAuthors({ authors }) {
      calls.push(['resolve']);
      return authors.map((author) => ({
        authorId: author.authorId,
        emailReference: author.emailReference,
        email: 'grace@example.test',
      }));
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
    connector: createOjsApiConnector({
      client,
      identityResolver,
      commitPermitAuthority,
      clock: { now: () => new Date('2026-07-24T00:00:00.000Z') },
    }),
  };
}

test('OJS plan binds locale, section, contributors, files and target profile', () => {
  const value = fixture();
  const plan = buildOjsSubmissionPlan({
    envelope: value.envelope,
    baseTargetProfile: value.target,
    portalBinding: value.binding,
    locale: 'en',
    sectionId: 7,
    userGroupId: 9,
    operation: 'draft',
  });
  assert.equal(verifyOjsSubmissionPlan(plan, {
    envelope: value.envelope,
    baseTargetProfile: value.target,
    portalBinding: value.binding,
  }), true);
  assert.deepEqual(plan.publicationMetadata.title, { en: value.envelope.title });
  assert.equal(plan.authorTemplates[0].emailReference, 'identity:author-1:email');
  assert.throws(() => buildOjsSubmissionPlan({
    envelope: value.envelope,
    baseTargetProfile: value.target,
    portalBinding: value.binding,
    sectionId: 7,
    operation: 'commit',
    commitAuthorizationHash: sha('9'),
  }), /ojs_commit_binding_invalid/);
});

test('OJS connector validates, stages a complete draft and commits after concurrency check', async () => {
  const value = fixture();
  const runtimeValue = runtime(value.schema);
  const common = {
    envelope: value.envelope,
    baseTargetProfile: value.target,
    portalBinding: value.binding,
    locale: 'en',
    sectionId: 7,
    userGroupId: 9,
  };
  const validationPlan = buildOjsSubmissionPlan({
    ...common,
    operation: 'validate',
  });
  const validation = await runtimeValue.connector.validate({
    ...common,
    assets: value.assets,
    plan: validationPlan,
  });
  assert.equal(validation.status, 'ojs_plan_validated');
  assert.equal(validation.externalActionPerformed, false);

  const draftPlan = buildOjsSubmissionPlan({ ...common, operation: 'draft' });
  const draft = await runtimeValue.connector.createDraft({
    ...common,
    assets: value.assets,
    plan: draftPlan,
  });
  assert.equal(draft.remoteSubmissionId, 101);
  assert.equal(draft.remotePublicationId, 202);
  assert.equal(draft.readAfterWriteVerified, true);
  assert.equal(draft.productionEligible, false);
  assert.deepEqual(
    runtimeValue.calls.map(([operation]) => operation)
      .filter((operation) => [
        'create', 'publication', 'contributors', 'files', 'save',
      ].includes(operation)),
    ['create', 'publication', 'contributors', 'files', 'save'],
  );

  const commitPlan = buildOjsSubmissionPlan({
    ...common,
    operation: 'commit',
    remoteSubmissionId: draft.remoteSubmissionId,
    remotePublicationId: draft.remotePublicationId,
    remoteVersionToken: draft.remoteVersionToken,
    commitAuthorizationHash: sha('9'),
  });
  const committed = await runtimeValue.connector.commit({
    ...common,
    plan: commitPlan,
    commitPermit: 'single-use-permit',
  });
  assert.equal(runtimeValue.permits.length, 1);
  assert.equal(committed.status, 'ojs_remote_submission_observed');
  assert.equal(committed.remoteSubmissionProgress, null);
  assert.equal(committed.readAfterWriteVerified, true);
});

test('OJS readiness fails closed on schema drift', async () => {
  const value = fixture();
  const good = runtime(value.schema);
  assert.equal((await good.connector.probeReadiness({
    portalBinding: value.binding,
    baseTargetProfile: value.target,
  })).productionEligible, false);
  const changed = runtime({ ...value.schema, requiredFields: ['changed'] });
  await assert.rejects(changed.connector.probeReadiness({
    portalBinding: value.binding,
    baseTargetProfile: value.target,
  }), /ojs_submission_schema_drift/);
});
