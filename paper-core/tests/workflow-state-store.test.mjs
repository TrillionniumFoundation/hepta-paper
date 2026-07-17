import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSqliteWorkflowStateStore } from '../../paper-adapters/persistence/sqlite-workflow-state-store.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { receiptIssuerPolicies } from '../../paper-adapters/persistence/receipt-issuer-policy.mjs';
import { issueWorkflowStateProjectorWriter } from '../../paper-adapters/persistence/receipt-writer-broker.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const clock = Object.freeze({ nowIso: () => '2026-07-11T03:00:00.000Z' });
const trustedWorkflowLedger = (store) => createSqliteReceiptLedger({ store, clock, issuerCapability: issueWorkflowStateProjectorWriter() });
const sqlQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

test('workflow state projection is hash-bound and rejects unregistered papers', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-workflow-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'state.sqlite') });
  t.after(() => store.close());
  const receiptLedger = trustedWorkflowLedger(store);
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
  assert.deepEqual(corrupt.blockers, ['workflow_state_projection_hash_mismatch', 'workflow_state_projection_receipt_missing_or_invalid']);
});

test('workflow state and its ledger receipt rollback together and reads require an effective receipt', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-workflow-state-atomic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'state.sqlite') });
  t.after(() => store.close());
  store.execute("INSERT INTO papers(slug,title,canonical_dir,status) VALUES('paper-atomic','Paper','paper','draft');");
  const receiptLedger = trustedWorkflowLedger(store);
  const broken = createSqliteWorkflowStateStore({
    store,
    clock,
    receiptLedger: {
      prepare(receipt, options) {
        return { ...receiptLedger.prepare(receipt, options), sql: 'INSERT INTO table_that_does_not_exist(value) VALUES(1);' };
      },
    },
  });
  assert.throws(() => broken.put({ paperId: 'paper-atomic', mode: 'inventory', state: { status: 'ready' } }), /no such table|transaction_failed/);
  assert.equal(store.query("SELECT count(*) AS count FROM workflow_states WHERE paper_id='paper-atomic';").rows[0].count, 0);

  const projections = createSqliteWorkflowStateStore({ store, clock, receiptLedger });
  assert.equal(store.execute("CREATE TRIGGER inject_workflow_projection_failure BEFORE INSERT ON workflow_states WHEN NEW.paper_id='paper-atomic' BEGIN SELECT RAISE(ABORT,'injected_workflow_projection_failure'); END;").ok, true);
  assert.throws(() => projections.put({ paperId: 'paper-atomic', mode: 'inventory', state: { status: 'ready' } }), /injected_workflow_projection_failure/);
  assert.equal(store.query("SELECT count(*) AS count FROM receipt_ledger WHERE stream='workflow-state' AND paper_id='paper-atomic';").rows[0].count, 0);
  assert.equal(store.query("SELECT count(*) AS count FROM workflow_states WHERE paper_id='paper-atomic';").rows[0].count, 0);
  assert.equal(store.execute('DROP TRIGGER inject_workflow_projection_failure;').ok, true);

  const write = projections.put({ paperId: 'paper-atomic', mode: 'inventory', state: { status: 'ready' } });
  assert.equal(projections.get('paper-atomic').integrityVerified, true);
  const qualification = {
    version: 1,
    kind: 'ReceiptLedgerQualification',
    receiptId: write.ledgerReceiptId,
    disposition: 'invalid',
    reason: 'fault_injection',
    replacementReceiptId: null,
    createdAt: clock.nowIso(),
  };
  const qualificationHash = hashRecord('ReceiptLedgerQualification', qualification);
  const inserted = store.execute(`INSERT INTO receipt_ledger_qualifications(qualification_id,receipt_id,disposition,reason,replacement_receipt_id,qualification_json,qualification_sha256,issuer_policy_id,created_at) VALUES('qualification:fault','${write.ledgerReceiptId}','invalid','fault_injection',NULL,'${JSON.stringify(qualification).replace(/'/g, "''")}','${qualificationHash}','fault-policy','${clock.nowIso()}');`);
  assert.equal(inserted.ok, true);
  const blocked = projections.get('paper-atomic');
  assert.equal(blocked.integrityVerified, false);
  assert.deepEqual(blocked.blockers, ['workflow_state_projection_receipt_missing_or_invalid']);
});

test('workflow state reads bind the complete canonical receipt and trusted ledger authority', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-workflow-state-authority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'state.sqlite') });
  t.after(() => store.close());
  const projections = createSqliteWorkflowStateStore({ store, clock, receiptLedger: trustedWorkflowLedger(store) });
  const policy = receiptIssuerPolicies()['workflow-state-projector'];
  const scenarios = [
    { name: 'foreign-stream', row: { stream: 'foreign-stream' } },
    { name: 'null-subject', row: { paperId: null } },
    { name: 'verification-environment', row: { environment: 'verification' } },
    { name: 'foreign-evidence-class', row: { evidenceClass: 'technical_conformance' } },
    { name: 'untrusted-writer', row: { writerTrusted: 0, writerId: 'untrusted-caller', writerKind: 'untrusted', issuerPolicyId: null, issuerPolicyHash: null, issuerAssurance: 'untrusted' } },
    { name: 'wrong-mode', receipt: { mode: 'wrong-mode' } },
    { name: 'wrong-status', receipt: { status: 'wrong-status' } },
    { name: 'wrong-created-at', receipt: { createdAt: '2026-07-11T03:00:01.000Z' } },
    { name: 'wrong-workflow-hash', receipt: { workflowReceiptHash: `sha256:${'9'.repeat(64)}` } },
    { name: 'wrong-self-hash', corruptSelfHash: true },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const paperId = `paper-authority-${index}`;
    const mode = 'inventory';
    const workflowReceiptHash = `sha256:${String(index).padStart(64, '0')}`;
    const recordedAt = clock.nowIso();
    const projection = {
      version: 1,
      kind: 'PaperWorkflowStateProjection',
      paperId,
      mode,
      state: { status: 'ready' },
      workflowReceiptHash,
      sourceReceiptHashes: [],
      recordedAt,
    };
    const projectionHash = hashRecord('PaperWorkflowStateProjection', projection);
    const receiptPayload = {
      version: 1,
      kind: 'PaperWorkflowStateProjectionReceipt',
      paperId,
      mode,
      status: 'workflow_state_projection_persisted',
      projectionHash,
      workflowReceiptHash,
      createdAt: recordedAt,
      externalActionPerformed: false,
      ...(scenario.receipt || {}),
    };
    const computedHash = hashRecord('PaperWorkflowStateProjectionReceipt', receiptPayload);
    const declaredHash = scenario.corruptSelfHash ? `sha256:${'f'.repeat(64)}` : computedHash;
    const receipt = { ...receiptPayload, paperWorkflowStateProjectionReceiptHash: declaredHash };
    const row = {
      stream: 'workflow-state',
      paperId,
      environment: 'administrative',
      evidenceClass: 'workflow_state_projection',
      writerId: policy.writerId,
      writerKind: policy.writerKind,
      writerTrusted: 1,
      issuerPolicyId: 'workflow-state-projector',
      issuerPolicyHash: policy.issuerPolicyHash,
      issuerAssurance: policy.assurance,
      ...(scenario.row || {}),
    };
    const receiptId = `${row.stream}:${declaredHash}`;
    assert.equal(store.execute(`INSERT INTO papers(slug,title,canonical_dir,status) VALUES(${sqlQuote(paperId)},'Paper','paper','draft');`).ok, true);
    assert.equal(store.execute(`INSERT INTO receipt_ledger(receipt_id,stream,paper_id,kind,status,receipt_json,receipt_sha256,created_at,environment,evidence_class,release_commit,writer_id,writer_kind,writer_trusted,issuer_policy_id,issuer_policy_hash,issuer_assurance) VALUES(${sqlQuote(receiptId)},${sqlQuote(row.stream)},${row.paperId ? sqlQuote(row.paperId) : 'NULL'},'PaperWorkflowStateProjectionReceipt',${sqlQuote(receipt.status)},${sqlQuote(JSON.stringify(receipt))},${sqlQuote(declaredHash)},${sqlQuote(receipt.createdAt)},${sqlQuote(row.environment)},${sqlQuote(row.evidenceClass)},NULL,${sqlQuote(row.writerId)},${sqlQuote(row.writerKind)},${row.writerTrusted},${row.issuerPolicyId ? sqlQuote(row.issuerPolicyId) : 'NULL'},${row.issuerPolicyHash ? sqlQuote(row.issuerPolicyHash) : 'NULL'},${sqlQuote(row.issuerAssurance)});`).ok, true);
    assert.equal(store.execute(`INSERT INTO workflow_states(paper_id,state_json,state_sha256,updated_at,ledger_receipt_id,projection_receipt_sha256) VALUES(${sqlQuote(paperId)},${sqlQuote(JSON.stringify(projection))},${sqlQuote(projectionHash)},${sqlQuote(recordedAt)},${sqlQuote(receiptId)},${sqlQuote(declaredHash)});`).ok, true);
    const verified = projections.get(paperId);
    assert.equal(verified.projectionHashVerified ?? true, true, scenario.name);
    assert.equal(verified.ledgerHashVerified, false, scenario.name);
    assert.equal(verified.integrityVerified, false, scenario.name);
    assert.equal(verified.blockers.includes('workflow_state_projection_receipt_missing_or_invalid'), true, scenario.name);
  }
});

test('workflow state writes reject an untrusted receipt writer', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-workflow-state-untrusted-writer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'state.sqlite') });
  t.after(() => store.close());
  store.execute("INSERT INTO papers(slug,title,canonical_dir,status) VALUES('paper-untrusted','Paper','paper','draft');");
  const untrustedLedger = createSqliteReceiptLedger({ store, clock });
  const projections = createSqliteWorkflowStateStore({ store, clock, receiptLedger: untrustedLedger });
  assert.throws(() => projections.put({ paperId: 'paper-untrusted', mode: 'inventory', state: { status: 'ready' } }), /workflow_state_trusted_writer_required/);
  assert.equal(store.query("SELECT count(*) AS count FROM workflow_states WHERE paper_id='paper-untrusted';").rows[0].count, 0);
});
