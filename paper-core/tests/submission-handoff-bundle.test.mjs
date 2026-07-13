import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFilesystemArtifactRepository } from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { exportSubmissionHandoffBundle } from '../../paper-adapters/submission/handoff-bundle-exporter.mjs';

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

test('submission handoff exporter creates a portable hash-bound artifact bundle', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hepta-handoff-bundle-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  const bundleRoot = path.join(root, 'bundle');
  await fsp.mkdir(sourceRoot);
  const content = Buffer.from('%PDF-fixture\n');
  await fsp.writeFile(path.join(sourceRoot, 'paper.pdf'), content);
  const repository = createFilesystemArtifactRepository({
    scopeRoot: root,
    receiptLedger: { record: () => ({ receiptId: 'ledger-receipt' }) },
    clock: { nowIso: () => '2026-07-13T00:00:00.000Z' },
  });
  const packageVerificationReceipt = { status: 'package_verification_passed', verifiedArtifactPackageHash: 'sha256:candidate', packageVerificationReceiptHash: 'sha256:verification' };
  const artifactPackage = {
    submitReady: true,
    artifactPackageHash: 'sha256:package',
    candidateArtifactPackageHash: 'sha256:candidate',
    packageVerificationReceiptHash: packageVerificationReceipt.packageVerificationReceiptHash,
    artifacts: [{ id: 'pdf', role: 'manuscript', path: 'paper.pdf', hash: sha256(content) }],
  };
  const manifest = { status: 'ready_for_adapter', paperId: 'paper', taskKey: 'paper:paper', manifestHash: 'sha256:manifest', payload: { artifactPackageHash: artifactPackage.artifactPackageHash } };
  const handoff = { status: 'dry_run_ready', envelopeHash: 'sha256:handoff', manifestHash: manifest.manifestHash };
  const replayGuard = { status: 'dry_run_replay_allowed', submissionReplayGuardHash: 'sha256:replay', manifestHash: manifest.manifestHash };
  const reviewedSubmitPreflightPacket = { status: 'reviewed_submit_preflight_ready_for_external_executor', reviewedSubmitPreflightPacketHash: 'sha256:preflight', outboxHash: 'sha256:outbox' };
  const dispatchAuthorization = { status: 'submission_dispatch_authorization_ready', submissionDispatchAuthorizationHash: 'sha256:dispatch', artifactPackageHash: artifactPackage.artifactPackageHash, preflightHash: reviewedSubmitPreflightPacket.reviewedSubmitPreflightPacketHash, outboxHash: reviewedSubmitPreflightPacket.outboxHash, provider: 'provider', accountId: 'account', nonce: 'nonce' };
  const submissionDecisionPacket = { status: 'reviewed_submission_decision_verified', reviewedSubmissionDecisionPacketHash: 'sha256:decision', metadata: { title: 'Fixture' } };
  dispatchAuthorization.reviewedSubmissionDecisionPacketHash = submissionDecisionPacket.reviewedSubmissionDecisionPacketHash;
  const receipt = await exportSubmissionHandoffBundle({ artifactRepository: repository, bundleRoot, artifactPackage, packageVerificationReceipt, manifest, handoff, replayGuard, reviewedSubmitPreflightPacket, dispatchAuthorization, submissionDecisionPacket, artifactBaseRoot: sourceRoot });
  assert.equal(receipt.status, 'submission_handoff_bundle_exported');
  assert.equal(receipt.artifactCount, 1);
  assert.deepEqual(await fsp.readFile(path.join(bundleRoot, 'artifacts', '001-paper.pdf')), content);
  const bundleManifest = JSON.parse(await fsp.readFile(path.join(bundleRoot, 'SUBMISSION_HANDOFF_MANIFEST.json'), 'utf8'));
  assert.equal(bundleManifest.dispatchAuthorizationHash, dispatchAuthorization.submissionDispatchAuthorizationHash);
  assert.equal(bundleManifest.artifacts[0].hash, sha256(content));

  const blocked = await exportSubmissionHandoffBundle({ artifactRepository: repository, bundleRoot: path.join(root, 'blocked'), artifactPackage: { ...artifactPackage, artifacts: [{ ...artifactPackage.artifacts[0], hash: 'sha256:wrong' }] }, packageVerificationReceipt, manifest, handoff, replayGuard, reviewedSubmitPreflightPacket, dispatchAuthorization, submissionDecisionPacket, artifactBaseRoot: sourceRoot });
  assert.equal(blocked.status, 'submission_handoff_bundle_blocked');
  assert.ok(blocked.blockers.includes('handoff_artifact_hash_mismatch:paper.pdf'));
  assert.equal(fs.existsSync(path.join(root, 'blocked')), false);
});
