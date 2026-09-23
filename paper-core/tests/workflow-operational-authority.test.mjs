import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDefaultPaperStore, createReadOnlyPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { runPaperBatch } from '../../paper-composition/batch/paper-batch-application.mjs';
import { runLegacyWorkflowProjectionBatch } from '../../paper-composition/compat/legacy-paper-batch-application.mjs';
import {
  convergeAutonomousSubmissionHandoff,
} from '../../paper-composition/bootstrap/autonomous-submission-handoff-migration-composition.mjs';
import {
  WORKFLOW_OPERATIONAL_AUTHORITY,
  assertLegacyWorkflowProjectionAuthorized,
  buildCanonicalPaperStatusReadProjection,
  buildWorkflowAuthorityLineage,
} from '../../paper-domain/workflow/operational-authority-policy.mjs';

const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function testHandoffMutationCoordinator() {
  const coveredDatabaseRoles = Object.freeze(['submission-handoff']);
  return Object.freeze({
    implemented: true,
    coveredDatabaseRoles,
    executeMutation() {
      throw new Error('workflow_authority_test_handoff_mutation_unexpected');
    },
    recoverPendingMutations() { return Object.freeze([]); },
    inspectStatus() {
      return Object.freeze({
        status: 'externally_fenced_sqlite_mutation_coordinator_ready',
        implemented: true,
        coveredDatabaseRoles,
        blockers: Object.freeze([]),
      });
    },
  });
}

function fixture(t, suffix = '') {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `hepta-batch-authority-${suffix}`));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'assets');
  const runtimeRoot = path.join(parent, 'runtime');
  const source = path.join(root, 'drafts', 'paper-1');
  fs.mkdirSync(path.join(root, 'registry'), { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'main.tex'), '\\documentclass{article}\\begin{document}x\\end{document}\n');
  fs.writeFileSync(path.join(root, 'registry', 'papers.yaml'), [
    'papers:',
    '  - slug: paper-1',
    '    title: Paper One',
    '    status: draft',
    '    source_dir: drafts/paper-1',
    '    canonical_dir: drafts/paper-1',
    '    venue_target: Test Venue',
    '',
  ].join('\n'));
  const store = createDefaultPaperStore({ root, runtimeRoot });
  const dbPath = store.dbPath;
  const registered = store.run(
    "INSERT INTO papers(slug,title,status,venue_target,canonical_dir,source_dir) VALUES(?,?,?,?,?,?);",
    ['paper-1', 'Paper One', 'draft', 'Test Venue', 'drafts/paper-1', 'drafts/paper-1'],
  );
  assert.equal(registered.ok, true, registered.error);
  convergeAutonomousSubmissionHandoff({ nativeStore: store, runtimeRoot });
  store.close();
  return {
    root,
    runtimeRoot,
    dbPath,
    submissionHandoffMutationCoordinator: testHandoffMutationCoordinator(),
  };
}

function inspectDatabase(roots, callback) {
  const store = createReadOnlyPaperStore({ root: roots.root, runtimeRoot: roots.runtimeRoot });
  try { return callback(store); } finally { store.close(); }
}

test('campaign DAG lineage requires and binds the campaign plan authority', () => {
  assert.throws(() => buildWorkflowAuthorityLineage({
    paperId: 'paper-1',
    mode: 'local-build',
    execute: true,
    recordedAt: '2026-07-14T00:00:00.000Z',
  }), /campaignId and campaignPlanHash/);
  const lineage = buildWorkflowAuthorityLineage({
    paperId: 'paper-1',
    mode: 'local-build',
    execute: true,
    campaignId: 'paper-campaign:paper-1:batch-local-build',
    campaignPlanHash: 'sha256:plan',
    workflowReceiptHash: null,
    recordedAt: '2026-07-14T00:00:00.000Z',
  });
  assert.equal(lineage.operationalAuthority, 'campaign-dag-v1');
  assert.equal(lineage.campaignId, 'paper-campaign:paper-1:batch-local-build');
  assert.equal(lineage.campaignPlanHash, 'sha256:plan');
  assert.equal(lineage.workflowReceiptHash, null);
  assert.deepEqual(lineage.operationalAuthorityTables, ['paper_campaigns', 'campaign_nodes', 'campaign_events']);
  assert.equal(lineage.batchRole, 'command_use_case_facade');
  assert.equal(lineage.legacyProjectionAuthorized, false);
  assert.throws(() => assertLegacyWorkflowProjectionAuthorized(lineage), /legacy_workflow_projection_not_authorized/);
  assert.equal(WORKFLOW_OPERATIONAL_AUTHORITY.paperStatusRole, 'canonical_read_projection');
});

test('execute batch submits a real hash-bound campaign without running stage handlers', async (t) => {
  const roots = fixture(t, 'execute-');
  const options = {
    ...roots,
    mode: 'local-build',
    execute: true,
    writeReport: false,
    paperIds: ['paper-1'],
    inventorySource: 'yaml',
    maxRounds: 2,
  };
  const first = await runPaperBatch(options);
  assert.equal(first.results.length, 1);
  const result = first.results[0];
  for (const key of [
    'buildResult',
    'packageResult',
    'researchReport',
    'refereeReview',
    'refereeRevision',
    'localDiagnosticReviewLoop',
    'journalManagement',
    'empiricalAnalysis',
    'venueResolution',
    'sourceAdaptation',
    'lifecycle',
  ]) assert.equal(Object.hasOwn(result, key), false, key);
  assert.equal(result.campaignSubmission.status, 'paper_campaign_queued');
  assert.equal(result.workflowAuthorityLineage.campaignId, result.campaignPlan.campaignId);
  assert.equal(result.workflowAuthorityLineage.campaignPlanHash, result.campaignPlan.campaignPlanHash);
  assert.equal(result.workflowAuthorityLineage.workflowReceiptHash, null);
  assert.deepEqual(result.campaignPlan.nodes.map((node) => node.kind), ['compile']);
  assert.equal(result.campaignPlan.mode, 'local-build');
  assert.equal(result.campaignSubmission.executionStatus, 'queued_not_executed');
  assert.equal(result.campaignSubmission.workflowExecutionPerformed, false);
  assert.equal(first.status, 'paper_campaigns_queued_not_executed');
  assert.equal(first.executionStatus, 'queued_not_executed');
  assert.equal(first.workflowExecutionPerformed, false);
  assert.equal(first.summary.campaignQueue.nodeCount, 1);
  assert.deepEqual(first.summary.campaignQueue.nodeKinds, ['compile']);
  assert.equal(Object.hasOwn(first.summary, 'researchTypedContracts'), false);
  assert.equal(Object.hasOwn(first, 'compatibilityStageSummary'), false);
  assert.equal(Object.hasOwn(first, 'coreIntegrity'), false);
  assert.deepEqual(first.campaignSubmissions.map((item) => ({
    campaignId: item.campaignId,
    campaignPlanHash: item.campaignPlanHash,
    nodeKinds: item.nodeKinds,
    executionStatus: item.executionStatus,
  })), [{
    campaignId: result.campaignPlan.campaignId,
    campaignPlanHash: result.campaignPlan.campaignPlanHash,
    nodeKinds: ['compile'],
    executionStatus: 'queued_not_executed',
  }]);

  const firstCounts = inspectDatabase(roots, (store) => {
    const campaign = store.query('SELECT campaign_id,spec_json FROM paper_campaigns;').rows[0];
    const spec = JSON.parse(campaign.spec_json);
    assert.equal(campaign.campaign_id, result.campaignPlan.campaignId);
    assert.equal(spec.campaignPlanHash, result.campaignPlan.campaignPlanHash);
    assert.equal(spec.commandBinding.batchCampaignCommandHash, result.campaignCommand.batchCampaignCommandHash);
    assert.equal(store.query('SELECT count(*) AS count FROM campaign_nodes;').rows[0].count, result.campaignPlan.nodes.length);
    assert.equal(store.query("SELECT count(*) AS count FROM campaign_events WHERE kind='campaign_created';").rows[0].count, 1);
    assert.equal(store.query('SELECT count(*) AS count FROM workflow_states;').rows[0].count, 0);
    return {
      campaigns: store.query('SELECT count(*) AS count FROM paper_campaigns;').rows[0].count,
      nodes: store.query('SELECT count(*) AS count FROM campaign_nodes;').rows[0].count,
      events: store.query('SELECT count(*) AS count FROM campaign_events;').rows[0].count,
      lineage: store.query("SELECT count(*) AS count FROM receipt_ledger WHERE stream='workflow-authority';").rows[0].count,
    };
  });

  const replay = await runPaperBatch(options);
  assert.equal(replay.results[0].campaignSubmission.status, 'paper_campaign_already_queued');
  assert.equal(replay.results[0].campaignPlan.campaignPlanHash, result.campaignPlan.campaignPlanHash);
  assert.deepEqual(inspectDatabase(roots, (store) => ({
    campaigns: store.query('SELECT count(*) AS count FROM paper_campaigns;').rows[0].count,
    nodes: store.query('SELECT count(*) AS count FROM campaign_nodes;').rows[0].count,
    events: store.query('SELECT count(*) AS count FROM campaign_events;').rows[0].count,
    lineage: store.query("SELECT count(*) AS count FROM receipt_ledger WHERE stream='workflow-authority';").rows[0].count,
  })), firstCounts);

  await assert.rejects(() => runPaperBatch({ ...options, maxRounds: 3 }), /batch_campaign_definition_conflict/);
});

test('referee-autopilot idempotently replays the local-review-loop campaign', async (t) => {
  const roots = fixture(t, 'review-loop-alias-');
  const options = {
    ...roots,
    execute: true,
    writeReport: false,
    paperIds: ['paper-1'],
    inventorySource: 'yaml',
    maxRounds: 2,
  };
  const canonical = await runPaperBatch({ ...options, mode: 'local-review-loop' });
  const alias = await runPaperBatch({ ...options, mode: 'referee-autopilot' });
  const canonicalResult = canonical.results[0];
  const aliasResult = alias.results[0];

  assert.equal(canonicalResult.campaignSubmission.status, 'paper_campaign_queued');
  assert.equal(aliasResult.campaignSubmission.status, 'paper_campaign_already_queued');
  assert.equal(aliasResult.campaignSubmission.idempotentReplay, true);
  assert.equal(aliasResult.campaignCommand.requestedMode, 'referee-autopilot');
  assert.equal(aliasResult.campaignCommand.effectiveMode, 'local-review-loop');
  assert.equal(aliasResult.campaignPlan.campaignId, canonicalResult.campaignPlan.campaignId);
  assert.equal(aliasResult.campaignPlan.campaignPlanHash, canonicalResult.campaignPlan.campaignPlanHash);
  assert.deepEqual(aliasResult.campaignPlan, canonicalResult.campaignPlan);
  inspectDatabase(roots, (store) => {
    assert.equal(store.query('SELECT count(*) AS count FROM paper_campaigns;').rows[0].count, 1);
    assert.equal(
      store.query('SELECT count(*) AS count FROM campaign_nodes;').rows[0].count,
      canonicalResult.campaignPlan.nodes.length,
    );
    assert.equal(store.query("SELECT count(*) AS count FROM campaign_events WHERE kind='campaign_created';").rows[0].count, 1);
  });
});

test('batch dataset benchmark intent rejects an incomplete operator authorization before campaign creation', async (t) => {
  const roots = fixture(t, 'dataset-');
  const datasetRoot = path.join(roots.root, 'datasets', 'benchmark-a');
  fs.mkdirSync(datasetRoot, { recursive: true });
  fs.writeFileSync(path.join(datasetRoot, 'records.json'), '{"score":1}\n');
  await assert.rejects(() => runPaperBatch({
      ...roots,
      mode: 'empirical-analysis',
      execute: true,
      writeReport: false,
      paperIds: ['paper-1'],
      inventorySource: 'yaml',
      datasetRoot,
      benchmarkId: 'benchmark-a',
      datasetLicenseId: 'LicenseRef-OperatorAuthorizedLocalData',
      datasetAuthorizationHash: `sha256:${'a'.repeat(64)}`,
      targetOverride: 'Target Venue',
      applyManuscript: true,
    }), /campaign_benchmark_dataset_authorization_invalid:benchmark-a/);
  inspectDatabase(roots, (store) => {
    assert.equal(store.query('SELECT count(*) AS count FROM paper_campaigns;').rows[0].count, 0);
    assert.equal(store.query('SELECT count(*) AS count FROM campaign_nodes;').rows[0].count, 0);
  });
});

test('reviewed-submit report exposes a local release handoff without claiming external submission', async (t) => {
  const roots = fixture(t, 'reviewed-submit-report-');
  const report = await runPaperBatch({
    ...roots,
    mode: 'reviewed-submit',
    execute: false,
    writeReport: false,
    paperIds: ['paper-1'],
    inventorySource: 'yaml',
  });
  assert.equal(report.campaignSubmissions.length, 1);
  assert.equal(report.campaignSubmissions[0].releaseHandoffRequired, true);
  assert.equal(report.campaignSubmissions[0].externalSubmissionEnabled, false);
  assert.deepEqual(report.campaignSubmissions[0].nodeKinds, ['final-compile', 'package', 'research-verify']);
  assert.equal(report.safety.reviewedSubmitBlockedByDefault, true);
  assert.equal(report.safety.externalActionPerformed, false);
});

test('legacy workflow projection exists only behind the explicit compatibility entry point', async (t) => {
  const roots = fixture(t, 'compat-');
  const report = await runLegacyWorkflowProjectionBatch({
    ...roots,
    mode: 'local-build',
    execute: true,
    writeReport: false,
    paperIds: ['paper-1'],
    inventorySource: 'yaml',
    maxRounds: 2,
  });
  assert.equal(report.results[0].workflowAuthorityLineage.legacyProjectionAuthorized, true);
  assert.equal(report.results[0].workflowStateProjection.persisted, true);
  assert.equal(report.compatibilityProjection.authoritative, false);
  assert.equal(report.compatibilityProjection.stageMetricsComputed, true);
  assert.ok(Number.isFinite(report.compatibilityStageSummary.researchTypedContracts));
  inspectDatabase(roots, (store) => {
    assert.equal(store.query('SELECT count(*) AS count FROM workflow_states;').rows[0].count, 1);
    assert.equal(store.query('SELECT count(*) AS count FROM paper_campaigns;').rows[0].count, 1);
  });
});

test('batch production graph has no workflow engine, stage handlers, or compatibility import', () => {
  const source = fs.readFileSync(path.join(workspaceRoot, 'paper-composition/batch/paper-batch-application.mjs'), 'utf8');
  assert.doesNotMatch(source, /runWorkflowStages|createPaperStageHandlers|runLocalDiagnosticReviewLoop/);
  assert.doesNotMatch(source, /paper-composition\/compat|\.\.\/compat\//);
  assert.doesNotMatch(source, /persistLegacyWorkflowStateProjection/);
  assert.doesNotMatch(source, /buildCoreIntegrityReport|core-integrity\.mjs/);
  assert.doesNotMatch(source, /emptyStageResults|buildResult:\s*null|researchReport:\s*null/);
  assert.match(source, /bootstrapAutomationContext/);
  assert.match(source, /submitBatchCampaignCommand/);

  const readProjection = buildCanonicalPaperStatusReadProjection({
    paperId: 'paper-1',
    observedStatus: 'draft',
    recordedAt: '2026-07-14T00:00:00.000Z',
  });
  assert.equal(readProjection.source, 'papers.status');
  assert.equal(readProjection.role, 'canonical_read_projection');
});
