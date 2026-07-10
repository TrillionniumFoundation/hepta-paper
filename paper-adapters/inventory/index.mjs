import path from 'node:path';
import {
  dirExists,
  fileExists,
  fileRecord,
  listDirSafe,
  pathStat,
  readJsonIfExists,
  readTextIfExists,
  relativePath,
  walkFiles,
} from '../../paper-core/src/runtime/file-utils.mjs';
import { normalizeText, uniqueStrings } from '../../paper-core/src/runtime/text-utils.mjs';
import { sortByMtimeDesc } from '../../paper-core/src/runtime/time-utils.mjs';
import {
  parseSimpleYamlList,
  parseSimpleYamlMap,
  safeJsonParse,
} from '../../paper-core/src/runtime/data-utils.mjs';
import {
  PAPER_ACTIONS,
  createPaperTask,
  createPaperWorkflowState,
  autoLevelForState,
  inferPaperStage,
  nextActionForState,
} from '../../paper-core/src/paper-contracts.mjs';

const TEX_IGNORE_RE = /(\.bak|\.backup|\.orig|\.old|\.tmp|\.synctex|supplementary|appendix-only)/i;
const QUARANTINE_SLUG_RE = /(^rust_patch_queue_shadow|_fixture_|fixture_|test_fixture|shadow_review_|review_flow_(applied|rolled)_back_patch_queue)/i;
const QUARANTINE_PATH_RE = /(logs\/paperctl\/_batches\/rust|logs\/paperctl\/.*fixture|tests\/fixtures|\/tmp\/|runtime\/)/i;

function repoPath(root, value) {
  const text = normalizeText(value);
  if (!text) return null;
  return path.isAbsolute(text) ? text : path.join(root, text);
}

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
  const result = store.query(sql);
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

function readSqliteRegistry(root, { legacy = false, store = null } = {}) {
  if (legacy || !store) {
    return {
      ok: false,
      papers: [],
      venues: [],
      error: legacy ? 'legacy_inventory_runtime_disabled' : 'native_store_not_injected',
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
    papers: (papersResult.rows || []).map((row) => normalizeSqlitePaper(
      row,
      legacy ? 'legacy_sqlite' : 'hepta_sqlite',
    )),
    venues: venuesResult.ok ? (venuesResult.rows || []) : [],
    error: venuesResult.ok ? null : venuesResult.error,
    refs: {
      papers: `${legacy ? 'legacy:' : ''}hepta-paper.sqlite:papers`,
      venues: venuesResult.ok ? `${legacy ? 'legacy:' : ''}hepta-paper.sqlite:venues` : null,
    },
  };
}

async function readInventorySources(root, source = 'auto', store = null) {
  const yaml = await readRegistry(root);
  if (source === 'yaml') {
    return {
      ...yaml,
      source: 'yaml',
      refs: { ...yaml.refs, source: 'yaml' },
      fallback: null,
    };
  }
  const legacyRequested = source === 'legacy-sqlite';
  const sqlite = readSqliteRegistry(root, { legacy: legacyRequested, store });
  if (['sqlite', 'hepta', 'legacy-sqlite'].includes(source)
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
        source: legacyRequested ? 'legacy_sqlite' : 'hepta_sqlite',
      },
      source: legacyRequested ? 'legacy_sqlite' : 'hepta_sqlite',
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

function quarantineReason(paper = {}) {
  const slug = normalizeText(paper.slug);
  const inventorySource = normalizeText(paper.inventory_source);
  const fields = [
    paper.canonical_dir,
    paper.source_dir,
    paper.current_pdf,
    paper.current_source_zip,
  ].map((value) => normalizeText(value).replace(/\\/g, '/'));
  if (QUARANTINE_SLUG_RE.test(slug)) return 'fixture_or_shadow_slug';
  if (inventorySource === 'proposal_staging') return null;
  if (fields.some((value) => QUARANTINE_PATH_RE.test(value))) return 'fixture_or_shadow_path';
  return null;
}

async function candidateSourceDirs(root, paper) {
  const slug = normalizeText(paper.slug);
  const candidates = [
    repoPath(root, paper.source_dir),
    repoPath(root, paper.canonical_dir),
    path.join(root, 'drafts', slug),
    path.join(root, 'workspaces', slug),
    path.join(root, 'accepted', slug),
    path.join(root, 'submission', slug),
    path.join(root, 'logs', 'paperctl', slug),
  ].filter(Boolean);
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (await dirExists(resolved)) unique.push(resolved);
  }
  return unique;
}

function scoreTexFile(candidate) {
  const base = path.basename(candidate).toLowerCase();
  if (base === 'main.tex') return 1000;
  if (base === 'manuscript.tex') return 900;
  if (base.includes('sample') && base.endsWith('.tex')) return 700;
  if (base.endsWith('.tex') && !TEX_IGNORE_RE.test(base)) return 500;
  return 0;
}

async function findMainTex(sourceDir) {
  if (!sourceDir) return null;
  const files = await walkFiles(sourceDir, {
    maxDepth: 4,
    maxFiles: 5000,
    match: (_full, name) => name.toLowerCase().endsWith('.tex') && !TEX_IGNORE_RE.test(name),
  });
  const ranked = files
    .map((file) => ({ file, score: scoreTexFile(file) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.file.length - right.file.length);
  return ranked[0]?.file || null;
}

async function discoverArtifacts(root, sourceDir) {
  if (!sourceDir) return { pdfs: [], zips: [], evidence: [] };
  const files = await walkFiles(sourceDir, {
    maxDepth: 3,
    maxFiles: 5000,
    match: (_full, name) => /\.(pdf|zip|md|json|jsonl|csv)$/i.test(name),
  });
  const pdfs = [];
  const zips = [];
  const evidence = [];
  for (const file of files) {
    const lower = path.basename(file).toLowerCase();
    if (lower.endsWith('.pdf')) {
      const record = await fileRecord(root, file, 'compiled_pdf');
      if (record) pdfs.push(record);
    } else if (lower.endsWith('.zip')) {
      const role = /source|workspace|submission|package|arxiv|camera|resubmission/i.test(lower)
        ? 'source_or_submission_zip'
        : 'zip_candidate';
      const record = await fileRecord(root, file, role);
      if (record) zips.push(record);
    } else if (
      /proof|evidence|referee|review|verdict|manifest|production_plan|semantic|readiness|status/i.test(lower)
    ) {
      const record = await fileRecord(root, file, 'research_evidence');
      if (record) evidence.push(record);
    }
  }
  return {
    pdfs: sortByMtimeDesc(pdfs),
    zips: sortByMtimeDesc(zips),
    evidence: sortByMtimeDesc(evidence),
  };
}

async function directArtifactRecords(root, paper) {
  const out = { pdfs: [], zips: [] };
  for (const [field, role, bucket] of [
    ['current_pdf', 'compiled_pdf', 'pdfs'],
    ['current_source_zip', 'source_or_submission_zip', 'zips'],
  ]) {
    const value = normalizeText(paper[field]);
    if (!value) continue;
    const candidates = [
      repoPath(root, value),
      repoPath(root, paper.canonical_dir ? path.join(paper.canonical_dir, value) : ''),
      repoPath(root, paper.source_dir ? path.join(paper.source_dir, value) : ''),
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (!(await fileExists(candidate))) continue;
      const record = await fileRecord(root, candidate, role);
      if (record) out[bucket].push(record);
      break;
    }
  }
  return out;
}

function paperMetadata(paper = {}) {
  const metadata = safeJsonParse(paper.metadata_json || '{}', {});
  const ledgerEvidence = safeJsonParse(paper.ledger_evidence_json || '{}', {});
  return {
    metadata,
    paperFactory: metadata.paper_factory || {},
    ledgerEvidence,
  };
}

function buildSubmissionIntent(paper, { sourceDir = null, mainTex = null } = {}) {
  const { paperFactory, ledgerEvidence } = paperMetadata(paper);
  const slug = normalizeText(paper.slug);
  const text = [
    slug,
    paper.title,
    paper.status,
    paper.canonical_dir,
    paper.source_dir,
    paper.ledger_lifecycle_stage,
    paper.ledger_submission_state,
  ].map((value) => normalizeText(value).toLowerCase()).join(' ');
  const venueTarget = normalizeText(paper.venue_target);
  const derivedLifecycle = normalizeText(paperFactory.derived_lifecycle || ledgerEvidence.derived_lifecycle);
  const sourceReady = paperFactory.derived_source_ready ?? ledgerEvidence.source_ready ?? null;
  if (venueTarget) {
    return {
      status: 'submission_candidate',
      disposition: 'active_submission',
      reason: 'venue_target_present',
      venueTarget,
    };
  }
  if (/(^|[_/ -])archive($|[_/ -])|dropbox_archive/.test(text)) {
    return {
      status: 'non_submission_archive',
      disposition: 'non_submission',
      reason: 'archive_named_asset_without_venue',
      venueTarget: null,
    };
  }
  if (derivedLifecycle === 'source_not_ready' || sourceReady === false || !sourceDir || !mainTex) {
    return {
      status: 'source_adapt_required',
      disposition: 'manual_source_decision',
      reason: !mainTex ? 'main_tex_missing' : 'source_not_ready',
      venueTarget: null,
    };
  }
  return {
    status: 'needs_venue_decision',
    disposition: 'manual_venue_decision',
    reason: 'venue_target_missing',
    venueTarget: null,
  };
}

async function discoverPaper(root, paper) {
  const slug = normalizeText(paper.slug);
  const sourceDirs = await candidateSourceDirs(root, paper);
  const sourceDir = sourceDirs[0] || null;
  const mainTex = await findMainTex(sourceDir);
  const artifacts = await discoverArtifacts(root, sourceDir);
  const directArtifacts = await directArtifactRecords(root, paper);
  artifacts.pdfs = sortByMtimeDesc([...directArtifacts.pdfs, ...artifacts.pdfs]);
  artifacts.zips = sortByMtimeDesc([...directArtifacts.zips, ...artifacts.zips]);
  const mainTexRecord = mainTex ? await fileRecord(root, mainTex, 'main_tex') : null;
  const sourceStat = sourceDir ? await pathStat(sourceDir) : null;
  const submissionIntent = buildSubmissionIntent(paper, { sourceDir, mainTex });
  const evidenceRefs = [
    mainTexRecord,
    ...artifacts.evidence.slice(0, 16),
    ...artifacts.pdfs.slice(0, 4),
    ...artifacts.zips.slice(0, 4),
  ].filter(Boolean);
  const task = createPaperTask({
    paperId: slug,
    title: paper.title,
    status: paper.status,
    venueTarget: paper.venue_target,
    paperType: paper.paper_type,
    canonicalDir: paper.canonical_dir,
    sourceWorkspace: sourceDir ? relativePath(root, sourceDir) : null,
    mainTex: mainTex ? relativePath(root, mainTex) : null,
    registry: {
      inventorySource: normalizeText(paper.inventory_source) || null,
      status: normalizeText(paper.status) || null,
      currentVerdict: normalizeText(paper.current_verdict) || null,
      nextAction: normalizeText(paper.next_action) || null,
      updatedAt: normalizeText(paper.updated_at) || null,
      submissionIntent,
      ledger: {
        lifecycleStage: normalizeText(paper.ledger_lifecycle_stage) || null,
        submissionState: normalizeText(paper.ledger_submission_state) || null,
        nextAction: normalizeText(paper.ledger_next_action) || null,
      },
    },
    source: {
      exists: Boolean(sourceStat?.isDirectory()),
      candidateDirs: sourceDirs.map((candidate) => relativePath(root, candidate)),
      pdfCount: artifacts.pdfs.length,
      zipCount: artifacts.zips.length,
      evidenceCount: artifacts.evidence.length,
      sourceDir: normalizeText(paper.source_dir) || null,
      currentPdf: normalizeText(paper.current_pdf) || null,
      currentSourceZip: normalizeText(paper.current_source_zip) || null,
    },
    evidenceRefs,
  });
  const draftStatus = !sourceDir ? 'missing_source' : mainTex ? 'source_tex_present' : 'source_present';
  const compileStatus = artifacts.pdfs.length ? 'compiled_pdf_present' : mainTex ? 'build_ready' : 'missing_main_tex';
  const proposalSeedEvidencePresent = artifacts.evidence.some((artifact) => (
    /proposal.*seed.*contract|claim.*proof.*evidence.*repro.*seed/i.test(`${artifact.filename} ${artifact.path}`)
  ));
  const researchVerifyStatus = proposalSeedEvidencePresent
    ? 'proposal_seed_present'
    : artifacts.evidence.length
      ? 'evidence_present'
      : normalizeText(paper.current_verdict) ? 'manual_review_only' : 'missing_evidence';
  const packageStatus = artifacts.zips.length ? 'package_present' : artifacts.pdfs.length && mainTex ? 'package_ready' : 'package_missing';
  const blockers = [];
  const warnings = [];
  if (!sourceDir) blockers.push('source_workspace_missing');
  if (sourceDir && !mainTex) blockers.push('main_tex_missing');
  if (!paper.venue_target) warnings.push('venue_target_missing');
  if (submissionIntent.status !== 'submission_candidate') warnings.push(`submission_intent_${submissionIntent.status}`);
  if (!artifacts.evidence.length) warnings.push('research_evidence_scan_empty');
  const readinessStatus = blockers.length
    ? 'blocked'
    : (['compiled_pdf_present', 'build_ready'].includes(compileStatus) && ['package_present', 'package_ready'].includes(packageStatus))
      ? 'ready_for_local_dry_run'
      : 'needs_local_package';
  let state = createPaperWorkflowState({
    paperTask: task,
    draftStatus,
    compileStatus,
    researchVerifyStatus,
    packageStatus,
    readinessStatus,
    blockers,
    warnings,
    evidenceRefs,
  });
  state = {
    ...state,
    nextAction: normalizeText(paper.next_action) || nextActionForState(state),
    autoLevel: autoLevelForState(state),
  };
  state = {
    ...state,
    stage: inferPaperStage(state),
  };
  return {
    paper: paper,
    task,
    state,
    artifacts,
    sourceDir,
    mainTex,
    submissionIntent,
  };
}

async function discoverLooseDrafts(root, knownSlugs) {
  const draftDir = path.join(root, 'drafts');
  const entries = await listDirSafe(draftDir);
  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || knownSlugs.has(entry.name)) continue;
    const dir = path.join(draftDir, entry.name);
    const mainTex = await findMainTex(dir);
    if (!mainTex) continue;
    rows.push({
      slug: entry.name,
      title: entry.name.replace(/_/g, ' '),
      status: 'draft',
      venue_target: '',
      paper_type: '',
      canonical_dir: relativePath(root, dir),
      current_verdict: '',
      next_action: '',
      updated_at: '',
    });
  }
  return rows;
}

function proposalStagingPaperRow(root, record, recordPath) {
  if (record?.kind !== 'PaperProposalStagingRecord') return null;
  if (record.status !== 'proposal_staged_for_inventory') return null;
  const slug = normalizeText(record.paperId);
  if (!slug) return null;
  return {
    slug,
    title: normalizeText(record.title) || slug.replace(/_/g, ' '),
    status: 'proposal_staged',
    venue_target: normalizeText(record.venueTarget),
    paper_type: normalizeText(record.paperType) || 'proposal_generated',
    canonical_dir: normalizeText(record.sourceWorkspace),
    source_dir: normalizeText(record.sourceWorkspace),
    current_pdf: '',
    current_source_zip: '',
    current_verdict: '',
    next_action: PAPER_ACTIONS.LATEX_BUILD,
    updated_at: normalizeText(record.createdAt),
    inventory_source: 'proposal_staging',
    metadata_json: JSON.stringify({
      proposal_staging: {
        recordPath: relativePath(root, recordPath),
        stagingRecordHash: record.paperProposalStagingRecordHash || null,
        proposalEnvelopeHash: record.proposalEnvelopeHash || null,
        productionPlanEnvelopeHash: record.productionPlanEnvelopeHash || null,
        manuscriptSourceContractHash: record.manuscriptSourceContractHash || null,
        paperTaskCreationEnvelopeHash: record.paperTaskCreationEnvelopeHash || null,
        paperTaskHash: record.paperTaskHash || null,
        safety: record.safety || {},
      },
    }),
    ledger_lifecycle_stage: 'proposal_staging',
    ledger_submission_state: '',
    ledger_next_action: PAPER_ACTIONS.LATEX_BUILD,
    ledger_evidence_json: '{}',
  };
}

async function discoverProposalStaging(root, knownSlugs, proposalStagingRoot = null) {
  const stagingRoot = proposalStagingRoot || path.join(root, 'hepta-paper-workspace', 'runtime', 'proposal-staging');
  const entries = (await listDirSafe(stagingRoot))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name));
  const rows = [];
  for (const entry of entries) {
    const recordPath = path.join(stagingRoot, entry.name);
    const record = await readJsonIfExists(recordPath);
    const row = proposalStagingPaperRow(root, record, recordPath);
    if (!row) continue;
    if (knownSlugs.has(normalizeText(row.slug))) continue;
    knownSlugs.add(normalizeText(row.slug));
    rows.push(row);
  }
  return {
    root: stagingRoot,
    rows,
  };
}

function venueMatchesTarget(venues, target) {
  const normalized = normalizeText(target).toLowerCase();
  if (!normalized) return null;
  return venues.find((venue) => normalizeText(venue.name).toLowerCase() === normalized)
    || venues.find((venue) => normalized.includes(normalizeText(venue.name).toLowerCase()))
    || null;
}

export async function discoverInventory({
  root,
  store = null,
  includeLooseDrafts = true,
  includeRetired = false,
  includeQuarantined = false,
  inventorySource = 'auto',
  includeProposalStaging = true,
  proposalStagingRoot = null,
  paperIds = [],
  limit = null,
} = {}) {
  if (!root) throw new Error('discoverInventory requires root');
  const registry = await readInventorySources(root, inventorySource, store);
  const requested = new Set((paperIds || []).map(normalizeText).filter(Boolean));
  const knownSlugs = new Set(registry.papers.map((paper) => normalizeText(paper.slug)).filter(Boolean));
  const loose = includeLooseDrafts ? await discoverLooseDrafts(root, knownSlugs) : [];
  for (const paper of loose) {
    const slug = normalizeText(paper.slug);
    if (slug) knownSlugs.add(slug);
  }
  const proposalStaging = includeProposalStaging
    ? await discoverProposalStaging(root, knownSlugs, proposalStagingRoot)
    : { root: proposalStagingRoot || path.join(root, 'hepta-paper-workspace', 'runtime', 'proposal-staging'), rows: [] };
  let papers = [
    ...registry.papers,
    ...loose.map((paper) => ({ ...paper, inventory_source: 'loose_draft' })),
    ...proposalStaging.rows,
  ];
  if (!includeRetired) papers = papers.filter((paper) => normalizeText(paper.status) !== 'retired_stale');
  const quarantine = papers
    .map((paper) => ({ paper, reason: quarantineReason(paper) }))
    .filter((item) => item.reason);
  if (!includeQuarantined) {
    const quarantinedSlugs = new Set(quarantine.map((item) => normalizeText(item.paper.slug)));
    papers = papers.filter((paper) => !quarantinedSlugs.has(normalizeText(paper.slug)));
  }
  if (requested.size) papers = papers.filter((paper) => requested.has(normalizeText(paper.slug)));
  if (Number.isFinite(Number(limit)) && Number(limit) > 0) papers = papers.slice(0, Number(limit));
  const rows = [];
  for (const paper of papers) {
    const row = await discoverPaper(root, paper);
    row.venue = venueMatchesTarget(registry.venues, row.task.venueTarget);
    rows.push(row);
  }
  return {
    version: 1,
    kind: 'PaperInventoryScan',
    root,
    registryRefs: {
      ...registry.refs,
      proposalStaging: proposalStaging.rows.length ? `${relativePath(root, proposalStaging.root)}/*.json` : null,
    },
    inventorySource: registry.source,
    inventoryFallback: registry.fallback,
    quarantined: quarantine.map((item) => ({
      slug: normalizeText(item.paper.slug),
      reason: item.reason,
      canonicalDir: normalizeText(item.paper.canonical_dir || item.paper.source_dir),
    })),
    venues: registry.venues,
    workflows: registry.workflows,
    rows,
    summary: {
      total: rows.length,
      sourceReady: rows.filter((row) => row.state.draftStatus === 'source_tex_present').length,
      packageReady: rows.filter((row) => ['package_present', 'package_ready'].includes(row.state.packageStatus)).length,
      dryRunReady: rows.filter((row) => row.state.readinessStatus === 'ready_for_local_dry_run').length,
      blocked: rows.filter((row) => row.state.blockers.length).length,
      proposalStaged: rows.filter((row) => row.task.registry?.inventorySource === 'proposal_staging').length,
      quarantined: includeQuarantined ? 0 : quarantine.length,
      venues: uniqueStrings(rows.map((row) => row.task.venueTarget).filter(Boolean), 32),
    },
  };
}
