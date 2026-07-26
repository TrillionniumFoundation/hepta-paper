import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runResearchVerifyAdapter } from '../../paper-adapters/research-verify/index.mjs';
import { readResearchEvidenceSources } from '../../paper-adapters/research-verify/research-evidence-reader.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';

function temporaryRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('research evidence IO reader preserves structured extraction golden', async (t) => {
  const root = temporaryRoot(t, 'hepta-research-reader-');
  const sourceRoot = path.join(root, 'paper');
  const logRoot = path.join(root, 'logs', 'paperctl', 'paper');
  const empiricalRoot = path.join(root, 'runtime', 'empirical-analysis', 'paper');
  await fsp.mkdir(sourceRoot, { recursive: true });
  const payload = {
    claims: [{ id: 'claim:alpha', text: 'Alpha', verification_plan: { kind: 'manual' } }],
    proof_obligations: [{ id: 'proof:alpha', text: 'Prove alpha' }],
    evidence: [{ id: 'evidence:alpha', path: 'paper/claim-evidence-result.json', claim_ids: ['claim:alpha'] }],
    reproducibility: [{ id: 'repro:alpha', text: 'seed:7' }],
    experiments: [{ id: 'experiment:alpha' }],
  };
  await fsp.writeFile(path.join(sourceRoot, 'claim-evidence-result.json'), `${JSON.stringify(payload)}\n`);

  const evidence = await readResearchEvidenceSources({ root, sourceRoot, logRoot, empiricalRoot });
  assert.deepEqual({
    sourceCount: evidence.sourceEvidence.length,
    logCount: evidence.logEvidence.length,
    empiricalCount: evidence.empiricalEvidence.length,
    proposalSeedCount: evidence.proposalSeedEvidence.length,
    claims: evidence.structured.claims.map(({ id, text, status, kind, sourceLocator }) => ({ id, text, status, kind, sourceLocator })),
    obligations: evidence.structured.obligations.map(({ id, text, status, kind, sourceLocator }) => ({ id, text, status, kind, sourceLocator })),
    evidenceItems: evidence.structured.evidenceItems.map(({ id, text, status, kind, claimIds, sourceLocator }) => ({ id, text, status, kind, claimIds, sourceLocator })),
    reproducibilityItems: evidence.structured.reproducibilityItems.map(({ id, text, status, kind, sourceLocator }) => ({ id, text, status, kind, sourceLocator })),
    experiments: evidence.structured.experiments,
  }, {
    sourceCount: 1,
    logCount: 0,
    empiricalCount: 0,
    proposalSeedCount: 0,
    claims: [{ id: 'claim:alpha', text: 'Alpha', status: 'observed', kind: 'claim', sourceLocator: 'paper/claim-evidence-result.json' }],
    obligations: [{ id: 'proof:alpha', text: 'Prove alpha', status: 'observed', kind: 'proof_obligation', sourceLocator: 'paper/claim-evidence-result.json' }],
    evidenceItems: [
      { id: 'evidence:1', text: 'evidence evidence: paper/claim-evidence-result.json', status: 'observed', kind: 'evidence', claimIds: undefined, sourceLocator: 'paper/claim-evidence-result.json' },
      { id: 'evidence:alpha', text: 'paper/claim-evidence-result.json', status: 'observed', kind: 'evidence', claimIds: ['claim:alpha'], sourceLocator: 'paper/claim-evidence-result.json' },
    ],
    reproducibilityItems: [
      { id: 'reproducibility:1', text: 'reproducibility evidence: paper/claim-evidence-result.json', status: 'observed', kind: 'reproducibility', sourceLocator: 'paper/claim-evidence-result.json' },
      { id: 'repro:alpha', text: 'seed:7', status: 'observed', kind: 'reproducibility', sourceLocator: 'paper/claim-evidence-result.json' },
    ],
    experiments: [{ id: 'experiment:alpha', experimentId: 'experiment:alpha', resultPath: 'paper/claim-evidence-result.json', resultHash: evidence.sourceEvidence[0].hash }],
  });
});

test('research orchestrator empty-input report matches the compatibility golden', async (t) => {
  const root = temporaryRoot(t, 'hepta-research-orchestrator-');
  const report = await runResearchVerifyAdapter({
    root,
    row: {
      task: {
        paperId: 'paper',
        taskKey: 'paper:task',
        title: 'Paper',
        paperType: 'systems',
        sourceWorkspace: 'missing',
        mainTex: 'missing/main.tex',
        registry: {},
      },
      state: { evidenceRefs: [] },
    },
    runtimeRoot: path.join(root, 'runtime'),
    now: new Date('2025-01-02T03:04:05.000Z'),
  });
  const { researchReportHash, ...reportPayload } = report;
  assert.equal(
    researchReportHash,
    hashPaperRecord('PaperResearchVerifyReport', reportPayload),
  );
  assert.deepEqual({
    version: report.version,
    kind: report.kind,
    status: report.status,
    academicEvidenceStatus: report.academicEvidenceStatus,
    academicEvidenceEligible: report.academicEvidenceEligible,
    counts: {
      source: report.sourceEvidenceCount,
      log: report.logEvidenceCount,
      empirical: report.empiricalEvidenceCount,
      claims: report.claimCount,
      proofs: report.proofObligationCount,
      evidence: report.evidenceItemCount,
      reproducibility: report.reproducibilityItemCount,
      nativePlanned: report.nativeResearchWorkerCount,
      nativeExecuted: report.executedResearchWorkerCount,
    },
    capabilityStatuses: {
      claimRegistry: report.capabilities.claimRegistry.status,
      evidenceIntake: report.capabilities.evidenceIntake.status,
      evidenceQualityGate: report.capabilities.evidenceQualityGate.status,
      evidenceIntakeRequired: report.capabilities.evidenceQualityGate.evidenceIntakeRequired,
      experimentRegistry: report.capabilities.experimentRegistry.status,
      researchGapPlanBinding: report.capabilities.researchGapPlanBinding,
    },
    promotionEligibility: report.promotionEligibility,
    blockers: report.blockers,
    warnings: report.warnings,
    sourceRoots: report.sourceRoots,
    safety: report.safety,
    typedVerifyReceiptHash: report.typedContracts.verifyReceipt.researchVerifyReceiptHash,
  }, {
    version: 1,
    kind: 'PaperResearchVerifyReport',
    status: 'manual_review_needed',
    academicEvidenceStatus: 'academic_evidence_attestation_missing',
    academicEvidenceEligible: false,
    counts: { source: 0, log: 0, empirical: 0, claims: 0, proofs: 0, evidence: 0, reproducibility: 0, nativePlanned: 0, nativeExecuted: 0 },
    capabilityStatuses: {
      claimRegistry: 'claim_graph_blocked',
      evidenceIntake: 'evidence_intake_blocked',
      evidenceQualityGate: 'evidence_quality_blocked',
      evidenceIntakeRequired: false,
      experimentRegistry: 'experiment_registry_ready',
      researchGapPlanBinding: null,
    },
    promotionEligibility: {
      status: 'research_promotion_blocked',
      blockers: [
        'evidence_quality_gate_not_ready',
        'evidence_quality:claim_graph_not_valid',
        'evidence_quality:claim_registry_not_valid',
        'evidence_quality:claim_registry_empty',
      ],
    },
    blockers: [],
    warnings: [
      'claim_evidence_not_found',
      'claim_scope_requires_manual_extraction',
      'proof_obligations_require_manual_review',
      'evidence_matrix_empty',
      'reproducibility_contract_requires_manual_review',
    ],
    sourceRoots: { sourceWorkspace: 'missing', paperctlLog: 'logs/paperctl/paper', empiricalAnalysis: 'runtime/empirical-analysis/paper' },
    safety: {
      readsOnly: true,
      writesRuntimeOnly: false,
      sourceMutation: false,
      subprocessExecution: false,
      trustedFormalExecutionAuthorized: false,
      trustedFormalPersistentFenceUsed: false,
      externalActionPerformed: false,
      legacyWorkerCatalogScanned: false,
    },
    typedVerifyReceiptHash: 'sha256:2c79d92a03356febf6ea013b6d193712383eed91cff32dcaba1a97145a56746c',
  });
});
