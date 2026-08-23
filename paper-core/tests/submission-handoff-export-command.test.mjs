import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createSqliteSubmissionHandoffExportAuthorityQuery,
} from '../../paper-adapters/submission/sqlite-submission-handoff-export-authority-query.mjs';
import { createSqliteSubmissionDeliveryStore } from '../../paper-adapters/submission/sqlite-delivery-store.mjs';
import { sqlJson, sqlText } from '../../paper-adapters/submission/sqlite-delivery-persistence.mjs';
import {
  createDefaultPaperStore,
  createReadOnlyPaperStore,
} from '../../paper-adapters/persistence/store-provider.mjs';
import {
  buildControlledExternalExecutorReceipt,
  buildExternalExecutorHandoffOutbox,
  buildReviewedSubmitPreflightPacket,
} from '../../paper-domain/contracts/submission.mjs';
import { createPaperArtifactPackage } from '../../paper-domain/contracts/workflow-contracts.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import {
  buildSubmissionDispatchAuthorization,
} from '../../paper-domain/submission/delivery-runtime.mjs';
import {
  buildReviewedSubmissionDecisionPacket,
} from '../../paper-domain/submission/reviewed-submission-decision.mjs';
import {
  executeSubmissionHandoffExport,
  exportVerifiedCurrentReleaseSubmissionHandoff,
} from '../../paper-composition/submission/submission-handoff-export-composition.mjs';
import {
  verifySubmissionHandoffExportRequest,
} from '../../paper-domain/submission/submission-handoff-export-request.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  runSubmissionHandoffExportCommand,
} from '../bin/paper-submission-handoff-export.mjs';
import { HEPTA_PAPER_COMMAND_REGISTRY } from '../src/command-registry.mjs';

const NOW = new Date('2026-08-15T00:00:00.000Z');
const NOW_ISO = NOW.toISOString();
const clock = Object.freeze({
  now: () => new Date(NOW),
  nowIso: () => NOW_ISO,
});

function H(label) {
  return hashRecord('SubmissionHandoffExportCommandFixtureHash', { label });
}

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-submission-handoff-export-',
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function paperRecord(kind, hashField, payload, extras = {}) {
  return Object.freeze({
    ...payload,
    [hashField]: hashPaperRecord(kind, payload),
    ...extras,
  });
}

function canonicalLifecycleRecords({
  campaignId = 'campaign-export',
  paperId = 'paper-export',
  taskKey = 'paper-export:reviewed-submit',
} = {}) {
  const paperTask = Object.freeze({ paperId, taskKey });
  const artifactPackage = createPaperArtifactPackage({
    paperTask,
    artifacts: [Object.freeze({
      path: 'paper.pdf',
      filename: 'paper.pdf',
      hash: H('paper-pdf'),
      role: 'manuscript',
    })],
    submitReady: true,
  });
  const promotionGate = Object.freeze({
    status: 'manuscript_promotion_ready',
    manuscriptPromotionGateHash: H('promotion-gate'),
  });
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
        promotionGate.manuscriptPromotionGateHash,
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
      replayKey: H('replay-key'),
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
    createdAt: NOW_ISO,
  });
  const venuePlan = Object.freeze({
    status: 'local_dry_run_ready',
    venueSubmissionPlanHash: H('venue-plan'),
  });
  const submissionDecisionPacket = buildReviewedSubmissionDecisionPacket({
    paperTask,
    venuePlan,
    metadata: Object.freeze({
      title: 'Reviewed export fixture',
      abstract: 'A complete reviewed export fixture.',
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
      reviewedAt: NOW_ISO,
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
    approvalHash: H('approval'),
    blockers: Object.freeze([]),
  });
  const freshVenueEvidenceBundle = Object.freeze({
    kind: 'FreshVenueEvidenceBundle',
    status: 'fresh_venue_evidence_ready',
    freshVenueEvidenceBundleHash: H('fresh-venue-evidence'),
    blockers: Object.freeze([]),
  });
  const independentReviewAuthorityReceipt = Object.freeze({
    status: 'independent_referee_acceptance_verified',
    independentRefereeAuthorityReceiptHash: H('independent-review'),
  });
  const semanticPromotionLock = Object.freeze({
    status: 'semantic_promotion_unlocked',
    semanticPromotionLockHash: H('semantic-promotion-lock'),
  });
  const provider = 'reviewed-provider';
  const accountId = 'reviewed-account';
  const portalRoute = '/reviewed-submit';
  const executorDescriptor = Object.freeze({
    kind: 'SubmissionExecutorDescriptor',
    executorId: 'reviewed-executor',
    provider,
    accountId,
    capabilitiesHash: H('executor-capabilities'),
    submissionExecutorDescriptorHash: H('executor-descriptor'),
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
    attestationHash: H('attestation'),
    verifiedSubjectIds: Object.freeze(['reviewed-provider-authority']),
    cryptographicSignaturesVerified: true,
    validFrom: '2026-08-14T00:00:00.000Z',
    expiresAt: '2026-08-16T00:00:00.000Z',
    blockers: Object.freeze([]),
  };
  const providerCapabilityVerificationReceipt = Object.freeze({
    ...providerCapabilityReceiptPayload,
    providerCapabilityVerificationReceiptHash: hashRecord(
      'ProviderCapabilityVerificationReceipt',
      providerCapabilityReceiptPayload,
    ),
  });
  const reviewedVenueEvidence = Object.freeze({
    status: 'reviewed_venue_evidence_verified',
    reviewedVenueEvidenceHash: H('reviewed-venue-evidence'),
    sourceVerificationReceiptHash: H('venue-source-receipt'),
    observationSubjectHash: H('venue-observation-subject'),
    portalRoute,
  });
  const liveAuthorizationReceipt = Object.freeze({
    status: 'live_submission_authorization_verified',
    liveExternalActionAuthorized: true,
    liveSubmissionAuthorizationReceiptHash: H('live-authorization'),
    provider,
    accountId,
    nonce: 'reviewed-nonce',
    responseDueAt: '2026-08-15T02:00:00.000Z',
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
    researchReport: Object.freeze({ researchReportHash: H('research-report') }),
    venuePlan,
    independentReviewAuthorityReceipt,
    liveAuthorizationReceipt,
    promotionGate,
    semanticPromotionLock,
    submissionDecisionPacket,
    createdAt: NOW_ISO,
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
    createdAt: NOW_ISO,
  });
  const dispatchAuthorization = buildSubmissionDispatchAuthorization({
    paperTask,
    outbox,
    replayGuard,
    reviewedSubmitPreflightPacket,
    controlledExecutorReceipt,
    liveAuthorizationReceipt,
    artifactPackage,
    responseDueAt: liveAuthorizationReceipt.responseDueAt,
    submissionDecisionPacket,
    reviewedVenueEvidence,
    providerCapabilityVerificationReceipt,
  });
  assert.equal(
    reviewedSubmitPreflightPacket.status,
    'reviewed_submit_preflight_ready_for_external_executor',
  );
  assert.equal(
    controlledExecutorReceipt.status,
    'controlled_external_executor_receipt_recorded',
  );
  assert.equal(
    dispatchAuthorization.status,
    'submission_dispatch_authorization_ready',
    JSON.stringify(dispatchAuthorization.blockers),
  );
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
  });
}

function insertProviderCapability(store, records) {
  const provider = records.providerCapabilityVerificationReceipt;
  const descriptor = records.executorDescriptor;
  const result = store.execute(`INSERT INTO submission_provider_capabilities(
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
    ${sqlText(provider.expiresAt)},'active',${sqlText(NOW_ISO)}
  );`);
  assert.equal(result.ok, true, result.error);
}

function insertProviderCapabilityLedger(store, records, {
  ledgerReceiptHash = null,
  receiptOverrides = {},
  writerTrusted = true,
} = {}) {
  const receipt = {
    ...structuredClone(records.providerCapabilityVerificationReceipt),
    ...receiptOverrides,
  };
  const receiptHash = records.providerCapabilityVerificationReceipt
    .providerCapabilityVerificationReceiptHash;
  const result = store.execute(`INSERT INTO receipt_ledger(
    receipt_id,stream,paper_id,kind,status,receipt_json,receipt_sha256,
    created_at,environment,evidence_class,release_commit,writer_id,
    writer_kind,writer_trusted,issuer_policy_id,issuer_policy_hash,
    issuer_assurance
  ) VALUES(
    ${sqlText(`submission-provider-capability:${receiptHash}`)},
    'submission-provider-capability',NULL,
    'ProviderCapabilityVerificationReceipt','provider_capability_verified',
    ${sqlJson(receipt)},${sqlText(ledgerReceiptHash || receiptHash)},${sqlText(NOW_ISO)},
    'production','provider_capability',NULL,
    'production-capability-verifier','capability-verifier',${writerTrusted ? 1 : 0},
    'production-capability-verifier',${sqlText(H('wrong-issuer-policy'))},
    'in_process_registered_issuer'
  );`);
  assert.equal(result.ok, true, result.error);
}

function persistedAuthorityFixture(t, {
  includeProviderReceiptLedger = false,
  providerReceiptLedgerOptions = {},
  providerReceiptOverrides = {},
  mutate = null,
} = {}) {
  const root = temporaryRoot(t);
  const runtimeRoot = path.join(root, 'runtime');
  const records = canonicalLifecycleRecords();
  const writer = createDefaultPaperStore({ root, runtimeRoot });
  insertProviderCapability(writer, records);
  if (includeProviderReceiptLedger) {
    insertProviderCapabilityLedger(writer, records, {
      ...providerReceiptLedgerOptions,
      receiptOverrides: providerReceiptOverrides,
    });
  }
  const deliveryStore = createSqliteSubmissionDeliveryStore({
    store: writer,
    receiptLedger: Object.freeze({}),
    clock,
  });
  deliveryStore.enqueueAuthorized({
    paperId: records.request.manifest.paperId,
    dispatchAuthorization: records.dispatchAuthorization,
    payload: {
      outbox: records.outbox,
      reviewedSubmitPreflightPacket: records.reviewedSubmitPreflightPacket,
      controlledExecutorReceipt: records.controlledExecutorReceipt,
    },
  });
  mutate?.(writer, records);
  writer.close();
  const reader = createReadOnlyPaperStore({ root, runtimeRoot });
  t.after(() => reader.close());
  let snapshotTransactionCount = 0;
  const queryStore = Object.freeze({
    ...reader,
    transaction(work, options) {
      snapshotTransactionCount += 1;
      assert.deepEqual(options, { readOnly: true });
      return reader.transaction(work, options);
    },
  });
  const query = createSqliteSubmissionHandoffExportAuthorityQuery({
    store: queryStore,
    clock,
    requireCurrentProviderCapabilitySignatureRevalidation: true,
  });
  return Object.freeze({
    root,
    runtimeRoot,
    records,
    query,
    snapshotTransactionCount: () => snapshotTransactionCount,
  });
}

function currentAuthority(fixture) {
  return fixture.query.getCurrentReviewedSubmissionAuthority({
    paperId: fixture.records.request.manifest.paperId,
    dispatchAuthorizationHash: fixture.records.dispatchAuthorization
      .submissionDispatchAuthorizationHash,
  });
}

function releaseInput(root, records) {
  const artifactPackageHash = records.artifactPackage.artifactPackageHash;
  const releaseAuthority = Object.freeze({
    campaignId: records.request.campaignId,
    paperId: records.request.manifest.paperId,
  });
  const releaseBundle = Object.freeze({
    campaignReleaseBundleHash: H('campaign-release-bundle'),
    packageOutput: Object.freeze({ artifactBaseRoot: root }),
  });
  return Object.freeze({
    campaignReleaseBundleHash: releaseBundle.campaignReleaseBundleHash,
    artifactPackageHash,
    manuscriptPromotionGateHash:
      records.request.manifest.payload.manuscriptPromotionGateHash,
    artifactPackage: records.artifactPackage,
    packageResult: Object.freeze({
      packageVerificationReceipt: Object.freeze({
        status: 'package_verification_passed',
        packageVerificationReceiptHash: H('package-verification'),
      }),
      releaseBundle,
    }),
    releaseAuthority,
  });
}

test('capability table projection cannot replace the effective provider receipt ledger', (t) => {
  const fixture = persistedAuthorityFixture(t);
  const authority = currentAuthority(fixture);
  assert.equal(
    authority.status,
    'submission_handoff_export_authority_blocked',
    JSON.stringify(authority.blockers),
  );
  assert.equal(authority.readOnly, true);
  assert.ok(authority.blockers.includes(
    'submission_handoff_export_authority_provider_receipt_ledger_missing',
  ));
  assert.equal(fixture.snapshotTransactionCount(), 1);
  assert.equal(
    authority.dispatchAuthorizationHash,
    fixture.records.dispatchAuthorization.submissionDispatchAuthorizationHash,
  );
  assert.equal(
    authority.controlledExecutorReceipt.hashChain.manifestHash,
    fixture.records.request.manifest.manifestHash,
  );
  assert.throws(
    () => fixture.query.getCurrentReviewedSubmissionAuthority({
      paperId: fixture.records.request.manifest.paperId,
      dispatchAuthorizationHash: 'forged',
    }),
    /submission_handoff_export_dispatch_hash_invalid/,
  );
  assert.equal(fixture.query.getCurrentReviewedSubmissionAuthority({
    paperId: fixture.records.request.manifest.paperId,
    dispatchAuthorizationHash: H('missing-dispatch'),
  }), null);
});

test('complete historical provider receipt cannot claim current signature revalidation', (t) => {
  const fixture = persistedAuthorityFixture(t, {
    includeProviderReceiptLedger: true,
  });
  const authority = currentAuthority(fixture);
  assert.equal(
    authority.status,
    'submission_handoff_export_authority_blocked',
    JSON.stringify(authority.blockers),
  );
  assert.deepEqual(
    authority.providerCapabilityVerificationReceipt,
    fixture.records.providerCapabilityVerificationReceipt,
  );
  assert.equal(
    authority.providerCapabilityVerificationReceiptInspection.ready,
    true,
    JSON.stringify(
      authority.providerCapabilityVerificationReceiptInspection.blockers,
    ),
  );
  assert.equal(
    authority.providerCapabilityVerificationReceiptInspection
      .cryptographicSignaturesVerified,
    true,
  );
  assert.equal(
    authority.providerCapabilityCurrentSignatureRevalidated,
    false,
  );
  assert.ok(authority.blockers.includes(
    'submission_handoff_export_authority_provider_receipt_issuer_policy_invalid',
  ));
  assert.ok(authority.blockers.includes(
    'submission_handoff_export_authority_provider_signature_revalidation_unavailable',
  ));
  for (const blocker of [
    'submission_handoff_export_authority_provider_receipt_ledger_binding_invalid',
    'submission_handoff_export_authority_provider_receipt_not_effective',
    'submission_handoff_export_authority_provider_receipt_writer_untrusted',
  ]) {
    assert.equal(authority.blockers.includes(blocker), false, blocker);
  }
});

test('effective provider receipt content and qualification are fail-closed', (t) => {
  const cases = [
    {
      label: 'signature flag',
      receiptOverrides: { cryptographicSignaturesVerified: false },
      blocker:
        'submission_handoff_export_authority_provider_capability_receipt_signatures_unverified',
    },
    {
      label: 'principal and route binding',
      receiptOverrides: {
        provider: 'forged-provider',
        portalRoute: '/forged-route',
      },
      blocker:
        'submission_handoff_export_authority_provider_capability_receipt_binding_invalid:provider',
    },
    {
      label: 'validity window',
      receiptOverrides: { expiresAt: '2026-08-14T23:00:00.000Z' },
      blocker:
        'submission_handoff_export_authority_provider_capability_receipt_not_current',
    },
  ];
  for (const { label, receiptOverrides, blocker } of cases) {
    const fixture = persistedAuthorityFixture(t, {
      includeProviderReceiptLedger: true,
      providerReceiptOverrides: receiptOverrides,
    });
    const authority = currentAuthority(fixture);
    assert.equal(
      authority.status,
      'submission_handoff_export_authority_blocked',
      label,
    );
    assert.ok(authority.blockers.includes(blocker), label);
    assert.ok(authority.blockers.includes(
      'submission_handoff_export_authority_provider_capability_receipt_self_hash_invalid',
    ), label);
  }

  for (const { label, providerReceiptLedgerOptions, blocker } of [
    {
      label: 'ledger receipt hash binding',
      providerReceiptLedgerOptions: { ledgerReceiptHash: H('forged-ledger') },
      blocker:
        'submission_handoff_export_authority_provider_receipt_ledger_binding_invalid',
    },
    {
      label: 'trusted writer marker',
      providerReceiptLedgerOptions: { writerTrusted: false },
      blocker:
        'submission_handoff_export_authority_provider_receipt_writer_untrusted',
    },
  ]) {
    const fixture = persistedAuthorityFixture(t, {
      includeProviderReceiptLedger: true,
      providerReceiptLedgerOptions,
    });
    assert.ok(currentAuthority(fixture).blockers.includes(blocker), label);
  }

  const attestationMismatch = persistedAuthorityFixture(t, {
    includeProviderReceiptLedger: true,
    mutate(store) {
      const result = store.execute(`UPDATE submission_provider_capabilities
        SET attestation_hash=${sqlText(H('forged-attestation'))};`);
      assert.equal(result.ok, true, result.error);
    },
  });
  assert.ok(currentAuthority(attestationMismatch).blockers.includes(
    'submission_handoff_export_authority_provider_capability_receipt_binding_invalid:attestationHash',
  ));

  const qualified = persistedAuthorityFixture(t, {
    includeProviderReceiptLedger: true,
    mutate(store, records) {
      const receiptId = `submission-provider-capability:${
        records.providerCapabilityVerificationReceipt
          .providerCapabilityVerificationReceiptHash
      }`;
      const result = store.execute(`INSERT INTO receipt_ledger_qualifications(
        qualification_id,receipt_id,disposition,reason,replacement_receipt_id,
        qualification_json,qualification_sha256,issuer_policy_id,created_at
      ) VALUES(
        'provider-capability-invalid',${sqlText(receiptId)},'invalid',
        'test qualification',NULL,'{}',${sqlText(H('qualification'))},
        'ledger-administrator',${sqlText(NOW_ISO)}
      );`);
      assert.equal(result.ok, true, result.error);
    },
  });
  assert.ok(currentAuthority(qualified).blockers.includes(
    'submission_handoff_export_authority_provider_receipt_not_effective',
  ));
});

test('request requires persisted authority and rejects self-hashed minimal records', (t) => {
  const fixture = persistedAuthorityFixture(t);
  const { request } = fixture.records;
  const withoutAuthority = verifySubmissionHandoffExportRequest(request, {
    campaignId: request.campaignId,
  });
  assert.equal(withoutAuthority.status, 'submission_handoff_export_request_blocked');
  assert.ok(withoutAuthority.blockers.includes(
    'submission_handoff_export_persisted_authority_required',
  ));

  const minimal = structuredClone(request);
  delete minimal.submissionDecisionPacket.reviewedBy;
  delete minimal.submissionDecisionPacket.reviewedAt;
  delete minimal.submissionDecisionPacket.humanConfirmedFields;
  const decisionPayload = { ...minimal.submissionDecisionPacket };
  delete decisionPayload.reviewedSubmissionDecisionPacketHash;
  minimal.submissionDecisionPacket.reviewedSubmissionDecisionPacketHash =
    hashRecord('ReviewedSubmissionDecisionPacket', decisionPayload);
  const requestPayload = { ...minimal };
  delete requestPayload.submissionHandoffExportRequestHash;
  minimal.submissionHandoffExportRequestHash = hashRecord(
    'SubmissionHandoffExportRequest',
    requestPayload,
  );
  const blocked = verifySubmissionHandoffExportRequest(minimal, {
    submissionAuthority: currentAuthority(fixture),
  });
  assert.equal(blocked.status, 'submission_handoff_export_request_blocked');
  assert.ok(blocked.blockers.includes(
    'submission_handoff_export_decision_contract_invalid',
  ));
});

test('historical provider receipt cannot flow into production offline export', async (t) => {
  const fixture = persistedAuthorityFixture(t, {
    includeProviderReceiptLedger: true,
  });
  const authority = currentAuthority(fixture);
  const bundleRoot = path.join(fixture.root, 'operator-export');
  let exporterCalls = 0;
  await assert.rejects(
    exportVerifiedCurrentReleaseSubmissionHandoff({
      root: fixture.root,
      runtimeRoot: fixture.runtimeRoot,
      campaignId: fixture.records.request.campaignId,
      bundleRoot,
      request: fixture.records.request,
      releaseInput: releaseInput(fixture.root, fixture.records),
      submissionAuthority: authority,
      submissionAuthorityFreshnessQuery: () => currentAuthority(fixture),
      bundleExporter: async () => { exporterCalls += 1; },
    }),
    (error) => error.code === 'submission_handoff_export_request_blocked',
  );
  assert.equal(exporterCalls, 0);
  assert.equal(fs.existsSync(bundleRoot), false);
});

test('SQLite authority rejects missing related authority rows', (t) => {
  for (const table of [
    'submission_authorization_consumptions',
    'submission_release_locks',
    'submission_provider_capabilities',
  ]) {
    const fixture = persistedAuthorityFixture(t, {
      mutate(store) {
        assert.equal(store.execute(`DELETE FROM ${table};`).ok, true);
      },
    });
    const authority = currentAuthority(fixture);
    assert.equal(authority.status, 'submission_handoff_export_authority_blocked');
    assert.ok(authority.blockers.length > 0, table);
  }
});

test('SQLite authority rejects row, payload, scheduling, and timestamp tamper', (t) => {
  const mutations = [
    ['provider', (store) => store.execute(
      "UPDATE submission_outbox SET provider='attacker-provider';",
    )],
    ['attempt', (store) => store.execute(
      'UPDATE submission_outbox SET attempt_count=1;',
    )],
    ['future schedule', (store) => store.execute(
      "UPDATE submission_outbox SET next_attempt_at='2026-08-15T01:00:00.000Z';",
    )],
    ['expired response', (store) => store.execute(
      "UPDATE submission_outbox SET response_due_at='2026-08-14T23:00:00.000Z';",
    )],
    ['transaction time drift', (store) => store.execute(
      "UPDATE submission_authorization_consumptions SET consumed_at='2026-08-14T23:59:00.000Z';",
    )],
    ['invalid capability time', (store) => store.execute(
      "UPDATE submission_provider_capabilities SET expires_at='not-a-date';",
    )],
    ['expired capability', (store) => store.execute(
      "UPDATE submission_provider_capabilities SET expires_at='2026-08-14T23:00:00.000Z';",
    )],
    ['claimed', (store) => store.execute(
      "UPDATE submission_outbox SET status='in_flight',claimed_by='worker',lease_token='lease',lease_expires_at='2026-08-15T00:30:00.000Z';",
    )],
    ['payload', (store) => {
      const row = store.query(
        'SELECT payload_json FROM submission_outbox LIMIT 1;',
      ).rows[0];
      const payload = JSON.parse(row.payload_json);
      payload.controlledExecutorReceipt.hashChain.manifestHash = H('forged');
      return store.execute(`UPDATE submission_outbox SET payload_json=${
        sqlJson(payload)
      };`);
    }],
  ];
  for (const [label, mutate] of mutations) {
    const fixture = persistedAuthorityFixture(t, {
      mutate(store) {
        const result = mutate(store);
        assert.equal(result.ok, true, `${label}:${result.error}`);
      },
    });
    const authority = currentAuthority(fixture);
    assert.equal(
      authority.status,
      'submission_handoff_export_authority_blocked',
      label,
    );
    assert.ok(authority.blockers.length > 0, label);
  }
});

test('SQLite authority rejects responded and dead-lettered dispatches', (t) => {
  const cases = [
    ['responded', (store, records) => store.execute(`INSERT INTO submission_inbox(
      response_id,message_id,dispatch_hash,outcome,response_json,received_at
    ) VALUES('response-fixture',${sqlText(`submission:${
      records.dispatchAuthorization.submissionDispatchAuthorizationHash
    }`)},${sqlText(
      records.dispatchAuthorization.submissionDispatchAuthorizationHash,
    )},'failed','{}',${sqlText(NOW_ISO)});`)],
    ['dead-letter', (store, records) => store.execute(`INSERT INTO submission_dead_letters(
      dead_letter_id,message_id,failure_class,attempt_count,receipt_json,created_at
    ) VALUES('dead-letter-fixture',${sqlText(`submission:${
      records.dispatchAuthorization.submissionDispatchAuthorizationHash
    }`)},'terminal',1,'{}',${sqlText(NOW_ISO)});`)],
  ];
  for (const [label, mutate] of cases) {
    const fixture = persistedAuthorityFixture(t, {
      mutate(store, records) {
        const result = mutate(store, records);
        assert.equal(result.ok, true, `${label}:${result.error}`);
      },
    });
    const authority = currentAuthority(fixture);
    assert.equal(
      authority.status,
      'submission_handoff_export_authority_blocked',
      label,
    );
  }
});

test('production execute blocks bad authority before exporter or output creation', async (t) => {
  const fixture = persistedAuthorityFixture(t, {
    mutate(store) {
      assert.equal(store.execute(
        "UPDATE submission_outbox SET status='in_flight',claimed_by='worker',lease_token='lease',lease_expires_at='2026-08-15T00:30:00.000Z';",
      ).ok, true);
    },
  });
  const requestPath = path.join(fixture.root, 'request.json');
  fs.writeFileSync(requestPath, JSON.stringify(fixture.records.request));
  const bundleRoot = path.join(fixture.root, 'must-not-exist');
  let exporterCalls = 0;
  await assert.rejects(
    executeSubmissionHandoffExport({
      root: fixture.root,
      runtimeRoot: fixture.runtimeRoot,
      campaignId: fixture.records.request.campaignId,
      bundleRoot,
      requestPath,
      bundleExporter: async () => { exporterCalls += 1; },
    }),
    (error) => error.code
      === 'submission_handoff_export_persisted_authority_blocked',
  );
  assert.equal(exporterCalls, 0);
  assert.equal(fs.existsSync(bundleRoot), false);
  assert.equal(fs.existsSync(path.join(
    fixture.root,
    '.must-not-exist.repository-boundary',
  )), false);
});

test('tamper and unsafe output root are rejected before export write', async (t) => {
  const fixture = persistedAuthorityFixture(t);
  const request = structuredClone(fixture.records.request);
  request.dispatchAuthorization.provider = 'attacker-provider';
  const bundleRoot = path.join(fixture.root, 'tampered-export');
  let exporterCalls = 0;
  await assert.rejects(
    exportVerifiedCurrentReleaseSubmissionHandoff({
      root: fixture.root,
      runtimeRoot: fixture.runtimeRoot,
      campaignId: fixture.records.request.campaignId,
      bundleRoot,
      request,
      releaseInput: releaseInput(fixture.root, fixture.records),
      submissionAuthority: currentAuthority(fixture),
      bundleExporter: async () => { exporterCalls += 1; },
    }),
    (error) => error.code === 'submission_handoff_export_request_blocked',
  );
  assert.equal(exporterCalls, 0);
  assert.equal(fs.existsSync(bundleRoot), false);

  const preexistingRoot = path.join(fixture.root, 'unsafe-export');
  fs.writeFileSync(preexistingRoot, 'not a bundle directory\n');
  await assert.rejects(
    exportVerifiedCurrentReleaseSubmissionHandoff({
      root: fixture.root,
      runtimeRoot: fixture.runtimeRoot,
      campaignId: fixture.records.request.campaignId,
      bundleRoot: preexistingRoot,
      request: fixture.records.request,
      releaseInput: releaseInput(fixture.root, fixture.records),
      submissionAuthority: currentAuthority(fixture),
      bundleExporter: async () => { exporterCalls += 1; },
    }),
    (error) => error.code
      === 'submission_handoff_export_existing_bundle_root_invalid',
  );
  assert.equal(exporterCalls, 0);
});

test('operator CLI route requires explicit inputs and no external action', async (t) => {
  const root = temporaryRoot(t);
  const writes = [];
  let executed = null;
  const result = await runSubmissionHandoffExportCommand({
    argv: [
      '--campaign-id', 'campaign-cli',
      '--bundle-root', path.join(root, 'bundle'),
      '--request', path.join(root, 'request.json'),
      '--root', path.join(root, 'assets'),
      '--runtime-root', path.join(root, 'runtime'),
    ],
    stdout: { write(value) { writes.push(value); } },
    execute: async (options) => {
      executed = options;
      return Object.freeze({
        version: 1,
        kind: 'SubmissionHandoffExportCommandReceipt',
        status: 'submission_handoff_export_completed',
        externalActionPerformed: false,
      });
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(executed.campaignId, 'campaign-cli');
  assert.equal(executed.bundleRoot, path.join(root, 'bundle'));
  assert.equal(executed.requestPath, path.join(root, 'request.json'));
  assert.equal(JSON.parse(writes.join('')).externalActionPerformed, false);

  const route = HEPTA_PAPER_COMMAND_REGISTRY.operator[
    'submission-handoff-export'
  ];
  assert.deepEqual(route.effects, {
    localMutation: 'local-write',
    externalAction: 'none',
    networkUse: 'none',
    credentialUse: 'none',
    providerCost: 'none',
  });
  assert.deepEqual(route.forwardedArgumentSchema.booleanFlags, ['help']);
  assert.deepEqual(route.forwardedArgumentSchema.valueFlags, [
    'bundle-root', 'campaign-id', 'request', 'root', 'runtime-root',
  ]);
  await assert.rejects(
    runSubmissionHandoffExportCommand({
      argv: ['--campaign-id', 'campaign-cli'],
      stdout: { write() {} },
      execute: async () => assert.fail('execute must not run'),
    }),
    /submission_handoff_export_bundle_root_required/,
  );
  await assert.rejects(
    runSubmissionHandoffExportCommand({
      argv: ['--execute'],
      stdout: { write() {} },
    }),
    /unknown_cli_option:--execute/,
  );
});
