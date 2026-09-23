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
  createPlaywrightAssistedSubmissionConnector,
} from '../../paper-adapters/submission/playwright-assisted-submission-connector.mjs';

const sha = (character) => `sha256:${character.repeat(64)}`;

function fixture() {
  const schema = Object.freeze({
    portal: 'fixture-cmt-like',
    domFingerprint: 'fixture-v1',
    fields: Object.freeze(['title', 'abstract', 'authors', 'paper']),
  });
  const target = getJournalSubmissionTargetProfile('cvpr');
  const binding = buildSubmissionPortalBinding({
    baseTargetProfile: target,
    targetInstanceId: 'cvpr-2027-main',
    edition: '2027',
    track: 'main',
    connectorFamily: 'playwright-assisted-draft-v1',
    portalOrigin: 'https://submission.example.test',
    submissionRoute: '/author/submit',
    authenticationMode: 'human-session-handoff',
    authenticationProfileHash: sha('1'),
    schemaFingerprintHash: hashRecord('BrowserSubmissionFormSchema', schema),
    schemaEvidenceHashes: [sha('2')],
    automationPolicyEvidenceHash: sha('3'),
    portalBindingEvidenceHashes: [sha('4')],
    statusMappingHash: sha('5'),
    enabledOperations: [
      'createDraft', 'discoverProfile', 'fillMetadata', 'getStatus', 'preview',
      'reconcile', 'uploadAssets', 'validate',
    ],
    termsAutomationPermitted: false,
    verifiedAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2027-08-01T00:00:00.000Z',
  });
  const pdfBytes = Buffer.from('%PDF-1.7\nplaywright fixture\n');
  const pdfHash = hashBytes(pdfBytes);
  const envelope = buildSubmissionEnvelope({
    campaignId: 'campaign-browser',
    paperId: 'paper-browser',
    venueId: 'cvpr',
    requestHash: sha('6'),
    portalBindingHash: binding.submissionPortalBindingHash,
    compiledPdfHash: pdfHash,
    title: 'Browser-assisted draft fixture',
    abstract: 'The final submit action remains human-only.',
    articleType: 'research_article',
    keywords: ['browser', 'draft'],
    authors: [{
      authorId: 'author-1',
      givenName: 'Katherine',
      familyName: 'Johnson',
      displayName: 'Katherine Johnson',
      emailReference: 'identity:author-1:email',
      orcid: null,
      affiliations: [{
        affiliationId: 'affiliation-1',
        displayName: 'Orbital Mechanics Laboratory',
        rorId: null,
        ringgoldId: null,
        countryCode: 'US',
      }],
      creditRoles: ['Methodology'],
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
  return {
    schema,
    target,
    binding,
    envelope,
    assets: [{ fileId: 'paper-pdf', bytes: pdfBytes }],
  };
}

function runtime(schema, { mfaOnDraft = false } = {}) {
  const calls = [];
  const browser = Object.freeze({
    kind: 'SubmissionBrowserSessionPort',
    browserEngine: 'playwright',
    networkPolicy: 'provider-scoped',
    credentialIsolation: true,
    selectorPolicy: 'semantic-versioned-fail-closed',
    captchaBypassPermitted: false,
    finalCommitAutomationPermitted: false,
    async probe(input) {
      calls.push(['probe', input]);
      return { ready: true, externalActionPerformed: false };
    },
    async discoverForm(input) {
      calls.push(['discover', input]);
      return schema;
    },
    async createDraft(input) {
      calls.push(['draft', input]);
      return mfaOnDraft
        ? { mfaRequired: true, externalActionPerformed: false }
        : {
          remoteDraftId: 'draft-42',
          externalActionPerformed: true,
          finalCommitPerformed: false,
        };
    },
    async fillFields(input) {
      calls.push(['fill', input]);
      return { saved: true, finalCommitPerformed: false };
    },
    async uploadFiles(input) {
      calls.push(['upload', input]);
      return { saved: true, finalCommitPerformed: false };
    },
    async capturePreview(input) {
      calls.push(['preview', input]);
      return { previewEvidenceHash: sha('7'), finalCommitPerformed: false };
    },
    async getStatus(input) {
      calls.push(['status', input]);
      return { status: 'incomplete' };
    },
    async reconcile(input) {
      calls.push(['reconcile', input]);
      return { status: 'incomplete' };
    },
    async handoffToHuman(input) {
      calls.push(['handoff', input]);
      return { handoffReference: 'handoff-1' };
    },
  });
  return {
    calls,
    connector: createPlaywrightAssistedSubmissionConnector({
      browser,
      clock: { now: () => new Date('2026-07-24T00:00:00.000Z') },
    }),
  };
}

test('browser-assisted connector reaches a review page but has no final-submit path', async () => {
  const value = fixture();
  const runtimeValue = runtime(value.schema);
  const common = {
    envelope: value.envelope,
    baseTargetProfile: value.target,
    portalBinding: value.binding,
  };
  assert.equal((await runtimeValue.connector.probeReadiness(common))
    .productionEligible, false);
  assert.equal((await runtimeValue.connector.validate(common)).status,
    'submission_browser_schema_validated');
  const draft = await runtimeValue.connector.createDraft(common);
  assert.equal(draft.remoteDraftId, 'draft-42');
  assert.equal((await runtimeValue.connector.uploadAssets({
    ...common,
    remoteDraftId: draft.remoteDraftId,
    assets: value.assets,
  })).finalCommitPerformed, false);
  assert.equal((await runtimeValue.connector.fillMetadata({
    ...common,
    remoteDraftId: draft.remoteDraftId,
  })).finalCommitPerformed, false);
  const preview = await runtimeValue.connector.preview({
    ...common,
    remoteDraftId: draft.remoteDraftId,
  });
  assert.equal(preview.status, 'submission_browser_review_page_ready');
  await assert.rejects(
    runtimeValue.connector.commit(common),
    /submission_browser_final_commit_human_only/,
  );
  assert.equal(
    runtimeValue.calls.some(([operation]) => operation === 'submit'),
    false,
  );
});

test('browser-assisted connector fails on DOM drift and hands MFA to a human', async () => {
  const value = fixture();
  const drifted = runtime({ ...value.schema, domFingerprint: 'changed' });
  await assert.rejects(
    drifted.connector.validate({
      envelope: value.envelope,
      baseTargetProfile: value.target,
      portalBinding: value.binding,
    }),
    /submission_browser_form_schema_drift/,
  );
  const mfa = runtime(value.schema, { mfaOnDraft: true });
  const result = await mfa.connector.createDraft({
    envelope: value.envelope,
    baseTargetProfile: value.target,
    portalBinding: value.binding,
  });
  assert.equal(result.status, 'submission_browser_human_handoff_required');
  assert.equal(result.reason, 'mfa');
  assert.equal(result.finalCommitPerformed, false);
  assert.equal(mfa.calls.some(([operation]) => operation === 'handoff'), true);
});
