import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEvidenceQualityGate } from '../../../paper-domain/research/evidence-quality-gate.mjs';

test('research.evidence-quality-gate consumes verified artifacts and hash-bound worker receipts', () => {
  const ready = buildEvidenceQualityGate({ paperTask: { paperId: 'p' }, claimRegistry: { status: 'claim_graph_valid', claims: [{ claimId: 'c' }] }, evidenceIntake: { status: 'evidence_intake_ready', items: [{ claimIds: ['c'], hash: 'h', verifiedHash: 'h', verificationStatus: 'evidence_artifact_verified', provenanceReceiptHash: 'p' }] }, nativeWorkerReceipts: [{ status: 'native_research_worker_receipt_verified', receiptHash: 'r', sourceSnapshotHash: 's', claimIds: ['c'] }] });
  assert.equal(ready.status, 'evidence_quality_ready');
  assert.equal(buildEvidenceQualityGate({ claimRegistry: { status: 'claim_graph_valid', claims: [{ claimId: 'c' }] }, evidenceIntake: { status: 'evidence_intake_ready', items: [] } }).status, 'evidence_quality_blocked');
});
