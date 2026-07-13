import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { verifyEvidenceArtifact } from '../../../paper-adapters/research-verify/evidence-verifier.mjs';
import { buildEvidenceIntake } from '../../../paper-domain/research/evidence-ingestor.mjs';
import { hashBytes } from '../../../workflow-kernel/record-hash.mjs';
import { temporaryDirectory } from './test-support.mjs';

test('research.evidence-ingestor verifies bytes and provenance before intake', async (t) => {
  const root = await temporaryDirectory(t);
  const target = path.join(root, 'evidence.json');
  const bytes = Buffer.from('{"ok":true}\n');
  await fsp.writeFile(target, bytes);
  const receipt = await verifyEvidenceArtifact({ sourceRoot: root, evidence: { id: 'e', path: 'evidence.json', hash: hashBytes(bytes), provenance: 'controlled_dataset' } });
  const intake = buildEvidenceIntake({ evidenceItems: [{ id: 'e', claimIds: ['c'], path: 'evidence.json', hash: receipt.verifiedHash, provenance: 'controlled_dataset', verificationStatus: receipt.status, verifiedHash: receipt.verifiedHash, provenanceReceiptHash: receipt.provenanceReceiptHash, createdAt: receipt.createdAt, verificationReceipt: receipt }] });
  assert.equal(intake.status, 'evidence_intake_ready');
  assert.equal((await verifyEvidenceArtifact({ sourceRoot: root, evidence: { id: 'e', path: '../escape', hash: 'sha256:x', provenance: 'x' } })).status, 'evidence_artifact_blocked');
  const outside = path.join(path.dirname(root), `outside-${path.basename(root)}.json`);
  await fsp.writeFile(outside, '{}');
  t.after(() => fsp.rm(outside, { force: true }));
  await fsp.symlink(outside, path.join(root, 'linked.json'));
  const linked = await verifyEvidenceArtifact({ sourceRoot: root, evidence: { id: 'linked', path: 'linked.json', provenance: 'x' } });
  assert.equal(linked.status, 'evidence_artifact_blocked');
  assert.ok(linked.blockers.includes('scoped_path_symlink_forbidden'));
});
