import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEvidenceQualityGate } from '../../../paper-domain/research/evidence-quality-gate.mjs';

test('research.evidence-quality-gate consumes verified artifacts and hash-bound worker receipts', () => {
  const ready = buildEvidenceQualityGate({ paperTask: { paperId: 'p' }, claimRegistry: { status: 'claim_graph_valid', claims: [{ claimId: 'c', text: 'claim', sourceLocator: 'main.tex#c', verificationPlan: { kind: 'artifact' } }] }, evidenceIntake: { status: 'evidence_intake_ready', items: [{ claimIds: ['c'], hash: 'h', verifiedHash: 'h', verificationStatus: 'evidence_artifact_verified', provenanceReceiptHash: 'p', consumptionPolicy: { status: 'evidence_consumption_ready' } }] }, nativeWorkerReceipts: [{ status: 'native_research_worker_receipt_verified', receiptHash: 'r', sourceSnapshotHash: 's', claimIds: ['c'] }] });
  assert.equal(ready.status, 'evidence_quality_ready');
  const artifactWithoutWorker = buildEvidenceQualityGate({ paperTask: { paperId: 'p' }, claimRegistry: { status: 'claim_graph_valid', claims: [{ claimId: 'artifact', text: 'artifact claim', sourceLocator: 'main.tex#artifact', verificationPlan: { kind: 'artifact' } }] }, evidenceIntake: { status: 'evidence_intake_ready', items: [{ claimIds: ['artifact'], hash: 'h', verifiedHash: 'h', verificationStatus: 'evidence_artifact_verified', provenanceReceiptHash: 'p', consumptionPolicy: { status: 'evidence_consumption_ready' } }] }, nativeWorkerReceipts: [] });
  assert.equal(artifactWithoutWorker.status, 'evidence_quality_ready');
  const formalWithoutWorker = buildEvidenceQualityGate({ paperTask: { paperId: 'p' }, claimRegistry: { status: 'claim_graph_valid', claims: [{ claimId: 'formal', text: 'formal claim', sourceLocator: 'main.tex#formal', proofObligations: ['o'], verificationPlan: { kind: 'formal' } }] }, evidenceIntake: { status: 'evidence_intake_ready', items: [{ claimIds: ['formal'], hash: 'h', verifiedHash: 'h', verificationStatus: 'evidence_artifact_verified', provenanceReceiptHash: 'p', consumptionPolicy: { status: 'evidence_consumption_ready' } }] }, nativeWorkerReceipts: [] });
  assert.equal(formalWithoutWorker.status, 'evidence_quality_blocked');
  assert.equal(buildEvidenceQualityGate({ claimRegistry: { status: 'claim_graph_valid', claims: [{ claimId: 'c' }] }, evidenceIntake: { status: 'evidence_intake_ready', items: [] } }).status, 'evidence_quality_blocked');
});
