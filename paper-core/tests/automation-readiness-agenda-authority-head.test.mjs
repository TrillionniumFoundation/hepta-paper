import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createDefaultPaperStore,
} from '../../paper-adapters/persistence/store-provider.mjs';
import {
  inspectPersistedAutonomousResearchAgendaAuthority,
} from '../../paper-composition/automation/automation-readiness-agenda-authority-inspection.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  genericManuscriptReleaseFixture,
} from './support/autonomous-research-generalization-fixture.mjs';

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function agendaAuthorityFixture(t, {
  paperId,
  campaignId,
} = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-agenda-head-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'assets');
  const runtimeRoot = path.join(base, 'runtime');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const fixture = genericManuscriptReleaseFixture({
    paperId,
    campaignId,
    objective: 'Compare a generated intervention with a fixed benchmark control.',
    protocolFamily: 'ml_algorithm_benchmark',
  });
  const {
    autonomousResearchLoopPreparationReportHash: _preparationHash,
    ...fixturePreparationPayload
  } = fixture.preparation;
  const preparationPayload = {
    ...fixturePreparationPayload,
    version: 1,
    kind: 'AutonomousResearchLoopPreparationReport',
  };
  const preparation = {
    ...preparationPayload,
    autonomousResearchLoopPreparationReportHash: hashRecord(
      'AutonomousResearchLoopPreparationReport',
      preparationPayload,
    ),
  };
  const plan = (selectedCampaignId, selectedPreparation = preparation) => {
    const payload = {
      version: 4,
      kind: 'PaperCampaignPlan',
      campaignId: selectedCampaignId,
      paperId,
      autonomousResearchPreparation: selectedPreparation,
    };
    return {
      ...payload,
      campaignPlanHash: hashRecord('PaperCampaignPlan', payload),
    };
  };
  const store = createDefaultPaperStore({ root, runtimeRoot });
  t.after(() => store.close());
  const inspect = (options = {}) =>
    inspectPersistedAutonomousResearchAgendaAuthority({
      store,
      currentPriorArtAuthorityTrustConfiguration:
        fixture.preparation.priorArtAuthorityTrustConfiguration,
      currentExternalCapabilityTrustInspection:
        fixture.preparation.externalCapabilityTrustInspection,
      now: new Date('2026-07-19T00:02:00.000Z'),
      ...options,
    });
  return { fixture, inspect, paperId, plan, preparation, store };
}

function insertCampaign(store, {
  campaignId,
  paperId,
  plan,
  timestamp,
  supersedesCampaignId = null,
} = {}) {
  const supersessionColumns = supersedesCampaignId
    ? ',supersedes_campaign_id' : '';
  const supersessionValues = supersedesCampaignId
    ? `,${quote(supersedesCampaignId)}` : '';
  const result = store.execute(`INSERT INTO paper_campaigns(
    campaign_id,paper_id,status,max_rounds,spec_json,created_at,updated_at
    ${supersessionColumns}
  ) VALUES(
    ${quote(campaignId)},${quote(paperId)},'running',1,
    ${quote(JSON.stringify(plan))},${quote(timestamp)},${quote(timestamp)}
    ${supersessionValues}
  );`);
  assert.equal(result.ok, true, result.error);
}

test('current production agenda authority never falls back to an older campaign',
  (t) => {
    const oldCampaignId = 'current-agenda-old';
    const currentCampaignId = 'current-agenda-new';
    const context = agendaAuthorityFixture(t, {
      paperId: 'current-agenda-paper',
      campaignId: oldCampaignId,
    });
    const {
      autonomousResearchLoopPreparationReportHash: _preparationHash,
      ...missingReceiptPayload
    } = structuredClone(context.preparation);
    delete missingReceiptPayload.researchAgendaProducerReceipt;
    const missingReceiptPreparation = {
      ...missingReceiptPayload,
      autonomousResearchLoopPreparationReportHash: hashRecord(
        'AutonomousResearchLoopPreparationReport',
        missingReceiptPayload,
      ),
    };
    insertCampaign(context.store, {
      campaignId: oldCampaignId,
      paperId: context.paperId,
      plan: context.plan(oldCampaignId),
      timestamp: '2026-07-19T00:00:00.000Z',
    });
    insertCampaign(context.store, {
      campaignId: currentCampaignId,
      paperId: context.paperId,
      plan: context.plan(currentCampaignId, missingReceiptPreparation),
      timestamp: '2026-07-19T00:01:00.000Z',
      supersedesCampaignId: oldCampaignId,
    });

    const missingReceipt = context.inspect();
    assert.equal(missingReceipt.ready, false);
    assert.ok(missingReceipt.blockers.includes(
      'autonomous_research_current_agenda_authority_invalid',
    ));

    assert.equal(context.store.execute(`UPDATE paper_campaigns
      SET spec_json=${quote(JSON.stringify(context.plan(currentCampaignId)))},
        status='paused',revision=revision+1
      WHERE campaign_id=${quote(currentCampaignId)};`).ok, true);
    const paused = context.inspect();
    assert.equal(paused.ready, false);
    assert.ok(paused.blockers.includes(
      'autonomous_research_current_agenda_authority_invalid',
    ));

    assert.equal(context.store.execute(`UPDATE paper_campaigns
      SET status='running',revision=revision+1
      WHERE campaign_id=${quote(currentCampaignId)};`).ok, true);
    const trustDrift = context.inspect({
      currentPriorArtAuthorityTrustConfiguration: Object.freeze({
        kind: 'UntrustedReplacement',
      }),
    });
    assert.equal(trustDrift.ready, true, JSON.stringify(trustDrift));
    assert.equal(trustDrift.campaignId, currentCampaignId);
    assert.equal(trustDrift.priorArtClaimAlignmentReady, false);
  });

test('agenda capability bootstrap snapshot cannot switch campaigns', (t) => {
  const firstCampaignId = 'agenda-snapshot-first';
  const secondCampaignId = 'agenda-snapshot-second';
  const context = agendaAuthorityFixture(t, {
    paperId: 'agenda-snapshot-paper',
    campaignId: firstCampaignId,
  });
  const unavailableInitial = context.inspect();
  assert.equal(unavailableInitial.ready, false);
  insertCampaign(context.store, {
    campaignId: firstCampaignId,
    paperId: context.paperId,
    plan: context.plan(firstCampaignId),
    timestamp: '2026-07-19T00:00:00.000Z',
  });
  const appeared = context.inspect({
    expectedAgendaAuthorityInspection: unavailableInitial,
  });
  assert.equal(appeared.ready, false);
  assert.ok(appeared.blockers.includes(
    'autonomous_research_agenda_authority_snapshot_mismatch',
  ));
  const initial = context.inspect();
  assert.equal(initial.ready, true, JSON.stringify(initial));
  assert.equal(initial.campaignId, firstCampaignId);
  insertCampaign(context.store, {
    campaignId: secondCampaignId,
    paperId: context.paperId,
    plan: context.plan(secondCampaignId),
    timestamp: '2026-07-19T00:01:00.000Z',
    supersedesCampaignId: firstCampaignId,
  });
  const switched = context.inspect({
    expectedAgendaAuthorityInspection: initial,
  });
  assert.equal(switched.ready, false);
  assert.ok(switched.blockers.includes(
    'autonomous_research_agenda_authority_snapshot_mismatch',
  ));
});
