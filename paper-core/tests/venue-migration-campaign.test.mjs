import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildVenueMigrationManifest,
  buildVenueMigrationReviewQueue,
  sourceVenueMatch,
} from '../../paper-domain/automation/venue-migration-campaign-contract.mjs';
import { CampaignCommandService } from '../../paper-application/automation/campaign-command-service.mjs';
import {
  materializeVenueMigrationWorkspaceSync,
} from '../../paper-adapters/automation/venue-migration-workspace-repository.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HASH = (character) => `sha256:${character.repeat(64)}`;

function row({ paperId = 'paper-1', venueTarget = 'NeurIPS 2026', source = '/tmp/paper-1', sourcePaperContract = null } = {}) {
  return {
    task: {
      paperId,
      title: paperId,
      venueTarget,
      semanticIdentityHash: HASH('a'),
      sourceWorkspace: source,
    },
    sourceWorkspace: source,
    sourcePaperContract,
    paper: { venue_target: venueTarget },
  };
}

test('venue migration selection records explicit provenance and rejects unrelated rows', () => {
  const selected = sourceVenueMatch(row(), 'NeurIPS');
  assert.equal(selected.matched, true);
  assert.equal(selected.confidence, 'explicit');
  assert.deepEqual(selected.explicitEvidence, ['NeurIPS 2026']);
  const historical = sourceVenueMatch(row({ venueTarget: '', source: '/tmp/NeurIPS_old/paper' }), 'NeurIPS');
  assert.equal(historical.matched, true);
  assert.equal(historical.confidence, 'historical-path');
  assert.equal(sourceVenueMatch(row({ venueTarget: 'ICLR 2027' }), 'NeurIPS').matched, false);
});

test('venue migration manifest is deterministic, isolated, and local-only', () => {
  const options = {
    rows: [row({ paperId: 'b' }), row({ paperId: 'a', source: '/tmp/a' })],
    sourceVenue: 'NeurIPS',
    targetVenue: 'ICLR',
    runtimeRoot: '/tmp/hepta-runtime',
    runId: 'neurips-to-iclr-20260824',
    rounds: 2,
    referees: 3,
  };
  const first = buildVenueMigrationManifest(options);
  const second = buildVenueMigrationManifest(options);
  assert.equal(first.manifestHash, second.manifestHash);
  assert.deepEqual(first.entries.map((entry) => entry.paperId), ['a', 'b']);
  assert.equal(first.externalSubmissionEnabled, false);
  assert.equal(first.networkUse, 'none');
  assert.match(first.entries[0].idempotencyKey, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.entries[0].campaignId, 'paper-campaign:a:neurips-to-iclr-20260824');
  assert.match(first.entries[0].workspaceIsolation.attemptWorkspaceRoot, /campaign-attempt-workspaces/);
  assert.equal(first.entries[0].reviewPlan.rounds, 2);
  const queue = buildVenueMigrationReviewQueue(first, {
    campaignPlans: first.entries.map((entry) => ({
      paperId: entry.paperId,
      campaignId: entry.campaignId,
      campaignPlanHash: HASH('b'),
    })),
  });
  assert.equal(queue.entryCount, 2);
  assert.equal(queue.queue[0].targetVenue, 'ICLR');
  assert.equal(queue.queue[0].campaignPlanHash, HASH('b'));
  assert.equal(queue.queue[0].sourcePaperProfile, null);
  assert.equal(queue.externalSubmissionEnabled, false);
  assert.throws(() => buildVenueMigrationReviewQueue(first, {
    campaignPlans: [{ paperId: 'a', campaignId: 'wrong', campaignPlanHash: HASH('b') }],
  }), /campaign_id_mismatch/);
});

test('venue migration preserves paper.json quality profile as metadata without silently activating a gate', () => {
  const manifest = buildVenueMigrationManifest({
    rows: [row({
      sourcePaperContract: {
        path: '/tmp/paper-1/paper.json',
        contractSchema: 'paper_factory.paper_production.contract.v1',
        profile: 'theorem_or_proof_paper',
        migrationState: 'profile_declared_proof_quality_pending',
        proofReadiness: {
          required: true,
          required_reports: [{ id: 'theorem_obligation_contract' }],
        },
      },
    })],
    sourceVenue: 'NeurIPS',
    targetVenue: 'ICLR',
    runtimeRoot: '/tmp/hepta-runtime',
    runId: 'profile-test',
  });
  assert.equal(manifest.entries[0].sourcePaperContract.profile, 'theorem_or_proof_paper');
  assert.match(manifest.entries[0].sourcePaperContractHash, /^sha256:[0-9a-f]{64}$/);
  const queue = buildVenueMigrationReviewQueue(manifest);
  assert.equal(queue.queue[0].sourcePaperProfile, 'theorem_or_proof_paper');
  assert.equal(queue.queue[0].qualityBindingPolicy, 'source_profile_recorded_requires_explicit_campaign_quality_binding');
});

test('campaign plan batch applies target venue override without mutating task provenance', () => {
  const campaignStore = {
    listCampaigns: () => [],
    listNodes: () => [],
    listEvents: () => [],
    getCampaign: () => null,
  };
  const service = new CampaignCommandService({
    campaignStore,
    runtimeRoot: '/tmp/runtime',
    buildRuntimeRetentionPlan: () => ({ categories: [] }),
    executeRuntimeRetentionPlan: () => ({}),
  });
  const plans = service.buildPlanBatch({
    inventoryRows: [{ task: row().task, state: { evidenceRefs: [] }, sourceWorkspace: '/tmp/paper-1' }],
    options: {
      paper: ['paper-1'],
      target: 'ICLR',
      mode: 'local-review-loop',
      'local-only': true,
      rounds: '1',
      referees: '1',
      languages: 'latex',
    },
    runId: 'neurips-to-iclr-20260824',
  });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].venueTarget, 'ICLR');
  assert.equal(plans[0].externalSubmissionEnabled, false);
  assert.equal(row().task.venueTarget, 'NeurIPS 2026');
});

test('venue migration materializes an idempotent campaign COW and never writes canonical source', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-venue-runtime-'));
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-venue-source-'));
  try {
    fs.mkdirSync(path.join(sourceRoot, 'experiments'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'main.tex'), '% canonical manuscript\n');
    fs.writeFileSync(path.join(sourceRoot, 'experiments', 'run.py'), 'print("ok")\n');
    const manifest = buildVenueMigrationManifest({
      rows: [row({ source: sourceRoot })],
      sourceVenue: 'NeurIPS',
      targetVenue: 'ICLR',
      runtimeRoot,
      runId: 'cow-test',
    });
    const entry = manifest.entries[0];
    const sourceBefore = fs.readFileSync(path.join(sourceRoot, 'main.tex'), 'utf8');
    const first = materializeVenueMigrationWorkspaceSync({ entry, runtimeRoot });
    assert.equal(first.status, 'venue_migration_workspace_bound');
    assert.equal(fs.readFileSync(path.join(sourceRoot, 'main.tex'), 'utf8'), sourceBefore);
    const campaignMain = path.join(entry.workspaceIsolation.campaignWorkspaceRoot, 'main.tex');
    assert.equal(fs.readFileSync(campaignMain, 'utf8'), sourceBefore);
    fs.writeFileSync(campaignMain, '% revised only in COW\n');
    const second = materializeVenueMigrationWorkspaceSync({ entry, runtimeRoot });
    assert.equal(second.status, 'venue_migration_workspace_reused');
    assert.equal(fs.readFileSync(campaignMain, 'utf8'), '% revised only in COW\n');
    assert.equal(fs.readFileSync(path.join(sourceRoot, 'main.tex'), 'utf8'), sourceBefore);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});
