import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractLeanReadableProofAudits,
  leanReadableProofAuditSetHash,
} from '../../paper-adapters/research-verify/lean-readable-proof-audit.mjs';
import {
  independentlyVerifyFormalReadableProofWorkerResult,
} from '../../paper-adapters/research-verify/formal-readable-proof-verifier.mjs';
import {
  buildCampaignReleaseFormalReadableProofEvidence,
} from '../../paper-adapters/build-package/research-evidence-formal-readable-proof.mjs';
import {
  buildFormalReadableProofExplanationBundle,
  verifyFormalReadableProofExplanationBundle,
} from '../../paper-domain/research/formal-readable-proof-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const HASH = (character) => `sha256:${character.repeat(64)}`;

function fixture() {
  const theoremName = 'heptaReadableInduction';
  const claimBinding = {
    claimId: 'formal-claim:readable',
    theoremName,
    sourceFile: 'Main.lean',
    formalClaimContract: {
      dynamicFormalClaimAuthority: { leanTypeSource: '∀ n : Nat, 0 + n = n' },
    },
  };
  const declaration = {
    name: theoremName,
    typeHash: HASH('1'),
    normalizedType: '∀ n : Nat, 0 + n = n',
    sourceStatementHash: HASH('2'),
    buildVerified: true,
    axioms: [],
    axiomAuditPresent: true,
  };
  const projectFiles = [{ path: 'Main.lean', projectPath: 'Main.lean', hash: HASH('3') }];
  const stdout = [
    `HEPTA_READABLE_PROOF_BEGIN:${theoremName}`,
    `theorem ${theoremName} : ∀ n : Nat, 0 + n = n :=`,
    'fun n => Nat.rec rfl (fun n ih => congrArg Nat.succ ih) n',
    `HEPTA_READABLE_PROOF_END:${theoremName}`,
  ].join('\n');
  const audits = extractLeanReadableProofAudits({
    stdout,
    claimBindings: [claimBinding],
    declarations: [declaration],
    projectFiles,
    executionReceiptHash: HASH('4'),
  });
  const certificatePayload = {
    version: 1,
    kind: 'FormalCertificateBundle',
    status: 'formal_claim_verified',
    projectFiles,
    claimBindings: [claimBinding],
    claimBindingReport: { bindings: [{
      claimId: claimBinding.claimId,
      theoremName,
      declarationTypeHash: declaration.typeHash,
      sourceStatementHash: declaration.sourceStatementHash,
      axioms: [],
      valid: true,
    }] },
    executionReceiptHash: HASH('4'),
    leanReadableProofPrintAudits: audits,
    leanReadableProofPrintAuditSetHash: leanReadableProofAuditSetHash(audits),
    productionReadableProofReady: true,
  };
  const certificateBundle = {
    ...certificatePayload,
    certificateBundleHash: hashRecord('FormalCertificateBundle', certificatePayload),
  };
  const replayPayload = {
    version: 1,
    kind: 'FormalCertificateReplayReceipt',
    status: 'formal_claim_replay_verified',
    blockers: [],
    originalCertificateBundleHash: certificateBundle.certificateBundleHash,
    rerunCertificateBundleHash: HASH('5'),
    externalActionPerformed: false,
  };
  const replayReceipt = {
    ...replayPayload,
    formalCertificateReplayReceiptHash:
      hashRecord('FormalCertificateReplayReceipt', replayPayload),
  };
  return { certificateBundle, replayReceipt };
}

function rehashCertificate(certificateBundle) {
  const { certificateBundleHash: _claimedHash, ...payload } = certificateBundle;
  return { ...payload, certificateBundleHash: hashRecord('FormalCertificateBundle', payload) };
}

function replayFor(certificateBundle) {
  const payload = {
    version: 1,
    kind: 'FormalCertificateReplayReceipt',
    status: 'formal_claim_replay_verified',
    blockers: [],
    originalCertificateBundleHash: certificateBundle.certificateBundleHash,
    rerunCertificateBundleHash: HASH('5'),
    externalActionPerformed: false,
  };
  return { ...payload, formalCertificateReplayReceiptHash: hashRecord('FormalCertificateReplayReceipt', payload) };
}

test('kernel-bound readable proof builds a multi-node goal/declaration/closure DAG', () => {
  const { certificateBundle, replayReceipt } = fixture();
  const bundle = buildFormalReadableProofExplanationBundle({ certificateBundle, replayReceipt });
  assert.equal(bundle.status, 'formal_readable_proof_explanation_bundle_verified');
  assert.equal(verifyFormalReadableProofExplanationBundle(bundle, {
    certificateBundle, replayReceipt,
  }).valid, true);
  const explanation = bundle.explanations[0];
  assert.deepEqual(explanation.usedDeclarations,
    ['Nat', 'Nat.rec', 'Nat.succ', 'congrArg', 'rfl']);
  assert.deepEqual(new Set(explanation.nodes.map((item) => item.kind)), new Set([
    'formal_goal', 'proof_expression', 'declaration_reference', 'kernel_replay_closure',
  ]));
  assert.equal(explanation.naturalLanguageDerivationMachineProven, false);
  const workerResult = {
    ...certificateBundle,
    replayReceipt,
    formalCertificateReplayReceiptHash: replayReceipt.formalCertificateReplayReceiptHash,
    readableProofExplanationBundle: bundle,
    formalReadableProofExplanationBundleHash: bundle.formalReadableProofExplanationBundleHash,
    productionReadableProofExplanationReady: true,
  };
  assert.equal(independentlyVerifyFormalReadableProofWorkerResult(workerResult, {
    required: true,
  }).valid, true);
  const releaseEvidence = buildCampaignReleaseFormalReadableProofEvidence({
    campaignId: 'campaign-readable-proof',
    paperId: 'paper-readable-proof',
    researchReport: {
      researchReportHash: HASH('8'),
      nativeResearchWorkerExecution: {
        workerReceipts: [{ workerType: 'formal_verifier_lake', result: workerResult }],
      },
    },
  });
  assert.deepEqual(releaseEvidence.bundleHashes,
    [bundle.formalReadableProofExplanationBundleHash]);
  assert.equal(releaseEvidence.theoremCount, 1);
});

test('readable proof verification rejects DAG tamper and omission', () => {
  const { certificateBundle, replayReceipt } = fixture();
  const bundle = buildFormalReadableProofExplanationBundle({ certificateBundle, replayReceipt });
  const tampered = structuredClone(bundle);
  tampered.explanations[0].nodes.pop();
  assert.equal(verifyFormalReadableProofExplanationBundle(tampered).valid, false);

  const missing = structuredClone(certificateBundle);
  missing.leanReadableProofPrintAudits = [];
  missing.leanReadableProofPrintAuditSetHash = leanReadableProofAuditSetHash([]);
  missing.productionReadableProofReady = false;
  const rehashed = rehashCertificate(missing);
  const blocked = buildFormalReadableProofExplanationBundle({
    certificateBundle: rehashed,
    replayReceipt: replayFor(rehashed),
  });
  assert.equal(blocked.productionReadableProofReady, false);
  assert.ok(blocked.blockers.includes('formal_readable_proof_audit_coverage_invalid'));
});

test('readable proof verification rejects mismatched theorem and source identity', () => {
  const { certificateBundle } = fixture();
  const mismatched = structuredClone(certificateBundle);
  mismatched.claimBindings[0].theoremName = 'differentTheorem';
  mismatched.projectFiles[0].hash = HASH('9');
  const rehashed = rehashCertificate(mismatched);
  const blocked = buildFormalReadableProofExplanationBundle({
    certificateBundle: rehashed,
    replayReceipt: replayFor(rehashed),
  });
  assert.equal(blocked.productionReadableProofReady, false);
  assert.ok(blocked.blockers.some((item) => item.startsWith('formal_readable_proof_audit_invalid:')));
});
