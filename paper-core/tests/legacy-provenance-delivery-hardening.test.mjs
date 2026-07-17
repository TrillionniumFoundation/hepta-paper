import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildLiveSubmissionAuthorizationSubject } from '../../paper-adapters/submission/live-authorization.mjs';
import { buildProviderCapabilitySubject, verifyProviderCapabilityAttestation } from '../../paper-adapters/submission/provider-capability-verification.mjs';
import { verifySignedAmbiguousRedriveReview } from '../../paper-adapters/submission/redrive-review-verification.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { issueArtifactRepositoryWriter } from '../../paper-adapters/persistence/receipt-writer-broker.mjs';
import { createFilesystemArtifactRepository } from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { verifyArtifactWriteReceiptSource } from '../../paper-adapters/artifacts/artifact-write-receipt-verifier.mjs';
import { verifyTrustedLedgerReceipt } from '../../paper-domain/evidence/trusted-ledger-receipt.mjs';
import { buildVenueObservationSubject } from '../../paper-adapters/submission/venue-observation-verification.mjs';
import { createSqliteSubmissionDeliveryStore } from '../../paper-adapters/submission/sqlite-delivery-store.mjs';
import { buildExecutorCapabilities } from '../../paper-ports/executor-capabilities.mjs';
import { submissionExecutorDescriptor } from '../../paper-ports/submission-executor-port.mjs';
import { buildExperimentEvidenceBinding } from '../../paper-domain/research/experiment-evidence-binding.mjs';
import { buildFormalVerifierRegistry } from '../../paper-domain/research/formal-verifier-registry.mjs';
import { buildGenericFormalCertificateIntake } from '../../paper-domain/research/formal-certificate-intake.mjs';
import { buildRefereeAppliedPatchReceipt } from '../../paper-domain/contracts/referee-application.mjs';
import { buildReviewedVenueEvidence } from '../../paper-domain/submission/reviewed-venue-evidence.mjs';
import { buildSubmissionRedriveDecision } from '../../paper-domain/submission/redrive-decision.mjs';
import { buildExecutorResponseIntake } from '../../paper-domain/submission/delivery-runtime.mjs';
import { signAuthorityDocument } from '../src/authority-signatures.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { h, trustedExperimentFixture, trustedFormalFixture, trustedVenueFixture } from './trusted-evidence-test-support.mjs';

function failLedgerWrites(ledger) {
  return Object.freeze({
    ...ledger,
    prepare(receipt, options) {
      const prepared = ledger.prepare(receipt, options);
      return Object.freeze({ ...prepared, sql: 'INSERT INTO simulated_missing_receipt_ledger_table(value) VALUES(1);' });
    },
  });
}

test('referee applied-patch receipt fails closed without a postimage and records complete lineage', () => {
  const paperTask = { paperId: 'paper-referee-apply', taskKey: 'paper:paper-referee-apply' };
  const issueQueue = {
    kind: 'RefereeRevisionIssueQueue',
    issueCount: 1,
    openIssueCount: 1,
    refereeRevisionIssueQueueHash: h('1'),
  };
  const patchPlan = {
    kind: 'RefereeRevisionPatchPlan',
    refereeRevisionPatchPlanHash: h('2'),
  };
  const patchApplyExecution = {
    status: 'referee_patch_apply_ready_for_separate_executor',
    refereePatchApplyExecutionHash: h('3'),
    plannedPatchInputs: [{ patchId: 'patch-1', patchSha256: h('4') }],
  };
  const patchApplyInvocation = {
    status: 'referee_patch_apply_invocation_applied',
    refereePatchApplyInvocationHash: h('5'),
    targetPreimageChecks: [{ targetPath: 'paper.tex', actualPreimageHash: h('6') }],
  };
  const base = {
    paperTask,
    issueQueue,
    patchPlan,
    patchApplyExecution,
    patchApplyInvocation,
    applied: true,
    executorId: 'isolated-referee-patch-executor',
    createdAt: '2026-07-13T00:00:00.000Z',
  };

  const missingPostimage = buildRefereeAppliedPatchReceipt(base);
  assert.equal(missingPostimage.status, 'applied_patch_receipt_blocked');
  assert.deepEqual(missingPostimage.blockers, ['postimage_snapshot_required']);
  assert.equal(missingPostimage.sourceMutationPerformed, false);

  const recorded = buildRefereeAppliedPatchReceipt({
    ...base,
    postimageRecords: [{ targetPath: 'paper.tex', postimageHash: h('7'), sizeBytes: 1024 }],
  });
  assert.equal(recorded.status, 'applied_patch_receipt_recorded');
  assert.equal(recorded.appliedPatchPerformed, true);
  assert.equal(recorded.postimageCount, 1);
  assert.equal(recorded.hashChain.patchApplyInvocationHash, h('5'));
  assert.equal(recorded.postimageRecords[0].postimageHash, h('7'));
});

test('venue evidence and redrive lineage are source verified and authorization bound', () => {
  const paperTask = { paperId: 'p', taskKey: 'paper:p', venueTarget: 'Journal X' };
  const venuePlan = { status: 'local_dry_run_ready', venueSubmissionPlanHash: h('1'), target: 'Journal X' };
  const fake = buildReviewedVenueEvidence({ paperTask, venuePlan, observation: { provider: 'p', portalRoute: '/x', venueTarget: 'Journal X', track: 'main', deadlineState: 'open', observedState: 'accepting_submissions', reviewedBy: 'self', fetchedPortalState: true, observedAt: '2026-07-13T00:00:00Z', expiresAt: '2026-07-13T02:00:00Z', evidenceHashes: [h('2')] }, now: new Date('2026-07-13T01:00:00Z') });
  assert.equal(fake.status, 'reviewed_venue_evidence_blocked');
  const trusted = trustedVenueFixture({ paperTask, venuePlan });
  const originalObservationSubject = buildVenueObservationSubject({ paperTask, venuePlan, observation: trusted.observation });
  const changedReviewerSubject = buildVenueObservationSubject({ paperTask, venuePlan, observation: { ...trusted.observation, reviewedBy: 'different-reviewer' } });
  assert.notEqual(originalObservationSubject.reviewedVenueObservationSubjectHash, changedReviewerSubject.reviewedVenueObservationSubjectHash);
  const venueEvidence = buildReviewedVenueEvidence({ paperTask, venuePlan, observation: trusted.observation, sourceVerificationReceipt: trusted.sourceVerificationReceipt, now: new Date('2026-07-13T01:00:00Z') });
  assert.equal(venueEvidence.status, 'reviewed_venue_evidence_verified');
  const base = { paperTask, artifactPackage: { artifactPackageHash: h('3') }, researchReport: { academicEvidenceAttestation: { academicEvidenceAttestationVerificationHash: h('4') } }, independentReviewAuthorityReceipt: { independentRefereeAuthorityReceiptHash: h('5') }, venuePlan, provider: 'p', accountId: 'a', semanticPromotionLock: { semanticPromotionLockHash: h('6') }, executorDescriptor: { submissionExecutorDescriptorHash: h('7'), capabilitiesHash: h('8') }, submissionDecisionPacket: { reviewedSubmissionDecisionPacketHash: h('9') }, providerCapabilityVerificationReceipt: { providerCapabilityVerificationReceiptHash: h('d') } };
  const first = buildLiveSubmissionAuthorizationSubject({ ...base, reviewedVenueEvidence: venueEvidence });
  const changed = buildLiveSubmissionAuthorizationSubject({ ...base, reviewedVenueEvidence: { ...venueEvidence, reviewedVenueEvidenceHash: h('a') } });
  assert.notEqual(first.liveSubmissionAuthorizationSubjectHash, changed.liveSubmissionAuthorizationSubjectHash);
  assert.notEqual(first.liveSubmissionAuthorizationSubjectHash, buildLiveSubmissionAuthorizationSubject({ ...base, reviewedVenueEvidence: { ...venueEvidence, reviewedBy: 'other-observer' } }).liveSubmissionAuthorizationSubjectHash);
  assert.notEqual(first.liveSubmissionAuthorizationSubjectHash, buildLiveSubmissionAuthorizationSubject({ ...base, reviewedVenueEvidence: { ...venueEvidence, purpose: 'ambiguous_redrive' } }).liveSubmissionAuthorizationSubjectHash);
  assert.notEqual(first.liveSubmissionAuthorizationSubjectHash, buildLiveSubmissionAuthorizationSubject({ ...base, providerCapabilityVerificationReceipt: { providerCapabilityVerificationReceiptHash: h('e') }, reviewedVenueEvidence: venueEvidence }).liveSubmissionAuthorizationSubjectHash);
});

test('fabricated receipts fail while trusted experiment evidence passes and unavailable formal tiers stay blocked', () => {
  const fakeExperiment = buildExperimentEvidenceBinding({ experiment: { datasetHash: h('1'), codeHash: h('2'), resultHash: h('3') }, workerReceipt: { status: 'worker_execution_completed', receiptHash: h('4'), datasetHash: h('1'), codeHash: h('2'), resultHash: h('3') }, resultArtifact: { hash: h('3'), outputArtifactHashes: [h('5')] }, reproducibilityReceipt: { status: 'experiment_reproducibility_verified', receiptHash: h('6'), workerReceiptHash: h('4'), resultHash: h('3'), outputArtifactHashes: [h('5')] } });
  assert.equal(fakeExperiment.status, 'experiment_evidence_binding_blocked');
  const trustedExperiment = trustedExperimentFixture({});
  const verifiedExperiment = buildExperimentEvidenceBinding({ experiment: trustedExperiment.artifact, workerReceipt: trustedExperiment.artifact.workerReceipt, resultArtifact: trustedExperiment.artifact.resultArtifact, reproducibilityReceipt: trustedExperiment.artifact.reproducibilityReceipt, receiptLedger: trustedExperiment.ledger, artifactVerifier: trustedExperiment.artifactVerifier, requiredOutputs: ['agent-compute-manifest.json', 'metrics.json', 'experiment-summary.md', 'experiment-reproducibility.json'] });
  assert.equal(verifiedExperiment.status, 'experiment_evidence_binding_verified');

  const fakeRegistry = buildFormalVerifierRegistry({ adapterReceipts: [{ version: 1, kind: 'FormalVerifierAdapterReceipt', verifierKind: 'coq', command: 'coqc', extension: '.v', status: 'formal_verifier_adapter_verified', receiptHash: h('8') }] });
  assert.equal(fakeRegistry.verifiers.find((item) => item.kind === 'coq').status, 'formal_verifier_unavailable');
  const formal = trustedFormalFixture({});
  const registry = buildFormalVerifierRegistry({ adapterReceipts: [formal.adapterReceipt], receiptLedger: formal.ledger });
  const intake = buildGenericFormalCertificateIntake({ verifierKind: 'coq', verifierRegistry: registry, certificate: formal.certificate, sourceRecords: formal.sourceRecords, claimBindings: formal.claimBindings, executionReceipt: formal.executionReceipt, receiptLedger: formal.ledger, artifactVerifier: formal.artifactVerifier });
  assert.equal(intake.status, 'formal_certificate_intake_blocked');
  assert.ok(intake.blockers.includes('formal_verifier_adapter_not_registered'));
  const changedToolchain = buildGenericFormalCertificateIntake({ verifierKind: 'coq', verifierRegistry: registry, certificate: { ...formal.certificate, toolchainHash: h('7') }, sourceRecords: formal.sourceRecords, claimBindings: formal.claimBindings, executionReceipt: formal.executionReceipt, receiptLedger: formal.ledger, artifactVerifier: formal.artifactVerifier });
  assert.equal(changedToolchain.status, 'formal_certificate_intake_blocked');
  assert.ok(changedToolchain.blockers.includes('formal_verifier_adapter_not_registered'));
});

test('trusted ledger metadata and actual CAS bytes are both required', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-trusted-cas-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root }); t.after(() => store.close());
  const clock = { now: () => new Date('2026-07-13T00:00:00Z'), nowIso: () => '2026-07-13T00:00:00.000Z' };
  const ledger = createSqliteReceiptLedger({ store, clock, issuerCapability: issueArtifactRepositoryWriter() });
  const repository = createFilesystemArtifactRepository({ scopeRoot: root, casRoot: path.join(root, 'cas'), receiptLedger: ledger, clock });
  const written = await repository.writeJson(path.join(root, 'evidence.json'), { verified: true }, { role: 'venue-observation' });
  assert.equal(verifyArtifactWriteReceiptSource({ receipt: written }).status, 'artifact_write_receipt_source_verified');
  const { ledgerReceiptId, ...storedWriteReceipt } = written;
  assert.equal(verifyTrustedLedgerReceipt({ receipt: storedWriteReceipt, ledgerReceiptId, receiptLedger: ledger, expectedKinds: ['ArtifactWriteReceipt'], expectedStreams: ['artifact-writes'], expectedWriterKinds: ['content-addressed-repository'] }).status, 'trusted_ledger_receipt_verified');
  assert.throws(() => ledger.record({ version: 1, kind: 'ExperimentWorkerExecutionReceipt', status: 'worker_execution_completed', receiptHash: h('a') }, { stream: 'experiment-workers' }), /issuer kind forbidden/);
  const missing = { ...written, path: 'missing.json', manifestPath: 'manifests/missing.json' };
  assert.equal(verifyArtifactWriteReceiptSource({ receipt: missing }).status, 'artifact_write_receipt_source_blocked');
  const outside = path.join(os.tmpdir(), `hepta-artifact-outside-${crypto.randomUUID()}.json`);
  fs.writeFileSync(outside, fs.readFileSync(path.join(root, written.path)));
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.rmSync(path.join(root, written.path));
  fs.symlinkSync(outside, path.join(root, written.path));
  assert.equal(verifyArtifactWriteReceiptSource({ receipt: written }).status, 'artifact_write_receipt_source_blocked');
});

test('response state and persisted receipt are one atomic transaction', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-response-atomic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root }); t.after(() => store.close());
  const clock = { now: () => new Date('2026-07-13T00:00:00Z'), nowIso: () => '2026-07-13T00:00:00.000Z' };
  const ledger = createSqliteReceiptLedger({ store, clock });
  const failingLedger = { ...ledger, prepare() { throw new Error('simulated-ledger-prepare-failure'); } };
  const delivery = createSqliteSubmissionDeliveryStore({ store, receiptLedger: failingLedger, clock });
  const authorization = { status: 'submission_dispatch_authorization_ready', submissionDispatchAuthorizationHash: 'atomic-dispatch', provider: 'p', accountId: 'a', nonce: 'atomic-nonce', attempt: 1 };
  const message = delivery.enqueue({ paperId: 'p', dispatchAuthorization: authorization, payload: {} });
  const response = { responseId: 'atomic-response', outcome: 'failed', dispatchAuthorizationHash: 'atomic-dispatch', provider: 'p', accountId: 'a', performedAt: clock.nowIso(), attempt: 1 };
  assert.throws(() => delivery.recordResponse({ messageId: message.message_id, response }), /simulated-ledger-prepare-failure/);
  assert.equal(store.query("SELECT count(*) AS count FROM submission_inbox WHERE response_id='atomic-response';").rows[0].count, 0);
  assert.equal(delivery.getOutbox(message.message_id).status, 'pending');
});

test('redrive, dead-letter and quarantine state roll back when ledger persistence fails', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-delivery-ledger-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root }); t.after(() => store.close());
  const clock = { now: () => new Date('2026-07-13T00:00:00Z'), nowIso: () => '2026-07-13T00:00:00.000Z' };
  const ledger = createSqliteReceiptLedger({ store, clock });
  const delivery = createSqliteSubmissionDeliveryStore({ store, receiptLedger: ledger, clock });
  const failing = createSqliteSubmissionDeliveryStore({ store, receiptLedger: failLedgerWrites(ledger), clock });

  const retryAuthorization = { status: 'submission_dispatch_authorization_ready', submissionDispatchAuthorizationHash: 'atomic-redrive-dispatch', provider: 'p', accountId: 'a', nonce: 'atomic-redrive-nonce', attempt: 1 };
  const retryMessage = delivery.enqueue({ paperId: 'redrive-paper', dispatchAuthorization: retryAuthorization, payload: { _delivery: { attempt: 1 } } });
  assert.equal(store.execute(`UPDATE submission_outbox SET status='retryable_failure' WHERE message_id='${retryMessage.message_id}';`).ok, true);
  const planPayload = { version: 1, kind: 'SubmissionRedrivePlan', status: 'submission_redrive_reauthorization_required', dispatchAuthorizationHash: retryMessage.dispatch_hash, nextAttempt: 2 };
  const redrivePlan = { ...planPayload, submissionRedrivePlanHash: hashRecord('SubmissionRedrivePlan', planPayload) };
  assert.throws(() => failing.scheduleRedrive({ messageId: retryMessage.message_id, redrivePlan }), /simulated_missing_receipt_ledger_table/);
  assert.equal(delivery.getOutbox(retryMessage.message_id).status, 'retryable_failure');
  assert.equal(store.query("SELECT count(*) AS count FROM receipt_ledger WHERE kind='SubmissionRedriveReauthorizationRequiredReceipt';").rows[0].count, 0);

  const deadAuthorization = { ...retryAuthorization, submissionDispatchAuthorizationHash: 'atomic-dead-dispatch', nonce: 'atomic-dead-nonce' };
  const deadMessage = delivery.enqueue({ paperId: 'dead-paper', dispatchAuthorization: deadAuthorization, payload: {} });
  assert.throws(() => failing.deadLetter({ messageId: deadMessage.message_id, failureClass: 'fixture_failure' }), /simulated_missing_receipt_ledger_table/);
  assert.equal(delivery.getOutbox(deadMessage.message_id).status, 'pending');
  assert.equal(store.query(`SELECT count(*) AS count FROM submission_dead_letters WHERE message_id='${deadMessage.message_id}';`).rows[0].count, 0);

  assert.throws(() => failing.quarantineInvalidIntake({ messageId: 'missing-message', payload: { secret: 'not-stored' }, failureCodes: ['fixture'] }), /simulated_missing_receipt_ledger_table/);
  assert.equal(store.query("SELECT count(*) AS count FROM submission_intake_quarantine WHERE message_id='missing-message';").rows[0].count, 0);
});

test('release-lock state and its persisted receipt commit atomically', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-ledger-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root }); t.after(() => store.close());
  const clock = { now: () => new Date('2026-07-13T00:00:00Z'), nowIso: () => '2026-07-13T00:00:00.000Z' };
  const ledger = createSqliteReceiptLedger({ store, clock });
  const delivery = createSqliteSubmissionDeliveryStore({ store, receiptLedger: ledger, clock });
  const dispatchAuthorization = {
    status: 'submission_dispatch_authorization_ready',
    submissionDispatchAuthorizationHash: h('1'),
    provider: 'provider',
    accountId: 'account',
    nonce: 'release-nonce',
    attempt: 1,
    replayKey: h('2'),
    actionScopeKey: h('3'),
    dispatchCycleHash: h('4'),
    liveAuthorizationHash: h('5'),
    responseDueAt: '2026-07-13T01:00:00.000Z',
    providerCapabilityVerificationReceiptHash: h('6'),
    portalRoute: '/submit',
  };
  const message = delivery.enqueueAuthorized({ paperId: 'release-paper', dispatchAuthorization, payload: {} });
  const response = {
    responseId: 'release-response',
    outcome: 'rejected',
    dispatchAuthorizationHash: dispatchAuthorization.submissionDispatchAuthorizationHash,
    provider: dispatchAuthorization.provider,
    accountId: dispatchAuthorization.accountId,
    performedAt: clock.nowIso(),
    attempt: 1,
  };
  delivery.recordResponse({ messageId: message.message_id, response });
  const responseIntake = buildExecutorResponseIntake({ dispatchAuthorization, response });
  const releaseLock = {
    status: 'submission_release_unlocked',
    dispatchAuthorizationHash: dispatchAuthorization.submissionDispatchAuthorizationHash,
    responseIntakeHash: responseIntake.executorResponseIntakeHash,
    reconciliationHash: h('7'),
  };
  const failing = createSqliteSubmissionDeliveryStore({ store, receiptLedger: failLedgerWrites(ledger), clock });
  assert.throws(() => failing.release({ paperId: 'release-paper', lockToken: dispatchAuthorization.submissionDispatchAuthorizationHash, releaseLock }), /simulated_missing_receipt_ledger_table/);
  assert.equal(delivery.getReleaseLock('release-paper').status, 'locked');
  assert.equal(store.query("SELECT count(*) AS count FROM receipt_ledger WHERE kind='SubmissionReleasePersistedReceipt';").rows[0].count, 0);
  assert.equal(delivery.release({ paperId: 'release-paper', lockToken: dispatchAuthorization.submissionDispatchAuthorizationHash, releaseLock }).status, 'released');
  assert.equal(store.query("SELECT count(*) AS count FROM receipt_ledger WHERE kind='SubmissionReleasePersistedReceipt';").rows[0].count, 1);
});

test('ambiguous human review requires a verified signature receipt', () => {
  const dispatch = { paperId: 'p', status: 'submission_dispatch_authorization_ready', submissionDispatchAuthorizationHash: h('1') };
  const responseIntake = { status: 'executor_response_intake_blocked', blockers: ['executor_response_missing'], executorResponseIntakeHash: h('2') };
  const unsignedPayload = { version: 1, kind: 'SignedAmbiguousSubmissionReview', status: 'submission_ambiguous_result_reviewed', decision: 'confirm_not_submitted', dispatchAuthorizationHash: h('1'), reviewedBy: 'operator', signedAt: '2026-07-13T00:00:00Z', validFrom: '2026-07-13T00:00:00Z', expiresAt: '2026-07-13T02:00:00Z' };
  const reviewHash = hashRecord('SignedAmbiguousSubmissionReview', unsignedPayload);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const humanReview = signAuthorityDocument({ ...unsignedPayload, submissionAmbiguousResultReviewHash: reviewHash }, { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), keyId: 'operator-key', role: 'submission_operator' });
  const trustStore = { version: 1, kind: 'AuthorityTrustStore', keys: [{ keyId: 'operator-key', subjectId: 'operator', algorithm: 'ed25519', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), roles: ['submission_operator'], status: 'active' }] };
  const verification = verifySignedAmbiguousRedriveReview({ dispatchAuthorization: dispatch, humanReview, trustStore, now: new Date('2026-07-13T01:00:00Z') });
  assert.equal(verification.status, 'ambiguous_redrive_review_verified');
  assert.equal(buildSubmissionRedriveDecision({ dispatchAuthorization: dispatch, responseIntake, responseDueAt: '2026-07-13T00:30:00Z', now: new Date('2026-07-13T01:00:00Z'), humanReview }).status, 'submission_redrive_decision_blocked');
  assert.equal(buildSubmissionRedriveDecision({ dispatchAuthorization: dispatch, responseIntake, responseDueAt: '2026-07-13T00:30:00Z', now: new Date('2026-07-13T01:00:00Z'), humanReview, humanReviewVerificationReceipt: verification }).status, 'submission_redrive_reauthorization_approved');
});

test('quarantine covers conflict, verifier failure and unknown message', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-quarantine-all-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root }); t.after(() => store.close());
  const clock = { now: () => new Date('2026-07-13T00:00:00Z'), nowIso: () => '2026-07-13T00:00:00.000Z' };
  const ledger = createSqliteReceiptLedger({ store, clock });
  const delivery = createSqliteSubmissionDeliveryStore({ store, receiptLedger: ledger, clock });
  const authorization = { status: 'submission_dispatch_authorization_ready', submissionDispatchAuthorizationHash: 'd', provider: 'p', accountId: 'a', nonce: 'n', attempt: 1 };
  const message = delivery.enqueue({ paperId: 'p', dispatchAuthorization: authorization, payload: {} });
  const response = { responseId: 'r', outcome: 'failed', dispatchAuthorizationHash: 'd', provider: 'p', accountId: 'a', performedAt: clock.nowIso(), attempt: 1 };
  delivery.recordResponse({ messageId: message.message_id, response });
  assert.throws(() => delivery.recordResponse({ messageId: message.message_id, response: { ...response, outcome: 'cancelled' } }), /duplicate executor response conflict/);
  assert.equal(delivery.listQuarantine({ messageId: message.message_id }).length, 1);
  assert.throws(() => delivery.recordResponse({ messageId: 'missing', response }), /outbox message missing/);
  assert.equal(delivery.listQuarantine({ limit: 10 }).length, 2);
  const verifierDelivery = createSqliteSubmissionDeliveryStore({ store, receiptLedger: ledger, clock, executorResponseVerifier: () => { throw new Error('secret verifier detail'); } });
  const identity = verifierDelivery.enqueue({ paperId: 'pv', dispatchAuthorization: { ...authorization, submissionDispatchAuthorizationHash: 'dv', nonce: 'nv', executorDescriptorHash: h('3') }, payload: {} });
  assert.throws(() => verifierDelivery.recordResponse({ messageId: identity.message_id, response: { ...response, responseId: 'rv', dispatchAuthorizationHash: 'dv' } }), /secret verifier detail/);
  const quarantine = verifierDelivery.listQuarantine({ messageId: identity.message_id });
  assert.equal(quarantine.length, 1);
  assert.equal(quarantine[0].failure_codes_json.includes('secret verifier detail'), false);
});

test('provider capability gates atomic claim lease heartbeat and response cursor', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-delivery-lease-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root }); t.after(() => store.close());
  let milliseconds = Date.parse('2026-07-13T00:00:00Z');
  const clock = { now: () => new Date(milliseconds), nowIso: () => new Date(milliseconds).toISOString() };
  const ledger = createSqliteReceiptLedger({ store, clock });
  const capabilities = buildExecutorCapabilities({ executorId: 'executor-1', sandboxModes: ['external-workspace'], networkPolicy: 'provider-scoped', externalActions: true, workspaceIsolation: true, receiptKinds: ['signed-response'] });
  const descriptor = submissionExecutorDescriptor({ executorId: 'executor-1', provider: 'portal-x', accountId: 'account-x', workspaceRoot: '/external', externalWorkspace: true, capabilities: () => capabilities, dispatch() {} });
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const trustStore = { version: 1, kind: 'AuthorityTrustStore', keys: [{ keyId: 'cap-key', subjectId: 'cap-operator', algorithm: 'ed25519', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), roles: ['provider_capability_operator'], status: 'active' }] };
  const attestationBase = { version: 1, kind: 'SignedSubmissionProviderCapabilityAttestation', provider: descriptor.provider, accountId: descriptor.accountId, portalRoute: '/submit', permittedAction: 'submit_manuscript', signedAt: clock.nowIso(), validFrom: clock.nowIso(), expiresAt: '2026-07-13T02:00:00.000Z' };
  const capabilitySubject = buildProviderCapabilitySubject({ attestation: attestationBase, executorDescriptor: descriptor });
  const attestation = signAuthorityDocument({ ...attestationBase, capabilitySubjectHash: capabilitySubject.submissionProviderCapabilitySubjectHash }, { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), keyId: 'cap-key', role: 'provider_capability_operator' });
  const verifier = ({ attestation: value, executorDescriptor: selected }) => verifyProviderCapabilityAttestation({ attestation: value, executorDescriptor: selected, trustStore, now: clock.now() });
  const responseVerifier = ({ dispatchAuthorization, response }) => ({ version: 1, kind: 'ExecutorResponseVerificationReceipt', status: 'executor_response_signature_verified', responseId: response.responseId, dispatchAuthorizationHash: dispatchAuthorization.submissionDispatchAuthorizationHash, executorId: dispatchAuthorization.executorId, executorDescriptorHash: dispatchAuthorization.executorDescriptorHash, capabilitiesHash: dispatchAuthorization.executorCapabilitiesHash, cryptographicSignaturesVerified: true, executorResponseVerificationReceiptHash: h('f') });
  const delivery = createSqliteSubmissionDeliveryStore({ store, receiptLedger: ledger, clock, providerCapabilityVerifier: verifier, executorResponseVerifier: responseVerifier });
  const failingDelivery = createSqliteSubmissionDeliveryStore({ store, receiptLedger: failLedgerWrites(ledger), clock, providerCapabilityVerifier: verifier, executorResponseVerifier: responseVerifier });
  assert.throws(() => failingDelivery.registerProviderCapability({ attestation, executorDescriptor: descriptor }), /simulated_missing_receipt_ledger_table/);
  assert.equal(store.query('SELECT count(*) AS count FROM submission_provider_capabilities;').rows[0].count, 0);
  const capabilityVerification = delivery.registerProviderCapability({ attestation, executorDescriptor: descriptor });
  assert.equal(capabilityVerification.status, 'provider_capability_verified');
  const replacementBase = { ...attestationBase, portalRoute: '/different-route' };
  const replacementSubject = buildProviderCapabilitySubject({ attestation: replacementBase, executorDescriptor: descriptor });
  const replacement = signAuthorityDocument({ ...replacementBase, capabilitySubjectHash: replacementSubject.submissionProviderCapabilitySubjectHash }, { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), keyId: 'cap-key', role: 'provider_capability_operator' });
  assert.throws(() => delivery.registerProviderCapability({ attestation: replacement, executorDescriptor: descriptor }), /replacement requires a new executor descriptor/);
  const dispatch = { status: 'submission_dispatch_authorization_ready', submissionDispatchAuthorizationHash: h('1'), provider: descriptor.provider, accountId: descriptor.accountId, nonce: 'nonce-lease', attempt: 1, replayKey: h('2'), actionScopeKey: h('3'), dispatchCycleHash: h('4'), liveAuthorizationHash: h('5'), executorId: descriptor.executorId, executorDescriptorHash: descriptor.submissionExecutorDescriptorHash, executorCapabilitiesHash: descriptor.capabilitiesHash, responseDueAt: '2026-07-13T01:00:00Z', providerCapabilityVerificationReceiptHash: capabilityVerification.providerCapabilityVerificationReceiptHash, portalRoute: capabilityVerification.portalRoute };
  const message = delivery.enqueueAuthorized({ paperId: 'p', dispatchAuthorization: dispatch, payload: {} });
  const prepareFailureDelivery = createSqliteSubmissionDeliveryStore({ store, receiptLedger: { ...ledger, prepare() { throw new Error('simulated-claim-prepare-failure'); } }, clock });
  assert.throws(() => prepareFailureDelivery.claimPending({ workerId: 'prepare-failing-worker', provider: descriptor.provider, accountId: descriptor.accountId, executorDescriptorHash: descriptor.submissionExecutorDescriptorHash, leaseSeconds: 60 }), /simulated-claim-prepare-failure/);
  assert.equal(delivery.getOutbox(message.message_id).status, 'pending');
  assert.throws(() => failingDelivery.claimPending({ workerId: 'failing-worker', provider: descriptor.provider, accountId: descriptor.accountId, executorDescriptorHash: descriptor.submissionExecutorDescriptorHash, leaseSeconds: 60 }), /simulated_missing_receipt_ledger_table/);
  assert.equal(delivery.getOutbox(message.message_id).status, 'pending');
  const claim = delivery.claimPending({ workerId: 'worker-1', provider: descriptor.provider, accountId: descriptor.accountId, executorDescriptorHash: descriptor.submissionExecutorDescriptorHash, leaseSeconds: 60 });
  assert.equal(claim.status, 'in_flight');
  assert.equal(delivery.claimPending({ workerId: 'worker-2', provider: descriptor.provider, accountId: descriptor.accountId, executorDescriptorHash: descriptor.submissionExecutorDescriptorHash }), null);
  assert.equal(delivery.heartbeatClaim({ messageId: message.message_id, leaseToken: claim.leaseToken }).status, 'submission_delivery_lease_renewed');
  const response = { responseId: 'response-lease', outcome: 'failed', dispatchAuthorizationHash: dispatch.submissionDispatchAuthorizationHash, provider: descriptor.provider, accountId: descriptor.accountId, performedAt: clock.nowIso(), attempt: 1, executorId: descriptor.executorId, executorDescriptorHash: descriptor.submissionExecutorDescriptorHash, capabilitiesHash: descriptor.capabilitiesHash };
  assert.throws(() => delivery.recordResponse({ messageId: message.message_id, response }), /active delivery lease required/);
  delivery.recordResponse({ messageId: message.message_id, response, leaseToken: claim.leaseToken });
  assert.equal(delivery.claimPending({ workerId: 'worker-2', provider: descriptor.provider, accountId: descriptor.accountId, executorDescriptorHash: descriptor.submissionExecutorDescriptorHash }), null);
  assert.equal(delivery.recoverPending({ at: clock.nowIso() }).some((item) => item.message_id === message.message_id), false);
  assert.equal(delivery.getOutbox(message.message_id).status, 'retryable_failure');
  const consumption = delivery.getResponseConsumption(response.responseId);
  const responseClaim = delivery.claimNextResponse({ workerId: 'response-worker', provider: descriptor.provider, accountId: descriptor.accountId, anchorHash: consumption.anchor_hash });
  delivery.completeResponseConsumption({ responseId: response.responseId, leaseToken: responseClaim.leaseToken });
  const cursor = delivery.advanceResponseCursor({ provider: descriptor.provider, accountId: descriptor.accountId, responseId: response.responseId });
  assert.equal(cursor.cursor_response_id, response.responseId);
});

test('response cursor is anchor-scoped, consumed-first and strictly monotonic', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-response-cursor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root }); t.after(() => store.close());
  const clock = { now: () => new Date('2026-07-13T00:00:00Z'), nowIso: () => '2026-07-13T00:00:00.000Z' };
  const ledger = createSqliteReceiptLedger({ store, clock });
  const delivery = createSqliteSubmissionDeliveryStore({ store, receiptLedger: ledger, clock });
  for (const suffix of ['1', '2']) {
    const authorization = { status: 'submission_dispatch_authorization_ready', submissionDispatchAuthorizationHash: `cursor-dispatch-${suffix}`, provider: 'p', accountId: 'a', nonce: `cursor-nonce-${suffix}`, attempt: 1 };
    const message = delivery.enqueue({ paperId: `p-${suffix}`, dispatchAuthorization: authorization, payload: {} });
    delivery.recordResponse({ messageId: message.message_id, response: { responseId: `cursor-response-${suffix}`, outcome: 'failed', dispatchAuthorizationHash: authorization.submissionDispatchAuthorizationHash, provider: 'p', accountId: 'a', performedAt: clock.nowIso(), attempt: 1 } });
  }
  const first = delivery.getResponseConsumption('cursor-response-1');
  const second = delivery.getResponseConsumption('cursor-response-2');
  assert.equal(delivery.claimNextResponse({ workerId: 'wrong-anchor', provider: 'p', accountId: 'a', anchorHash: h('f') }), null);
  const firstClaim = delivery.claimNextResponse({ workerId: 'cursor-worker', provider: 'p', accountId: 'a', anchorHash: first.anchor_hash });
  assert.equal(firstClaim.state, 'IN_PROGRESS');
  delivery.completeResponseConsumption({ responseId: first.response_id, leaseToken: firstClaim.leaseToken });
  assert.equal(delivery.claimNextResponse({ workerId: 'cursor-worker', provider: 'p', accountId: 'a', anchorHash: second.anchor_hash }), null);
  assert.throws(() => delivery.advanceResponseCursor({ provider: 'p', accountId: 'a', responseId: second.response_id }), /skip an earlier response/);
  delivery.advanceResponseCursor({ provider: 'p', accountId: 'a', responseId: first.response_id });
  const secondClaim = delivery.claimNextResponse({ workerId: 'cursor-worker', provider: 'p', accountId: 'a', anchorHash: second.anchor_hash });
  assert.equal(secondClaim.state, 'IN_PROGRESS');
  delivery.completeResponseConsumption({ responseId: second.response_id, leaseToken: secondClaim.leaseToken });
  assert.throws(() => delivery.completeResponseConsumption({ responseId: second.response_id, leaseToken: secondClaim.leaseToken }), /active response consumption lease required/);
  const advanced = delivery.advanceResponseCursor({ provider: 'p', accountId: 'a', responseId: second.response_id });
  assert.equal(Number(advanced.cursor_sequence), Number(second.sequence));
  assert.throws(() => delivery.advanceResponseCursor({ provider: 'p', accountId: 'a', responseId: first.response_id }), /skip an earlier response/);
});
