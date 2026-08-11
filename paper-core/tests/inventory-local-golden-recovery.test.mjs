import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverInventory } from '../../paper-adapters/inventory/index.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { sqlJson, sqlText } from '../../paper-ports/store-port.mjs';

test('native local-only campaigns remain discoverable for recovery under an isolated temporary root', async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-local-golden-recovery-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'assets');
  const runtimeRoot = path.join(parent, 'runtime');
  const paperId = 'local-golden-recovery-paper';
  const campaignId = `paper-campaign:${paperId}:attempt-1`;
  const sourceWorkspace = path.join(root, 'drafts', paperId);
  fs.mkdirSync(sourceWorkspace, { recursive: true });
  fs.writeFileSync(path.join(sourceWorkspace, 'main.tex'), '\\documentclass{article}\\begin{document}seed\\end{document}\n');
  const store = createDefaultPaperStore({ root, runtimeRoot });
  t.after(() => store.close());
  const metadata = { source: 'paper_campaign_creation', campaignId };
  const createdAt = '2026-08-10T00:00:00.000Z';
  const inserted = store.execute(`
INSERT INTO papers(slug,title,status,paper_type,canonical_dir,source_dir,submission_dir,metadata_json,created_at,updated_at)
VALUES(${sqlText(paperId)},${sqlText(paperId)},'draft','campaign',${sqlText(sourceWorkspace)},${sqlText(sourceWorkspace)},'submission',${sqlJson(metadata)},${sqlText(createdAt)},${sqlText(createdAt)});
INSERT INTO paper_campaigns(campaign_id,paper_id,status,max_rounds,spec_json,created_at,updated_at,current_phase)
VALUES(${sqlText(campaignId)},${sqlText(paperId)},'failed',1,${sqlJson({ localOnly: true })},${sqlText(createdAt)},${sqlText(createdAt)},'failed');
`);
  assert.equal(inserted.ok, true, inserted.error);

  const recoverable = await discoverInventory({ root, store, paperIds: [paperId] });
  assert.equal(recoverable.rows.length, 1);
  assert.equal(recoverable.quarantined.length, 0);
  assert.equal(recoverable.rows[0].task.paperId, paperId);

  assert.equal(store.execute(`UPDATE paper_campaigns SET spec_json=${sqlJson({ localOnly: false })} WHERE campaign_id=${sqlText(campaignId)};`).ok, true);
  const rejected = await discoverInventory({ root, store, paperIds: [paperId] });
  assert.equal(rejected.rows.length, 0);
  assert.deepEqual(rejected.quarantined, [{
    slug: paperId,
    reason: 'fixture_or_shadow_path',
    canonicalDir: sourceWorkspace,
  }]);
});
