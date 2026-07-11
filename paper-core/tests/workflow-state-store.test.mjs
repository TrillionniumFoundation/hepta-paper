import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSqliteWorkflowStateStore } from '../../paper-adapters/persistence/sqlite-workflow-state-store.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';

const clock = Object.freeze({ nowIso: () => '2026-07-11T03:00:00.000Z' });

test('workflow state projection is hash-bound and rejects unregistered papers', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-workflow-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'state.sqlite') });
  const receiptLedger = createSqliteReceiptLedger({ store, clock });
  const projections = createSqliteWorkflowStateStore({ store, clock, receiptLedger });
  assert.equal(projections.put({ paperId: 'missing', mode: 'inventory', state: { status: 'blocked' } }).status, 'workflow_state_projection_blocked');
  store.execute("INSERT INTO papers(slug,title,canonical_dir,status) VALUES('paper-1','Paper 1','paper-1','draft');");
  const write = projections.put({
    paperId: 'paper-1',
    mode: 'reviewed-submit',
    state: { readinessStatus: 'blocked', blockers: ['academic_evidence_required'] },
    workflowReceiptHash: `sha256:${'1'.repeat(64)}`,
  });
  assert.equal(write.status, 'workflow_state_projection_persisted');
  assert.equal(receiptLedger.list({ stream: 'workflow-state' }).length, 1);
  assert.equal(projections.get('paper-1').integrityVerified, true);
  assert.equal(projections.list({ limit: 10 }).length, 1);
  store.execute("UPDATE workflow_states SET state_json='{}' WHERE paper_id='paper-1';");
  const corrupt = projections.get('paper-1');
  assert.equal(corrupt.status, 'workflow_state_projection_corrupt');
  assert.deepEqual(corrupt.blockers, ['workflow_state_projection_hash_mismatch']);
});
