import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  buildResearchCapabilityMatrix,
  RESEARCH_CAPABILITY_EVIDENCE_LEVELS,
} from '../../paper-application/automation/research-capability-matrix.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

test('capability matrix distinguishes implementation, qualification, and production readiness', () => {
  const matrix = buildResearchCapabilityMatrix({
    runtimeReady: true,
    academicEmpiricalReady: true,
    genericDomainCapabilityReady: false,
    genericResearchReady: false,
    productionReady: false,
    dynamicFormalProjectClosureReady: false,
    dynamicFormalProjectClosure: { blockers: ['dynamic_formal_project_closure_hash_required'] },
    genericDomainCapabilityBlockers: [
      'autonomous_research_formal_domain_coverage_receipt_required',
      'autonomous_research_experiment_ir_execution_authority_receipt_required',
    ],
    runtimes: {
      python: { usable: true },
      r: { usable: true },
      julia: { usable: false },
      lean: { usable: true },
      latex: { usable: true },
    },
    autonomousSubmissionHandoffReady: true,
    autonomousSubmissionDispatcherReady: false,
    autonomousSubmissionDispatcherReadiness: {
      blockers: ['autonomous_submission_dispatcher_portal_binding_not_ready'],
    },
    fullResearchQualificationReady: false,
    fullResearchQualificationBlockers: ['golden_micro_campaign_qualification_receipt_missing'],
    fullAutomaticResearchWritingReady: false,
  });
  assert.equal(matrix.universalResearchClaimed, false);
  assert.equal(matrix.fullyAutonomousProductionReady, false);
  assert.equal(matrix.status, 'research_capabilities_bounded_or_blocked');
  assert.equal(
    matrix.capabilityEntriesStatus,
    'research_capability_entries_bounded_or_blocked',
  );
  assert.equal(matrix.version, 2);
  assert.deepEqual(
    matrix.evidenceLevelDefinitions.map((entry) => entry.id),
    ['contract_fixture', 'real_runtime_fixture', 'live_model', 'external_trust'],
  );
  assert.equal(matrix.capabilities.length, 8);
  const formal = matrix.capabilities.find((entry) => entry.id === 'formal-proof-search');
  assert.equal(formal.implemented, true);
  assert.equal(formal.qualified, false);
  assert.equal(formal.productionReady, false);
  assert.equal(formal.strongestEvidenceLevel, 'contract_fixture');
  assert.deepEqual(formal.scope.strategies, [
    'direct_elaboration',
    'mathlib_retrieval',
    'bounded_refutation_or_synthesis',
  ]);
  assert.deepEqual(formal.scope.backends.map((entry) => [
    entry.backend,
    entry.availability,
  ]), [
    ['lean', 'active'],
    ['coq', 'unavailable'],
    ['isabelle', 'unavailable'],
  ]);
  assert.ok(formal.scope.strategyCapabilities
    .find((entry) => entry.strategy === 'bounded_refutation_or_synthesis')
    .capabilities.includes('counterexample_guided_repair'));
  const empirical = matrix.capabilities.find((entry) => entry.id === 'empirical-code-execution');
  assert.equal(empirical.scope.benchmarkFamilies.length, 5);
  assert.deepEqual(empirical.scope.runtimeLanguages, ['python', 'r']);
  assert.equal(empirical.strongestEvidenceLevel, 'real_runtime_fixture');
  const handoff = matrix.capabilities.find((entry) => entry.id === 'local-submission-handoff');
  const draft = matrix.capabilities.find((entry) => entry.id === 'submission-provider-draft');
  const submission = matrix.capabilities.find((entry) => entry.id === 'live-submission-commit');
  assert.equal(handoff.scope.localHandoffReady, true);
  assert.equal(handoff.qualified, true);
  assert.equal(handoff.productionReady, true);
  assert.equal(handoff.strongestEvidenceLevel, 'real_runtime_fixture');
  assert.equal(draft.qualified, false);
  assert.equal(submission.scope.humanReviewedSingleUseAuthorizationRequired, true);
  assert.equal(submission.qualified, false);
  assert.equal(submission.productionReady, false);
  const { researchCapabilityMatrixHash, ...payload } = matrix;
  assert.equal(researchCapabilityMatrixHash, hashRecord('ResearchCapabilityMatrix', payload));
});

test('capability evidence levels never infer live-model evidence from runtime fixtures', () => {
  const fixtureOnly = buildResearchCapabilityMatrix({
    academicEmpiricalReady: true,
  });
  const empirical = fixtureOnly.capabilities.find(
    (entry) => entry.id === 'empirical-code-execution',
  );
  assert.equal(empirical.strongestEvidenceLevel, 'real_runtime_fixture');

  const live = buildResearchCapabilityMatrix({
    academicEmpiricalReady: true,
    liveModelEvidenceCapabilityIds: ['empirical-code-execution'],
  });
  assert.equal(
    live.capabilities.find((entry) => entry.id === 'empirical-code-execution')
      .strongestEvidenceLevel,
    'live_model',
  );
  assert.throws(
    () => buildResearchCapabilityMatrix({
      explicitCapabilityEvidenceLevels: {
        'formal-proof-search': 'production-by-name-only',
      },
    }),
    /research_capability_evidence_level_invalid/,
  );
  assert.throws(
    () => buildResearchCapabilityMatrix({
      explicitCapabilityEvidenceLevels: {
        'formal-proof-search': 'external_trust',
      },
    }),
    /research_capability_evidence_level_exceeds_readiness/,
  );
  assert.equal(RESEARCH_CAPABILITY_EVIDENCE_LEVELS.at(-1).productionAuthority, true);
});

test('capability matrix cannot infer universal readiness from runtime availability', () => {
  const matrix = buildResearchCapabilityMatrix({
    academicEmpiricalReady: true,
    dynamicFormalProjectClosureReady: true,
    genericDomainCapabilityReady: true,
    genericResearchReady: true,
    productionReady: true,
    fullyAutonomousResearchSystemReady: true,
    fullResearchQualificationReady: true,
    fullAutomaticResearchWritingReady: true,
    autonomousSubmissionHandoffReady: true,
    autonomousSubmissionDispatcherReady: true,
    autonomousSubmissionDispatcherReadiness: { blockers: [] },
    runtimes: { python: { usable: true }, lean: { usable: true } },
  });
  assert.equal(matrix.fullyAutonomousProductionReady, true);
  assert.equal(matrix.status, 'research_capabilities_production_ready');
  assert.equal(
    matrix.capabilityEntriesStatus,
    'research_capability_entries_production_ready',
  );
  assert.equal(matrix.universalResearchClaimed, false);
  assert.ok(matrix.capabilities.every((entry) => entry.productionReady));
});

test('capability matrix rejects a split-brain autonomous readiness projection', () => {
  const matrix = buildResearchCapabilityMatrix({
    academicEmpiricalReady: true,
    dynamicFormalProjectClosureReady: true,
    genericDomainCapabilityReady: true,
    genericResearchReady: true,
    productionReady: true,
    fullyAutonomousResearchSystemReady: false,
    fullResearchQualificationReady: true,
    fullAutomaticResearchWritingReady: true,
    autonomousSubmissionHandoffReady: true,
    autonomousSubmissionDispatcherReady: true,
    autonomousSubmissionDispatcherReadiness: { blockers: [] },
    empiricalLanguagesReady: ['python', 'r'],
  });
  assert.ok(matrix.capabilities.every((entry) => entry.productionReady));
  assert.equal(matrix.fullyAutonomousProductionReady, false);
  assert.equal(matrix.status, 'research_capabilities_bounded_or_blocked');
  assert.equal(
    matrix.capabilityEntriesStatus,
    'research_capability_entries_production_ready',
  );
});

test('capability matrix rejects a split-brain production readiness projection', () => {
  const matrix = buildResearchCapabilityMatrix({
    academicEmpiricalReady: true,
    dynamicFormalProjectClosureReady: true,
    genericDomainCapabilityReady: true,
    genericResearchReady: true,
    productionReady: false,
    fullyAutonomousResearchSystemReady: true,
    fullResearchQualificationReady: true,
    fullAutomaticResearchWritingReady: true,
    autonomousSubmissionHandoffReady: true,
    autonomousSubmissionDispatcherReady: true,
    autonomousSubmissionDispatcherReadiness: { blockers: [] },
    empiricalLanguagesReady: ['python', 'r'],
  });
  assert.ok(matrix.capabilities.every((entry) => entry.productionReady));
  assert.equal(matrix.fullyAutonomousProductionReady, false);
  assert.equal(matrix.status, 'research_capabilities_bounded_or_blocked');
  assert.equal(
    matrix.capabilityEntriesStatus,
    'research_capability_entries_production_ready',
  );
});

test('capability matrix reports canonical container-backed empirical languages', () => {
  const matrix = buildResearchCapabilityMatrix({
    academicEmpiricalReady: true,
    empiricalLanguagesReady: ['python', 'r', 'r', 'unsupported-language'],
    runtimes: {
      python: { usable: true },
      r: { usable: false },
      images: {
        r: { usable: true },
      },
    },
  });
  const empirical = matrix.capabilities.find(
    (entry) => entry.id === 'empirical-code-execution',
  );
  assert.deepEqual(empirical.scope.runtimeLanguages, ['python', 'r']);
});

test('capability matrix help discloses local runtime observation effects', () => {
  const run = spawnSync(process.execPath, [
    fileURLToPath(new URL('../bin/research-capability-matrix.mjs', import.meta.url)),
    '--help',
  ], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '' },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    version: 1,
    kind: 'ResearchCapabilityMatrixUsage',
    usage: 'research-capability-matrix [--json] [--deployment-environment-file PATH] [--root PATH] [--runtime-root PATH] [--require-production-ready]',
    mutation: 'no-canonical-state-write',
    localObservationEffects: 'runtime-metadata-and-daemon-probes-may-change',
    externalAction: 'local-runtime-observation',
  });
});
