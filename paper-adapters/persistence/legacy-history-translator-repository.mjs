import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyLegacyHistorySnapshot } from './legacy-history-snapshot-repository.mjs';

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function readNdjson(candidate) {
  const text = fs.readFileSync(candidate, 'utf8');
  if (!text.trim()) return [];
  return text.trimEnd().split('\n').map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`legacy_translation_invalid_ndjson:${candidate}:${index + 1}`); }
  });
}

function immutableWrite(candidate, content) {
  try { fs.writeFileSync(candidate, content, { flag: 'wx', mode: 0o444 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (sha256(fs.readFileSync(candidate)) !== sha256(content)) throw new Error(`legacy_translation_immutable_collision:${candidate}`);
  }
}

function first(row, keys) {
  for (const key of keys) if (row?.[key] !== undefined && row?.[key] !== null && row?.[key] !== '') return row[key];
  return null;
}

function parsedJson(value, fallback = {}) {
  try { const parsed = JSON.parse(String(value || '')); return parsed && typeof parsed === 'object' ? parsed : fallback; }
  catch { return fallback; }
}

function nativeRecord(kind, table, row, lineage, fields = {}) {
  const payload = {
    version: 1,
    kind,
    sourceTable: table,
    sourcePrimaryKey: lineage?.sourcePrimaryKey || {},
    sourceRowHash: lineage?.sourceRowHash || null,
    authorityImported: false,
    activeControlPlaneRowCreated: false,
    ...fields,
  };
  return { ...payload, translationHash: hashRecord(kind, payload) };
}

const TRANSLATABLE_EVENT_TYPES = new Set([
  'local_package',
  'patch_merge',
  'merge_queue',
  'release_status',
  'referee_revision_request_transition',
  'referee_revision_request_bulk_transition',
]);

export function classifyLegacyEvent(row = {}) {
  const eventType = String(row.event_type || row.type || '').trim();
  const generatedNoise = /(?:capstone|dashboard|roadmap|report|telegram|terminal|command_index|refusal|status_guard)/i.test(eventType);
  const classification = TRANSLATABLE_EVENT_TYPES.has(eventType)
    ? 'native_lineage_candidate'
    : generatedNoise ? 'generated_control_plane_archive_only' : 'unclassified_archive_only';
  const payload = { version: 1, kind: 'LegacyEventClassification', eventType, classification, translatable: classification === 'native_lineage_candidate' };
  return Object.freeze({ ...payload, legacyEventClassificationHash: hashRecord('LegacyEventClassification', payload) });
}

function translateTable(table, rows, lineage) {
  return rows.map((row, index) => {
    const source = lineage[index];
    if (!source?.sourceRowHash) throw new Error(`legacy_translation_lineage_missing:${table}:${index}`);
    if (source.sourceRowHash !== hashRecord('LegacyHistoryRow', { table, row })) {
      throw new Error(`legacy_translation_source_row_hash_mismatch:${table}:${index}`);
    }
    if (['gate_runs', 'events', 'referee_rounds'].includes(table)) {
      return nativeRecord('LegacyNativeReceiptReference', table, row, source, {
        receiptKind: table === 'gate_runs' ? 'legacy_gate_run' : table === 'referee_rounds' ? 'legacy_referee_round' : 'legacy_event',
        paperId: first(row, ['slug', 'paper_id', 'paperId']),
        historicalStatus: first(row, ['status', 'result', 'verdict', 'event_type']),
        occurredAt: first(row, ['created_at', 'updated_at', 'occurred_at', 'timestamp']),
        path: first(row, ['path', 'log_path', 'review_path']),
        contentHash: first(row, ['sha256', 'output_hash', 'input_hash']),
      });
    }
    if (table === 'paper_versions') {
      return nativeRecord('LegacyArtifactVersionLineage', table, row, source, {
        paperId: first(row, ['slug', 'paper_id', 'paperId']),
        versionId: first(row, ['version_id', 'id', 'version']),
        artifactHash: first(row, ['manifest_sha256', 'sha256', 'source_sha256', 'artifact_hash', 'hash']),
        artifactPath: first(row, ['path', 'manifest_path']),
        versionType: first(row, ['version_type', 'type']),
        label: first(row, ['label', 'version']),
        parentVersionId: first(row, ['parent_version_id', 'parent_id', 'supersedes_version_id']),
        artifactMembers: parsedJson(row.metadata_json, {}).files || [],
        createdAt: first(row, ['created_at']),
      });
    }
    if (table === 'jobs') {
      return nativeRecord('LegacyCampaignNodeLineage', table, row, source, {
        legacyJobId: first(row, ['job_id', 'id']),
        paperId: first(row, ['paper_id', 'slug', 'paperId']),
        nodeKind: first(row, ['task_name', 'kind', 'job_type', 'type']),
        nodeType: first(row, ['task_type', 'job_type', 'type']),
        pluginId: first(row, ['plugin_id']),
        goal: first(row, ['goal']),
        historicalStatus: first(row, ['status', 'state']),
        deduplicationKey: first(row, ['deduplication_key', 'dedupe_key']),
        inputHash: first(row, ['input_hash']),
        outputHash: first(row, ['output_hash']),
        createdAt: first(row, ['created_at']),
        startedAt: first(row, ['started_at']),
        finishedAt: first(row, ['finished_at']),
      });
    }
    if (table === 'job_edges') {
      return nativeRecord('LegacyCampaignEdgeLineage', table, row, source, {
        paperId: first(row, ['paper_id', 'slug', 'paperId']),
        fromLegacyJobId: first(row, ['from_job_id', 'from_task', 'source_job_id', 'parent_job_id']),
        toLegacyJobId: first(row, ['to_job_id', 'to_task', 'target_job_id', 'child_job_id']),
        edgeKind: first(row, ['kind', 'edge_type', 'type']) || 'dependency',
      });
    }
    if (table === 'source_workspaces') {
      return nativeRecord('LegacyWorkspaceLineage', table, row, source, {
        legacyWorkspaceId: first(row, ['workspace_id', 'id']),
        paperId: first(row, ['paper_id', 'slug', 'paperId']),
        sourcePath: first(row, ['source_path', 'path', 'workspace_path']),
        sourceHash: first(row, ['source_sha256', 'workspace_sha256', 'manifest_hash', 'hash']),
        workspacePath: first(row, ['workspace_dir', 'workspace_path']),
        mainTexPath: first(row, ['main_tex_path']),
        historicalStatus: first(row, ['status']),
        parentWorkspaceId: first(row, ['parent_workspace_id', 'parent_id', 'recovery_of_workspace_id']),
      });
    }
    if (table === 'submission_portal_events') {
      return nativeRecord('LegacySubmissionPortalLineage', table, row, source, {
        paperId: first(row, ['paper_id', 'slug', 'paperId']),
        provider: first(row, ['portal_system', 'provider', 'portal', 'venue']),
        portalId: first(row, ['portal_id']),
        portalUrl: first(row, ['portal_url']),
        historicalState: first(row, ['submission_state', 'status', 'event_type']),
        providerReceiptHash: first(row, ['provider_receipt_hash', 'receipt_hash', 'sha256']),
        occurredAt: first(row, ['created_at', 'occurred_at', 'timestamp']),
        deadline: first(row, ['deadline']),
        decision: first(row, ['decision']),
        nextAction: first(row, ['next_action']),
      });
    }
    return null;
  }).filter(Boolean);
}

export function translateLegacyHistorySnapshot({ manifestPath, receiptLedger = null, clock = { nowIso: () => new Date().toISOString() } } = {}) {
  const verification = verifyLegacyHistorySnapshot({ manifestPath });
  if (verification.status !== 'legacy_history_snapshot_verified') {
    throw new Error(`legacy_translation_snapshot_invalid:${verification.blockers.join(',')}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const root = path.dirname(manifestPath);
  const translatedTables = new Set(['gate_runs', 'referee_rounds', 'events', 'paper_versions', 'submission_portal_events', 'jobs', 'job_edges', 'source_workspaces']);
  const records = [];
  const eventClassificationCounts = {};
  for (const table of manifest.tables || []) {
    if (!translatedTables.has(table.name)) continue;
    const rows = readNdjson(path.join(root, `${table.name}.ndjson`));
    const lineage = readNdjson(path.join(root, `${table.name}.lineage.ndjson`));
    if (rows.length !== lineage.length) throw new Error(`legacy_translation_row_lineage_count_mismatch:${table.name}`);
    if (table.name === 'events') {
      const selectedRows = [];
      const selectedLineage = [];
      rows.forEach((row, index) => {
        const classification = classifyLegacyEvent(row);
        eventClassificationCounts[classification.classification] = (eventClassificationCounts[classification.classification] || 0) + 1;
        if (classification.translatable) {
          selectedRows.push(row);
          selectedLineage.push(lineage[index]);
        }
      });
      records.push(...translateTable(table.name, selectedRows, selectedLineage));
    } else records.push(...translateTable(table.name, rows, lineage));
  }
  const ndjson = records.length ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n` : '';
  const translationsPath = path.join(root, 'native-translations.ndjson');
  immutableWrite(translationsPath, Buffer.from(ndjson));
  const byKind = Object.fromEntries([...new Set(records.map((record) => record.kind))].sort()
    .map((kind) => [kind, records.filter((record) => record.kind === kind).length]));
  const payload = {
    version: 1,
    kind: 'LegacyNativeTranslationBundle',
    status: 'legacy_native_translations_verified',
    sourceManifestHash: manifest.manifestHash,
    translationsPath,
    translationsHash: sha256(Buffer.from(ndjson)),
    translationCount: records.length,
    byKind,
    eventClassificationCounts,
    policy: {
      historicalStatusIsNotAuthority: true,
      activeControlPlaneRowsCreated: false,
      explicitNativeImportRequiredForActivation: true,
      generatedControlPlaneEventsRemainArchiveOnly: true,
      unclassifiedEventsRemainArchiveOnly: true,
    },
    createdAt: clock.nowIso(),
  };
  const legacyNativeTranslationBundleHash = hashRecord('LegacyNativeTranslationBundle', payload);
  const ledger = receiptLedger?.record
    ? receiptLedger.record({ ...payload, legacyNativeTranslationBundleHash }, { stream: 'legacy-native-translations', evidenceClass: 'legacy_lineage_reference', environment: 'administrative' })
    : null;
  return Object.freeze({ ...payload, legacyNativeTranslationBundleHash, ledgerReceiptId: ledger?.receiptId || null, records });
}

export function verifyLegacyNativeTranslation({ bundle } = {}) {
  const blockers = [];
  if (!bundle?.translationsPath || !fs.existsSync(bundle.translationsPath)) blockers.push('legacy_native_translation_file_missing');
  else if (sha256(fs.readFileSync(bundle.translationsPath)) !== bundle.translationsHash) blockers.push('legacy_native_translation_hash_mismatch');
  const records = !blockers.length ? readNdjson(bundle.translationsPath) : [];
  if (records.length !== Number(bundle?.translationCount || 0)) blockers.push('legacy_native_translation_count_mismatch');
  for (const record of records) {
    if (!record.sourceRowHash || !record.translationHash) blockers.push('legacy_native_translation_binding_missing');
    else {
      const { translationHash: _translationHash, ...payload } = record;
      if (hashRecord(record.kind, payload) !== record.translationHash) blockers.push('legacy_native_translation_record_hash_mismatch');
    }
    if (record.authorityImported !== false || record.activeControlPlaneRowCreated !== false) blockers.push('legacy_native_translation_authority_boundary_crossed');
  }
  const payload = {
    version: 1,
    kind: 'LegacyNativeTranslationVerification',
    status: blockers.length ? 'legacy_native_translation_invalid' : 'legacy_native_translation_verified',
    translationCount: records.length,
    translationsHash: bundle?.translationsHash || null,
    blockers: [...new Set(blockers)],
  };
  return Object.freeze({ ...payload, verificationHash: hashRecord('LegacyNativeTranslationVerification', payload) });
}

const TABLE_BY_KIND = Object.freeze({
  LegacyNativeReceiptReference: 'legacy_receipt_lineage',
  LegacyArtifactVersionLineage: 'legacy_artifact_version_lineage',
  LegacyCampaignNodeLineage: 'legacy_campaign_node_lineage',
  LegacyCampaignEdgeLineage: 'legacy_campaign_edge_lineage',
  LegacyWorkspaceLineage: 'legacy_workspace_lineage',
  LegacySubmissionPortalLineage: 'legacy_submission_portal_lineage',
});

function sqlText(value) { return `'${String(value ?? '').replace(/'/g, "''")}'`; }

export function persistLegacyNativeTranslations({ store, bundle, receiptLedger = null, clock = { nowIso: () => new Date().toISOString() }, withinTransaction = false } = {}) {
  if (!store?.execute) throw new Error('legacy_native_lineage_store_required');
  const verification = verifyLegacyNativeTranslation({ bundle });
  if (verification.status !== 'legacy_native_translation_verified') throw new Error(`legacy_native_lineage_bundle_invalid:${verification.blockers.join(',')}`);
  const importedAt = clock.nowIso();
  const records = readNdjson(bundle.translationsPath);
  const byTable = {};
  const beforeCounts = {};
  for (const table of new Set(records.map((record) => TABLE_BY_KIND[record.kind]).filter(Boolean))) {
    const result = store.query(`SELECT count(*) AS count FROM ${table};`);
    if (!result.ok) throw new Error(result.error || `legacy_native_lineage_count_failed:${table}`);
    beforeCounts[table] = Number(result.rows?.[0]?.count || 0);
  }
  for (let offset = 0; offset < records.length; offset += 200) {
    const statements = records.slice(offset, offset + 200).map((record) => {
      const table = TABLE_BY_KIND[record.kind];
      if (!table) throw new Error(`legacy_native_lineage_kind_unsupported:${record.kind}`);
      byTable[table] = (byTable[table] || 0) + 1;
      return `INSERT OR IGNORE INTO ${table}(translation_hash,source_table,source_row_hash,paper_id,payload_json,imported_at,authority_imported,active_control_plane_row_created) VALUES(${sqlText(record.translationHash)},${sqlText(record.sourceTable)},${sqlText(record.sourceRowHash)},${record.paperId ? sqlText(record.paperId) : 'NULL'},${sqlText(JSON.stringify(record))},${sqlText(importedAt)},0,0);`;
    });
    const result = store.execute(`${withinTransaction ? '' : 'BEGIN IMMEDIATE;'}${statements.join('')}${withinTransaction ? '' : 'COMMIT;'}`);
    if (!result.ok) throw new Error(result.error || result.stderr || 'legacy_native_lineage_persistence_failed');
  }
  const insertedByTable = {};
  for (const table of Object.keys(byTable)) {
    const result = store.query(`SELECT count(*) AS count FROM ${table};`);
    if (!result.ok) throw new Error(result.error || `legacy_native_lineage_count_failed:${table}`);
    insertedByTable[table] = Math.max(0, Number(result.rows?.[0]?.count || 0) - Number(beforeCounts[table] || 0));
  }
  const insertedCount = Object.values(insertedByTable).reduce((total, count) => total + count, 0);
  const payload = {
    version: 1,
    kind: 'LegacyNativeLineagePersistenceReceipt',
    status: 'legacy_native_lineage_persisted',
    translationBundleHash: bundle.legacyNativeTranslationBundleHash,
    translationsHash: bundle.translationsHash,
    attemptedCount: records.length,
    insertedCount,
    existingCount: records.length - insertedCount,
    rejectedCount: 0,
    byTable,
    insertedByTable,
    authorityImported: false,
    activeControlPlaneRowsCreated: false,
    importedAt,
  };
  const receiptHash = hashRecord('LegacyNativeLineagePersistenceReceipt', payload);
  const ledger = receiptLedger?.record
    ? receiptLedger.record({ ...payload, receiptHash }, { stream: 'legacy-native-lineage', evidenceClass: 'legacy_lineage_reference', environment: 'administrative' })
    : null;
  return Object.freeze({ ...payload, receiptHash, ledgerReceiptId: ledger?.receiptId || null });
}
