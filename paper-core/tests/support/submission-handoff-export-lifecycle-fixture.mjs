import {
  createSqliteSubmissionDeliveryStore,
} from '../../../paper-adapters/submission/sqlite-delivery-store.mjs';
import {
  createSqliteCampaignReleaseAuthorityRepository,
} from '../../../paper-adapters/persistence/sqlite-campaign-release-authority-repository.mjs';
import {
  sqlJson,
  sqlText,
} from '../../../paper-adapters/submission/sqlite-delivery-persistence.mjs';
import {
  buildControlledExternalExecutorReceipt,
  buildExternalExecutorHandoffOutbox,
  buildReviewedSubmitPreflightPacket,
} from '../../../paper-domain/contracts/submission.mjs';
import {
  hashPaperRecord,
} from '../../../paper-domain/contracts/primitives.mjs';
import {
  buildSubmissionDispatchAuthorization,
} from '../../../paper-domain/submission/delivery-runtime.mjs';
import {
  buildReviewedSubmissionDecisionPacket,
} from '../../../paper-domain/submission/reviewed-submission-decision.mjs';
import {
  resolveReceiptIssuerPolicy,
} from '../../../paper-domain/evidence/receipt-issuer-policy-registry.mjs';
import { hashRecord } from '../../../workflow-kernel/record-hash.mjs';
export {
  assertSubmissionHandoffDetachedRecoveryConsistency,
} from './submission-handoff-recovery-consistency.mjs';

export function createCampaignReleaseAuthorityRepositoryFixture(options) {
  return createSqliteCampaignReleaseAuthorityRepository(options);
}

function fixtureHash(label) {
  return hashRecord('SubmissionHandoffExportLifecycleFixtureHash', { label });
}

function paperRecord(kind, hashField, payload, extras = {}) {
  return Object.freeze({
    ...payload,
    [hashField]: hashPaperRecord(kind, payload),
    ...extras,
  });
}

export function buildSubmissionHandoffExportLifecycleFixture({
  artifactPackage,
  campaignId,
  manuscriptPromotionGate,
  now = new Date(),
} = {}) {
  if (!artifactPackage?.artifactPackageHash || !artifactPackage?.paperId
      || !artifactPackage?.taskKey) {
    throw new Error('submission_handoff_export_fixture_artifact_package_required');
  }
  if (!campaignId || manuscriptPromotionGate?.status
      !== 'manuscript_promotion_ready') {
    throw new Error('submission_handoff_export_fixture_release_binding_required');
  }
  const observedAt = new Date(now);
  if (!Number.isFinite(observedAt.getTime())) {
    throw new Error('submission_handoff_export_fixture_time_invalid');
  }
  const createdAt = new Date(observedAt.getTime() - 60_000).toISOString();
  const responseDueAt = new Date(
    observedAt.getTime() + (24 * 60 * 60 * 1_000),
  ).toISOString();
  const paperId = artifactPackage.paperId;
  const taskKey = artifactPackage.taskKey;
  const paperTask = Object.freeze({ paperId, taskKey });
  const manifestPayload = {
    version: 1,
    kind: 'PaperActionManifest',
    paperId,
    taskKey,
    action: 'reviewed-submit',
    status: 'ready_for_adapter',
    readyForAdapter: true,
    payload: {
      artifactPackageHash: artifactPackage.artifactPackageHash,
      manuscriptPromotionGateHash:
        manuscriptPromotionGate.manuscriptPromotionGateHash,
    },
    blockers: [],
    safety: { executesExternalAction: false },
  };
  const sealedManifest = paperRecord(
    'PaperActionManifest',
    'manifestHash',
    manifestPayload,
  );
  const manifest = Object.freeze({
    ...sealedManifest,
    hash: sealedManifest.manifestHash,
  });
  const handoff = paperRecord('PaperHandoffEnvelope', 'envelopeHash', {
    version: 1,
    kind: 'PaperHandoffEnvelope',
    paperId,
    taskKey,
    action: 'reviewed-submit',
    status: 'dry_run_ready',
    readyForExecution: false,
    manifestHash: manifest.manifestHash,
    blockers: [],
    commandPreview: 'reviewed-submit --dry-run',
    safety: { executesExternalAction: false },
  });
  const replayGuard = paperRecord(
    'SubmissionReplayGuard',
    'submissionReplayGuardHash',
    {
      version: 1,
      kind: 'SubmissionReplayGuard',
      paperId,
      taskKey,
      action: 'reviewed-submit',
      status: 'dry_run_replay_allowed',
      manifestHash: manifest.manifestHash,
      replayKey: fixtureHash('replay-key'),
      blockers: [],
      safety: {
        grantsExecutionPermission: false,
        externalActionPerformed: false,
      },
    },
  );
  const outbox = buildExternalExecutorHandoffOutbox({
    manifest,
    handoff,
    replayGuard,
    createdAt,
  });
  const venuePlan = Object.freeze({
    status: 'local_dry_run_ready',
    venueSubmissionPlanHash: fixtureHash('venue-plan'),
  });
  const submissionDecisionPacket = buildReviewedSubmissionDecisionPacket({
    paperTask,
    venuePlan,
    metadata: Object.freeze({
      title: 'Reviewed production export fixture',
      abstract: 'A complete reviewed production export fixture.',
      authors: Object.freeze([{ name: 'Fixture Author' }]),
      track: 'main',
      anonymity: 'double_blind',
      keywords: Object.freeze(['verification']),
      subjectAreas: Object.freeze(['systems']),
      conflicts: Object.freeze([]),
      supplements: Object.freeze([]),
      checklist: Object.freeze({ reproducibility: true }),
      coverLetter: 'Please consider this verified manuscript.',
    }),
    review: Object.freeze({
      reviewedBy: 'human-operator',
      reviewedAt: createdAt,
      reviewActorType: 'human',
      humanConfirmedFields: Object.freeze([
        'title', 'abstract', 'authors', 'track', 'anonymity', 'keywords',
        'subjectAreas', 'conflicts', 'supplements', 'checklist', 'coverLetter',
      ]),
    }),
  });
  const approvalPacket = Object.freeze({
    kind: 'SubmissionApprovalPacket',
    status: 'approved_for_external_executor_handoff',
    approved: true,
    agentApproved: true,
    approvalHash: fixtureHash('approval'),
    blockers: Object.freeze([]),
  });
  const freshVenueEvidenceBundle = Object.freeze({
    kind: 'FreshVenueEvidenceBundle',
    status: 'fresh_venue_evidence_ready',
    freshVenueEvidenceBundleHash: fixtureHash('fresh-venue-evidence'),
    blockers: Object.freeze([]),
  });
  const independentReviewAuthorityReceipt = Object.freeze({
    status: 'independent_referee_acceptance_verified',
    independentRefereeAuthorityReceiptHash: fixtureHash('independent-review'),
  });
  const semanticPromotionLock = Object.freeze({
    status: 'semantic_promotion_unlocked',
    semanticPromotionLockHash: fixtureHash('semantic-promotion-lock'),
  });
  const provider = 'reviewed-provider';
  const accountId = 'reviewed-account';
  const portalRoute = '/reviewed-submit';
  const executorDescriptor = Object.freeze({
    kind: 'SubmissionExecutorDescriptor',
    executorId: 'reviewed-executor',
    provider,
    accountId,
    capabilitiesHash: fixtureHash('executor-capabilities'),
    submissionExecutorDescriptorHash: fixtureHash('executor-descriptor'),
  });
  const providerCapabilityReceiptPayload = {
    version: 1,
    kind: 'ProviderCapabilityVerificationReceipt',
    status: 'provider_capability_verified',
    provider,
    accountId,
    portalRoute,
    executorDescriptorHash:
      executorDescriptor.submissionExecutorDescriptorHash,
    capabilitiesHash: executorDescriptor.capabilitiesHash,
    attestationHash: fixtureHash('attestation'),
    verifiedSubjectIds: Object.freeze(['reviewed-provider-authority']),
    cryptographicSignaturesVerified: true,
    validFrom: new Date(
      observedAt.getTime() - (24 * 60 * 60 * 1_000),
    ).toISOString(),
    expiresAt: new Date(
      observedAt.getTime() + (48 * 60 * 60 * 1_000),
    ).toISOString(),
    blockers: Object.freeze([]),
  };
  const providerCapabilityVerificationReceipt = Object.freeze({
    ...providerCapabilityReceiptPayload,
    providerCapabilityVerificationReceiptHash:
      hashRecord(
        'ProviderCapabilityVerificationReceipt',
        providerCapabilityReceiptPayload,
      ),
  });
  const reviewedVenueEvidence = Object.freeze({
    status: 'reviewed_venue_evidence_verified',
    reviewedVenueEvidenceHash: fixtureHash('reviewed-venue-evidence'),
    sourceVerificationReceiptHash: fixtureHash('venue-source-receipt'),
    observationSubjectHash: fixtureHash('venue-observation-subject'),
    portalRoute,
  });
  const liveAuthorizationReceipt = Object.freeze({
    status: 'live_submission_authorization_verified',
    liveExternalActionAuthorized: true,
    liveSubmissionAuthorizationReceiptHash: fixtureHash('live-authorization'),
    provider,
    accountId,
    nonce: 'reviewed-nonce',
    responseDueAt,
    authorizationSubject: Object.freeze({
      artifactPackageHash: artifactPackage.artifactPackageHash,
      executorDescriptorHash:
        executorDescriptor.submissionExecutorDescriptorHash,
      reviewedSubmissionDecisionPacketHash:
        submissionDecisionPacket.reviewedSubmissionDecisionPacketHash,
      reviewedVenueEvidenceHash:
        reviewedVenueEvidence.reviewedVenueEvidenceHash,
      venueObservationSourceVerificationReceiptHash:
        reviewedVenueEvidence.sourceVerificationReceiptHash,
      providerCapabilityVerificationReceiptHash:
        providerCapabilityVerificationReceipt
          .providerCapabilityVerificationReceiptHash,
      venueTarget: 'Reviewed Venue',
      portalRoute,
    }),
  });
  const reviewedSubmitPreflightPacket = buildReviewedSubmitPreflightPacket({
    paperTask,
    approvalPacket,
    freshVenueEvidenceBundle,
    manifest,
    replayGuard,
    outbox,
    artifactPackage,
    researchReport: Object.freeze({
      researchReportHash: fixtureHash('research-report'),
    }),
    venuePlan,
    independentReviewAuthorityReceipt,
    liveAuthorizationReceipt,
    promotionGate: manuscriptPromotionGate,
    semanticPromotionLock,
    submissionDecisionPacket,
    createdAt,
  });
  const controlledExecutorReceipt = buildControlledExternalExecutorReceipt({
    paperTask,
    approvalPacket,
    reviewedSubmitPreflightPacket,
    manifest,
    outbox,
    replayGuard,
    independentReviewAuthorityReceipt,
    liveAuthorizationReceipt,
    executorDescriptor,
    executorId: executorDescriptor.executorId,
    submissionDecisionPacket,
    createdAt,
  });
  const dispatchAuthorization = buildSubmissionDispatchAuthorization({
    paperTask,
    outbox,
    replayGuard,
    reviewedSubmitPreflightPacket,
    controlledExecutorReceipt,
    liveAuthorizationReceipt,
    artifactPackage,
    responseDueAt,
    submissionDecisionPacket,
    reviewedVenueEvidence,
    providerCapabilityVerificationReceipt,
  });
  if (reviewedSubmitPreflightPacket.status
      !== 'reviewed_submit_preflight_ready_for_external_executor'
      || controlledExecutorReceipt.status
      !== 'controlled_external_executor_receipt_recorded'
      || dispatchAuthorization.status
      !== 'submission_dispatch_authorization_ready') {
    throw new Error('submission_handoff_export_fixture_lifecycle_invalid');
  }
  const requestPayload = {
    version: 1,
    kind: 'SubmissionHandoffExportRequest',
    campaignId,
    manifest,
    handoff,
    replayGuard,
    reviewedSubmitPreflightPacket,
    dispatchAuthorization,
    submissionDecisionPacket,
  };
  const request = Object.freeze({
    ...requestPayload,
    submissionHandoffExportRequestHash: hashRecord(
      'SubmissionHandoffExportRequest',
      requestPayload,
    ),
  });
  return Object.freeze({
    request,
    artifactPackage,
    outbox,
    reviewedSubmitPreflightPacket,
    controlledExecutorReceipt,
    dispatchAuthorization,
    providerCapabilityVerificationReceipt,
    executorDescriptor,
    createdAt,
    responseDueAt,
  });
}

export function createProviderCapabilityCurrentSignatureRevalidatorFixture(
  records,
) {
  const expected = records?.providerCapabilityVerificationReceipt;
  if (!expected?.providerCapabilityVerificationReceiptHash) {
    throw new Error('provider_capability_revalidation_fixture_receipt_required');
  }
  return Object.freeze((request) => {
    if (request?.providerCapabilityVerificationReceiptHash
        !== expected.providerCapabilityVerificationReceiptHash
      || request.attestationHash !== expected.attestationHash
      || request.provider !== expected.provider
      || request.accountId !== expected.accountId
      || request.portalRoute !== expected.portalRoute
      || request.executorDescriptorHash !== expected.executorDescriptorHash
      || request.capabilitiesHash !== expected.capabilitiesHash
      || JSON.stringify(request.verifiedSubjectIds)
        !== JSON.stringify(expected.verifiedSubjectIds)) {
      throw new Error('provider_capability_revalidation_fixture_binding_invalid');
    }
    const payload = {
      version: 1,
      kind: 'ProviderCapabilityCurrentSignatureRevalidationReceipt',
      status: 'provider_capability_current_signature_revalidated',
      provider: request.provider,
      accountId: request.accountId,
      portalRoute: request.portalRoute,
      executorDescriptorHash: request.executorDescriptorHash,
      capabilitiesHash: request.capabilitiesHash,
      attestationHash: request.attestationHash,
      providerCapabilityVerificationReceiptHash:
        request.providerCapabilityVerificationReceiptHash,
      verifiedSubjectIds: Object.freeze([...request.verifiedSubjectIds]),
      observedAt: request.observedAt,
      cryptographicSignaturesVerified: true,
      currentSignatureRevalidated: true,
      blockers: Object.freeze([]),
      externalActionPerformed: false,
    };
    return Object.freeze({
      ...payload,
      providerCapabilityCurrentSignatureRevalidationReceiptHash: hashRecord(
        'ProviderCapabilityCurrentSignatureRevalidationReceipt',
        payload,
      ),
    });
  });
}

export function persistSubmissionHandoffExportLifecycle({
  clock,
  records,
  store,
} = {}) {
  const provider = records?.providerCapabilityVerificationReceipt;
  const descriptor = records?.executorDescriptor;
  const capability = store.execute(`INSERT INTO submission_provider_capabilities(
    capability_id,provider,account_id,portal_route,executor_descriptor_hash,
    capabilities_hash,attestation_hash,verification_receipt_hash,
    verified_subject_ids_json,valid_from,expires_at,status,created_at
  ) VALUES(
    ${sqlText('provider-capability:reviewed')},
    ${sqlText(provider.provider)},${sqlText(provider.accountId)},
    ${sqlText(provider.portalRoute)},
    ${sqlText(descriptor.submissionExecutorDescriptorHash)},
    ${sqlText(descriptor.capabilitiesHash)},${sqlText(provider.attestationHash)},
    ${sqlText(provider.providerCapabilityVerificationReceiptHash)},
    ${sqlJson(provider.verifiedSubjectIds)},
    ${sqlText(provider.validFrom)},
    ${sqlText(provider.expiresAt)},
    'active',${sqlText(records.createdAt)}
  );`);
  if (!capability.ok) {
    throw new Error(`submission_handoff_export_fixture_capability_failed:${capability.error}`);
  }
  const issuerPolicy = resolveReceiptIssuerPolicy(
    'production-capability-verifier',
  );
  const ledger = store.execute(`INSERT INTO receipt_ledger(
    receipt_id,stream,paper_id,kind,status,receipt_json,receipt_sha256,
    created_at,environment,evidence_class,release_commit,writer_id,
    writer_kind,writer_trusted,issuer_policy_id,issuer_policy_hash,
    issuer_assurance
  ) VALUES(
    ${sqlText(`submission-provider-capability:${
      provider.providerCapabilityVerificationReceiptHash}`)},
    'submission-provider-capability',NULL,
    'ProviderCapabilityVerificationReceipt','provider_capability_verified',
    ${sqlJson(provider)},
    ${sqlText(provider.providerCapabilityVerificationReceiptHash)},
    ${sqlText(records.createdAt)},'production','provider_capability',NULL,
    ${sqlText(issuerPolicy.writerId)},${sqlText(issuerPolicy.writerKind)},1,
    'production-capability-verifier',
    ${sqlText(issuerPolicy.issuerPolicyHash)},
    ${sqlText(issuerPolicy.assurance)}
  );`);
  if (!ledger.ok) {
    throw new Error(
      `submission_handoff_export_fixture_ledger_failed:${ledger.error}`,
    );
  }
  const deliveryStore = createSqliteSubmissionDeliveryStore({
    store,
    receiptLedger: Object.freeze({}),
    clock,
  });
  return deliveryStore.enqueueAuthorized({
    paperId: records.request.manifest.paperId,
    dispatchAuthorization: records.dispatchAuthorization,
    payload: {
      outbox: records.outbox,
      reviewedSubmitPreflightPacket: records.reviewedSubmitPreflightPacket,
      controlledExecutorReceipt: records.controlledExecutorReceipt,
    },
  });
}
