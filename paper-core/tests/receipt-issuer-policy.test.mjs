import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  issueArtifactRepositoryWriter,
  issueLedgerAdministratorWriter,
} from '../../paper-adapters/persistence/receipt-writer-broker.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createSqliteReceiptLedgerQualificationStore } from '../../paper-adapters/persistence/sqlite-receipt-ledger-qualification.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { verifyTrustedLedgerReceipt } from '../../paper-domain/evidence/trusted-ledger-receipt.mjs';
import { resolveReceiptIssuerPolicy } from '../../paper-domain/evidence/receipt-issuer-policy-registry.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-issuer-policy-'));
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'test.sqlite') });
  const clock = { nowIso: () => '2026-07-13T00:00:00.000Z' };
  return { root, store, clock };
}

test('trusted writer cannot be self-declared and registered issuer is least-privilege', () => {
  const { root, store, clock } = fixture();
  try {
    assert.throws(() => createSqliteReceiptLedger({
      store,
      clock,
      writerIdentity: { writerId: 'self-declared', trusted: true },
    }), /raw_trusted_writer_identity_forbidden/);
    const ledger = createSqliteReceiptLedger({
      store,
      clock,
      issuerCapability: issueArtifactRepositoryWriter(),
    });
    const payload = { version: 1, kind: 'ArtifactWriteReceipt', status: 'written' };
    const recorded = ledger.record({ ...payload, writeReceiptHash: hashRecord('ArtifactWriteReceipt', payload) }, { stream: 'artifact-writes' });
    assert.equal(recorded.writerTrusted, true);
    assert.equal(recorded.issuerPolicyId, 'artifact-repository');
    assert.equal(recorded.issuerAssurance, 'in_process_registered_issuer');
    assert.throws(() => ledger.record({ kind: 'ForgedReceipt' }, { stream: 'artifact-writes' }), /issuer kind forbidden/);
    assert.throws(() => ledger.record({ ...payload, writeReceiptHash: hashRecord('Other', payload) }, { stream: 'jobs' }), /issuer stream forbidden/);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('receipt ledger rows cannot be updated or deleted after schema 20', () => {
  const { root, store, clock } = fixture();
  try {
    const ledger = createSqliteReceiptLedger({ store, clock });
    const receipt = ledger.record({ kind: 'UntrustedDiagnosticReceipt', status: 'recorded' }, { stream: 'diagnostic' });
    assert.equal(store.execute(`UPDATE receipt_ledger SET status='changed' WHERE receipt_id='${receipt.receiptId}'`).ok, false);
    assert.equal(store.execute(`DELETE FROM receipt_ledger WHERE receipt_id='${receipt.receiptId}'`).ok, false);
    assert.equal(ledger.get(receipt.receiptId).status, 'recorded');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('trusted receipt verification derives issuer trust from the canonical policy registry', () => {
  const { root, store } = fixture();
  const policyId = 'artifact-repository';
  const policy = resolveReceiptIssuerPolicy(policyId);
  const payload = { version: 1, kind: 'ArtifactWriteReceipt', status: 'written', path: 'forged.json' };
  const receipt = { ...payload, writeReceiptHash: hashRecord('ArtifactWriteReceipt', payload) };
  const sqlText = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const cases = [
    {
      suffix: 'policy-id',
      values: { policyId: 'attacker-self-declared', policyHash: policy.issuerPolicyHash, assurance: policy.assurance, writerId: policy.writerId },
      blocker: 'trusted_receipt_issuer_policy_unregistered',
    },
    {
      suffix: 'policy-hash',
      values: { policyId, policyHash: `sha256:${'0'.repeat(64)}`, assurance: policy.assurance, writerId: policy.writerId },
      blocker: 'trusted_receipt_issuer_policy_hash_mismatch',
    },
    {
      suffix: 'assurance',
      values: { policyId, policyHash: policy.issuerPolicyHash, assurance: 'in_process_registered_administrator', writerId: policy.writerId },
      blocker: 'trusted_receipt_issuer_assurance_mismatch',
    },
    {
      suffix: 'writer-id',
      values: { policyId, policyHash: policy.issuerPolicyHash, assurance: policy.assurance, writerId: 'attacker-writer' },
      blocker: 'trusted_receipt_issuer_writer_id_mismatch',
    },
  ];
  try {
    for (const fixtureCase of cases) {
      const receiptId = `forged:${fixtureCase.suffix}`;
      const inserted = store.execute(`INSERT INTO receipt_ledger(receipt_id,stream,paper_id,kind,status,receipt_json,receipt_sha256,created_at,environment,evidence_class,release_commit,writer_id,writer_kind,writer_trusted,issuer_policy_id,issuer_policy_hash,issuer_assurance) VALUES(${sqlText(receiptId)},'artifact-writes',NULL,'ArtifactWriteReceipt','written',${sqlText(JSON.stringify(receipt))},${sqlText(receipt.writeReceiptHash)},'2026-07-13T00:00:00.000Z','test','test',NULL,${sqlText(fixtureCase.values.writerId)},${sqlText(policy.writerKind)},1,${sqlText(fixtureCase.values.policyId)},${sqlText(fixtureCase.values.policyHash)},${sqlText(fixtureCase.values.assurance)});`);
      assert.equal(inserted.ok, true, inserted.error || fixtureCase.suffix);
      const verification = verifyTrustedLedgerReceipt({
        receipt,
        ledgerReceiptId: receiptId,
        receiptLedger: { get: (id) => store.query(`SELECT * FROM receipt_ledger WHERE receipt_id=${sqlText(id)} LIMIT 1;`).rows[0] || null },
        expectedKinds: ['ArtifactWriteReceipt'],
        expectedStreams: ['artifact-writes'],
      });
      assert.equal(verification.status, 'trusted_ledger_receipt_blocked', fixtureCase.suffix);
      assert.equal(verification.blockers.includes(fixtureCase.blocker), true, fixtureCase.suffix);
      assert.equal(verification.issuerPolicyVerified, false, fixtureCase.suffix);
    }
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('same-UID database-writer threat model fails closed without external issuer attestation', () => {
  const { root, store } = fixture();
  const policyId = 'artifact-repository';
  const policy = resolveReceiptIssuerPolicy(policyId);
  const payload = { version: 1, kind: 'ArtifactWriteReceipt', status: 'written', path: 'canonical-forgery.json' };
  const receipt = { ...payload, writeReceiptHash: hashRecord('ArtifactWriteReceipt', payload) };
  const receiptId = 'forged:canonical-policy-copy';
  const sqlText = (value) => `'${String(value).replace(/'/g, "''")}'`;
  try {
    const inserted = store.execute(`INSERT INTO receipt_ledger(receipt_id,stream,paper_id,kind,status,receipt_json,receipt_sha256,created_at,environment,evidence_class,release_commit,writer_id,writer_kind,writer_trusted,issuer_policy_id,issuer_policy_hash,issuer_assurance) VALUES(${sqlText(receiptId)},'artifact-writes',NULL,'ArtifactWriteReceipt','written',${sqlText(JSON.stringify(receipt))},${sqlText(receipt.writeReceiptHash)},'2026-07-13T00:00:00.000Z','test','test',NULL,${sqlText(policy.writerId)},${sqlText(policy.writerKind)},1,${sqlText(policyId)},${sqlText(policy.issuerPolicyHash)},${sqlText(policy.assurance)});`);
    assert.equal(inserted.ok, true, inserted.error);
    const verification = verifyTrustedLedgerReceipt({
      receipt,
      ledgerReceiptId: receiptId,
      receiptLedger: { get: (id) => store.query(`SELECT * FROM receipt_ledger WHERE receipt_id=${sqlText(id)} LIMIT 1;`).rows[0] || null },
      expectedKinds: ['ArtifactWriteReceipt'],
      expectedStreams: ['artifact-writes'],
      requireExternalIssuerAttestation: true,
    });
    assert.equal(verification.status, 'trusted_ledger_receipt_blocked');
    assert.equal(verification.blockers.includes('trusted_receipt_external_issuer_attestation_required'), true);
    assert.deepEqual(verification.issuerAuthentication, {
      mode: 'in_process_registered_policy',
      externallyAttested: false,
      directDatabaseWriterResistant: false,
    });
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('qualified trusted receipts fail closed while raw rows remain audit-readable', () => {
  const { root, store, clock } = fixture();
  try {
    const ledger = createSqliteReceiptLedger({
      store,
      clock,
      issuerCapability: issueArtifactRepositoryWriter(),
    });
    const payload = { version: 1, kind: 'ArtifactWriteReceipt', status: 'written' };
    const receipt = { ...payload, writeReceiptHash: hashRecord('ArtifactWriteReceipt', payload) };
    const recorded = ledger.record(receipt, { stream: 'artifact-writes' });
    const qualifications = createSqliteReceiptLedgerQualificationStore({
      store,
      clock,
      issuerCapability: issueLedgerAdministratorWriter(),
    });
    const qualification = qualifications.qualify({
      receiptId: recorded.receiptId,
      disposition: 'invalid',
      reason: 'adversarial effective-ledger test',
    });
    const verification = verifyTrustedLedgerReceipt({
      receipt,
      ledgerReceiptId: recorded.receiptId,
      receiptLedger: ledger,
      expectedKinds: ['ArtifactWriteReceipt'],
      expectedStreams: ['artifact-writes'],
    });
    assert.equal(verification.status, 'trusted_ledger_receipt_blocked');
    assert.deepEqual(verification.blockers, ['trusted_receipt_qualified_invalid']);
    assert.equal(verification.qualificationHash, qualification.qualificationHash);
    assert.equal(ledger.list({ stream: 'artifact-writes' }).length, 0);
    assert.equal(ledger.list({ stream: 'artifact-writes', includeQualified: true }).length, 1);
    assert.equal(ledger.getRawForAudit(recorded.receiptId).receipt_id, recorded.receiptId);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('superseded receipts resolve only through a hash-bound replacement lineage', () => {
  const { root, store, clock } = fixture();
  try {
    const ledger = createSqliteReceiptLedger({ store, clock, issuerCapability: issueArtifactRepositoryWriter() });
    const oldPayload = { version: 1, kind: 'ArtifactWriteReceipt', status: 'written', path: 'old' };
    const oldReceipt = { ...oldPayload, writeReceiptHash: hashRecord('ArtifactWriteReceipt', oldPayload) };
    const oldRecorded = ledger.record(oldReceipt, { stream: 'artifact-writes' });
    const replacementPayload = { version: 1, kind: 'ArtifactWriteReceipt', status: 'written', path: 'replacement' };
    const replacementReceipt = { ...replacementPayload, writeReceiptHash: hashRecord('ArtifactWriteReceipt', replacementPayload) };
    const replacementRecorded = ledger.record(replacementReceipt, { stream: 'artifact-writes' });
    const qualifications = createSqliteReceiptLedgerQualificationStore({ store, clock, issuerCapability: issueLedgerAdministratorWriter() });
    qualifications.qualify({ receiptId: oldRecorded.receiptId, disposition: 'superseded', reason: 'replacement lineage test', replacementReceiptId: replacementRecorded.receiptId });
    const replacementVerification = verifyTrustedLedgerReceipt({ receipt: replacementReceipt, ledgerReceiptId: oldRecorded.receiptId, receiptLedger: ledger, expectedKinds: ['ArtifactWriteReceipt'], expectedStreams: ['artifact-writes'] });
    assert.equal(replacementVerification.status, 'trusted_ledger_receipt_verified');
    assert.equal(replacementVerification.effectiveLineage.length, 1);
    assert.equal(replacementVerification.effectiveLineage[0].replacementReceiptId, replacementRecorded.receiptId);
    const staleVerification = verifyTrustedLedgerReceipt({ receipt: oldReceipt, ledgerReceiptId: oldRecorded.receiptId, receiptLedger: ledger });
    assert.equal(staleVerification.status, 'trusted_ledger_receipt_blocked');
    assert.equal(staleVerification.blockers.includes('trusted_receipt_ledger_payload_mismatch'), true);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('receipt qualification is irreversible and supersession preserves issuer identity', () => {
  const { root, store, clock } = fixture();
  try {
    const trusted = createSqliteReceiptLedger({ store, clock, issuerCapability: issueArtifactRepositoryWriter() });
    const untrusted = createSqliteReceiptLedger({ store, clock });
    const firstPayload = { version: 1, kind: 'ArtifactWriteReceipt', status: 'written', path: 'first' };
    const secondPayload = { version: 1, kind: 'ArtifactWriteReceipt', status: 'written', path: 'second' };
    const first = trusted.record({ ...firstPayload, writeReceiptHash: hashRecord('ArtifactWriteReceipt', firstPayload) }, { stream: 'artifact-writes' });
    const second = trusted.record({ ...secondPayload, writeReceiptHash: hashRecord('ArtifactWriteReceipt', secondPayload) }, { stream: 'artifact-writes' });
    const foreignPayload = { version: 1, kind: 'ArtifactWriteReceipt', status: 'written', path: 'foreign' };
    const foreign = untrusted.record({ ...foreignPayload, writeReceiptHash: hashRecord('ArtifactWriteReceipt', foreignPayload) }, { stream: 'artifact-writes' });
    const qualifications = createSqliteReceiptLedgerQualificationStore({ store, clock, issuerCapability: issueLedgerAdministratorWriter() });
    qualifications.qualify({ receiptId: first.receiptId, disposition: 'invalid', reason: 'terminal decision' });
    assert.throws(() => qualifications.qualify({ receiptId: first.receiptId, disposition: 'superseded', reason: 'attempted reversal', replacementReceiptId: second.receiptId }), /receipt_qualification_is_monotonic/);
    assert.throws(() => qualifications.qualify({ receiptId: second.receiptId, disposition: 'superseded', reason: 'issuer mismatch', replacementReceiptId: foreign.receiptId }), /receipt_supersession_identity_mismatch/);
    assert.equal(store.execute(`INSERT INTO receipt_ledger_qualifications(qualification_id,receipt_id,disposition,reason,replacement_receipt_id,qualification_json,qualification_sha256,issuer_policy_id,created_at) VALUES('manual-reversal','${first.receiptId}','superseded','manual','${second.receiptId}','{}','sha256:manual','ledger-administrator','2026-07-13T00:00:01.000Z');`).ok, false);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
