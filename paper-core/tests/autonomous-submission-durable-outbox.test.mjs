import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  autonomousSubmissionAwareCampaignStatus,
  deliverAutonomousSubmission as deliverAutonomousSubmissionWithVerifier,
  evaluateAutonomousSubmissionDeliveryReadiness as
    evaluateAutonomousSubmissionDeliveryReadinessWithVerifier,
  inspectPersistedAutonomousSubmissionDelivery as
    inspectPersistedAutonomousSubmissionDeliveryWithVerifier,
} from '../../paper-application/automation/autonomous-submission-delivery.mjs';
import {
  recoverAutonomousResearchSubmission as recoverAutonomousResearchSubmissionWithVerifier,
} from '../../paper-application/automation/autonomous-research-submission-recovery.mjs';
import {
  buildAutonomousSubmissionPortalConfiguration,
  createHttpAutonomousSubmissionPortalAdapter,
  deriveAutonomousSubmissionPortalPublicConfiguration,
  readAutonomousSubmissionPortalConfiguration,
} from '../../paper-adapters/automation/http-autonomous-submission-portal-adapter.mjs';
import {
  autonomousSubmissionPortalPublicDescriptorHash,
} from '../../paper-adapters/automation/autonomous-submission-portal-public-adapter.mjs';
import {
  buildAutonomousSubmissionPortalIdentityAttestationBundle,
} from '../../paper-adapters/automation/autonomous-submission-portal-identity-attestation.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import {
  createAutonomousSubmissionOutboxRepository,
} from '../../paper-adapters/automation/autonomous-submission-outbox-repository.mjs';
import {
  createAutonomousSubmissionDispatchAuthority,
} from '../../paper-composition/automation/autonomous-submission-dispatch-authority-composition.mjs';
import {
  buildAutonomousSubmissionReceipt,
  verifyAutonomousSubmissionReceipt,
  verifyLegacyAutonomousSubmissionReceipt,
  verifyAutonomousSubmissionRequest,
} from '../../paper-domain/automation/autonomous-submission-contract.mjs';
import {
  buildAutonomousSubmissionAuthoritativeNotFoundReceipt,
  buildAutonomousSubmissionDeliveryStateReceipt,
  buildAutonomousSubmissionDispatchPermit,
  buildAutonomousSubmissionPortalLookupOutcome,
} from '../../paper-domain/automation/autonomous-submission-delivery-contract.mjs';
import {
  assertPinnedExternalEvidenceEnvelope,
  buildPinnedExternalEvidenceEnvelope,
  inspectPinnedExternalEvidenceTrustStore,
  pinnedExternalEvidenceSigningPayload,
} from '../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import {
  buildExternalPrincipalIdentityAttestationSubject,
} from '../../paper-domain/evidence/external-principal-identity-attestation-contract.mjs';
import {
  assertAutonomousSubmissionPortalPort,
} from '../../paper-ports/autonomous-submission-portal-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildAutonomousLiveSubmissionAuthorizationSubject,
} from '../../paper-domain/submission/autonomous-live-submission-authorization-contract.mjs';

const NOW = '2026-07-19T02:00:00.000Z';
const H = (label) => hashRecord('AutonomousSubmissionDurableOutboxTest', { label });
const submissionDispatchAuthority = createAutonomousSubmissionDispatchAuthority();
const portalSigningPair = crypto.generateKeyPairSync('ed25519');
const PORTAL_SIGNER_KEY_ID = 'durable-portal-key-1';
const PORTAL_SIGNER_ROLE = 'autonomous_submission_portal';
const identityAttestorSigningPair = crypto.generateKeyPairSync('ed25519');
const IDENTITY_ATTESTOR_KEY_ID = 'durable-identity-attestor-key-1';
const IDENTITY_ATTESTOR_ROLE = 'external_principal_identity_attestor';
const portalReceiptTrustStore = Object.freeze({
  version: 1,
  kind: 'AuthorityTrustStore',
  keys: Object.freeze([Object.freeze({
    keyId: PORTAL_SIGNER_KEY_ID,
    subjectId: 'durable-portal-authority',
    organization: 'Durable Portal Test Authority',
    algorithm: 'ed25519',
    publicKeyPem: portalSigningPair.publicKey.export({ type: 'spki', format: 'pem' }),
    roles: [PORTAL_SIGNER_ROLE],
    status: 'active',
    effectiveFrom: '2026-07-19T00:00:00.000Z',
    expiresAt: '2026-07-20T00:00:00.000Z',
    revokedAt: null,
  })]),
});
const identityAttestorTrustStore = Object.freeze({
  version: 1,
  kind: 'AuthorityTrustStore',
  keys: Object.freeze([Object.freeze({
    keyId: IDENTITY_ATTESTOR_KEY_ID,
    subjectId: 'durable-identity-attestor',
    organization: 'Durable Identity Attestor',
    algorithm: 'ed25519',
    publicKeyPem: identityAttestorSigningPair.publicKey.export({
      type: 'spki', format: 'pem',
    }),
    roles: [IDENTITY_ATTESTOR_ROLE],
    status: 'active',
    effectiveFrom: '2026-07-19T00:00:00.000Z',
    expiresAt: '2026-07-20T00:00:00.000Z',
    revokedAt: null,
  })]),
});
const PORTAL_SIGNER_SPKI_HASH = inspectPinnedExternalEvidenceTrustStore(
  portalReceiptTrustStore,
  { requiredRole: PORTAL_SIGNER_ROLE, expectedKeyIds: [PORTAL_SIGNER_KEY_ID] },
).keys[0].publicKeySpkiHash;

const submissionRequestVerifier = Object.freeze({
  version: 1,
  kind: 'AutonomousSubmissionRequestVerifier',
  verify(request) {
    const { requestHash, ...payload } = request || {};
    return requestHash === hashRecord('AutonomousSubmissionRequest', payload);
  },
  verifyHumanAuthorization() { return true; },
});

function deliverAutonomousSubmission(input) {
  return deliverAutonomousSubmissionWithVerifier({
    ...input,
    submissionRequestVerifier,
  });
}

function evaluateAutonomousSubmissionDeliveryReadiness(input) {
  return evaluateAutonomousSubmissionDeliveryReadinessWithVerifier({
    ...input,
    submissionRequestVerifier,
  });
}

function inspectPersistedAutonomousSubmissionDelivery(input) {
  return inspectPersistedAutonomousSubmissionDeliveryWithVerifier({
    ...input,
    submissionRequestVerifier,
  });
}

function recoverAutonomousResearchSubmission(input) {
  return recoverAutonomousResearchSubmissionWithVerifier({
    ...input,
    submissionRequestVerifier,
  });
}

function requestFixture(portalConfiguration = null) {
  const configuration = portalConfiguration && typeof portalConfiguration === 'object'
    ? portalConfiguration : null;
  const portalConfigurationHash = configuration?.configurationHash
    || portalConfiguration || H('portal-configuration');
  const portalId = configuration?.portalId || 'durable-portal';
  const portalServiceIdentityHash = configuration?.serviceIdentityHash
    || H('fixture-portal-service');
  const portalAccountIdentityHash = configuration?.portalAccountIdentityHash
    || H('portal-account');
  const portalTrustDomainIdentityHash = configuration?.portalTrustDomainIdentityHash
    || H('portal-trust-domain');
  const portalDescriptorHash = configuration
    ? autonomousSubmissionPortalPublicDescriptorHash(
      deriveAutonomousSubmissionPortalPublicConfiguration({ configuration }),
    ) : H('portal-descriptor');
  const idempotencyPayload = {
    immutableCampaignPackageOutputHash: H('package'),
    venueId: 'durable-journal',
    campaignReleaseBundleHash: H('release'),
    venueProfileHash: H('venue-profile'),
    qualificationReceiptHash: H('qualification'),
    submissionMetadataReceiptHash: H('metadata'),
    venueComplianceReceiptHash: H('compliance'),
    researchClosureReceiptHash: H('research-closure'),
    portalConfigurationHash,
  };
  const authorizationSubject = buildAutonomousLiveSubmissionAuthorizationSubject({
    campaignId: 'campaign-durable-1',
    paperId: 'paper-durable-1',
    immutableCampaignPackageOutputHash:
      idempotencyPayload.immutableCampaignPackageOutputHash,
    campaignReleaseBundleHash: idempotencyPayload.campaignReleaseBundleHash,
    qualificationReceiptHash: idempotencyPayload.qualificationReceiptHash,
    researchClosureReceiptHash: idempotencyPayload.researchClosureReceiptHash,
    venueComplianceReceiptHash: idempotencyPayload.venueComplianceReceiptHash,
    submissionMetadataReceiptHash: idempotencyPayload.submissionMetadataReceiptHash,
    venueProfileSelectionHash: H('venue-selection'),
    venueId: idempotencyPayload.venueId,
    submissionPortalProfileId: 'durable-portal-v1',
    portalId,
    portalConfigurationHash,
    portalDescriptorHash,
    serviceIdentityHash: portalServiceIdentityHash,
    portalAccountIdentityHash,
    portalTrustDomainIdentityHash,
  });
  const authorizationDocument = {
    version: 1,
    kind: 'LiveSubmissionAuthorization',
    paperId: 'paper-durable-1',
    taskKey: 'campaign-durable-1',
    allowLiveExternalAction: true,
    environment: 'production',
    portalAction: 'submit_manuscript',
    singleUse: true,
    nonce: 'durable-human-permit-0001',
    provider: portalId,
    accountId: portalAccountIdentityHash,
    authorizationSubjectHash:
      authorizationSubject.liveSubmissionAuthorizationSubjectHash,
    signedAt: '2026-07-19T01:59:00.000Z',
    validFrom: '2026-07-19T01:59:00.000Z',
    expiresAt: '2026-07-19T02:30:00.000Z',
    responseDueAt: '2026-07-19T02:20:00.000Z',
    signatures: [
      { keyId: 'operator', role: 'submission_operator', algorithm: 'ed25519', value: 'fixture' },
      { keyId: 'executor', role: 'live_executor_authorizer', algorithm: 'ed25519', value: 'fixture' },
    ],
  };
  const signatureVerification = {
    status: 'authority_signatures_verified',
    cryptographicSignaturesVerified: true,
    requiredRoles: ['submission_operator', 'live_executor_authorizer'],
    requiredSignatureCount: 2,
    verifiedSignatures: [],
    verifiedRoles: ['live_executor_authorizer', 'submission_operator'],
    verifiedSubjectIds: ['durable-executor-authorizer', 'durable-submission-operator'],
    blockers: [],
  };
  const timeWindow = {
    valid: true,
    signedAt: authorizationDocument.signedAt,
    validFrom: authorizationDocument.validFrom,
    expiresAt: authorizationDocument.expiresAt,
    blockers: [],
  };
  const authorizationReport = {
    version: 2,
    kind: 'LiveSubmissionAuthorizationReceipt',
    authorizationMode: 'autonomous_submission_handoff',
    paperId: 'paper-durable-1',
    taskKey: 'campaign-durable-1',
    status: 'live_submission_authorization_verified',
    liveExternalActionAuthorized: true,
    cryptographicSignaturesVerified: true,
    authorizationPath: 'fixture/LIVE_SUBMISSION_AUTHORIZATION.json',
    authorizationSubject,
    authorizationSubjectHash:
      authorizationSubject.liveSubmissionAuthorizationSubjectHash,
    authorizationDocument,
    authorizationDocumentHash: hashRecord(
      'LiveSubmissionAuthorizationDocument', authorizationDocument,
    ),
    provider: portalId,
    accountId: portalAccountIdentityHash,
    portalRoute: 'durable-portal-v1',
    portalAction: 'submit_manuscript',
    environment: 'production',
    nonce: authorizationDocument.nonce,
    singleUse: true,
    signedAt: authorizationDocument.signedAt,
    validFrom: authorizationDocument.validFrom,
    expiresAt: authorizationDocument.expiresAt,
    authorizerSubjectIds: signatureVerification.verifiedSubjectIds,
    signatureVerification,
    timeWindow,
    consumed: false,
    responseDueAt: authorizationDocument.responseDueAt,
    blockers: [],
    safety: {
      humanReviewRequired: true,
      dualControlRequired: true,
      singleUseAuthorization: true,
      authorizationLifetimeHoursMaximum: 24,
      separatedDutiesEnforced: true,
      grantsExecutionInsideOverlay: false,
      externalActionPerformed: false,
    },
  };
  const humanAuthorizationReceipt = Object.freeze({
    ...authorizationReport,
    liveSubmissionAuthorizationReceiptHash: hashRecord(
      'LiveSubmissionAuthorizationReceipt', authorizationReport,
    ),
  });
  Object.assign(idempotencyPayload, {
    portalId,
    portalDescriptorHash,
    portalServiceIdentityHash,
    portalAccountIdentityHash,
    portalTrustDomainIdentityHash,
    humanAuthorizationReceiptHash:
      humanAuthorizationReceipt.liveSubmissionAuthorizationReceiptHash,
    humanAuthorizationSubjectHash:
      authorizationSubject.liveSubmissionAuthorizationSubjectHash,
    humanAuthorizationNonce: humanAuthorizationReceipt.nonce,
    humanAuthorizationExpiresAt: humanAuthorizationReceipt.expiresAt,
  });
  const payload = {
    version: 7,
    kind: 'AutonomousSubmissionRequest',
    campaignId: 'campaign-durable-1',
    paperId: 'paper-durable-1',
    venueId: idempotencyPayload.venueId,
    venueProfileHash: idempotencyPayload.venueProfileHash,
    venueProfileSelectionHash: H('venue-selection'),
    submissionPortalProfileId: 'durable-portal-v1',
    campaignReleaseBundleHash: idempotencyPayload.campaignReleaseBundleHash,
    immutableCampaignPackageOutputHash:
      idempotencyPayload.immutableCampaignPackageOutputHash,
    sourceSnapshotHash: H('source'),
    sourceTreeManifestHash: H('tree'),
    researchEvidenceCapsuleManifestHash: H('capsule'),
    researchClosureReceiptHash: idempotencyPayload.researchClosureReceiptHash,
    qualificationReceiptHash: idempotencyPayload.qualificationReceiptHash,
    venueComplianceReceiptHash: idempotencyPayload.venueComplianceReceiptHash,
    submissionMetadataReceiptHash: idempotencyPayload.submissionMetadataReceiptHash,
    renderedSourceHash: H('rendered'),
    compiledPdfHash: H('pdf'),
    independentRebuiltPdfHash: H('independent-pdf'),
    pageCount: 7,
    portalConfigurationHash: idempotencyPayload.portalConfigurationHash,
    portalId,
    portalDescriptorHash,
    portalServiceIdentityHash,
    portalAccountIdentityHash,
    portalTrustDomainIdentityHash,
    humanAuthorizationReceiptHash:
      humanAuthorizationReceipt.liveSubmissionAuthorizationReceiptHash,
    humanAuthorizationSubjectHash:
      authorizationSubject.liveSubmissionAuthorizationSubjectHash,
    humanAuthorizationNonce: humanAuthorizationReceipt.nonce,
    humanAuthorizationExpiresAt: humanAuthorizationReceipt.expiresAt,
    humanAuthorizationReceipt,
    idempotencyKey: hashRecord('AutonomousSubmissionIdempotencyKey', idempotencyPayload),
    humanApprovalPerformed: true,
    requestedAt: NOW,
  };
  return Object.freeze({
    ...payload,
    requestHash: hashRecord('AutonomousSubmissionRequest', payload),
  });
}

function resealRequest(request, patch = {}) {
  const { requestHash: _requestHash, ...payload } = request;
  const selected = { ...payload, ...patch };
  return Object.freeze({
    ...selected,
    requestHash: hashRecord('AutonomousSubmissionRequest', selected),
  });
}

function expiredAuthorizationRequest(request) {
  const receipt = structuredClone(request.humanAuthorizationReceipt);
  receipt.authorizationDocument.expiresAt = '2026-07-19T01:59:30.000Z';
  receipt.expiresAt = receipt.authorizationDocument.expiresAt;
  receipt.timeWindow.expiresAt = receipt.expiresAt;
  receipt.authorizationDocumentHash = hashRecord(
    'LiveSubmissionAuthorizationDocument', receipt.authorizationDocument,
  );
  delete receipt.liveSubmissionAuthorizationReceiptHash;
  receipt.liveSubmissionAuthorizationReceiptHash = hashRecord(
    'LiveSubmissionAuthorizationReceipt', receipt,
  );
  return resealRequest(request, {
    humanAuthorizationReceipt: receipt,
    humanAuthorizationReceiptHash: receipt.liveSubmissionAuthorizationReceiptHash,
    humanAuthorizationExpiresAt: receipt.expiresAt,
  });
}

function receiptFixture(request, suffix = '1') {
  return buildAutonomousSubmissionReceipt({
    request,
    requestVerifier: submissionRequestVerifier,
    portalSubmissionId: `submission-${suffix}`,
    portalAccountIdentityHash: H('portal-account'),
    portalTrustDomainIdentityHash: H('portal-trust-domain'),
    submissionArtifactManifestHash: H(`artifact-${suffix}`),
    signatureHash: H(`signature-${suffix}`),
    signatureVerificationReceiptHash: H(`signature-verification-${suffix}`),
    submittedAt: NOW,
  });
}

function closureRequestFixture() {
  const { requestHash: _requestHash, ...legacyPayload } = requestFixture();
  const payload = {
    ...legacyPayload,
    version: 6,
    researchClosureReceiptHash: H('research-closure'),
  };
  return Object.freeze({
    ...payload,
    requestHash: hashRecord('AutonomousSubmissionRequest', payload),
  });
}

function signedEnvelope({
  subjectKind,
  subjectHash,
  keyId,
  role,
  privateKey,
}) {
  const placeholder = buildPinnedExternalEvidenceEnvelope({
    subjectKind,
    subjectHash,
    signedAt: '2026-07-19T01:59:00.000Z',
    expiresAt: '2026-07-19T02:01:00.000Z',
    signatures: [{
      keyId,
      role,
      algorithm: 'ed25519',
      value: 'placeholder',
    }],
  });
  const value = crypto.sign(
    null,
    pinnedExternalEvidenceSigningPayload(placeholder),
    privateKey,
  ).toString('base64');
  return buildPinnedExternalEvidenceEnvelope({
    ...placeholder,
    signatures: [{
      keyId,
      role,
      algorithm: 'ed25519',
      value,
    }],
  });
}

function signedPortalEnvelope({ subjectKind, subjectHash }) {
  return signedEnvelope({
    subjectKind,
    subjectHash,
    keyId: PORTAL_SIGNER_KEY_ID,
    role: PORTAL_SIGNER_ROLE,
    privateKey: portalSigningPair.privateKey,
  });
}

function signedIdentityAttestationBundle(subject) {
  return buildAutonomousSubmissionPortalIdentityAttestationBundle({
    subject,
    authorityEnvelope: signedEnvelope({
      subjectKind: 'ExternalPrincipalIdentityAttestationSubject',
      subjectHash: subject.externalPrincipalIdentityAttestationSubjectHash,
      keyId: IDENTITY_ATTESTOR_KEY_ID,
      role: IDENTITY_ATTESTOR_ROLE,
      privateKey: identityAttestorSigningPair.privateKey,
    }),
    trustStore: identityAttestorTrustStore,
    signerKeyIds: [IDENTITY_ATTESTOR_KEY_ID],
    signerRole: IDENTITY_ATTESTOR_ROLE,
  });
}

function signedLookupEvidence({
  request,
  portalId = 'durable-portal',
  serviceIdentityHash = H('fixture-portal-service'),
  portalAccountIdentityHash = H('portal-account'),
  portalTrustDomainIdentityHash = H('portal-trust-domain'),
} = {}) {
  const remoteLookupOutcome = buildAutonomousSubmissionPortalLookupOutcome({
    request,
    portalId,
    portalConfigurationHash: request.portalConfigurationHash,
    serviceIdentityHash,
    portalAccountIdentityHash,
    portalTrustDomainIdentityHash,
    observedAt: NOW,
  });
  const authorityEnvelope = signedPortalEnvelope({
    subjectKind: 'AutonomousSubmissionPortalLookupOutcome',
    subjectHash: remoteLookupOutcome.autonomousSubmissionPortalLookupOutcomeHash,
  });
  const signatureVerificationReceipt = assertPinnedExternalEvidenceEnvelope({
    envelope: authorityEnvelope,
    subjectKind: 'AutonomousSubmissionPortalLookupOutcome',
    subjectHash: remoteLookupOutcome.autonomousSubmissionPortalLookupOutcomeHash,
    trustStore: portalReceiptTrustStore,
    requiredRole: PORTAL_SIGNER_ROLE,
    expectedKeyIds: [PORTAL_SIGNER_KEY_ID],
    now: new Date(NOW),
  });
  return Object.freeze({
    remoteLookupOutcome,
    authorityEnvelope,
    signatureVerificationReceipt,
  });
}

function fixture(t) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-autonomous-outbox-'));
  const store = createDefaultPaperStore({ root: runtimeRoot, runtimeRoot });
  const clock = Object.freeze({ now: () => new Date(NOW), nowIso: () => NOW });
  const receiptLedger = createSqliteReceiptLedger({ store, clock });
  const outbox = createAutonomousSubmissionOutboxRepository({
    store, receiptLedger, clock, submissionRequestVerifier,
    dispatchCapability: submissionDispatchAuthority.outbox,
  });
  t.after(() => {
    store.close();
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });
  return { store, receiptLedger, outbox, clock };
}

function portal(request, { submit, lookup }) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionPortalPort',
    portalId: 'durable-portal',
    configurationHash: request.portalConfigurationHash,
    idempotencyLookupSupported: true,
    singleUseDispatchCapabilityEnforced: true,
    authoritativeLookupCapabilityIssued: true,
    signedAuthoritativeLookupSupported: true,
    authoritativeNotFoundCryptographicAuthorityReady: true,
    signedCompletedReceiptSupported: false,
    cryptographicAuthorityReady: false,
    identityIndependenceReady: false,
    async submit(input) {
      submissionDispatchAuthority.portal.consumeDispatchPermit({
        permit: input?.sideEffectPermit,
        request: input?.request,
        portalId: 'durable-portal',
      });
      return submit(input);
    },
    async lookup(input) {
      const response = await lookup(input);
      if (response?.status !== 'autonomous_submission_portal_authoritative_not_found') {
        return response;
      }
      const evidence = signedLookupEvidence({ request });
      return Object.freeze({
        ...response,
        authoritativeNotFoundReceipt:
          submissionDispatchAuthority.portal.issueAuthoritativeNotFoundReceipt({
            request,
            portalId: 'durable-portal',
            ...evidence,
          }),
      });
    },
  });
}

function issueHttpDispatchPermit(request, portalId, label) {
  return submissionDispatchAuthority.outbox.issueDispatchPermit({
    request,
    portalId,
    attempt: 1,
    previousState: 'prepared',
    previousStateReceiptHash: H(`http-previous:${label}`),
    dispatchStateReceiptHash: H(`http-dispatch:${label}`),
    resolution: 'initial-dispatch',
  });
}

function authoritativeNotFound(request) {
  return Object.freeze({
    status: 'autonomous_submission_portal_authoritative_not_found',
    requestHash: request.requestHash,
    idempotencyKey: request.idempotencyKey,
    authoritative: true,
    externalActionPerformed: false,
  });
}

function submissionCampaign(request) {
  return Object.freeze({
    campaignId: request.campaignId,
    paperId: request.paperId,
    spec: Object.freeze({
      autonomousResearchPreparation: Object.freeze({
        autonomousSubmissionPortalConfigurationHash: request.portalConfigurationHash,
        venueProfileSelection: Object.freeze({
          requireExternalSubmission: true,
        }),
      }),
    }),
  });
}

test('durable autonomous submission writes intent before POST and duplicate calls do not resubmit', async (t) => {
  const { outbox, receiptLedger } = fixture(t);
  const request = requestFixture();
  const receipt = receiptFixture(request);
  let submits = 0;
  let lookups = 0;
  const adapter = portal(request, {
    async submit() { submits += 1; return receipt; },
    async lookup() { lookups += 1; return authoritativeNotFound(request); },
  });
  const first = await deliverAutonomousSubmission({ portal: adapter, outbox, request });
  assert.equal(first.status, 'autonomous_submission_delivery_completed');
  assert.equal(first.externalActionPerformed, true);
  assert.equal(submits, 1);
  assert.equal(lookups, 0);
  const second = await deliverAutonomousSubmission({ portal: adapter, outbox, request });
  assert.equal(second.receipt.autonomousSubmissionReceiptHash,
    receipt.autonomousSubmissionReceiptHash);
  assert.equal(submits, 1);
  assert.equal(lookups, 0);
  assert.equal(receiptLedger.list({
    stream: 'autonomous-submission-delivery', paperId: request.paperId,
  }).length, 3);
});

test('lost response persists unknown outcome and restart reconciles accepted receipt without POST', async (t) => {
  const { outbox } = fixture(t);
  const request = requestFixture();
  const accepted = receiptFixture(request, 'lost-response');
  let submits = 0;
  let acceptedRemotely = false;
  const adapter = portal(request, {
    async submit() {
      submits += 1;
      acceptedRemotely = true;
      const error = new Error('socket_closed_after_remote_accept');
      error.autonomousSubmissionOutcome = 'uncertain';
      throw error;
    },
    async lookup() {
      assert.equal(acceptedRemotely, true);
      return Object.freeze({
        status: 'autonomous_submission_portal_completed',
        requestHash: request.requestHash,
        idempotencyKey: request.idempotencyKey,
        authoritative: true,
        externalActionPerformed: true,
        receipt: accepted,
      });
    },
  });
  const uncertain = await deliverAutonomousSubmission({ portal: adapter, outbox, request });
  assert.equal(uncertain.status, 'autonomous_submission_delivery_uncertain');
  assert.equal(uncertain.lookupRequired, true);
  const recovered = await deliverAutonomousSubmission({ portal: adapter, outbox, request });
  assert.equal(recovered.status, 'autonomous_submission_delivery_completed');
  assert.equal(recovered.reconciled, true);
  assert.equal(submits, 1);
});

test('resident recovery discovers the campaign outbox and settles an uncertain delivery', async (t) => {
  const { outbox } = fixture(t);
  const request = requestFixture();
  const accepted = receiptFixture(request, 'resident-recovery');
  let submits = 0;
  let lookups = 0;
  const adapter = portal(request, {
    async submit() {
      submits += 1;
      const error = new Error('response_lost_after_accept');
      error.autonomousSubmissionOutcome = 'uncertain';
      throw error;
    },
    async lookup() {
      lookups += 1;
      return Object.freeze({
        status: 'autonomous_submission_portal_completed',
        requestHash: request.requestHash,
        idempotencyKey: request.idempotencyKey,
        authoritative: true,
        externalActionPerformed: true,
        receipt: accepted,
      });
    },
  });
  const uncertain = await deliverAutonomousSubmission({ portal: adapter, outbox, request });
  assert.equal(uncertain.lookupRequired, true);
  const statusInspection = inspectPersistedAutonomousSubmissionDelivery({
    outbox,
    campaignId: request.campaignId,
    paperId: request.paperId,
    portalConfigurationHash: request.portalConfigurationHash,
    portalId: adapter.portalId,
  });
  assert.equal(statusInspection.delivery.status,
    'autonomous_submission_delivery_uncertain');
  assert.equal(statusInspection.delivery.networkActionPerformed, false);
  const pendingReadiness = evaluateAutonomousSubmissionDeliveryReadiness({
    required: true,
    autonomousSubmission: statusInspection,
  });
  assert.equal(pendingReadiness.ready, false);
  assert.equal(autonomousSubmissionAwareCampaignStatus({
    campaignStatus: 'completed',
    qualificationEligibility: { fullAutomaticResearchWritingReady: true },
    submissionReadiness: pendingReadiness,
  }), 'autonomous_research_campaign_completed_submission_pending');
  assert.equal(outbox.listAutonomousSubmissionsForCampaign({
    campaignId: request.campaignId,
    paperId: request.paperId,
    portalId: adapter.portalId,
  }).length, 1);
  const recovered = await recoverAutonomousResearchSubmission({
    campaign: submissionCampaign(request),
    portal: adapter,
    outbox,
  });
  assert.equal(recovered.status, 'autonomous_research_submission_recovery_completed');
  assert.equal(recovered.ready, true);
  assert.equal(recovered.terminal, true);
  const completedStatus = inspectPersistedAutonomousSubmissionDelivery({
    outbox,
    campaignId: request.campaignId,
    paperId: request.paperId,
    portalConfigurationHash: request.portalConfigurationHash,
    portalId: adapter.portalId,
  });
  const completedReadiness = evaluateAutonomousSubmissionDeliveryReadiness({
    required: true,
    autonomousSubmission: completedStatus,
  });
  assert.equal(completedReadiness.ready, true);
  assert.equal(autonomousSubmissionAwareCampaignStatus({
    campaignStatus: 'completed',
    qualificationEligibility: { fullAutomaticResearchWritingReady: true },
    submissionReadiness: completedReadiness,
  }), 'autonomous_research_campaign_completed_and_qualified');
  assert.equal(submits, 1);
  assert.equal(lookups, 1);
});

test('crash before remote call requires a fresh human permit after authoritative not-found', async (t) => {
  const { outbox } = fixture(t);
  const request = requestFixture();
  const receipt = receiptFixture(request, 'crash-before');
  outbox.prepareAutonomousSubmission({ request, portalId: 'durable-portal' });
  outbox.beginAutonomousSubmissionAttempt({ request, portalId: 'durable-portal' });
  let lookups = 0;
  let submits = 0;
  await assert.rejects(deliverAutonomousSubmission({
    outbox,
    request,
    portal: portal(request, {
      async lookup() { lookups += 1; return authoritativeNotFound(request); },
      async submit({ request: posted }) {
        submits += 1;
        assert.equal(posted.requestHash, request.requestHash);
        assert.equal(posted.idempotencyKey, request.idempotencyKey);
        return receipt;
      },
    }),
  }), /autonomous_submission_human_authorization_already_consumed/);
  assert.equal(lookups, 1);
  assert.equal(submits, 0);
});

test('crash after remote accept leaves dispatching marker and restart queries instead of reposting', async (t) => {
  const { outbox } = fixture(t);
  const request = requestFixture();
  const accepted = receiptFixture(request, 'crash-after');
  let submits = 0;
  let remoteAccepted = false;
  const adapter = portal(request, {
    async submit() {
      submits += 1;
      remoteAccepted = true;
      const crash = new Error('simulated_process_crash_after_accept');
      crash.autonomousSubmissionCrashSimulation = true;
      throw crash;
    },
    async lookup() {
      assert.equal(remoteAccepted, true);
      return Object.freeze({
        status: 'autonomous_submission_portal_completed',
        requestHash: request.requestHash,
        idempotencyKey: request.idempotencyKey,
        authoritative: true,
        externalActionPerformed: true,
        receipt: accepted,
      });
    },
  });
  await assert.rejects(
    deliverAutonomousSubmission({ portal: adapter, outbox, request }),
    /simulated_process_crash_after_accept/,
  );
  assert.equal(outbox.getAutonomousSubmission({
    request, portalId: adapter.portalId,
  }).stateReceipt.state, 'dispatching');
  const recovered = await deliverAutonomousSubmission({ portal: adapter, outbox, request });
  assert.equal(recovered.status, 'autonomous_submission_delivery_completed');
  assert.equal(submits, 1);
});

test('unknown lookup fails closed and never blindly redrives', async (t) => {
  const { outbox } = fixture(t);
  const request = requestFixture();
  outbox.prepareAutonomousSubmission({ request, portalId: 'durable-portal' });
  outbox.beginAutonomousSubmissionAttempt({ request, portalId: 'durable-portal' });
  let submits = 0;
  const adapter = portal(request, {
    async submit() { submits += 1; return receiptFixture(request, 'forbidden-redrive'); },
    async lookup() { throw new Error('lookup_unavailable'); },
  });
  const first = await deliverAutonomousSubmission({ portal: adapter, outbox, request });
  const second = await deliverAutonomousSubmission({ portal: adapter, outbox, request });
  assert.equal(first.status, 'autonomous_submission_delivery_uncertain');
  assert.equal(second.status, 'autonomous_submission_delivery_uncertain');
  assert.equal(first.safeToRedriveWithoutLookup, false);
  assert.equal(submits, 0);
});

test('explicit rejection is terminal and outbox tampering fails closed', async (t) => {
  const { outbox, store } = fixture(t);
  const request = requestFixture();
  let submits = 0;
  const adapter = portal(request, {
    async submit() {
      submits += 1;
      const error = new Error('autonomous_submission_portal_http_failed:422');
      error.autonomousSubmissionOutcome = 'explicit_failure';
      error.httpStatus = 422;
      throw error;
    },
    async lookup() { throw new Error('lookup_must_not_run'); },
  });
  const failed = await deliverAutonomousSubmission({ portal: adapter, outbox, request });
  assert.equal(failed.status, 'autonomous_submission_delivery_explicit_failure');
  const failedSubmission = { request, delivery: failed, receipt: failed.receipt };
  const failedReadiness = evaluateAutonomousSubmissionDeliveryReadiness({
    required: true,
    autonomousSubmission: failedSubmission,
  });
  assert.equal(failedReadiness.ready, false);
  assert.equal(failedReadiness.terminalFailure, true);
  assert.equal(autonomousSubmissionAwareCampaignStatus({
    campaignStatus: 'completed',
    qualificationEligibility: { fullAutomaticResearchWritingReady: true },
    submissionReadiness: failedReadiness,
  }), 'autonomous_research_campaign_completed_submission_failed');
  await deliverAutonomousSubmission({ portal: adapter, outbox, request });
  assert.equal(submits, 1);
  const messageId = `autonomous-submission:${request.idempotencyKey}`;
  const row = store.query(
    'SELECT payload_json FROM submission_outbox WHERE message_id=?', [messageId],
  ).rows[0];
  const envelope = JSON.parse(row.payload_json);
  envelope.request.compiledPdfHash = H('tampered-pdf');
  assert.equal(store.run(
    'UPDATE submission_outbox SET payload_json=? WHERE message_id=?',
    [JSON.stringify(envelope), messageId],
  ).changes, 1);
  assert.throws(() => outbox.getAutonomousSubmission({ request }),
    /autonomous_submission_outbox_binding_invalid/);
  assert.equal(verifyAutonomousSubmissionRequest({
    ...request, submissionMetadataReceiptHash: H('wrong-metadata'),
  }), false);
});

test('HTTP portal lookup treats an unsigned 404 as uncertain and never mints redrive authority', async (t) => {
  const configuration = buildAutonomousSubmissionPortalConfiguration({
    portalId: 'durable-http-portal',
    endpoint: 'https://submission.example.test/submit',
    serviceIdentityHash: H('http-service'),
    portalAccountIdentityHash: H('portal-account'),
    portalTrustDomainIdentityHash: H('portal-trust-domain'),
    tokenEnvironmentVariable: 'DURABLE_HTTP_TOKEN',
  });
  const request = requestFixture(configuration);
  const observed = [];
  const adapter = createHttpAutonomousSubmissionPortalAdapter({
    configuration,
    environment: { DURABLE_HTTP_TOKEN: 'secret' },
    submissionRequestVerifier,
    dispatchCapability: submissionDispatchAuthority.portal,
    fetchImpl: async (url, init) => {
      observed.push({ url, init });
      return { ok: false, status: 404 };
    },
  });
  await assert.rejects(adapter.lookup({ request }), (error) => (
    error.message === 'autonomous_submission_portal_unsigned_not_found'
      && error.autonomousSubmissionOutcome === 'uncertain'
      && error.httpStatus === 404
  ));
  assert.equal(adapter.authoritativeLookupCapabilityIssued, false);
  assert.equal(adapter.signedAuthoritativeLookupSupported, false);
  assert.equal(observed[0].init.method, 'GET');
  assert.equal(observed[0].init.headers['idempotency-key'], request.idempotencyKey);
  const url = new URL(observed[0].url);
  assert.equal(url.searchParams.get('idempotencyKey'), request.idempotencyKey);
  assert.equal(url.searchParams.get('requestHash'), request.requestHash);

  const { outbox } = fixture(t);
  outbox.prepareAutonomousSubmission({ request, portalId: adapter.portalId });
  outbox.beginAutonomousSubmissionAttempt({ request, portalId: adapter.portalId });
  const first = await deliverAutonomousSubmission({ portal: adapter, outbox, request });
  const second = await deliverAutonomousSubmission({ portal: adapter, outbox, request });
  assert.equal(first.status, 'autonomous_submission_delivery_uncertain');
  assert.equal(second.status, 'autonomous_submission_delivery_uncertain');
  assert.equal(observed.some(({ init }) => init.method === 'POST'), false);
});

test('HTTP portal accepts pinned not-found evidence but redrive still needs fresh human authorization', async (t) => {
  const configuration = buildAutonomousSubmissionPortalConfiguration({
    version: 2,
    portalId: 'signed-durable-http-portal',
    endpoint: 'https://submission.example.test/submit',
    serviceIdentityHash: H('signed-http-service'),
    portalAccountIdentityHash: H('portal-account'),
    portalTrustDomainIdentityHash: H('portal-trust-domain'),
    tokenEnvironmentVariable: 'DURABLE_HTTP_TOKEN',
    receiptTrustStore: portalReceiptTrustStore,
    receiptSignerKeyIds: [PORTAL_SIGNER_KEY_ID],
    receiptSignerRole: PORTAL_SIGNER_ROLE,
  });
  const request = requestFixture(configuration);
  const evidence = signedLookupEvidence({
    request,
    portalId: configuration.portalId,
    serviceIdentityHash: configuration.serviceIdentityHash,
    portalAccountIdentityHash: configuration.portalAccountIdentityHash,
    portalTrustDomainIdentityHash: configuration.portalTrustDomainIdentityHash,
  });
  const adapter = createHttpAutonomousSubmissionPortalAdapter({
    configuration,
    environment: { DURABLE_HTTP_TOKEN: 'secret' },
    submissionRequestVerifier,
    dispatchCapability: submissionDispatchAuthority.portal,
    clock: { now: () => new Date(NOW) },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          requestHash: request.requestHash,
          portalId: configuration.portalId,
          serviceIdentityHash: configuration.serviceIdentityHash,
          portalAccountIdentityHash: configuration.portalAccountIdentityHash,
          portalTrustDomainIdentityHash: configuration.portalTrustDomainIdentityHash,
          externalActionPerformed: false,
          autonomousSubmissionPortalLookupOutcome: evidence.remoteLookupOutcome,
          authorityEnvelope: evidence.authorityEnvelope,
        };
      },
    }),
  });
  assert.equal(adapter.authoritativeLookupCapabilityIssued, true);
  assert.equal(adapter.authoritativeNotFoundCryptographicAuthorityReady, true);
  const lookup = await adapter.lookup({ request });
  assert.equal(lookup.status, 'autonomous_submission_portal_authoritative_not_found');
  assert.equal(lookup.cryptographicAuthorityVerified, true);

  const { outbox } = fixture(t);
  outbox.prepareAutonomousSubmission({ request, portalId: configuration.portalId });
  outbox.beginAutonomousSubmissionAttempt({ request, portalId: configuration.portalId });
  assert.throws(() => outbox.beginAutonomousSubmissionAttempt({
    request,
    portalId: configuration.portalId,
    authoritativeNotFoundReceipt: lookup.authoritativeNotFoundReceipt,
  }), /autonomous_submission_human_authorization_already_consumed/);
  assert.throws(() => outbox.beginAutonomousSubmissionAttempt({
    request,
    portalId: configuration.portalId,
    authoritativeNotFoundReceipt: lookup.authoritativeNotFoundReceipt,
  }), /autonomous_submission_authoritative_lookup_capability_invalid/);
});

test('HTTP portal v2 verifies pinned completed receipts for submit and lookup', async () => {
  const configuration = buildAutonomousSubmissionPortalConfiguration({
    version: 2,
    portalId: 'signed-completed-http-portal',
    endpoint: 'https://submission.example.test/submit',
    serviceIdentityHash: H('signed-completed-http-service'),
    portalAccountIdentityHash: H('portal-account'),
    portalTrustDomainIdentityHash: H('portal-trust-domain'),
    tokenEnvironmentVariable: 'DURABLE_HTTP_TOKEN',
    receiptTrustStore: portalReceiptTrustStore,
    receiptSignerKeyIds: [PORTAL_SIGNER_KEY_ID],
    receiptSignerRole: PORTAL_SIGNER_ROLE,
  });
  const request = requestFixture(configuration);
  const receipt = receiptFixture(request, 'signed-completed');
  const authorityEnvelope = signedPortalEnvelope({
    subjectKind: 'AutonomousSubmissionReceiptV5',
    subjectHash: receipt.autonomousSubmissionReceiptHash,
  });
  const observedMethods = [];
  const response = () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        requestHash: request.requestHash,
        portalId: configuration.portalId,
        serviceIdentityHash: configuration.serviceIdentityHash,
        portalAccountIdentityHash: configuration.portalAccountIdentityHash,
        portalTrustDomainIdentityHash: configuration.portalTrustDomainIdentityHash,
        externalActionPerformed: true,
        autonomousSubmissionReceipt: receipt,
        authorityEnvelope,
      };
    },
  });
  const adapter = createHttpAutonomousSubmissionPortalAdapter({
    configuration,
    environment: { DURABLE_HTTP_TOKEN: 'secret' },
    submissionRequestVerifier,
    dispatchCapability: submissionDispatchAuthority.portal,
    clock: { now: () => new Date(NOW) },
    fetchImpl: async (_url, init) => {
      observedMethods.push(init.method);
      return response();
    },
  });
  assert.equal(adapter.cryptographicAuthorityReady, true);
  assert.equal(adapter.signedCompletedReceiptSupported, true);
  assert.equal(adapter.identityIndependenceReady, false);
  const submitted = await adapter.submit({
    request,
    sideEffectPermit: issueHttpDispatchPermit(
      request, configuration.portalId, 'signed-completed-submit',
    ),
  });
  assert.equal(submitted.version, 6);
  assert.equal(submitted.cryptographicAuthorityReady, true);
  assert.equal(submitted.legacyReceiptHash,
    receipt.autonomousSubmissionReceiptHash);
  assert.equal(verifyAutonomousSubmissionReceipt(submitted, {
    request,
    requestVerifier: submissionRequestVerifier,
    requireCryptographicAuthority: true,
  }), false);
  assert.equal(verifyAutonomousSubmissionReceipt(submitted, {
    request,
    requestVerifier: submissionRequestVerifier,
    completedReceiptVerifier: adapter.completedReceiptVerifier,
    requireCryptographicAuthority: true,
  }), true);
  assert.equal(verifyAutonomousSubmissionReceipt(receipt, {
    request,
    requestVerifier: submissionRequestVerifier,
    completedReceiptVerifier: adapter.completedReceiptVerifier,
    requireCryptographicAuthority: true,
  }), false);
  const lookup = await adapter.lookup({ request });
  assert.equal(lookup.status, 'autonomous_submission_portal_completed');
  assert.equal(lookup.cryptographicAuthorityVerified, true);
  assert.equal(lookup.signatureVerificationReceipt.cryptographicAuthorityReady, true);
  assert.equal(lookup.receipt.version, 6);
  assert.equal(lookup.receipt.legacyReceiptHash,
    receipt.autonomousSubmissionReceiptHash);
  assert.deepEqual(observedMethods, ['POST', 'GET']);

  const unsignedAdapter = createHttpAutonomousSubmissionPortalAdapter({
    configuration,
    environment: { DURABLE_HTTP_TOKEN: 'secret' },
    submissionRequestVerifier,
    dispatchCapability: submissionDispatchAuthority.portal,
    clock: { now: () => new Date(NOW) },
    fetchImpl: async () => {
      const unsigned = response();
      return {
        ...unsigned,
        async json() {
          const document = await unsigned.json();
          delete document.authorityEnvelope;
          return document;
        },
      };
    },
  });
  await assert.rejects(unsignedAdapter.submit({
    request,
    sideEffectPermit: issueHttpDispatchPermit(
      request, configuration.portalId, 'unsigned-completed-submit',
    ),
  }), /pinned_external_evidence_verification_capability_invalid/);
});

test('HTTP portal v3 proves signed platform identity separation from local origins', async (t) => {
  const portalIdentity = buildExternalPrincipalIdentityAttestationSubject({
    serviceId: 'signed-identity-v3-portal',
    principalId: 'signed-identity-v3-principal',
    provider: 'durable-submission-provider',
    providerAccountIdentityHash: H('portal-account'),
    credentialRootIdentityHash: H('v3-portal-credential-root'),
    hostIdentityHash: H('v3-portal-host'),
    processIdentityHash: H('v3-portal-process'),
    trustDomainIdentityHash: H('portal-trust-domain'),
    signerPublicKeySpkiHash: PORTAL_SIGNER_SPKI_HASH,
    challengeHash: H('v3-portal-identity-challenge'),
    assuranceProfile: 'pinned-provider-account-and-platform-attestation-v1',
    attestedAt: '2026-07-19T01:58:00.000Z',
    expiresAt: '2026-07-19T02:02:00.000Z',
  });
  const localOriginIdentity = buildExternalPrincipalIdentityAttestationSubject({
    serviceId: 'local-research-origin',
    principalId: 'local-research-author',
    provider: 'local-research-provider',
    providerAccountIdentityHash: H('v3-origin-account'),
    credentialRootIdentityHash: H('v3-origin-credential-root'),
    hostIdentityHash: H('v3-origin-host'),
    processIdentityHash: H('v3-origin-process'),
    trustDomainIdentityHash: H('v3-origin-trust-domain'),
    signerPublicKeySpkiHash: H('v3-origin-signer-spki'),
    challengeHash: H('v3-origin-identity-challenge'),
    assuranceProfile: 'pinned-provider-account-and-platform-attestation-v1',
    attestedAt: '2026-07-19T01:58:00.000Z',
    expiresAt: '2026-07-19T02:02:00.000Z',
  });
  const portalIdentityBundle = signedIdentityAttestationBundle(portalIdentity);
  const localOriginBundle = signedIdentityAttestationBundle(localOriginIdentity);
  const configuration = buildAutonomousSubmissionPortalConfiguration({
    version: 3,
    portalId: portalIdentity.serviceId,
    endpoint: 'https://submission.example.test/submit',
    serviceIdentityHash: portalIdentity.externalPrincipalIdentityAttestationSubjectHash,
    portalAccountIdentityHash: portalIdentity.providerAccountIdentityHash,
    portalTrustDomainIdentityHash: portalIdentity.trustDomainIdentityHash,
    tokenEnvironmentVariable: 'DURABLE_HTTP_TOKEN',
    receiptTrustStore: portalReceiptTrustStore,
    receiptSignerKeyIds: [PORTAL_SIGNER_KEY_ID],
    receiptSignerRole: PORTAL_SIGNER_ROLE,
    portalIdentityAttestationBundle: portalIdentityBundle,
    localOriginIdentityAttestationBundles: [localOriginBundle],
  });
  const configurationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-portal-v3-config-'));
  t.after(() => fs.rmSync(configurationRoot, { recursive: true, force: true }));
  const configurationPath = path.join(configurationRoot, 'portal.json');
  fs.writeFileSync(configurationPath, JSON.stringify(configuration), { mode: 0o600 });
  assert.deepEqual(readAutonomousSubmissionPortalConfiguration({
    configPath: configurationPath,
  }), configuration);
  const request = requestFixture(configuration);
  const receipt = receiptFixture(request, 'signed-identity-v3');
  const authorityEnvelope = signedPortalEnvelope({
    subjectKind: 'AutonomousSubmissionReceiptV5',
    subjectHash: receipt.autonomousSubmissionReceiptHash,
  });
  const adapter = createHttpAutonomousSubmissionPortalAdapter({
    configuration,
    environment: { DURABLE_HTTP_TOKEN: 'secret' },
    submissionRequestVerifier,
    dispatchCapability: submissionDispatchAuthority.portal,
    clock: { now: () => new Date(NOW) },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          requestHash: request.requestHash,
          portalId: configuration.portalId,
          serviceIdentityHash: configuration.serviceIdentityHash,
          portalAccountIdentityHash: configuration.portalAccountIdentityHash,
          portalTrustDomainIdentityHash: configuration.portalTrustDomainIdentityHash,
          externalActionPerformed: true,
          autonomousSubmissionReceipt: receipt,
          authorityEnvelope,
        };
      },
    }),
  });
  assert.equal(adapter.cryptographicAuthorityReady, true);
  assert.equal(adapter.identityIndependenceReady, true);
  assert.match(adapter.trustSetHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(adapter.signatureVerificationPolicyHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(adapter.identitySeparationInspection
    .identitySeparationReceipt.requiredDistinctFields.length, 6);
  assert.equal(assertAutonomousSubmissionPortalPort(adapter, {
    requiredLocalOriginIdentitySubjectHashes: [
      localOriginIdentity.externalPrincipalIdentityAttestationSubjectHash,
    ],
  }), adapter);
  assert.throws(() => assertAutonomousSubmissionPortalPort(adapter, {
    requiredLocalOriginIdentitySubjectHashes: [H('rotated-author')],
  }), /autonomous_submission_portal_required_origin_identity_missing/);
  const completed = await adapter.submit({
    request,
    sideEffectPermit: issueHttpDispatchPermit(
      request, configuration.portalId, 'signed-identity-v3-submit',
    ),
  });
  assert.equal(completed.version, 6);

  const selfReportedIdentity = buildExternalPrincipalIdentityAttestationSubject({
    ...portalIdentity,
    assuranceProfile: 'operator-attested-external-principal-v1',
  });
  const selfReportedConfiguration = buildAutonomousSubmissionPortalConfiguration({
    ...configuration,
    serviceIdentityHash:
      selfReportedIdentity.externalPrincipalIdentityAttestationSubjectHash,
    portalIdentityAttestationBundle:
      signedIdentityAttestationBundle(selfReportedIdentity),
  });
  assert.throws(() => createHttpAutonomousSubmissionPortalAdapter({
    configuration: selfReportedConfiguration,
    environment: { DURABLE_HTTP_TOKEN: 'secret' },
    submissionRequestVerifier,
    dispatchCapability: submissionDispatchAuthority.portal,
    clock: { now: () => new Date(NOW) },
  }), /autonomous_submission_portal_identity_separation_invalid/);

  const selfAttestorKeyId = 'portal-self-identity-attestor';
  const selfAttestorTrustStore = Object.freeze({
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: Object.freeze([Object.freeze({
      keyId: selfAttestorKeyId,
      subjectId: 'portal-self-identity-attestor',
      organization: 'Portal Self Attestor',
      algorithm: 'ed25519',
      publicKeyPem: portalSigningPair.publicKey.export({ type: 'spki', format: 'pem' }),
      roles: [IDENTITY_ATTESTOR_ROLE],
      status: 'active',
      effectiveFrom: '2026-07-19T00:00:00.000Z',
      expiresAt: '2026-07-20T00:00:00.000Z',
      revokedAt: null,
    })]),
  });
  const selfAttestedBundle = buildAutonomousSubmissionPortalIdentityAttestationBundle({
    subject: portalIdentity,
    authorityEnvelope: signedEnvelope({
      subjectKind: 'ExternalPrincipalIdentityAttestationSubject',
      subjectHash: portalIdentity.externalPrincipalIdentityAttestationSubjectHash,
      keyId: selfAttestorKeyId,
      role: IDENTITY_ATTESTOR_ROLE,
      privateKey: portalSigningPair.privateKey,
    }),
    trustStore: selfAttestorTrustStore,
    signerKeyIds: [selfAttestorKeyId],
    signerRole: IDENTITY_ATTESTOR_ROLE,
  });
  const selfAttestedConfiguration = buildAutonomousSubmissionPortalConfiguration({
    ...configuration,
    portalIdentityAttestationBundle: selfAttestedBundle,
  });
  assert.throws(() => createHttpAutonomousSubmissionPortalAdapter({
    configuration: selfAttestedConfiguration,
    environment: { DURABLE_HTTP_TOKEN: 'secret' },
    submissionRequestVerifier,
    dispatchCapability: submissionDispatchAuthority.portal,
    clock: { now: () => new Date(NOW) },
  }), /autonomous_submission_identity_self_attestation_forbidden/);

  const collidingOrigin = buildExternalPrincipalIdentityAttestationSubject({
    ...localOriginIdentity,
    providerAccountIdentityHash: portalIdentity.providerAccountIdentityHash,
  });
  const collisionConfiguration = buildAutonomousSubmissionPortalConfiguration({
    ...configuration,
    localOriginIdentityAttestationBundles: [
      signedIdentityAttestationBundle(collidingOrigin),
    ],
  });
  assert.throws(() => createHttpAutonomousSubmissionPortalAdapter({
    configuration: collisionConfiguration,
    environment: { DURABLE_HTTP_TOKEN: 'secret' },
    submissionRequestVerifier,
    dispatchCapability: submissionDispatchAuthority.portal,
    clock: { now: () => new Date(NOW) },
  }), /external_principal_identity_not_distinct:providerAccount/);
});

test('v6 completed receipt survives SQLite restart and offline Ed25519 replay rejects resealed tamper', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-submission-v6-restart-'));
  const clock = Object.freeze({ now: () => new Date(NOW), nowIso: () => NOW });
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const configuration = buildAutonomousSubmissionPortalConfiguration({
    version: 2,
    portalId: 'restart-v6-portal',
    endpoint: 'https://submission.example.test/submit',
    serviceIdentityHash: H('restart-v6-service'),
    portalAccountIdentityHash: H('portal-account'),
    portalTrustDomainIdentityHash: H('portal-trust-domain'),
    tokenEnvironmentVariable: 'DURABLE_HTTP_TOKEN',
    receiptTrustStore: portalReceiptTrustStore,
    receiptSignerKeyIds: [PORTAL_SIGNER_KEY_ID],
    receiptSignerRole: PORTAL_SIGNER_ROLE,
  });
  const request = requestFixture(configuration);
  const legacyReceipt = receiptFixture(request, 'restart-v6');
  const authorityEnvelope = signedPortalEnvelope({
    subjectKind: 'AutonomousSubmissionReceiptV5',
    subjectHash: legacyReceipt.autonomousSubmissionReceiptHash,
  });
  const adapter = createHttpAutonomousSubmissionPortalAdapter({
    configuration,
    environment: { DURABLE_HTTP_TOKEN: 'secret' },
    submissionRequestVerifier,
    dispatchCapability: submissionDispatchAuthority.portal,
    clock,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          requestHash: request.requestHash,
          portalId: configuration.portalId,
          serviceIdentityHash: configuration.serviceIdentityHash,
          portalAccountIdentityHash: configuration.portalAccountIdentityHash,
          portalTrustDomainIdentityHash: configuration.portalTrustDomainIdentityHash,
          externalActionPerformed: true,
          autonomousSubmissionReceipt: legacyReceipt,
          authorityEnvelope,
        };
      },
    }),
  });
  let store = createDefaultPaperStore({ root: runtimeRoot, runtimeRoot });
  let ledger = createSqliteReceiptLedger({ store, clock });
  let outbox = createAutonomousSubmissionOutboxRepository({
    store,
    receiptLedger: ledger,
    clock,
    submissionRequestVerifier,
    dispatchCapability: submissionDispatchAuthority.outbox,
  });
  const delivered = await deliverAutonomousSubmission({
    portal: adapter,
    outbox,
    request,
  });
  assert.equal(delivered.status, 'autonomous_submission_delivery_completed');
  assert.equal(delivered.receipt.version, 6);
  assert.equal(delivered.receipt.legacyReceiptHash,
    legacyReceipt.autonomousSubmissionReceiptHash);
  store.close();

  store = createDefaultPaperStore({ root: runtimeRoot, runtimeRoot });
  ledger = createSqliteReceiptLedger({ store, clock });
  outbox = createAutonomousSubmissionOutboxRepository({
    store,
    receiptLedger: ledger,
    clock,
    submissionRequestVerifier,
    dispatchCapability: submissionDispatchAuthority.outbox,
  });
  const restarted = outbox.getAutonomousSubmission({
    request,
    portalId: configuration.portalId,
  });
  assert.equal(restarted.stateReceipt.submissionReceipt.version, 6);
  assert.equal(restarted.stateReceipt.submissionReceipt.cryptographicAuthorityReady, true);

  const messageId = `autonomous-submission:${request.idempotencyKey}`;
  const row = store.query(
    'SELECT payload_json FROM submission_outbox WHERE message_id=?', [messageId],
  ).rows[0];
  const stored = JSON.parse(row.payload_json);
  const wrapped = stored.stateReceipt.submissionReceipt;
  const signature = Buffer.from(wrapped.authorityEnvelope.signatures[0].value, 'base64');
  signature[0] ^= 0x01;
  wrapped.authorityEnvelope.signatures[0].value = signature.toString('base64');
  wrapped.authorityEnvelopeHash = hashRecord(
    'PinnedExternalEvidenceEnvelope', wrapped.authorityEnvelope,
  );
  const verificationReceipt = wrapped.signatureVerificationReceipt;
  verificationReceipt.envelopeHash = wrapped.authorityEnvelopeHash;
  delete verificationReceipt.pinnedExternalEvidenceVerificationReceiptHash;
  verificationReceipt.pinnedExternalEvidenceVerificationReceiptHash = hashRecord(
    'PinnedExternalEvidenceVerificationReceipt', verificationReceipt,
  );
  wrapped.signatureVerificationReceiptHash =
    verificationReceipt.pinnedExternalEvidenceVerificationReceiptHash;
  delete wrapped.autonomousSubmissionReceiptHash;
  wrapped.autonomousSubmissionReceiptHash = hashRecord(
    'AutonomousSubmissionReceiptV6', wrapped,
  );
  delete stored.stateReceipt.autonomousSubmissionDeliveryStateReceiptHash;
  stored.stateReceipt.autonomousSubmissionDeliveryStateReceiptHash = hashRecord(
    'AutonomousSubmissionDeliveryStateReceipt', stored.stateReceipt,
  );
  assert.equal(store.run(
    'UPDATE submission_outbox SET payload_json=? WHERE message_id=?',
    [JSON.stringify(stored), messageId],
  ).changes, 1);
  store.close();

  store = createDefaultPaperStore({ root: runtimeRoot, runtimeRoot });
  ledger = createSqliteReceiptLedger({ store, clock });
  outbox = createAutonomousSubmissionOutboxRepository({
    store,
    receiptLedger: ledger,
    clock,
    submissionRequestVerifier,
    dispatchCapability: submissionDispatchAuthority.outbox,
  });
  assert.throws(() => outbox.getAutonomousSubmission({
    request,
    portalId: configuration.portalId,
  }), /autonomous_submission_outbox_binding_invalid/);
  store.close();
});

test('HTTP portal classifies definite rejection separately from unknown remote outcome', async () => {
  const configuration = buildAutonomousSubmissionPortalConfiguration({
    portalId: 'durable-http-classification',
    endpoint: 'https://submission.example.test/submit',
    serviceIdentityHash: H('http-service-classification'),
    portalAccountIdentityHash: H('portal-account'),
    portalTrustDomainIdentityHash: H('portal-trust-domain'),
    tokenEnvironmentVariable: 'DURABLE_HTTP_TOKEN',
  });
  const request = requestFixture(configuration);
  const make = (status) => createHttpAutonomousSubmissionPortalAdapter({
    configuration,
    environment: { DURABLE_HTTP_TOKEN: 'secret' },
    submissionRequestVerifier,
    dispatchCapability: submissionDispatchAuthority.portal,
    clock: { now: () => new Date(NOW) },
    fetchImpl: async () => ({ ok: false, status }),
  });
  await assert.rejects(make(422).submit({
    request,
    sideEffectPermit: issueHttpDispatchPermit(
      request, configuration.portalId, 'explicit-rejection',
    ),
  }), (error) => (
    error.autonomousSubmissionOutcome === 'explicit_failure' && error.httpStatus === 422
  ));
  await assert.rejects(make(503).submit({
    request,
    sideEffectPermit: issueHttpDispatchPermit(
      request, configuration.portalId, 'uncertain-outcome',
    ),
  }), (error) => (
    error.autonomousSubmissionOutcome === 'uncertain' && error.httpStatus === 503
  ));
});

test('missing, expired, and mismatched human permits fail before any provider POST', async () => {
  const configuration = buildAutonomousSubmissionPortalConfiguration({
    portalId: 'durable-human-permit-negative',
    endpoint: 'https://submission.example.test/submit',
    serviceIdentityHash: H('human-permit-negative-service'),
    portalAccountIdentityHash: H('portal-account'),
    portalTrustDomainIdentityHash: H('portal-trust-domain'),
    tokenEnvironmentVariable: 'DURABLE_HTTP_TOKEN',
  });
  const request = requestFixture(configuration);
  let networkCalls = 0;
  const adapter = createHttpAutonomousSubmissionPortalAdapter({
    configuration,
    environment: { DURABLE_HTTP_TOKEN: 'secret' },
    submissionRequestVerifier,
    dispatchCapability: submissionDispatchAuthority.portal,
    clock: { now: () => new Date(NOW) },
    fetchImpl: async () => {
      networkCalls += 1;
      return { ok: false, status: 500 };
    },
  });
  const missing = resealRequest(request, {
    humanAuthorizationReceipt: null,
    humanAuthorizationReceiptHash: null,
  });
  const expired = expiredAuthorizationRequest(request);
  const mismatched = resealRequest(request, {
    humanAuthorizationSubjectHash: H('mismatched-human-authorization-subject'),
  });
  for (const candidate of [missing, expired, mismatched]) {
    await assert.rejects(adapter.submit({ request: candidate }),
      /autonomous_submission_portal_request_invalid/);
  }
  assert.equal(networkCalls, 0);
});

test('submission boundaries require an explicit trusted request verifier', async (t) => {
  const { store, receiptLedger, outbox, clock } = fixture(t);
  const request = requestFixture();
  assert.throws(() => createAutonomousSubmissionOutboxRepository({
    store,
    receiptLedger,
    clock,
    dispatchCapability: submissionDispatchAuthority.outbox,
  }), /submissionRequestVerifier/);

  const configuration = buildAutonomousSubmissionPortalConfiguration({
    portalId: 'missing-verifier-portal',
    endpoint: 'https://submission.example.test/submit',
    serviceIdentityHash: H('missing-verifier-service'),
    portalAccountIdentityHash: H('portal-account'),
    portalTrustDomainIdentityHash: H('portal-trust-domain'),
    tokenEnvironmentVariable: 'DURABLE_HTTP_TOKEN',
  });
  assert.throws(() => createHttpAutonomousSubmissionPortalAdapter({
    configuration,
    environment: { DURABLE_HTTP_TOKEN: 'secret' },
    dispatchCapability: submissionDispatchAuthority.portal,
    fetchImpl: async () => ({ ok: false, status: 404 }),
  }), /autonomous_submission_request_verifier_required/);
  await assert.rejects(deliverAutonomousSubmissionWithVerifier({
    portal: portal(request, {
      async submit() { return receiptFixture(request); },
      async lookup() { return authoritativeNotFound(request); },
    }),
    outbox,
    request,
  }), /autonomous_submission_request_verifier_required/);
});

test('v6 completion cannot persist a structurally valid legacy v5 receipt', () => {
  const request = closureRequestFixture();
  const legacyReceipt = receiptFixture(request, 'legacy-v5-for-closure');
  assert.equal(legacyReceipt.version, 5);
  assert.equal(verifyLegacyAutonomousSubmissionReceipt(legacyReceipt, {
    request,
    requestVerifier: submissionRequestVerifier,
  }), true, 'legacy parser remains available for the signed-v5 wrapping boundary');
  assert.equal(verifyAutonomousSubmissionReceipt(legacyReceipt, {
    request,
    requestVerifier: submissionRequestVerifier,
  }), false, 'a v6 request is never completed directly by a v5 receipt');
  assert.throws(() => buildAutonomousSubmissionDeliveryStateReceipt({
    request,
    portalId: 'durable-portal',
    state: 'completed',
    attempt: 1,
    resolution: 'remote-confirmed-completed',
    previousStateReceiptHash: H('v6-legacy-previous-state'),
    submissionReceipt: legacyReceipt,
    recordedAt: NOW,
    requestVerifier: submissionRequestVerifier,
  }), /autonomous_submission_delivery_state_receipt_invalid/);
});

test('restart outbox revalidates persisted requests against current trust authority', (t) => {
  const { store, receiptLedger, clock } = fixture(t);
  const request = requestFixture();
  let currentAuthorityHash = request.requestHash;
  const revocableVerifier = Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionRequestVerifier',
    verify(candidate) {
      return submissionRequestVerifier.verify(candidate)
        && candidate.requestHash === currentAuthorityHash;
    },
    verifyHumanAuthorization(input) {
      return submissionRequestVerifier.verifyHumanAuthorization(input);
    },
  });
  const firstProcess = createAutonomousSubmissionOutboxRepository({
    store,
    receiptLedger,
    clock,
    submissionRequestVerifier: revocableVerifier,
    dispatchCapability: submissionDispatchAuthority.outbox,
  });
  firstProcess.prepareAutonomousSubmission({
    request,
    portalId: 'durable-portal',
  });
  currentAuthorityHash = H('superseding-current-release-authority');

  const restartedProcess = createAutonomousSubmissionOutboxRepository({
    store,
    receiptLedger,
    clock,
    submissionRequestVerifier: revocableVerifier,
    dispatchCapability: submissionDispatchAuthority.outbox,
  });
  assert.throws(() => restartedProcess.listAutonomousSubmissionsForCampaign({
    campaignId: request.campaignId,
    paperId: request.paperId,
    portalId: 'durable-portal',
  }), /autonomous_submission_outbox_binding_invalid/);
});

test('HTTP lookup rejects stale authority before any network action', async () => {
  const configuration = buildAutonomousSubmissionPortalConfiguration({
    portalId: 'stale-authority-http-portal',
    endpoint: 'https://submission.example.test/submit',
    serviceIdentityHash: H('stale-authority-http-service'),
    portalAccountIdentityHash: H('portal-account'),
    portalTrustDomainIdentityHash: H('portal-trust-domain'),
    tokenEnvironmentVariable: 'DURABLE_HTTP_TOKEN',
  });
  const request = requestFixture(configuration);
  let networkCalls = 0;
  const staleAuthorityVerifier = Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionRequestVerifier',
    verify: () => false,
  });
  const adapter = createHttpAutonomousSubmissionPortalAdapter({
    configuration,
    environment: { DURABLE_HTTP_TOKEN: 'secret' },
    submissionRequestVerifier: staleAuthorityVerifier,
    dispatchCapability: submissionDispatchAuthority.portal,
    fetchImpl: async () => {
      networkCalls += 1;
      return { ok: false, status: 404 };
    },
  });
  await assert.rejects(adapter.lookup({ request }),
    /autonomous_submission_portal_request_invalid/);
  await assert.rejects(adapter.submit({ request }),
    /autonomous_submission_portal_request_invalid/);
  assert.equal(networkCalls, 0);
});

test('submission delivery contract rejects every short-circuit identity edge', () => {
  const request = requestFixture();
  const permitInput = {
    request,
    portalId: 'durable-portal',
    attempt: 1,
    previousState: 'prepared',
    previousStateReceiptHash: H('edge-previous-state'),
    dispatchStateReceiptHash: H('edge-dispatch-state'),
    resolution: 'initial-dispatch',
    authoritativeNotFoundReceiptHash: null,
    onlineMutationSideEffectPermitHash: null,
  };
  assert.match(
    buildAutonomousSubmissionDispatchPermit(permitInput)
      .autonomousSubmissionDispatchPermitHash,
    /^sha256:[0-9a-f]{64}$/,
  );
  for (const [label, patch] of [
    ['request hash', { request: { ...request, requestHash: null } }],
    ['idempotency key', { request: { ...request, idempotencyKey: null } }],
    ['portal configuration', {
      request: { ...request, portalConfigurationHash: null },
    }],
    ['portal id', { portalId: '' }],
    ['previous state receipt', { previousStateReceiptHash: null }],
    ['dispatch state receipt', { dispatchStateReceiptHash: null }],
    ['online mutation permit', { onlineMutationSideEffectPermitHash: '' }],
  ]) {
    assert.throws(
      () => buildAutonomousSubmissionDispatchPermit({ ...permitInput, ...patch }),
      /autonomous_submission_dispatch_permit_invalid/,
      label,
    );
  }

  const notFoundInput = {
    request,
    portalId: 'durable-portal',
    portalConfigurationHash: request.portalConfigurationHash,
    serviceIdentityHash: H('edge-service'),
    portalAccountIdentityHash: H('edge-account'),
    portalTrustDomainIdentityHash: H('edge-trust-domain'),
  };
  assert.match(
    buildAutonomousSubmissionAuthoritativeNotFoundReceipt(notFoundInput)
      .autonomousSubmissionAuthoritativeNotFoundReceiptHash,
    /^sha256:[0-9a-f]{64}$/,
  );
  for (const [label, patch] of [
    ['request hash', { request: { ...request, requestHash: null } }],
    ['idempotency key', { request: { ...request, idempotencyKey: null } }],
    ['service identity', { serviceIdentityHash: null }],
  ]) {
    assert.throws(
      () => buildAutonomousSubmissionAuthoritativeNotFoundReceipt({
        ...notFoundInput,
        ...patch,
      }),
      /autonomous_submission_authoritative_not_found_receipt_invalid/,
      label,
    );
  }

  const lookupInput = { ...notFoundInput, observedAt: NOW };
  for (const [label, patch] of [
    ['request hash', { request: { ...request, requestHash: null } }],
    ['idempotency key', { request: { ...request, idempotencyKey: null } }],
    ['portal id', { portalId: '' }],
    ['service identity', { serviceIdentityHash: null }],
    ['observation time', { observedAt: null }],
  ]) {
    assert.throws(
      () => buildAutonomousSubmissionPortalLookupOutcome({ ...lookupInput, ...patch }),
      /autonomous_submission_portal_lookup_outcome_invalid/,
      label,
    );
  }
});
