import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createPaperTask,
  hashPaperRecord,
} from '../../paper-domain/contracts/index.mjs';
import { sha256File } from '../../workflow-kernel/runtime/file-utils.mjs';
import { signAuthorityDocument } from './authority-signatures.mjs';
import { runResearchVerifyAdapter } from '../../paper-adapters/research-verify/index.mjs';
import { createFilesystemArtifactRepository } from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { verifyIndependentRefereeAuthority } from '../../paper-adapters/referee-review/independent-authority.mjs';
import {
  buildSubmissionLifecycle,
  buildSubmissionVenuePlan,
} from '../../paper-adapters/submission/index.mjs';
import {
  buildLiveSubmissionAuthorizationSubject,
  verifyLiveSubmissionAuthorization,
} from '../../paper-adapters/submission/live-authorization.mjs';
import { buildTargetScopeReceipt } from '../../paper-domain/automation/target-scope-policy.mjs';
import { buildSemanticPromotionLock } from '../../paper-domain/submission/semantic-promotion-lock.mjs';
import { evaluatePromotionDependencyClosure } from '../../paper-domain/quality/promotion-dependency-closure.mjs';
import { buildExecutorCapabilities } from '../../paper-ports/executor-capabilities.mjs';
import { submissionExecutorDescriptor } from '../../paper-ports/submission-executor-port.mjs';
import { buildReviewedSubmissionDecisionPacket } from '../../paper-domain/submission/reviewed-submission-decision.mjs';
import { buildReviewedVenueEvidence } from '../../paper-domain/submission/reviewed-venue-evidence.mjs';
import { buildVenueObservationSubject, verifyReviewedVenueObservationSource } from '../../paper-adapters/submission/venue-observation-verification.mjs';

function keyMaterial(keyId, subjectId, roles) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    keyId,
    subjectId,
    roles,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hepta-authority-selftest-'));
try {
  const sourceRoot = path.join(root, 'papers', 'authority_fixture');
  const runtimeRoot = path.join(root, 'runtime');
  const inbox = path.join(runtimeRoot, 'authority-inbox', 'authority_fixture');
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.mkdir(inbox, { recursive: true });
  const mainTex = [
    '\\documentclass{article}',
    '\\begin{document}',
    'A bounded research-worker and signed-authority fixture.',
    '\\end{document}',
    '',
  ].join('\n');
  const csv = [
    'episode,return,violation',
    '1,1.0,0.10',
    '2,2.0,0.05',
    '3,3.0,0.00',
    '',
  ].join('\n');
  const resultJson = { checks: { sampleCount: 3, passed: true } };
  await fs.writeFile(path.join(sourceRoot, 'main.tex'), mainTex, 'utf8');
  await fs.writeFile(path.join(sourceRoot, 'observations.csv'), csv, 'utf8');
  await writeJson(path.join(sourceRoot, 'results.json'), resultJson);
  await writeJson(path.join(sourceRoot, 'CLAIMS.json'), {
    claims: [{
      id: 'claim-1',
      text: 'The bounded observed fixture satisfies its declared checks.',
      source_locator: 'main.tex#bounded-observed-fixture',
      claim_kind: 'empirical_claim',
      verification_plan: { kind: 'artifact_integrity', worker_ids: ['artifact_integrity', 'descriptive_statistics', 'result_assertions'] },
    }],
  });
  const mainHash = await sha256File(path.join(sourceRoot, 'main.tex'));
  const csvHash = await sha256File(path.join(sourceRoot, 'observations.csv'));
  const resultHash = await sha256File(path.join(sourceRoot, 'results.json'));
  const paperTask = createPaperTask({
    paperId: 'authority_fixture',
    title: 'Authority pipeline fixture',
    venueTarget: 'Fixture Journal',
    sourceWorkspace: 'papers/authority_fixture',
    mainTex: 'papers/authority_fixture/main.tex',
  });
  const row = {
    task: paperTask,
    state: {
      blockers: [],
      evidenceRefs: [],
      compileStatus: 'build_passed',
      packageStatus: 'package_ready',
    },
  };
  await writeJson(path.join(sourceRoot, 'RESEARCH_WORKER_PLAN.json'), {
    version: 1,
    kind: 'NativeResearchWorkerPlan',
    paperId: paperTask.paperId,
    taskKey: paperTask.taskKey,
    workers: [
      {
        id: 'artifact_integrity',
        type: 'artifact_integrity',
        evidenceClass: 'research_evidence',
        syntheticInput: false,
        outcomesPreprogrammed: false,
        claimIds: ['claim-1'],
        inputs: [
          { role: 'manuscript', path: 'main.tex', sha256: mainHash },
          { role: 'observations', path: 'observations.csv', sha256: csvHash },
          { role: 'result', path: 'results.json', sha256: resultHash },
        ],
      },
      {
        id: 'descriptive_statistics',
        type: 'csv_descriptive_statistics',
        evidenceClass: 'research_evidence',
        syntheticInput: false,
        outcomesPreprogrammed: false,
        claimIds: ['claim-1'],
        inputs: [{ role: 'observations', path: 'observations.csv', sha256: csvHash }],
        parameters: { numericColumns: ['return', 'violation'] },
      },
      {
        id: 'result_assertions',
        type: 'json_assertions',
        evidenceClass: 'research_evidence',
        syntheticInput: false,
        outcomesPreprogrammed: false,
        claimIds: ['claim-1'],
        inputs: [{ role: 'result', path: 'results.json', sha256: resultHash }],
        parameters: {
          assertions: [
            { path: 'checks.sampleCount', op: 'gte', value: 3 },
            { path: 'checks.passed', op: 'equals', value: true },
          ],
        },
      },
    ],
  });
  const sourceHashBeforeWorkers = await sha256File(path.join(sourceRoot, 'main.tex'));
  let artifactLedgerCounter = 0;
  const artifactLedgerRows = new Map();
  const artifactReceiptLedger = {
    record(receipt) {
      const receiptId = `authority-selftest:${++artifactLedgerCounter}`;
      const receiptHash = receipt.writeReceiptHash || receipt.receiptHash || hashPaperRecord(receipt.kind || 'Receipt', receipt);
      artifactLedgerRows.set(receiptId, { receipt_id: receiptId, receipt_sha256: receiptHash, receipt_json: JSON.stringify(receipt), stream: receipt.kind === 'ArtifactWriteReceipt' ? 'artifact-writes' : 'authority-selftest', writer_id: 'authority-selftest', writer_kind: receipt.kind === 'ArtifactWriteReceipt' ? 'content-addressed-repository' : 'isolated-selftest', writer_trusted: 1, issuer_policy_id: 'authority-selftest-fixture', issuer_policy_hash: `sha256:${'f'.repeat(64)}`, issuer_assurance: 'test_only' });
      return { receiptId, receiptHash };
    },
    get(receiptId) { return artifactLedgerRows.get(receiptId) || null; },
    list() { return [...artifactLedgerRows.values()]; },
  };
  const artifactRepositoryFactory = (scopeRoot) => createFilesystemArtifactRepository({
    scopeRoot,
    casRoot: path.join(runtimeRoot, 'artifact-cas'),
    clock: { nowIso: () => new Date().toISOString() },
    receiptLedger: artifactReceiptLedger,
  });
  await Promise.all([
    runResearchVerifyAdapter({
      root,
      runtimeRoot,
      row,
      executeResearchWorkers: true,
      artifactRepositoryFactory,
    }),
    runResearchVerifyAdapter({
      root,
      runtimeRoot,
      row,
      executeResearchWorkers: true,
      artifactRepositoryFactory,
    }),
  ]);
  const sourceHashAfterWorkers = await sha256File(path.join(sourceRoot, 'main.tex'));
  assert.equal(sourceHashAfterWorkers, sourceHashBeforeWorkers);
  const persistedWorkerVerification = await runResearchVerifyAdapter({
    root,
    runtimeRoot,
    row,
    executeResearchWorkers: false,
  });
  assert.equal(persistedWorkerVerification.nativeResearchWorkerExecution.status, 'native_research_workers_verified');
  assert.equal(persistedWorkerVerification.executedResearchWorkerCount, 3);
  assert.equal(persistedWorkerVerification.verifiedNativeResearchWorkerCount, 3);
  assert.equal(persistedWorkerVerification.safety.sourceMutation, false);

  const evidenceAuthority = keyMaterial(
    'evidence-key',
    'evidence-authority-subject',
    ['academic_evidence_authority', 'independent_referee'],
  );
  const refereeAuthority = keyMaterial(
    'referee-key',
    'independent-referee-subject',
    ['independent_referee'],
  );
  const submissionOperator = keyMaterial(
    'operator-key',
    'submission-operator-subject',
    ['submission_operator'],
  );
  const liveExecutorAuthorizer = keyMaterial(
    'executor-key',
    'live-executor-authorizer-subject',
    ['live_executor_authorizer'],
  );
  const venueObserver = keyMaterial(
    'venue-observer-key',
    'venue-observer-subject',
    ['venue_observer'],
  );
  const trustStore = {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [evidenceAuthority, refereeAuthority, submissionOperator, liveExecutorAuthorizer, venueObserver]
      .map(({ privateKeyPem: _privateKeyPem, ...key }) => ({
        ...key,
        algorithm: 'ed25519',
        status: 'active',
      })),
  };
  const fixedNow = new Date('2026-07-10T05:30:00.000Z');
  let academicAttestation = {
    version: 2,
    kind: 'AcademicEvidenceAttestation',
    paperId: paperTask.paperId,
    taskKey: paperTask.taskKey,
    classification: 'research_evidence',
    syntheticOrGenerated: false,
    outcomesPreprogrammed: false,
    sourceSnapshot: { path: 'main.tex', sha256: mainHash },
    workerExecutionReceiptHashes:
      persistedWorkerVerification.nativeResearchWorkerExecution.workerReceiptHashes,
    artifacts: [
      {
        scope: 'source',
        path: 'observations.csv',
        sha256: csvHash,
        kind: 'observed_dataset',
        claimIds: ['claim-1'],
      },
      {
        scope: 'source',
        path: 'results.json',
        sha256: resultHash,
        kind: 'verified_result',
        claimIds: ['claim-1'],
      },
    ],
    signedAt: '2026-07-10T05:00:00.000Z',
    validFrom: '2026-07-10T05:00:00.000Z',
    expiresAt: '2026-08-10T05:00:00.000Z',
  };
  academicAttestation = signAuthorityDocument(academicAttestation, {
    privateKeyPem: evidenceAuthority.privateKeyPem,
    keyId: evidenceAuthority.keyId,
    role: 'academic_evidence_authority',
  });
  await writeJson(path.join(sourceRoot, 'ACADEMIC_EVIDENCE_ATTESTATION.json'), academicAttestation);
  const researchReport = await runResearchVerifyAdapter({
    root,
    runtimeRoot,
    row,
    executeResearchWorkers: false,
    trustStoreOverride: trustStore,
    now: fixedNow,
  });
  assert.equal(researchReport.academicEvidenceStatus, 'academic_evidence_verified');
  assert.equal(researchReport.academicEvidenceEligible, true);
  assert.equal(researchReport.academicEvidenceAttestation.cryptographicSignaturesVerified, true);
  assert.equal(researchReport.academicEvidenceAttestation.verifiedWorkerReceiptCount, 3);

  const artifactPackage = {
    version: 1,
    kind: 'PaperArtifactPackage',
    paperId: paperTask.paperId,
    artifactCount: 2,
    submitReady: true,
    packageVerificationStatus: 'package_verification_passed',
    packageVerificationReceiptHash: hashPaperRecord('FixturePackageVerification', {}),
    artifactSettlementStatus: 'artifact_settlement_verified',
    artifactSettlementHash: hashPaperRecord('FixtureArtifactSettlement', {}),
    sourceSnapshotHash: mainHash,
    evidenceRefs: [],
    artifacts: [
      { role: 'compiled_pdf', path: 'package/paper.pdf', hash: hashPaperRecord('FixturePdf', {}) },
      { role: 'source_archive', path: 'package/source.zip', hash: hashPaperRecord('FixtureSource', {}) },
    ],
  };
  artifactPackage.artifactPackageHash = hashPaperRecord('PaperArtifactPackage', artifactPackage);
  const venues = [{ venue_id: 'fixture-journal', name: 'Fixture Journal', kind: 'journal' }];
  const venuePlan = buildSubmissionVenuePlan({
    row,
    venues,
    artifactPackage,
    mode: 'reviewed-submit',
  });
  assert.equal(venuePlan.status, 'local_dry_run_ready');
  const packageVerificationReceipt = {
    status: 'package_verification_passed',
    packageVerificationReceiptHash: artifactPackage.packageVerificationReceiptHash,
    artifactSettlement: { status: 'artifact_settlement_verified', artifactSettlementHash: artifactPackage.artifactSettlementHash },
  };
  const promotionGate = {
    status: 'manuscript_promotion_ready',
    manuscriptPromotionGateHash: hashPaperRecord('FixtureManuscriptPromotionGate', {}),
    promotionDependencyClosure: evaluatePromotionDependencyClosure({ researchReport }),
    promotionInputSnapshotHash: researchReport.capabilities.promotionInputSnapshot.promotionInputSnapshotHash,
  };
  assert.equal(promotionGate.promotionDependencyClosure.status, 'promotion_dependency_closure_ready', JSON.stringify(promotionGate.promotionDependencyClosure));
  const packageResult = { artifactPackage, packageVerificationReceipt, manuscriptPromotionGate: promotionGate };
  const targetScopeReceipt = buildTargetScopeReceipt({
    mode: 'reviewed-submit', execute: true, requestedPaperIds: [paperTask.paperId],
    selectedTasks: [paperTask], inventorySource: 'fixture', requireExplicitScope: true,
  });
  const semanticPromotionLock = buildSemanticPromotionLock({
    paperTask, targetScopeReceipt, artifactPackage, packageVerificationReceipt,
    researchReport, promotionGate, venuePlan,
  });
  assert.equal(semanticPromotionLock.status, 'semantic_promotion_unlocked');
  const reviewText = [
    '# Independent Referee Report',
    '',
    'The reviewed source, evidence bundle, and package hashes are accepted for the stated claim scope.',
    '',
  ].join('\n');
  await fs.writeFile(path.join(inbox, 'review.md'), reviewText, 'utf8');
  const reviewHash = await sha256File(path.join(inbox, 'review.md'));
  let independentVerdict = {
    version: 1,
    kind: 'IndependentRefereeVerdict',
    paperId: paperTask.paperId,
    taskKey: paperTask.taskKey,
    verdict: 'accept',
    blockingFindingCount: 0,
    reviewer: {
      subjectId: refereeAuthority.subjectId,
      independentFromAuthors: true,
      conflictOfInterest: false,
      reviewMethod: 'human',
    },
    reviewScope: {
      sourceSha256: mainHash,
      academicEvidenceVerificationHash:
        researchReport.academicEvidenceAttestation.academicEvidenceAttestationVerificationHash,
      artifactPackageHash: artifactPackage.artifactPackageHash,
      venueSubmissionPlanHash: venuePlan.venueSubmissionPlanHash,
      semanticPromotionLockHash: semanticPromotionLock.semanticPromotionLockHash,
    },
    reviewArtifact: { path: 'review.md', sha256: reviewHash },
    signedAt: '2026-07-10T05:05:00.000Z',
    validFrom: '2026-07-10T05:05:00.000Z',
    expiresAt: '2026-08-01T05:05:00.000Z',
  };
  independentVerdict = signAuthorityDocument(independentVerdict, {
    privateKeyPem: refereeAuthority.privateKeyPem,
    keyId: refereeAuthority.keyId,
    role: 'independent_referee',
  });
  await writeJson(path.join(inbox, 'INDEPENDENT_REFEREE_VERDICT.json'), independentVerdict);
  const independentReviewAuthorityReceipt = await verifyIndependentRefereeAuthority({
    root,
    runtimeRoot,
    sourceRoot,
    paperTask,
    researchReport,
    artifactPackage,
    venuePlan,
    semanticPromotionLock,
    trustStoreOverride: trustStore,
    now: fixedNow,
  });
  assert.equal(independentReviewAuthorityReceipt.status, 'independent_referee_acceptance_verified');
  assert.equal(independentReviewAuthorityReceipt.acceptanceAuthorityReady, true);
  assert.equal(independentReviewAuthorityReceipt.safety.independentReviewPerformed, true);

  const { signatures: _refereeSignatures, ...unsignedIndependentVerdict } = independentVerdict;
  const conflictedVerdict = signAuthorityDocument({
    ...unsignedIndependentVerdict,
    reviewer: {
      ...unsignedIndependentVerdict.reviewer,
      subjectId: evidenceAuthority.subjectId,
    },
  }, {
    privateKeyPem: evidenceAuthority.privateKeyPem,
    keyId: evidenceAuthority.keyId,
    role: 'independent_referee',
  });
  await writeJson(path.join(inbox, 'INDEPENDENT_REFEREE_VERDICT.json'), conflictedVerdict);
  const conflictedReviewAuthority = await verifyIndependentRefereeAuthority({
    root,
    runtimeRoot,
    sourceRoot,
    paperTask,
    researchReport,
    artifactPackage,
    venuePlan,
    semanticPromotionLock,
    trustStoreOverride: trustStore,
    now: fixedNow,
  });
  assert.equal(conflictedReviewAuthority.status, 'independent_referee_authority_blocked');
  assert.ok(conflictedReviewAuthority.blockers.includes(
    'referee_not_independent_from_academic_evidence_authority',
  ));
  await writeJson(path.join(inbox, 'INDEPENDENT_REFEREE_VERDICT.json'), independentVerdict);

  const executorCapabilities = buildExecutorCapabilities({ executorId: 'fixture-submission-executor', sandboxModes: ['external-workspace'], networkPolicy: 'provider-scoped', externalActions: true, workspaceIsolation: true, receiptKinds: ['signed-response'] });
  const executorDescriptor = submissionExecutorDescriptor({ executorId: 'fixture-submission-executor', provider: 'fixture-portal', accountId: 'fixture-account', workspaceRoot: '/external/fixture', externalWorkspace: true, capabilities: () => executorCapabilities, dispatch() {} });
  const providerCapabilityPayload = { version: 1, kind: 'ProviderCapabilityVerificationReceipt', status: 'provider_capability_verified', provider: 'fixture-portal', accountId: 'fixture-account', portalRoute: '/submit/manuscript', executorDescriptorHash: executorDescriptor.submissionExecutorDescriptorHash, capabilitiesHash: executorDescriptor.capabilitiesHash, attestationHash: hashPaperRecord('FixtureProviderCapabilityAttestation', { provider: 'fixture-portal', accountId: 'fixture-account', portalRoute: '/submit/manuscript' }), verifiedSubjectIds: ['fixture-provider-capability-operator'], cryptographicSignaturesVerified: true, validFrom: '2026-07-10T05:00:00.000Z', expiresAt: '2026-07-10T06:00:00.000Z', blockers: [] };
  const providerCapabilityVerificationReceipt = { ...providerCapabilityPayload, providerCapabilityVerificationReceiptHash: hashPaperRecord('ProviderCapabilityVerificationReceipt', providerCapabilityPayload) };
  const submissionMetadata = { title: 'Authority fixture', abstract: 'Authority pipeline fixture abstract.', authors: [{ name: 'Fixture Author' }], track: 'main', anonymity: 'double_blind', keywords: ['verification'], subjectAreas: ['systems'], conflicts: [], supplements: [], checklist: { ethics: true }, coverLetter: 'Please consider this fixture.' };
  const submissionDecisionPacket = buildReviewedSubmissionDecisionPacket({ paperTask, venuePlan, metadata: submissionMetadata, review: { reviewedBy: 'fixture-human-operator', reviewedAt: '2026-07-10T05:20:00.000Z', reviewActorType: 'human', humanConfirmedFields: ['title', 'abstract', 'authors', 'track', 'anonymity', 'keywords', 'subjectAreas', 'conflicts', 'supplements', 'checklist', 'coverLetter'] } });
  assert.equal(submissionDecisionPacket.status, 'reviewed_submission_decision_verified');
  const venueRepository = artifactRepositoryFactory(inbox);
  const venueWriteReceipt = await venueRepository.writeJson(path.join(inbox, 'venue-observation.json'), { portalState: 'accepting_submissions', route: '/submit/manuscript' }, { role: 'venue-observation' });
  const { ledgerReceiptId: venueLedgerReceiptId, ...storedVenueWriteReceipt } = venueWriteReceipt;
  const venuePreflightObservation = { provider: 'fixture-portal', portalRoute: '/submit/manuscript', venueTarget: venuePlan.venue?.name || venuePlan.target || paperTask.venueTarget, track: 'main', deadlineState: 'open', observedState: 'accepting_submissions', observedAt: '2026-07-10T05:20:00.000Z', expiresAt: '2026-07-10T05:55:00.000Z', reviewedBy: venueObserver.subjectId, evidenceHashes: [venueWriteReceipt.hash], evidenceRefs: [{ path: venueWriteReceipt.path, hash: venueWriteReceipt.hash, artifactWriteReceipt: storedVenueWriteReceipt, ledgerReceiptId: venueLedgerReceiptId }], fetchedPortalState: true };
  const venueSubject = buildVenueObservationSubject({ paperTask, venuePlan, observation: venuePreflightObservation });
  const signedVenueObservation = signAuthorityDocument({ version: 1, kind: 'ReviewedVenueObservationAuthorization', observationSubjectHash: venueSubject.reviewedVenueObservationSubjectHash, signedAt: '2026-07-10T05:20:00.000Z', validFrom: '2026-07-10T05:20:00.000Z', expiresAt: '2026-07-10T05:55:00.000Z' }, { privateKeyPem: venueObserver.privateKeyPem, keyId: venueObserver.keyId, role: 'venue_observer' });
  const venueSourceVerificationReceipt = verifyReviewedVenueObservationSource({ paperTask, venuePlan, observation: venuePreflightObservation, signedObservation: signedVenueObservation, receiptLedger: artifactReceiptLedger, trustStore, now: fixedNow });
  assert.equal(venueSourceVerificationReceipt.status, 'reviewed_venue_observation_source_verified');
  const reviewedVenueEvidence = buildReviewedVenueEvidence({ paperTask, venuePlan, observation: venuePreflightObservation, sourceVerificationReceipt: venueSourceVerificationReceipt, now: fixedNow });
  assert.equal(reviewedVenueEvidence.status, 'reviewed_venue_evidence_verified');
  const liveSubject = buildLiveSubmissionAuthorizationSubject({
    paperTask,
    artifactPackage,
    researchReport,
    independentReviewAuthorityReceipt,
    venuePlan,
    provider: 'fixture-portal',
    accountId: 'fixture-account',
    semanticPromotionLock,
    executorDescriptor,
    submissionDecisionPacket,
    reviewedVenueEvidence,
    venueObservationSourceVerificationReceipt: venueSourceVerificationReceipt,
    providerCapabilityVerificationReceipt,
  });
  let liveAuthorization = {
    version: 1,
    kind: 'LiveSubmissionAuthorization',
    paperId: paperTask.paperId,
    taskKey: paperTask.taskKey,
    authorizationSubjectHash: liveSubject.liveSubmissionAuthorizationSubjectHash,
    allowLiveExternalAction: true,
    environment: 'production',
    portalAction: 'submit_manuscript',
    provider: 'fixture-portal',
    accountId: 'fixture-account',
    nonce: 'fixture_nonce_00000001',
    singleUse: true,
    signedAt: '2026-07-10T05:10:00.000Z',
    validFrom: '2026-07-10T05:10:00.000Z',
    expiresAt: '2026-07-10T06:10:00.000Z',
    responseDueAt: '2026-07-10T05:50:00.000Z',
  };
  liveAuthorization = signAuthorityDocument(liveAuthorization, {
    privateKeyPem: submissionOperator.privateKeyPem,
    keyId: submissionOperator.keyId,
    role: 'submission_operator',
  });
  liveAuthorization = signAuthorityDocument(liveAuthorization, {
    privateKeyPem: liveExecutorAuthorizer.privateKeyPem,
    keyId: liveExecutorAuthorizer.keyId,
    role: 'live_executor_authorizer',
  });
  await writeJson(path.join(inbox, 'LIVE_SUBMISSION_AUTHORIZATION.json'), liveAuthorization);
  const liveAuthorizationReceipt = await verifyLiveSubmissionAuthorization({
    root,
    runtimeRoot,
    paperTask,
    artifactPackage,
    researchReport,
    independentReviewAuthorityReceipt,
    venuePlan,
    semanticPromotionLock,
    trustStoreOverride: trustStore,
    now: fixedNow,
    executorDescriptor,
    submissionDecisionPacket,
    reviewedVenueEvidence,
    venueObservationSourceVerificationReceipt: venueSourceVerificationReceipt,
    providerCapabilityVerificationReceipt,
  });
  assert.equal(liveAuthorizationReceipt.status, 'live_submission_authorization_verified');
  assert.equal(liveAuthorizationReceipt.liveExternalActionAuthorized, true);
  assert.equal(liveAuthorizationReceipt.authorizerSubjectIds.length, 2);
  await writeJson(path.join(inbox, 'LIVE_SUBMISSION_AUTHORIZATION.json'), {
    ...liveAuthorization,
    accountId: 'tampered-account',
  });
  const tamperedLiveAuthorization = await verifyLiveSubmissionAuthorization({
    root,
    runtimeRoot,
    paperTask,
    artifactPackage,
    researchReport,
    independentReviewAuthorityReceipt,
    venuePlan,
    semanticPromotionLock,
    trustStoreOverride: trustStore,
    now: fixedNow,
    executorDescriptor,
    submissionDecisionPacket,
    reviewedVenueEvidence,
    venueObservationSourceVerificationReceipt: venueSourceVerificationReceipt,
    providerCapabilityVerificationReceipt,
  });
  assert.equal(tamperedLiveAuthorization.status, 'live_submission_authorization_blocked');
  assert.ok(tamperedLiveAuthorization.blockers.some((blocker) => (
    blocker.includes('authority_signature_invalid')
    || blocker === 'live_submission_authorization_subject_hash_mismatch'
  )));
  await writeJson(path.join(inbox, 'LIVE_SUBMISSION_AUTHORIZATION.json'), liveAuthorization);
  const lifecycle = buildSubmissionLifecycle({
    row,
    venues,
    artifactPackage,
    packageResult,
    researchReport,
    targetScopeReceipt,
    mode: 'reviewed-submit',
    reviewedSubmit: true,
    venuePlanOverride: venuePlan,
    independentReviewAuthorityReceipt,
    liveAuthorizationReceipt,
    semanticPromotionLock,
    submissionDecisionPacket,
    executorDescriptor,
    venueEvidenceNow: fixedNow,
    venuePreflightObservation,
    reviewedVenueEvidenceOverride: reviewedVenueEvidence,
    providerCapabilityVerificationReceipt,
  });
  assert.equal(lifecycle.approvalPacket.status, 'approved_for_external_executor_handoff');
  assert.equal(lifecycle.approvalPacket.agentApproved, false);
  assert.equal(lifecycle.reviewedSubmitPreflightPacket.status, 'reviewed_submit_preflight_ready_for_external_executor');
  assert.equal(lifecycle.controlledExecutorReceipt.status, 'controlled_external_executor_receipt_recorded');
  assert.equal(lifecycle.controlledExecutorReceipt.controlledExecutorReady, true);
  assert.equal(lifecycle.safety.executorImplementationPresent, false);
  assert.equal(lifecycle.safety.externalActionPerformed, false);
  assert.equal(lifecycle.receipt.externalActionPerformed, false);
  assert.equal(lifecycle.auditArchive.liveSubmitBlocked, true);

  const expiredAuthorizationReceipt = await verifyLiveSubmissionAuthorization({
    root,
    runtimeRoot,
    paperTask,
    artifactPackage,
    researchReport,
    independentReviewAuthorityReceipt,
    venuePlan,
    semanticPromotionLock,
    trustStoreOverride: trustStore,
    now: new Date('2026-07-10T06:11:00.000Z'),
    executorDescriptor,
    submissionDecisionPacket,
    reviewedVenueEvidence,
    venueObservationSourceVerificationReceipt: venueSourceVerificationReceipt,
    providerCapabilityVerificationReceipt,
  });
  assert.equal(expiredAuthorizationReceipt.status, 'live_submission_authorization_blocked');
  assert.ok(expiredAuthorizationReceipt.blockers.includes('authority_expired'));

  await fs.writeFile(path.join(sourceRoot, 'observations.csv'), `${csv}4,999,999\n`, 'utf8');
  const tamperedResearch = await runResearchVerifyAdapter({
    root,
    runtimeRoot,
    row,
    executeResearchWorkers: false,
    trustStoreOverride: trustStore,
    now: fixedNow,
  });
  assert.equal(tamperedResearch.academicEvidenceEligible, false);
  assert.equal(tamperedResearch.nativeResearchWorkerExecution.status, 'native_research_workers_blocked');
  assert.ok(tamperedResearch.academicEvidenceAttestation.blockers.some((blocker) => (
    blocker.includes('artifact_hash_mismatch') || blocker.includes('worker_receipt_not_verified')
  )));
  await fs.writeFile(path.join(sourceRoot, 'observations.csv'), csv, 'utf8');

  const runtimeSource = await fs.readFile(
    path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'paper-adapters', 'research-verify', 'worker-runtime.mjs'),
    'utf8',
  );
  assert.doesNotMatch(runtimeSource, /node:(?:net|http|https|child_process)|\bfetch\s*\(/);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: 'pass_authority_pipeline_selftest',
    nativeResearchWorkers: 3,
    academicEvidenceCryptographicallyVerified: true,
    independentRefereeAuthorityVerified: true,
    liveAuthorizationDualControlVerified: true,
    controlledExecutorBoundaryReady: true,
    executorImplementationPresent: false,
    externalActions: 0,
    sourceMutations: 0,
  })}\n`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
