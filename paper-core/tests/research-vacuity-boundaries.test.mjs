import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClaimRegistry } from '../../paper-domain/research/claim-registry.mjs';
import { buildEvidenceIntake } from '../../paper-domain/research/evidence-ingestor.mjs';
import { buildEvidenceQualityGate } from '../../paper-domain/research/evidence-quality-gate.mjs';
import { evaluateFormalClaimBindings } from '../../paper-domain/research/formal-claim-binding-policy.mjs';

test('empty claim and evidence graphs cannot become promotion-ready', () => {
  const paperTask = { paperId: 'paper' };
  const claimRegistry = buildClaimRegistry({ paperTask, claims: [] });
  const evidenceIntake = buildEvidenceIntake({ paperTask, evidenceItems: [] });
  const quality = buildEvidenceQualityGate({ paperTask, claimRegistry, evidenceIntake, nativeWorkerReceipts: [] });
  assert.equal(claimRegistry.status, 'claim_graph_blocked');
  assert.equal(evidenceIntake.status, 'evidence_intake_blocked');
  assert.equal(quality.status, 'evidence_quality_blocked');
  assert.equal(quality.version, 6);
  assert.equal(quality.evidenceIntakeRequired, false);
  assert.ok(quality.blockers.includes('claim_registry_empty'));
  assert.equal(quality.blockers.includes('evidence_intake_not_verified'), false);
});

test('a registered evidence-required claim cannot bypass a blocked evidence intake', () => {
  const paperTask = { paperId: 'paper' };
  const claimRegistry = buildClaimRegistry({ paperTask, claims: [{
    id: 'claim-evidence-required',
    text: 'This claim requires external evidence.',
    sourceLocator: 'main.tex#bytes=0-38',
    verificationPlan: { kind: 'evidence', requiresEvidence: true },
  }] });
  const evidenceIntake = buildEvidenceIntake({ paperTask, evidenceItems: [] });
  const quality = buildEvidenceQualityGate({ paperTask, claimRegistry, evidenceIntake, nativeWorkerReceipts: [] });
  assert.equal(claimRegistry.status, 'claim_graph_valid');
  assert.equal(evidenceIntake.status, 'evidence_intake_blocked');
  assert.equal(quality.evidenceIntakeRequired, true);
  assert.ok(quality.blockers.includes('evidence_intake_not_verified'));
  assert.ok(quality.blockers.includes('claim_evidence_coverage_missing:claim-evidence-required'));
});

test('worker-created claims and unbound formal declarations cannot self-certify', () => {
  const paperTask = { paperId: 'paper' };
  const claimRegistry = buildClaimRegistry({ paperTask, claims: [{
    id: 'worker-claim', text: 'worker output', sourceLocator: 'worker://claim',
    claimKind: 'worker_bound_claim', verificationPlan: { kind: 'formal' },
  }] });
  const evidenceIntake = { status: 'evidence_intake_ready', items: [{ claimIds: ['worker-claim'], hash: 'sha256:e', verifiedHash: 'sha256:e', verificationStatus: 'evidence_artifact_verified', provenanceReceiptHash: 'sha256:p', consumptionPolicy: { status: 'evidence_consumption_ready' } }] };
  const quality = buildEvidenceQualityGate({ paperTask, claimRegistry, evidenceIntake, nativeWorkerReceipts: [{ status: 'native_research_worker_receipt_verified', receiptHash: 'sha256:r', sourceSnapshotHash: 'sha256:s', claimIds: ['worker-claim'] }] });
  assert.ok(quality.blockers.includes('worker-claim:worker_synthesized_claim_forbidden'));
  const formal = evaluateFormalClaimBindings({
    claims: [{ claimId: 'c', theoremName: 't', expectedTypeHash: 'sha256:type' }],
    declarations: [{ name: 't', typeHash: 'sha256:type', buildVerified: true, axioms: [] }],
  });
  assert.equal(formal.status, 'formal_claim_binding_blocked');
  assert.ok(formal.blockers.includes('c:claim_source_statement_hash_missing'));
  assert.ok(formal.blockers.includes('c:claim_proof_obligations_missing'));
});
