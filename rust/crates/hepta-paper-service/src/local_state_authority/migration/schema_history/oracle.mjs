// Real incumbent journal fixture. Keys are isolated test inputs, never runtime
// qualification. Expected heads come from actual signed runtime operations.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export async function createSchemaHistoryFixture({
  repository, root, rebindCount = 0, stopAt = 'activated', reverseIds = false,
  backupCount = 0, pendingBackup = false,
  backupLeaseMs = 30000, backupReceiptLeaseDeltaMs = 0,
} = {}) {
  if (!path.isAbsolute(repository) || !root.startsWith('/tmp/hepta-')
    || fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root
    || !Number.isSafeInteger(rebindCount) || rebindCount < 0 || rebindCount > 3) {
    throw Error('isolated_fixture_required');
  }
  const load = relative => import(pathToFileURL(path.join(repository, relative)));
  const { productionOracleProfile } = await load('rust/oracle/production-record-hash-v1.mjs');
  const { hashRecord } = await load('workflow-kernel/record-hash.mjs');
  const { createLocalAutonomousResearchStateAuthority } = await load('paper-adapters/automation/local-autonomous-research-state-authority-runtime.mjs');
  const { AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES: roles, autonomousResearchStateDatabaseScopeHash: scopeHash } = await load('paper-domain/automation/autonomous-research-state-backup-contract.mjs');
  const { autonomousResearchOnlineSchemaTransitionReceiptHash: receiptHash } = await load('paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs');
  const { buildAutonomousResearchOnlineSchemaTransitionFinalizeRequest: finalizeRequest } = await load('paper-adapters/automation/autonomous-research-online-schema-transition-state.mjs');
  const { autonomousResearchStateBackupAuthoritySignaturePayload: backupPayload } = await load('paper-adapters/automation/autonomous-research-state-backup-authority.mjs');
  const h = text => `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPath = path.join(root, 'fixture-key.pem');
  fs.writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  let instances = roles.map((role, index) => ({
    databaseRole: role, databaseInstanceId: reverseIds ? `instance:${String(roles.length - index).padStart(2, '0')}:${role}` : `instance:${role}`,
    sourceRelativePath: `${role}.sqlite`, preSchemaContractId: 'schema:old', schemaContractId: 'schema:initial',
    preSchemaHash: h('schema:old'), expectedPostSchemaHash: h('schema:initial'), sourceSha256: h(role),
    sourceFileIdentityHash: h('identity'), journalPreimageHash: h('journal'),
    expectedNormalizedSourceSha256: h('normalized'), prePristineStateHash: h('pristine'),
  })).sort((a, b) => a.databaseInstanceId < b.databaseInstanceId ? -1 : 1);
  let configuration = {
    version: 1, kind: 'HeptaLocalAutonomousResearchStateAuthorityConfiguration',
    authorityId: 'authority:legacy-history', keyId: 'key:legacy-history', scopeId: 'scope:legacy-history',
    databaseScopeHash: scopeHash(instances.map(i => ({ instanceId: i.databaseInstanceId, role: i.databaseRole, sourceRelativePath: i.sourceRelativePath }))),
    writerManifestHash: h('writer:initial'), privateKeyPath,
    stateDatabasePath: path.join(root, 'authority.sqlite'), socketPath: path.join(root, 'authority.sock'),
    maximumReservationLeaseMs: 30000, maximumObservationAgeMs: 30000,
  };
  const configurationPath = path.join(root, 'configuration.json');
  fs.writeFileSync(configurationPath, JSON.stringify(configuration), { mode: 0o600, flag: 'wx' });
  let now = '2026-09-21T00:00:00.000Z';
  const clock = { now: () => new Date(now) };
  let authority = createLocalAutonomousResearchStateAuthority({ configurationPath, clock });
  let lastReservation = null;
  const transitions = [];
  function request(epoch) {
    const q = {
      version: epoch === 0 ? 1 : 2, kind: 'AutonomousResearchOnlineSchemaTransitionReserveRequest',
      protocol: epoch === 0 ? 'external-authority-quiesced-offline-schema-transition-v1' : 'external-authority-pristine-finalized-schema-rebind-v2',
      scopeId: configuration.scopeId, databaseScopeHash: configuration.databaseScopeHash,
      writerManifestHash: epoch === 0 ? configuration.writerManifestHash : h(`writer:rebind:${epoch}`),
      stateDatabaseManifestHash: h('manifest'), schemaBundleHash: h(`bundle:${epoch}`),
      authorityJournalSchemaContractId: 'journal:v1', authorityJournalSchemaHash: h('journal:schema'),
      markerSchemaHash: h('marker'), instances, requestedAt: now, requestedLeaseMs: 30000, requiredExecutionWindowMs: 1000,
      ...(epoch === 0 ? {} : { transitionMode: 'pristine-finalized-writer-manifest-rebind', sourceWriterManifestHash: configuration.writerManifestHash, prePristineRuntimeStateHash: h(`pristine:${epoch}`) }),
    };
    q.transitionInventoryHash = hashRecord('AutonomousResearchOnlineSchemaTransitionInventory', {
      stateDatabaseManifestHash: q.stateDatabaseManifestHash, databaseScopeHash: q.databaseScopeHash, instances,
    });
    const identity = {
      scopeId: q.scopeId, databaseScopeHash: q.databaseScopeHash, writerManifestHash: q.writerManifestHash,
      stateDatabaseManifestHash: q.stateDatabaseManifestHash, schemaBundleHash: q.schemaBundleHash,
      instances: instances.map(i => Object.fromEntries(['databaseRole', 'databaseInstanceId', 'sourceRelativePath', 'preSchemaContractId', 'schemaContractId', 'prePristineStateHash', 'expectedPostSchemaHash'].map(k => [k, i[k]]))),
      ...(epoch === 0 ? {} : { transitionMode: q.transitionMode, sourceWriterManifestHash: q.sourceWriterManifestHash, prePristineRuntimeStateHash: q.prePristineRuntimeStateHash }),
    };
    q.transitionId = hashRecord('AutonomousResearchOnlineSchemaTransitionIdentity', identity);
    return q;
  }
  function finish(q, reservation) {
    const installations = instances.map(i => {
      const row = {
        databaseRole: i.databaseRole, databaseInstanceId: i.databaseInstanceId, schemaContractId: i.schemaContractId,
        preSchemaHash: i.preSchemaHash, postSchemaHash: i.expectedPostSchemaHash,
        prePristineStateHash: i.prePristineStateHash, postPristineStateHash: h('post:pristine'),
      };
      return { ...row, installationHash: hashRecord('AutonomousResearchOnlineSchemaTransitionDatabaseInstallation', { ...row, transitionId: q.transitionId, reservationReceiptHash: receiptHash(reservation) }) };
    });
    return finalizeRequest({ plan: q, reservation, inventory: { inventoryHash: h('post:inventory') }, installations,
      postPristineRuntimeStateHash: h('post:runtime'), completedAt: now });
  }
  if (stopAt !== 'uninitialized') {
    for (let epoch = 0; epoch <= rebindCount; epoch++) {
      now = `2026-09-21T00:00:0${epoch}.000Z`;
      if (epoch > 0) {
        const previous = authority.inspect().databaseHeads;
        instances = instances.map((i, index) => ({ ...i,
          preSchemaContractId: i.schemaContractId, schemaContractId: `schema:rebind:${epoch}`,
          preSchemaHash: previous[index].schemaHash, expectedPostSchemaHash: h(`schema:rebind:${epoch}`),
        }));
      }
      const q = request(epoch);
      const reservation = authority.handle(q);
      lastReservation = reservation;
      if ((epoch === 0 && stopAt === 'reserved-initial') || (epoch === rebindCount && stopAt === 'reserved-rebind')) break;
      const finalize = finish(q, reservation);
      const finalization = authority.handle(finalize);
      transitions.push({ request: q, reservation, finalize, finalization });
      if (epoch > 0) {
        if (epoch === rebindCount && stopAt === 'finalized-rebind') break;
        authority.close();
        configuration = { ...configuration, writerManifestHash: q.writerManifestHash };
        fs.writeFileSync(configurationPath, JSON.stringify(configuration), { mode: 0o600 });
        authority = createLocalAutonomousResearchStateAuthority({ configurationPath, clock });
      }
    }
  }
  const backups = [];
  if (stopAt !== 'uninitialized') {
    for (let index = 0; index < backupCount; index++) {
      now = `2026-09-21T00:01:${String(index).padStart(2, '0')}.000Z`;
      const current = authority.inspect();
      const reserve = {
        version: 1, kind: 'AutonomousResearchStateBackupAuthorityReserveRequest',
        inventoryHash: h(`backup:inventory:${index}`),
        databaseScopeHash: configuration.databaseScopeHash,
        databaseInstanceIds: current.databaseHeads.map(head => head.databaseInstanceId),
        requestedAt: now, maximumLeaseMs: backupLeaseMs,
      };
      const reservation = authority.handle(reserve);
      if (pendingBackup && index === backupCount - 1) {
        backups.push({ reserve, reservation, finalize: null, finalization: null });
        break;
      }
      now = `2026-09-21T00:01:${String(index).padStart(2, '0')}.100Z`;
      const finalize = {
        version: 1, kind: 'AutonomousResearchStateBackupAuthorityFinalizeRequest',
        reservationId: reservation.reservationId,
        inventoryHash: reserve.inventoryHash,
        databaseScopeHash: reserve.databaseScopeHash,
        snapshotContentHash: h(`backup:snapshot:${index}`), requestedAt: now,
      };
      const finalization = authority.handle(finalize);
      backups.push({ reserve, reservation, finalize, finalization });
    }
  }
  if (backupReceiptLeaseDeltaMs !== 0) {
    // Only this isolated negative fixture is changed. The actual Node producer
    // above supplies the request and original signed records; a fresh signature
    // deliberately binds a false lease duration using the same fixture key.
    const receipt = { ...backups[0].reservation };
    backups[0].reservation = receipt;
    receipt.expiresAt = new Date(Date.parse(receipt.expiresAt) + backupReceiptLeaseDeltaMs).toISOString();
    const payload = Buffer.from(backupPayload(receipt), 'utf8');
    receipt.signature = crypto.sign(null, payload, privateKey).toString('base64');
    if (!crypto.verify(null, payload, publicKey, Buffer.from(receipt.signature, 'base64'))) {
      throw Error('fixture_signature_invalid');
    }
    const database = new DatabaseSync(configuration.stateDatabasePath);
    try {
      database.prepare('UPDATE authority_backup_reservation SET reservation_receipt_json=? WHERE reservation_id=?')
        .run(JSON.stringify(receipt), receipt.reservationId);
    } finally { database.close(); }
  }
  const terminal = authority.inspect();
  const genesis = {
    globalSequence: terminal.globalSequence, globalHash: terminal.globalHash,
    databaseHeads: terminal.databaseHeads.map(head => ({ ...head,
      schemaContractId: lastReservation.databaseGenesis.find(i => i.databaseInstanceId === head.databaseInstanceId).schemaContractId,
    })),
  };
  return {
    authority, configuration, configurationPath, publicKeyPem, genesis, terminal, transitions,
    backups, profile: productionOracleProfile(), setNow: value => { now = value; }, close: () => authority.close(),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [repository, root, scenario = 'genesis'] = process.argv.slice(2);
  const options = {
    uninitialized: { stopAt: 'uninitialized' }, genesis: {}, rebind: { rebindCount: 1 },
    rebind2: { rebindCount: 2 }, 'reserved-initial': { stopAt: 'reserved-initial' },
    'rebind-permuted': { rebindCount: 1, reverseIds: true },
    'reserved-rebind': { rebindCount: 1, stopAt: 'reserved-rebind' },
    'finalized-rebind': { rebindCount: 1, stopAt: 'finalized-rebind' },
    'finalized-backups': { backupCount: 3 },
    'pending-backup': { backupCount: 2, pendingBackup: true },
    'signed-backup-short-lease': { backupCount: 3, backupLeaseMs: 10000, backupReceiptLeaseDeltaMs: -1000 },
    'signed-backup-long-lease': { backupCount: 3, backupLeaseMs: 10000, backupReceiptLeaseDeltaMs: 1000 },
  }[scenario];
  if (!options) throw Error('fixture_scenario_invalid');
  const fixture = await createSchemaHistoryFixture({ repository, root, ...options });
  try {
    const { configuration, configurationPath, publicKeyPem, genesis, terminal, transitions, backups, profile } = fixture;
    process.stdout.write(JSON.stringify({ configuration, configurationPath, publicKeyPem, genesis, terminal, transitions, backups, profile }) + '\n');
  } finally { fixture.close(); }
}
