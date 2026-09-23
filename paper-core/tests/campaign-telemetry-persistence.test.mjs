import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';

test('campaign telemetry is append-only and queryable for SLO input', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-telemetry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root });
  t.after(() => store.close());
  const campaigns = createSqliteCampaignStore({ store, clock: { nowIso: () => '2026-07-12T00:00:00Z' } });
  campaigns.createCampaign({ campaignId: 'campaign', paperId: 'paper', maxRounds: 1, nodes: [{ nodeId: 'n', kind: 'draft', dependencies: [] }] });
  campaigns.recordTelemetry({ campaignId: 'campaign', nodeId: 'n', phases: { command: 5 }, lockWaitMs: 2, queueContentionCount: 1 });
  const samples = campaigns.listTelemetry('campaign');
  assert.equal(samples.length, 1);
  assert.equal(samples[0].phases.command, 5);
  assert.equal(samples[0].lockWaitMs, 2);
  assert.equal(samples[0].queueContentionCount, 1);
});
