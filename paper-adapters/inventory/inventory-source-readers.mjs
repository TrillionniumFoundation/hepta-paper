import path from 'node:path';
import { readTextIfExists } from '../../workflow-kernel/runtime/file-utils.mjs';
import { parseSimpleYamlList, parseSimpleYamlMap } from '../../workflow-kernel/runtime/data-utils.mjs';
import { assertStoreQueryResult } from '../../paper-ports/store-port.mjs';

async function readRegistry(root) {
  const registryDir = path.join(root, 'registry');
  const papersText = await readTextIfExists(path.join(registryDir, 'papers.yaml'));
  const venuesText = await readTextIfExists(path.join(registryDir, 'venues.yaml'));
  const workflowsText = await readTextIfExists(path.join(registryDir, 'workflows.yaml'));
  return {
    papers: parseSimpleYamlList(papersText || '', 'papers'),
    venues: parseSimpleYamlList(venuesText || '', 'venues'),
    workflows: parseSimpleYamlMap(workflowsText || '', 'workflows'),
    refs: {
      papers: papersText ? 'registry/papers.yaml' : null,
      venues: venuesText ? 'registry/venues.yaml' : null,
      workflows: workflowsText ? 'registry/workflows.yaml' : null,
    },
  };
}

function sqliteJson(store, sql) {
  if (typeof store.available === 'function' && !store.available()) return { ok: false, rows: [], error: 'sqlite3_not_found' };
  const result = assertStoreQueryResult(store.query(sql));
  return { ok: result.ok, rows: result.rows, error: result.error };
}

function normalizeSqlitePaper(row = {}, inventorySource = 'hepta_sqlite') {
  return {
    slug: row.slug,
    title: row.title,
    status: row.status,
    venue_target: row.venue_target,
    paper_type: row.paper_type,
    canonical_dir: row.source_dir || row.canonical_dir,
    source_dir: row.source_dir || '',
    current_pdf: row.current_pdf || '',
    current_source_zip: row.current_source_zip || '',
    current_verdict: row.current_verdict,
    next_action: row.next_action,
    updated_at: row.updated_at,
    inventory_source: inventorySource,
    metadata_json: row.metadata_json || '{}',
    ledger_lifecycle_stage: row.ledger_lifecycle_stage || '',
    ledger_submission_state: row.ledger_submission_state || '',
    ledger_next_action: row.ledger_next_action || '',
    ledger_evidence_json: row.ledger_evidence_json || '{}',
  };
}

function readSqliteRegistry({ store = null } = {}) {
  if (!store) {
    return {
      ok: false,
      papers: [],
      venues: [],
      error: 'native_store_not_injected',
      refs: { papers: null, venues: null },
    };
  }
  const papersResult = sqliteJson(store, [
    'select p.slug,p.title,p.status,p.venue_target,p.paper_type,p.canonical_dir,p.source_dir,p.current_pdf,p.current_source_zip,p.current_verdict,p.next_action,p.updated_at,p.metadata_json,',
    'l.lifecycle_stage as ledger_lifecycle_stage,l.submission_state as ledger_submission_state,l.next_action as ledger_next_action,l.evidence_json as ledger_evidence_json',
    'from papers p left join submission_ledger l on p.slug=l.slug order by p.slug',
  ].join(' '));
  const venuesResult = sqliteJson(store, [
    'select venue_id,name,kind,cycle,deadline,metadata_json',
    'from venues order by venue_id',
  ].join(' '));
  if (!papersResult.ok) {
    return {
      ok: false,
      papers: [],
      venues: [],
      error: papersResult.error,
      refs: { papers: null, venues: null },
    };
  }
  return {
    ok: true,
    papers: (papersResult.rows || []).map((row) => normalizeSqlitePaper(row)),
    venues: venuesResult.ok ? (venuesResult.rows || []) : [],
    error: venuesResult.ok ? null : venuesResult.error,
    refs: {
      papers: 'hepta-paper.sqlite:papers',
      venues: venuesResult.ok ? 'hepta-paper.sqlite:venues' : null,
    },
  };
}

export async function readInventorySources(root, source = 'auto', store = null) {
  if (source === 'legacy-sqlite') {
    throw new Error('legacy_inventory_runtime_disabled_use_explicit_compatibility_boundary');
  }
  if (!['auto', 'hepta', 'sqlite', 'yaml'].includes(source)) {
    throw new Error(`inventory_source_unsupported:${source}`);
  }
  const yaml = await readRegistry(root);
  if (source === 'yaml') {
    return {
      ...yaml,
      source: 'yaml',
      refs: { ...yaml.refs, source: 'yaml' },
      fallback: null,
    };
  }
  const sqlite = readSqliteRegistry({ store });
  if (['sqlite', 'hepta'].includes(source)
    || (source === 'auto' && sqlite.ok && sqlite.papers.length)) {
    return {
      papers: sqlite.papers,
      venues: sqlite.venues.length ? sqlite.venues : yaml.venues,
      workflows: yaml.workflows,
      refs: {
        ...yaml.refs,
        papers: sqlite.refs.papers,
        venues: sqlite.refs.venues || yaml.refs.venues,
        workflows: yaml.refs.workflows,
        source: 'hepta_sqlite',
      },
      source: 'hepta_sqlite',
      fallback: sqlite.venues.length ? null : 'venues_yaml_fallback',
    };
  }
  return {
    ...yaml,
    source: 'yaml',
    refs: { ...yaml.refs, source: 'yaml' },
    fallback: sqlite.ok ? 'sqlite_empty_papers' : sqlite.error,
  };
}
