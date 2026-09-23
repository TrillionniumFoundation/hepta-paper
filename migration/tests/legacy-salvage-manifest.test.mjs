import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('legacy salvage manifest covers source and adversarial tests without runtime authority', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'migration', 'legacy-salvage-manifest.v1.json'), 'utf8'));
  const payload = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'manifestHash'));
  const hash = `sha256:${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
  assert.equal(manifest.manifestHash, hash);
  assert.equal(manifest.runtimeDependencyAllowed, false);
  assert.equal(manifest.summary.pythonModuleCount, 452);
  assert.equal(manifest.summary.pythonTestCount, 464);
  assert.deepEqual(manifest.summary.excludedBuildTrees, ['rust/paperctl-rs/target']);
  assert.equal(manifest.files.some((item) => item.path.startsWith('rust/paperctl-rs/target/')), false);
  assert.equal(new Set(manifest.files.map((item) => item.path)).size, manifest.files.length);
  const allowed = new Set(['verified_behavioral_replacement', 'partial_semantic_replacement', 'capability_mapped_semantics_open', 'fixture_only', 'archive_only', 'retired']);
  assert.equal(manifest.files.every((item) => allowed.has(item.disposition) && /^sha256:[a-f0-9]{64}$/.test(item.sourceHash) && !path.isAbsolute(item.path)), true);
  const consumption = manifest.files.find((item) => item.path === 'paperctl_modules/llm_consumption.py');
  assert.equal(consumption.disposition, 'verified_behavioral_replacement');
  assert.ok(consumption.targets.some((target) => target.path === 'paper-adapters/referee-revise/decision-routing.mjs' && /^sha256:/.test(target.hash)));
  for (const legacyPath of [
    'paperctl_modules/paper_production_operator_drop_intake_preflight.py',
    'paperctl_modules/paper_production_referee_repair_typed_evidence_contract_matrix.py',
    'paperctl_modules/research_compute_claim_quality_gate.py',
    'paperctl_modules/research_compute_evidence_ingestor.py',
    'paperctl_modules/research_compute_experiment_registry.py',
    'paperctl_modules/research_compute_formal_verifier_adapter.py',
    'paperctl_modules/research_compute_formal_verifier_certificate_intake.py',
  ]) {
    const replacement = manifest.files.find((item) => item.path === legacyPath);
    assert.equal(replacement.disposition, 'verified_behavioral_replacement', legacyPath);
    assert.ok(replacement.evidence.length > 0, legacyPath);
  }
  assert.equal(manifest.files.filter((item) => ['verified_behavioral_replacement', 'capability_mapped_semantics_open'].includes(item.disposition)).every((item) => item.targets.length && item.targets.every((target) => /^sha256:[a-f0-9]{64}$/.test(target.hash))), true);
  for (const legacyPath of [
    'paperctl_modules/paper_production_submission_lifecycle.py',
    'paperctl_modules/external_submission_handoff_bundle.py',
    'paperctl_modules/paper_production_runner_execution_contract_matrix.py',
    'paperctl_modules/paper_production_reviewed_target_evidence_autofill.py',
    'paperctl_modules/paper_production_submission_decision_template.py',
    'paperctl_modules/paper_production_submission_evidence_intake_quarantine_workflow_matrix.py',
    'paperctl_modules/report_schema.py',
    'paperctl_modules/paper_production_executor_dispatch_cycle_audit.py',
    'paperctl_modules/paper_production_submission_evidence_real_intake_acceptance_gate.py',
  ]) {
    const partial = manifest.files.find((item) => item.path === legacyPath);
    assert.equal(partial.disposition, 'partial_semantic_replacement', legacyPath);
    assert.ok(partial.targets.length > 0 && partial.targets.every((target) => /^sha256:[a-f0-9]{64}$/.test(target.hash)), legacyPath);
    assert.ok(partial.evidence.length > 0 && partial.evidence.every((evidence) => /^sha256:[a-f0-9]{64}$/.test(evidence.hash)), legacyPath);
    assert.equal(partial.replacementVerification, null, legacyPath);
  }
  assert.equal(manifest.files.filter((item) => item.disposition === 'verified_behavioral_replacement').every((item) => (
    item.evidence.length > 0
    && item.evidence.every((evidence) => /^sha256:[a-f0-9]{64}$/.test(evidence.hash))
    && item.replacementVerification?.status === 'salvage_replacement_verification_bound'
    && /^sha256:[a-f0-9]{64}$/.test(item.replacementVerification?.verificationReceiptHash || '')
  )), true);
  assert.equal(manifest.files.filter((item) => item.path.startsWith('tests/')).every((item) => item.disposition === 'fixture_only'), true);
});
