import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePaperQualityPolicy, PAPER_QUALITY_PROFILES } from '../../paper-domain/quality/paper-quality-policy.mjs';
import { buildPaperQualityEvidence } from '../../paper-domain/quality/manuscript-promotion-gate.mjs';

test('paper quality policy uses an explicit profile and hash-bound verified evidence', () => {
  const evidence = PAPER_QUALITY_PROFILES.theorem_or_proof.map((requirementId) => ({ requirementId, kind: requirementId, verified: true, hash: `sha256:${requirementId}` }));
  const passed = evaluatePaperQualityPolicy({ paperId: 'paper', profile: 'theorem_or_proof', evidence, shadow: false });
  assert.equal(passed.status, 'paper_quality_policy_passed');
  const blocked = evaluatePaperQualityPolicy({ paperId: 'paper', profile: 'external_data_or_human_subjects', evidence: [], shadow: true });
  assert.equal(blocked.status, 'paper_quality_policy_shadow_blocked');
  assert.ok(blocked.blockers.some((item) => item.includes('ethics_review')));
  assert.ok(evaluatePaperQualityPolicy({ paperId: 'paper', profile: 'title-guessed-profile' }).blockers.includes('paper_quality_profile_missing_or_invalid'));
});

test('survey quality consumes typed novelty evidence and theorem prose does not imply Lean', () => {
  const evidence = buildPaperQualityEvidence({
    paperTask: { paperId: 'paper' },
    theoremReadiness: { applicable: true, passed: true, theoremManuscriptReadinessPolicyHash: 'sha256:proof', manuscriptQualitySurfaces: { limitationsPresent: true } },
    researchReport: {
      capabilities: {
        claimRegistry: { status: 'claim_graph_valid', claimRegistryHash: 'sha256:claims' },
        evidenceIntake: { evidenceIntakeHash: 'sha256:intake', items: [{ provenance: 'novelty_scope_review', provenanceReceiptHash: 'sha256:novelty', consumptionPolicy: { status: 'evidence_consumption_ready' } }] },
      },
      academicEvidenceAttestation: { sourceSnapshot: { verified: true }, academicEvidenceAttestationVerificationHash: 'sha256:source' },
      nativeResearchWorkerExecution: { workerReceipts: [] },
    },
  });
  assert.equal(evaluatePaperQualityPolicy({ paperId: 'paper', profile: 'survey_or_position', evidence, shadow: false }).status, 'paper_quality_policy_passed');
  assert.equal(evaluatePaperQualityPolicy({ paperId: 'paper', profile: 'theorem_or_proof', evidence, shadow: false }).status, 'paper_quality_policy_passed');
  assert.ok(evaluatePaperQualityPolicy({ paperId: 'paper', profile: 'formal_theorem_or_proof', evidence, shadow: false }).blockers.includes('paper_quality_evidence_missing_or_invalid:formal_claim_binding'));
});
