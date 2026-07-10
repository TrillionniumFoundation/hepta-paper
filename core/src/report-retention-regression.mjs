import { digest } from './hash-utils.mjs';
import {
  buildReportRetentionPlan,
  buildReportRetentionResult,
} from './prune-reports.mjs';

export const REPORT_RETENTION_REGRESSION_VERSION = 1;

export const REPORT_RETENTION_REGRESSION_REPORT_FILE_ID = 'report-retention-regression-latest.json';

const FIXTURE_GENERATED_AT = '2026-01-01T00:00:00.000Z';

function missingValues(expected, observed) {
  const observedSet = new Set(observed);
  return expected.filter((value) => !observedSet.has(value));
}

function unexpectedValues(observed, expected) {
  const expectedSet = new Set(expected);
  return observed.filter((value) => !expectedSet.has(value));
}

function planFor(fileNames) {
  return buildReportRetentionPlan({ fileNames });
}

function retentionScenario({
  scenarioId,
  label,
  fileNames,
  expectedKeep = [],
  expectedArchive = [],
  extraChecks = () => [],
}) {
  const plan = planFor(fileNames);
  const observed = {
    keep: plan.keep,
    archive: plan.archive,
  };
  const missingKept = missingValues(expectedKeep, plan.keep);
  const missingArchived = missingValues(expectedArchive, plan.archive);
  const unexpectedArchived = unexpectedValues(
    plan.archive,
    expectedArchive.length ? expectedArchive : plan.archive,
  ).filter((name) => expectedKeep.includes(name));
  const blockers = [
    ...missingKept.map((name) => ({
      code: 'report_retention_regression_expected_keep_missing',
      notes: `${scenarioId} expected ${name} to be kept.`,
    })),
    ...missingArchived.map((name) => ({
      code: 'report_retention_regression_expected_archive_missing',
      notes: `${scenarioId} expected ${name} to be an archive candidate.`,
    })),
    ...unexpectedArchived.map((name) => ({
      code: 'report_retention_regression_protected_file_archived',
      notes: `${scenarioId} archived protected file ${name}.`,
    })),
    ...extraChecks({ plan }),
  ];
  return {
    scenarioId,
    label,
    status: blockers.length ? 'blocked_report_retention_regression_scenario' : 'pass_report_retention_regression_scenario',
    ok: blockers.length === 0,
    fixture: {
      generatedAt: FIXTURE_GENERATED_AT,
      fileNames,
    },
    expected: {
      keep: expectedKeep,
      archive: expectedArchive,
    },
    observed,
    blockers,
  };
}

const SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'timestamped_reports_archive',
    label: 'Timestamped report files become archive candidates',
    run() {
      return retentionScenario({
        scenarioId: this.scenarioId,
        label: this.label,
        fileNames: [
          'README.md',
          'integration-dependency-gate-latest.json',
          'integration-dependency-gate-latest.md',
          'integration-dependency-gate-20260605T010203Z.json',
          'integration-dependency-gate-20260605T010203Z.md',
        ],
        expectedKeep: [
          'README.md',
          'integration-dependency-gate-latest.json',
          'integration-dependency-gate-latest.md',
        ],
        expectedArchive: [
          'integration-dependency-gate-20260605T010203Z.json',
          'integration-dependency-gate-20260605T010203Z.md',
        ],
      });
    },
  }),
  Object.freeze({
    scenarioId: 'latest_json_md_kept',
    label: 'Latest JSON and Markdown reports are protected',
    run() {
      return retentionScenario({
        scenarioId: this.scenarioId,
        label: this.label,
        fileNames: [
          'package-surface-latest.json',
          'package-surface-latest.md',
          'report-freshness-latest.json',
          'report-freshness-latest.md',
        ],
        expectedKeep: [
          'package-surface-latest.json',
          'package-surface-latest.md',
          'report-freshness-latest.json',
          'report-freshness-latest.md',
        ],
        expectedArchive: [],
      });
    },
  }),
  Object.freeze({
    scenarioId: 'reports_readme_kept',
    label: 'Reports README is protected',
    run() {
      return retentionScenario({
        scenarioId: this.scenarioId,
        label: this.label,
        fileNames: [
          'README.md',
          'read-only-samples-20260605T010203Z.json',
        ],
        expectedKeep: ['README.md'],
        expectedArchive: ['read-only-samples-20260605T010203Z.json'],
      });
    },
  }),
  Object.freeze({
    scenarioId: 'latest_like_names_archive',
    label: 'Only exact latest JSON/Markdown names are protected',
    run() {
      return retentionScenario({
        scenarioId: this.scenarioId,
        label: this.label,
        fileNames: [
          'package-surface-latest.json',
          'package-surface-latest.txt',
          'latest.json',
          'README.txt',
        ],
        expectedKeep: ['package-surface-latest.json'],
        expectedArchive: [
          'README.txt',
          'latest.json',
          'package-surface-latest.txt',
        ],
      });
    },
  }),
  Object.freeze({
    scenarioId: 'dry_run_reports_candidates_without_mutation',
    label: 'Dry run reports archive candidates without file mutation',
    run() {
      const fileNames = [
        'README.md',
        'report-retention-latest.json',
        'report-retention-latest.md',
        'report-retention-20260605T010203Z.json',
      ];
      const plan = planFor(fileNames);
      const result = buildReportRetentionResult({
        plan,
        dryRun: true,
        generatedAt: FIXTURE_GENERATED_AT,
      });
      const blockers = [
        ...(result.dryRun !== true ? [{
          code: 'report_retention_regression_dry_run_flag_missing',
          notes: 'Synthetic dry-run result must expose dryRun=true.',
        }] : []),
        ...(result.archivedCount !== 1 ? [{
          code: 'report_retention_regression_dry_run_candidate_count_mismatch',
          notes: `Expected one dry-run archive candidate, got ${result.archivedCount}.`,
        }] : []),
        ...(result.safety.deletesFiles !== false ? [{
          code: 'report_retention_regression_delete_safety_missing',
          notes: 'Report retention must never mark deletesFiles=true.',
        }] : []),
        ...(result.safety.executesExternalAction !== false ? [{
          code: 'report_retention_regression_external_action_safety_missing',
          notes: 'Report retention must never execute external actions.',
        }] : []),
      ];
      return {
        scenarioId: this.scenarioId,
        label: this.label,
        status: blockers.length ? 'blocked_report_retention_regression_scenario' : 'pass_report_retention_regression_scenario',
        ok: blockers.length === 0,
        fixture: {
          generatedAt: FIXTURE_GENERATED_AT,
          fileNames,
        },
        expected: {
          dryRun: true,
          archivedCount: 1,
          deletesFiles: false,
          executesExternalAction: false,
        },
        observed: {
          dryRun: result.dryRun,
          archivedCount: result.archivedCount,
          moved: result.moved,
          safety: result.safety,
          retentionHash: result.retentionHash,
        },
        blockers,
      };
    },
  }),
]);

export function buildReportRetentionRegressionReport({
  generatedAt = new Date().toISOString(),
} = {}) {
  const scenarios = SCENARIOS.map((scenario) => scenario.run());
  const blockers = scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
    ...item,
    scenarioId: scenario.scenarioId,
  })));
  const report = {
    version: REPORT_RETENTION_REGRESSION_VERSION,
    kind: 'ReportRetentionRegression',
    status: blockers.length ? 'blocked_report_retention_regression' : 'pass_report_retention_regression',
    ok: blockers.length === 0,
    generatedAt,
    fixture: {
      generatedAt: FIXTURE_GENERATED_AT,
      scenarioIds: SCENARIOS.map((scenario) => scenario.scenarioId),
    },
    scenarios,
    summary: {
      expectedScenarioCount: SCENARIOS.length,
      scenarioCount: scenarios.length,
      passedScenarioCount: scenarios.filter((scenario) => scenario.ok).length,
      failedScenarioCount: scenarios.filter((scenario) => !scenario.ok).length,
      archiveCandidateCount: scenarios.reduce((sum, scenario) => (
        sum + (scenario.observed.archive?.length || scenario.observed.archivedCount || 0)
      ), 0),
      protectedKeepCount: scenarios.reduce((sum, scenario) => (
        sum + (scenario.expected.keep?.length || 0)
      ), 0),
      blockerCount: blockers.length,
    },
    blockers,
    safety: {
      localOnly: true,
      readOnly: true,
      syntheticFixtureOnly: true,
      mutatesReportFiles: false,
      deletesFiles: false,
      executesExternalAction: false,
      providerSpend: false,
      browserAutomation: false,
      upload: false,
      submit: false,
      messaging: false,
      payment: false,
      acceptance: false,
      deployment: false,
      fetchesChannelState: false,
      appliesLocalStateTransition: false,
      grantsExecutionPermission: false,
    },
  };
  const retentionRegressionHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    fixture: report.fixture,
    scenarios: report.scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      status: scenario.status,
      ok: scenario.ok,
      expected: scenario.expected,
      observed: scenario.observed,
      blockers: scenario.blockers,
    })),
    summary: report.summary,
    blockers: report.blockers,
    safety: report.safety,
  });
  return {
    ...report,
    retentionRegressionHash,
    hash: retentionRegressionHash,
  };
}

export function summarizeReportRetentionRegressionReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_report_retention_regression',
    ok: report?.ok === true,
    retentionRegressionHash: report?.retentionRegressionHash || null,
    scenarioCount: report?.summary?.scenarioCount || 0,
    passedScenarioCount: report?.summary?.passedScenarioCount || 0,
    failedScenarioCount: report?.summary?.failedScenarioCount || 0,
    archiveCandidateCount: report?.summary?.archiveCandidateCount || 0,
    protectedKeepCount: report?.summary?.protectedKeepCount || 0,
    blockerCount: report?.summary?.blockerCount || 0,
    safety: {
      localOnly: report?.safety?.localOnly === true,
      readOnly: report?.safety?.readOnly === true,
      syntheticFixtureOnly: report?.safety?.syntheticFixtureOnly === true,
      mutatesReportFiles: report?.safety?.mutatesReportFiles === true,
      deletesFiles: report?.safety?.deletesFiles === true,
      executesExternalAction: report?.safety?.executesExternalAction === true,
    },
  };
}
