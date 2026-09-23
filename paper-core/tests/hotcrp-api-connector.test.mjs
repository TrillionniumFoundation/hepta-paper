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
  buildHotCrpSubmissionPlan,
  verifyHotCrpSubmissionPlan,
} from '../../paper-domain/submission/hotcrp-submission-plan.mjs';
import {
  createHotCrpApiConnector,
} from '../../paper-adapters/submission/hotcrp-api-connector.mjs';

const sha = (character) => `sha256:${character.repeat(64)}`;

function fixture() {
  const schema = Object.freeze({
    version: '2026-07-15',
    fields: Object.freeze(['title', 'abstract', 'authors', 'submission']),
  });
  const target = getJournalSubmissionTargetProfile('focs');
  const binding = buildSubmissionPortalBinding({
    baseTargetProfile: target,
    targetInstanceId: 'focs-2027-main',
    edition: '2027',
    track: 'main',
    connectorFamily: 'hotcrp-rest-v1',
    portalOrigin: 'https://focs27.hotcrp.com',
    submissionRoute: '/api/paper',
    authenticationMode: 'bearer-token',
    authenticationProfileHash: sha('1'),
    schemaFingerprintHash: hashRecord('HotCrpSubmissionSchema', schema),
    schemaEvidenceHashes: [sha('2')],
    automationPolicyEvidenceHash: sha('3'),
    portalBindingEvidenceHashes: [sha('4')],
    statusMappingHash: sha('5'),
    enabledOperations: [
      'commit', 'createDraft', 'discoverProfile', 'getReceipt', 'getStatus',
      'preview', 'reconcile', 'uploadAssets', 'validate',
    ],
    termsAutomationPermitted: true,
    verifiedAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2027-08-01T00:00:00.000Z',
  });
  const pdfBytes = Buffer.from('%PDF-1.7\nhotcrp fixture\n');
  const pdfHash = hashBytes(pdfBytes);
  const envelope = buildSubmissionEnvelope({
    campaignId: 'campaign-hotcrp',
    paperId: 'paper-hotcrp',
    venueId: 'focs',
    requestHash: sha('6'),
    portalBindingHash: binding.submissionPortalBindingHash,
    compiledPdfHash: pdfHash,
    title: 'HotCRP contract fixture',
    abstract: 'A deterministic draft and commit fixture.',
    articleType: 'research_article',
    keywords: ['verification'],
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
  return {
    schema,
    target,
    binding,
    envelope,
    pdfBytes,
    assets: [{ fileId: 'paper-pdf', bytes: pdfBytes }],
  };
}

function runtime(schema) {
  const calls = [];
  let status = 'draft';
  const client = Object.freeze({
    kind: 'HotCrpClientPort',
    networkPolicy: 'hotcrp-only',
    credentialIsolation: true,
    async probe() {
      calls.push(['probe']);
      return { email: 'author@example.test' };
    },
    async getSubmissionSchema() {
      calls.push(['schema']);
      return schema;
    },
    async savePaper(input) {
      calls.push(['save', input]);
      status = input.paper.status;
      if (input.dryRun) {
        return {
          ok: true, valid: true, dry_run: true, message_list: [], change_list: [],
        };
      }
      return {
        ok: true,
        valid: true,
        pid: 42,
        message_list: [],
        paper: { pid: 42, status },
      };
    },
    async getPaper({ paperId }) {
      calls.push(['get', paperId]);
      return { pid: paperId, status, modified_at: 1_800_000_000 };
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
        email: 'ada@example.test',
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
    connector: createHotCrpApiConnector({
      client,
      identityResolver,
      commitPermitAuthority,
      clock: { now: () => new Date('2026-07-24T00:00:00.000Z') },
    }),
  };
}

test('HotCRP plan maps a canonical envelope and requires draft identity before commit', () => {
  const value = fixture();
  const plan = buildHotCrpSubmissionPlan({
    envelope: value.envelope,
    baseTargetProfile: value.target,
    portalBinding: value.binding,
    operation: 'validate',
  });
  assert.equal(verifyHotCrpSubmissionPlan(plan, {
    envelope: value.envelope,
    baseTargetProfile: value.target,
    portalBinding: value.binding,
  }), true);
  assert.equal(plan.paperObjectTemplate.pid, 'new');
  assert.equal(plan.paperObjectTemplate.status, 'draft');
  assert.equal(plan.dryRun, true);
  assert.throws(() => buildHotCrpSubmissionPlan({
    envelope: value.envelope,
    baseTargetProfile: value.target,
    portalBinding: value.binding,
    operation: 'commit',
    commitAuthorizationHash: sha('9'),
  }), /hotcrp_commit_binding_invalid/);
});

test('HotCRP connector dry-runs, creates a draft, then commits with one permit and read-after-write', async () => {
  const value = fixture();
  const runtimeValue = runtime(value.schema);
  const common = {
    envelope: value.envelope,
    baseTargetProfile: value.target,
    portalBinding: value.binding,
    assets: value.assets,
  };
  const validationPlan = buildHotCrpSubmissionPlan({
    ...common,
    operation: 'validate',
  });
  const validation = await runtimeValue.connector.validate({
    ...common, plan: validationPlan,
  });
  assert.equal(validation.status, 'hotcrp_dry_run_validated');
  assert.equal(validation.externalActionPerformed, false);

  const draftPlan = buildHotCrpSubmissionPlan({
    ...common,
    operation: 'draft',
  });
  const draft = await runtimeValue.connector.createDraft({
    ...common, plan: draftPlan,
  });
  assert.equal(draft.remotePaperId, 42);
  assert.equal(draft.remoteStatus, 'draft');
  assert.equal(draft.readAfterWriteVerified, true);
  assert.equal(draft.productionEligible, false);

  const commitPlan = buildHotCrpSubmissionPlan({
    ...common,
    operation: 'commit',
    remotePaperId: draft.remotePaperId,
    ifUnmodifiedSince: 1_800_000_000,
    commitAuthorizationHash: sha('9'),
  });
  const committed = await runtimeValue.connector.commit({
    ...common,
    plan: commitPlan,
    commitPermit: 'single-use-permit',
  });
  assert.equal(runtimeValue.permits.length, 1);
  assert.equal(committed.remoteStatus, 'submitted');
  assert.equal(committed.readAfterWriteVerified, true);
  assert.equal(committed.productionEligible, false);
  assert.equal(
    runtimeValue.calls.filter(([operation]) => operation === 'save').length,
    3,
  );
});

test('HotCRP readiness detects schema drift and remains non-production', async () => {
  const value = fixture();
  const good = runtime(value.schema);
  const readiness = await good.connector.probeReadiness({
    portalBinding: value.binding,
    baseTargetProfile: value.target,
  });
  assert.equal(readiness.productionEligible, false);
  const drifted = runtime({ ...value.schema, fields: ['changed'] });
  await assert.rejects(drifted.connector.probeReadiness({
    portalBinding: value.binding,
    baseTargetProfile: value.target,
  }), /hotcrp_submission_schema_drift/);
});
