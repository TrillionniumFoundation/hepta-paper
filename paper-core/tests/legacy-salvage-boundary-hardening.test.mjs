import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createSqliteSubmissionDeliveryStore } from '../../paper-adapters/submission/sqlite-delivery-store.mjs';
import { buildExecutorResponseIntake, buildSubmissionRedrivePlan } from '../../paper-domain/submission/delivery-runtime.mjs';
import { verifySignedExecutorResponse } from '../../paper-adapters/submission/executor-response-verification.mjs';
import { buildReviewedSubmissionDecisionPacket } from '../../paper-domain/submission/reviewed-submission-decision.mjs';
import { buildReviewedVenueEvidence } from '../../paper-domain/submission/reviewed-venue-evidence.mjs';
import { buildSubmissionRedriveDecision } from '../../paper-domain/submission/redrive-decision.mjs';
import { buildExperimentEvidenceBinding } from '../../paper-domain/research/experiment-evidence-binding.mjs';
import { evaluateExperimentAcceptance } from '../../paper-domain/research/experiment-acceptance-policy.mjs';
import { buildExperimentAcceptanceContract } from '../../paper-domain/research/experiment-profiles.mjs';
import { buildFormalVerifierRegistry } from '../../paper-domain/research/formal-verifier-registry.mjs';
import { buildGenericFormalCertificateIntake } from '../../paper-domain/research/formal-certificate-intake.mjs';
import { buildExecutorCapabilities } from '../../paper-ports/executor-capabilities.mjs';
import { submissionExecutorDescriptor } from '../../paper-ports/submission-executor-port.mjs';
import { validateBoundaryRecord } from '../../paper-ports/boundary-schema-catalog.mjs';
import { signAuthorityDocument } from '../src/authority-signatures.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { trustedExperimentFixture, trustedFormalFixture, trustedVenueFixture } from './trusted-evidence-test-support.mjs';

const h = (character) => `sha256:${character.repeat(64)}`;
const paperTask = { paperId: 'paper-hardening', taskKey: 'paper:paper-hardening', venueTarget: 'Journal X' };
const venuePlan = { status: 'local_dry_run_ready', venueSubmissionPlanHash: h('a'), target: 'Journal X' };

function venueObservation(overrides = {}) {
  return { provider: 'portal-x', portalRoute: '/submit/manuscript', venueTarget: 'Journal X', track: 'main', deadlineState: 'open', observedState: 'accepting_submissions', observedAt: '2026-07-13T00:00:00.000Z', expiresAt: '2026-07-13T02:00:00.000Z', reviewedBy: 'operator-1', evidenceHashes: [h('b')], fetchedPortalState: true, ...overrides };
}

test('reviewed venue evidence is real, reviewed and expiring rather than a zero-evidence label', () => {
  const blocked = buildReviewedVenueEvidence({ paperTask, venuePlan, observation: { fetchedPortalState: false }, now: new Date('2026-07-13T01:00:00Z') });
  assert.equal(blocked.status, 'reviewed_venue_evidence_blocked');
  assert.ok(blocked.blockers.includes('reviewed_venue_evidence_hashes_missing'));
  const trusted = trustedVenueFixture({ paperTask, venuePlan });
  const ready = buildReviewedVenueEvidence({ paperTask, venuePlan, observation: trusted.observation, sourceVerificationReceipt: trusted.sourceVerificationReceipt, now: new Date('2026-07-13T01:00:00Z') });
  assert.equal(ready.status, 'reviewed_venue_evidence_verified');
  assert.equal(ready.fetchedPortalState, true);
});

test('ambiguous executor outcome waits until due and then requires reviewed non-submission evidence', () => {
  const dispatch = { status: 'submission_dispatch_authorization_ready', paperId: paperTask.paperId, submissionDispatchAuthorizationHash: h('c'), responseDueAt: '2026-07-13T01:00:00.000Z' };
  const intake = { status: 'executor_response_intake_blocked', executorResponseIntakeHash: h('d'), blockers: ['executor_response_missing'] };
  const waiting = buildSubmissionRedriveDecision({ dispatchAuthorization: dispatch, responseIntake: intake, responseDueAt: dispatch.responseDueAt, now: new Date('2026-07-13T00:30:00Z') });
  assert.equal(waiting.decision, 'continue_waiting');
  assert.equal(buildSubmissionRedrivePlan({ dispatchAuthorization: dispatch, responseIntake: intake, redriveDecision: waiting }).status, 'submission_redrive_waiting');
  const due = buildSubmissionRedriveDecision({ dispatchAuthorization: dispatch, responseIntake: intake, responseDueAt: dispatch.responseDueAt, now: new Date('2026-07-13T01:30:00Z') });
  assert.equal(due.status, 'submission_redrive_decision_blocked');
  const trusted = trustedVenueFixture({ paperTask, venuePlan, observedState: 'not_submitted', purpose: 'ambiguous_redrive' });
  const negative = buildReviewedVenueEvidence({ paperTask, venuePlan, purpose: 'ambiguous_redrive', observation: trusted.observation, sourceVerificationReceipt: trusted.sourceVerificationReceipt, now: new Date('2026-07-13T01:00:00Z') });
  const approved = buildSubmissionRedriveDecision({ dispatchAuthorization: dispatch, responseIntake: intake, responseDueAt: dispatch.responseDueAt, now: new Date('2026-07-13T01:30:00Z'), reviewedVenueEvidence: negative });
  assert.equal(approved.status, 'submission_redrive_reauthorization_approved');
  assert.equal(buildSubmissionRedrivePlan({ dispatchAuthorization: dispatch, responseIntake: intake, redriveDecision: approved }).status, 'submission_redrive_reauthorization_required');
});

test('experiment promotion requires receipt-bound evidence and registered promotion rules cannot be weakened', () => {
  const trusted = trustedExperimentFixture({ profileId: 'fbsde_solver_residual_smoke' });
  const experiment = { ...trusted.artifact, acceptanceProfileId: 'fbsde_solver_residual_smoke' };
  const binding = buildExperimentEvidenceBinding({ experiment, workerReceipt: trusted.artifact.workerReceipt, resultArtifact: trusted.artifact.resultArtifact, reproducibilityReceipt: trusted.artifact.reproducibilityReceipt, receiptLedger: trusted.ledger, artifactVerifier: trusted.artifactVerifier, requiredOutputs: ['agent-compute-manifest.json', 'metrics.json', 'experiment-summary.md', 'experiment-reproducibility.json'] });
  assert.equal(binding.status, 'experiment_evidence_binding_verified');
  const changedSeed = buildExperimentEvidenceBinding({ experiment: { ...experiment, seed: 8 }, workerReceipt: trusted.artifact.workerReceipt, resultArtifact: trusted.artifact.resultArtifact, reproducibilityReceipt: trusted.artifact.reproducibilityReceipt, receiptLedger: trusted.ledger, artifactVerifier: trusted.artifactVerifier, requiredOutputs: ['agent-compute-manifest.json', 'metrics.json', 'experiment-summary.md', 'experiment-reproducibility.json'] });
  assert.equal(changedSeed.status, 'experiment_evidence_binding_blocked');
  assert.ok(changedSeed.blockers.includes('experiment_worker_seed_mismatch'));
  const weakenedIsolation = buildExperimentEvidenceBinding({ experiment: { ...experiment, networkPolicy: 'provider-scoped' }, workerReceipt: trusted.artifact.workerReceipt, resultArtifact: trusted.artifact.resultArtifact, reproducibilityReceipt: trusted.artifact.reproducibilityReceipt, receiptLedger: trusted.ledger, artifactVerifier: trusted.artifactVerifier, requiredOutputs: ['agent-compute-manifest.json', 'metrics.json', 'experiment-summary.md', 'experiment-reproducibility.json'] });
  assert.equal(weakenedIsolation.status, 'experiment_evidence_binding_blocked');
  assert.ok(weakenedIsolation.blockers.includes('experiment_network_isolation_required'));
  const wrongPathOutputs = trusted.artifact.resultArtifact.outputArtifacts.map((item, index) => index === 0 ? { ...item, artifactWriteReceipt: { ...item.artifactWriteReceipt, path: 'unrelated.json' } } : item);
  const wrongPath = buildExperimentEvidenceBinding({ experiment, workerReceipt: trusted.artifact.workerReceipt, resultArtifact: { ...trusted.artifact.resultArtifact, outputArtifacts: wrongPathOutputs }, reproducibilityReceipt: trusted.artifact.reproducibilityReceipt, receiptLedger: trusted.ledger, artifactVerifier: trusted.artifactVerifier, requiredOutputs: ['agent-compute-manifest.json', 'metrics.json', 'experiment-summary.md', 'experiment-reproducibility.json'] });
  assert.equal(wrongPath.status, 'experiment_evidence_binding_blocked');
  const contract = buildExperimentAcceptanceContract({ profileId: experiment.acceptanceProfileId, overrides: { allowedPromotionResultClasses: ['negative'], promotionAllowed: true } });
  assert.deepEqual(contract.allowedPromotionResultClasses, ['positive']);
  const report = evaluateExperimentAcceptance({ experiment: { ...experiment, evidenceBinding: binding, seed: 1, availableOutputs: contract.requiredOutputs, metrics: { local_execution: 1, source_mutation_performed: 0, external_action_performed: 0, terminal_residual_max: 0.01, pathwise_seed_reused: 1 }, resultClass: 'negative', promotionRequested: true }, contract });
  assert.equal(report.promotionEligible, false);
  assert.ok(report.blockers.includes('experiment_result_class_not_promotable:negative'));
});

test('selected submission executor identity is hash-bound and its response is cryptographically signed', () => {
  const capabilities = buildExecutorCapabilities({ executorId: 'executor-1', sandboxModes: ['external-workspace'], networkPolicy: 'provider-scoped', externalActions: true, workspaceIsolation: true, receiptKinds: ['signed-response'] });
  const descriptor = submissionExecutorDescriptor({ executorId: 'executor-1', provider: 'portal-x', accountId: 'account-1', workspaceRoot: '/external', externalWorkspace: true, capabilities: () => capabilities, dispatch() {} });
  const dispatch = { status: 'submission_dispatch_authorization_ready', submissionDispatchAuthorizationHash: h('7'), executorId: descriptor.executorId, executorDescriptorHash: descriptor.submissionExecutorDescriptorHash, executorCapabilitiesHash: descriptor.capabilitiesHash, provider: descriptor.provider, accountId: descriptor.accountId, attempt: 1 };
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const unsigned = { version: 1, kind: 'SignedExecutorResponse', responseId: 'response-1', outcome: 'failed', dispatchAuthorizationHash: dispatch.submissionDispatchAuthorizationHash, provider: dispatch.provider, accountId: dispatch.accountId, executorId: descriptor.executorId, executorDescriptorHash: descriptor.submissionExecutorDescriptorHash, capabilitiesHash: descriptor.capabilitiesHash, performedAt: '2026-07-13T00:00:00.000Z', attempt: 1 };
  const response = signAuthorityDocument(unsigned, { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), keyId: 'executor-key', role: 'submission_executor' });
  const trustStore = { version: 1, kind: 'AuthorityTrustStore', keys: [{ keyId: 'executor-key', subjectId: 'executor-1', algorithm: 'ed25519', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), roles: ['submission_executor'], status: 'active' }] };
  const verification = verifySignedExecutorResponse({ dispatchAuthorization: dispatch, response, trustStore });
  assert.equal(verification.status, 'executor_response_signature_verified');
  assert.equal(buildExecutorResponseIntake({ dispatchAuthorization: dispatch, response, responseVerificationReceipt: verification }).status, 'executor_response_accepted');
  assert.equal(buildExecutorResponseIntake({ dispatchAuthorization: dispatch, response: { ...response, executorId: 'other' }, responseVerificationReceipt: verification }).status, 'executor_response_intake_blocked');
});

test('submission metadata packet requires human confirmation and never treats worksheets as authorization', () => {
  const metadata = { title: 'A title', abstract: 'An abstract', authors: [{ name: 'A' }], track: 'main', anonymity: 'double_blind', keywords: ['control'], subjectAreas: ['theory'], conflicts: [], supplements: [], checklist: { ethics: true }, coverLetter: 'Please consider.' };
  const machine = buildReviewedSubmissionDecisionPacket({ paperTask, venuePlan, metadata, review: { reviewedBy: 'agent', reviewedAt: '2026-07-13T00:00:00Z', reviewActorType: 'machine', humanConfirmedFields: [] } });
  assert.equal(machine.status, 'reviewed_submission_decision_blocked');
  const human = buildReviewedSubmissionDecisionPacket({ paperTask, venuePlan, metadata, review: { reviewedBy: 'human-1', reviewedAt: '2026-07-13T00:00:00Z', reviewActorType: 'human', humanConfirmedFields: ['title', 'abstract', 'authors', 'track', 'anonymity', 'keywords', 'subjectAreas', 'conflicts', 'supplements', 'checklist', 'coverLetter'] } });
  assert.equal(human.status, 'reviewed_submission_decision_verified');
  assert.equal(human.localWorksheetGrantsAuthorization, false);
});

test('Coq and Isabelle are registry/certificate contracts, not support inferred from executable presence', () => {
  const trusted = trustedFormalFixture({});
  const registry = buildFormalVerifierRegistry({ adapterReceipts: [trusted.adapterReceipt], receiptLedger: trusted.ledger });
  assert.equal(registry.verifiers.find((item) => item.kind === 'coq').status, 'formal_verifier_registered');
  assert.equal(registry.verifiers.find((item) => item.kind === 'isabelle').status, 'formal_verifier_unavailable');
  const intake = buildGenericFormalCertificateIntake({ verifierKind: 'coq', verifierRegistry: registry, certificate: trusted.certificate, sourceRecords: trusted.sourceRecords, claimBindings: trusted.claimBindings, executionReceipt: trusted.executionReceipt, receiptLedger: trusted.ledger, artifactVerifier: trusted.artifactVerifier });
  assert.equal(intake.status, 'formal_certificate_intake_verified');
  const weakened = buildGenericFormalCertificateIntake({ verifierKind: 'coq', verifierRegistry: registry, certificate: trusted.certificate, sourceRecords: trusted.sourceRecords, claimBindings: trusted.claimBindings, executionReceipt: { ...trusted.executionReceipt, networkPolicy: 'provider-scoped' }, receiptLedger: trusted.ledger, artifactVerifier: trusted.artifactVerifier });
  assert.equal(weakened.status, 'formal_certificate_intake_blocked');
  assert.ok(weakened.blockers.includes('formal_execution_isolation_claim_invalid'));
  assert.equal(buildGenericFormalCertificateIntake({ verifierKind: 'isabelle', certificate: { kind: 'IsabelleFormalCertificate', certificateHash: h('e'), toolchainHash: h('f') }, sourceRecords: [{ path: 'fake.lean', hash: h('1') }], claimBindings: [], executionReceipt: null }).status, 'formal_certificate_intake_blocked');
});

test('compact boundary catalog rejects missing hashes and SQLite atomically consumes authorization and quarantines invalid input', (t) => {
  assert.equal(validateBoundaryRecord({ version: 1, kind: 'SubmissionExecutorDescriptor', executorId: 'x', provider: 'p', accountId: 'a', capabilitiesHash: 'bad' }).status, 'boundary_schema_blocked');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root });
  t.after(() => store.close());
  const clock = { now: () => new Date('2026-07-13T00:00:00Z'), nowIso: () => '2026-07-13T00:00:00.000Z' };
  const ledger = createSqliteReceiptLedger({ store, clock });
  const delivery = createSqliteSubmissionDeliveryStore({ store, receiptLedger: ledger, clock });
  const authorization = { status: 'submission_dispatch_authorization_ready', submissionDispatchAuthorizationHash: h('2'), paperId: paperTask.paperId, provider: 'portal-x', accountId: 'account-1', nonce: 'nonce-boundary-0001', attempt: 1, replayKey: h('3'), actionScopeKey: h('4'), dispatchCycleHash: h('5'), liveAuthorizationHash: h('6'), responseDueAt: '2026-07-13T01:00:00.000Z', providerCapabilityVerificationReceiptHash: h('7'), portalRoute: '/submit' };
  const message = delivery.enqueueAuthorized({ paperId: paperTask.paperId, dispatchAuthorization: authorization, payload: {} });
  assert.equal(message._releaseLock.message_id, message.message_id);
  assert.equal(store.query('SELECT count(*) AS count FROM submission_authorization_consumptions;').rows[0].count, 1);
  assert.throws(() => delivery.enqueueAuthorized({ paperId: paperTask.paperId, dispatchAuthorization: authorization, payload: {} }));
  assert.throws(() => delivery.recordResponse({ messageId: message.message_id, response: { password: 'must-not-be-stored' } }), /invalid executor response/);
  const quarantine = delivery.listQuarantine({ messageId: message.message_id });
  assert.equal(quarantine.length, 1);
  assert.equal(Object.hasOwn(quarantine[0], 'payload_json'), false);
  assert.match(quarantine[0].payload_hash, /^sha256:/);
});
