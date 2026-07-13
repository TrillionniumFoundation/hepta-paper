import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorkspaceRegistry } from '../../paper-adapters/automation/workspace-registry.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';

test('workspace registry keeps unresolved failures protected and requires export before eligibility', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-workspace-registry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root });
  t.after(() => store.close());
  let tick = 0;
  const clock = { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)), nowIso() { return this.now().toISOString(); } };
  store.execute("INSERT INTO papers(slug,title,canonical_dir,source_dir) VALUES('paper','Paper','.','.');");
  const campaignStore = createSqliteCampaignStore({ store, clock });
  campaignStore.createCampaign({ campaignId: 'campaign', paperId: 'paper', maxRounds: 1, nodes: [{ nodeId: 'node', kind: 'draft', dependencies: [] }] });
  const registry = createWorkspaceRegistry({ store, clock });
  const entry = registry.register({ workspaceId: 'workspace-1', campaignId: 'campaign', nodeId: 'node', sourcePath: '/source', workspacePath: '/runtime/workspace-1', manifestHash: 'sha256:manifest' });
  assert.equal(entry.retentionState, 'protected');
  const failed = registry.transition(entry.workspaceId, { status: 'failed', failureClass: 'merge_conflict' });
  assert.equal(failed.retentionState, 'protected');
  assert.throws(() => registry.transition(entry.workspaceId, { status: 'merged', retentionState: 'eligible' }), /export receipt/);
  const exported = registry.transition(entry.workspaceId, { status: 'exported', retentionState: 'eligible', retentionReason: 'diagnostic_exported', exportReceiptHash: 'sha256:export' });
  assert.equal(exported.retentionState, 'eligible');
  assert.equal(registry.retentionRecords().length, 1);
});
