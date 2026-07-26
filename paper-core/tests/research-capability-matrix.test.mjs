import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildResearchCapabilityMatrix } from '../../paper-application/automation/research-capability-matrix.mjs';
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
  assert.equal(matrix.capabilities.length, 6);
  const formal = matrix.capabilities.find((entry) => entry.id === 'formal-proof-search');
  assert.equal(formal.implemented, true);
  assert.equal(formal.qualified, false);
  assert.equal(formal.productionReady, false);
  assert.deepEqual(formal.scope.strategies, [
    'direct_elaboration',
    'mathlib_retrieval',
    'bounded_refutation_or_synthesis',
  ]);
  const empirical = matrix.capabilities.find((entry) => entry.id === 'empirical-code-execution');
  assert.equal(empirical.scope.benchmarkFamilies.length, 5);
  assert.deepEqual(empirical.scope.runtimeLanguages, ['python', 'r']);
  const submission = matrix.capabilities.find((entry) => entry.id === 'live-submission');
  assert.equal(submission.scope.localHandoffReady, true);
  assert.equal(submission.productionReady, false);
  const { researchCapabilityMatrixHash, ...payload } = matrix;
  assert.equal(researchCapabilityMatrixHash, hashRecord('ResearchCapabilityMatrix', payload));
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
    usage: 'research-capability-matrix [--json] [--root PATH] [--runtime-root PATH] [--require-production-ready]',
    mutation: 'no-canonical-state-write',
    localObservationEffects: 'runtime-metadata-and-daemon-probes-may-change',
    externalAction: 'local-runtime-observation',
  });
});
