import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function hasSymbol(text, symbol) {
  const escaped = String(symbol).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

function migrationBacklogEntries(entries) {
  return entries
    .filter((entry) => ['P0', 'P1'].includes(entry.priority))
    .filter((entry) => !['quarantine_not_migrate', 'retire_not_migrate'].includes(entry.migrationAction));
}

function validateMatrixEntry({
  root,
  workspaceRoot,
  row,
  sourceEntry,
  behaviorTestCache,
}) {
  const blockers = [];
  const sourcePath = String(row?.source?.path || '');
  const targetPath = String(row?.target?.path || '');
  const sourceFile = path.resolve(root, sourcePath);
  const targetFile = path.resolve(root, targetPath);
  const sourceSymbols = Array.isArray(row?.source?.symbols) ? row.source.symbols.filter(Boolean) : [];
  const targetSymbols = Array.isArray(row?.target?.symbols) ? row.target.symbols.filter(Boolean) : [];
  const behaviorTests = Array.isArray(row?.behaviorTests) ? row.behaviorTests : [];
  const evidenceArtifacts = Array.isArray(row?.evidenceArtifacts) ? row.evidenceArtifacts : [];
  const semanticScopeStatus = String(row?.semanticScope?.status || '');
  if (!row?.id) blockers.push('matrix_id_missing');
  if (!sourceEntry) blockers.push('source_not_in_current_p0_p1_backlog');
  if (!sourcePath || !fs.existsSync(sourceFile)) blockers.push('source_file_missing');
  if (!targetPath || !fs.existsSync(targetFile)) blockers.push('target_file_missing');
  if (!sourceSymbols.length) blockers.push('source_symbols_missing');
  if (!targetSymbols.length) blockers.push('target_symbols_missing');
  if (!behaviorTests.length) blockers.push('behavior_tests_missing');
  if (semanticScopeStatus !== 'complete') blockers.push('semantic_scope_incomplete');
  if (fs.existsSync(sourceFile)) {
    const actualHash = sha256File(sourceFile);
    if (row?.source?.sha256 !== actualHash) blockers.push('source_hash_mismatch');
    const text = fs.readFileSync(sourceFile, 'utf8');
    for (const symbol of sourceSymbols) {
      if (!hasSymbol(text, symbol)) blockers.push(`source_symbol_missing:${symbol}`);
    }
  }
  if (fs.existsSync(targetFile)) {
    const actualHash = sha256File(targetFile);
    if (row?.target?.sha256 !== actualHash) blockers.push('target_hash_mismatch');
    const text = fs.readFileSync(targetFile, 'utf8');
    for (const symbol of targetSymbols) {
      if (!hasSymbol(text, symbol)) blockers.push(`target_symbol_missing:${symbol}`);
    }
  }
  const testResults = behaviorTests.map((test) => {
    const testPath = String(test?.path || '');
    const cacheKey = JSON.stringify([testPath, test?.sha256 || '']);
    const prior = behaviorTestCache.get(cacheKey);
    if (prior) {
      blockers.push(...prior.blockers.map((blocker) => `${test?.id || testPath || 'unknown'}:${blocker}`));
      return {
        id: test?.id || null,
        path: testPath || null,
        ok: prior.blockers.length === 0,
        blockers: [...prior.blockers],
        cachedExecution: true,
      };
    }
    const absoluteTestPath = path.resolve(workspaceRoot, testPath);
    const insideWorkspace = absoluteTestPath === workspaceRoot
      || absoluteTestPath.startsWith(`${workspaceRoot}${path.sep}`);
    const testBlockers = [];
    if (!testPath || !insideWorkspace || !fs.existsSync(absoluteTestPath)) {
      testBlockers.push('behavior_test_file_missing_or_outside_workspace');
    } else {
      if (test.sha256 !== sha256File(absoluteTestPath)) testBlockers.push('behavior_test_hash_mismatch');
      const result = spawnSync(process.execPath, [absoluteTestPath], {
        cwd: workspaceRoot,
        encoding: 'utf8',
        timeout: 120000,
        env: { ...process.env, HEPTA_MIGRATION_MATRIX_TEST: '1' },
      });
      if (result.status !== 0) testBlockers.push('behavior_test_failed');
    }
    behaviorTestCache.set(cacheKey, { blockers: [...testBlockers] });
    blockers.push(...testBlockers.map((blocker) => `${test?.id || testPath || 'unknown'}:${blocker}`));
    return {
      id: test?.id || null,
      path: testPath || null,
      ok: testBlockers.length === 0,
      blockers: testBlockers,
      cachedExecution: false,
    };
  });
  const evidenceArtifactResults = evidenceArtifacts.map((artifact) => {
    const artifactPath = String(artifact?.path || '');
    const absoluteArtifactPath = path.resolve(workspaceRoot, artifactPath);
    const insideWorkspace = absoluteArtifactPath === workspaceRoot
      || absoluteArtifactPath.startsWith(`${workspaceRoot}${path.sep}`);
    const artifactBlockers = [];
    if (!artifactPath || !insideWorkspace || !fs.existsSync(absoluteArtifactPath)) {
      artifactBlockers.push('evidence_artifact_missing_or_outside_workspace');
    } else if (artifact.sha256 !== sha256File(absoluteArtifactPath)) {
      artifactBlockers.push('evidence_artifact_hash_mismatch');
    }
    blockers.push(...artifactBlockers.map((blocker) => `${artifact?.id || artifactPath || 'unknown'}:${blocker}`));
    return {
      id: artifact?.id || null,
      path: artifactPath || null,
      ok: artifactBlockers.length === 0,
      blockers: artifactBlockers,
    };
  });
  return {
    id: row?.id || null,
    sourcePath,
    targetPath,
    sourceSymbols,
    targetSymbols,
    semanticScopeStatus: semanticScopeStatus || null,
    behaviorTests: testResults,
    evidenceArtifacts: evidenceArtifactResults,
    status: blockers.length ? 'blocked_migration_matrix_entry' : 'verified_migration_matrix_entry',
    verified: blockers.length === 0,
    blockers,
    matrixEntry: row,
  };
}

export function buildMigrationMatrixAudit({ root, entries, matrixOverride = null }) {
  const workspaceRoot = path.join(root, 'hepta-paper-workspace');
  const matrixPath = path.join(workspaceRoot, 'migration', 'legacy-semantic-migration-matrix.json');
  const backlog = migrationBacklogEntries(entries);
  let matrix = null;
  const globalBlockers = [];
  if (matrixOverride) {
    matrix = matrixOverride;
  } else {
    try {
      matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
    } catch (error) {
      globalBlockers.push(`migration_matrix_unreadable:${error.code || error.name}`);
      matrix = { version: 1, entries: [] };
    }
  }
  const matrixEntries = Array.isArray(matrix.entries) ? matrix.entries : [];
  if (!Array.isArray(matrix.entries)) globalBlockers.push('migration_matrix_entries_not_array');
  const backlogByPath = new Map(backlog.map((entry) => [entry.path, entry]));
  const seenSources = new Set();
  const duplicateSources = [];
  for (const row of matrixEntries) {
    const sourcePath = String(row?.source?.path || '');
    if (sourcePath && seenSources.has(sourcePath)) duplicateSources.push(sourcePath);
    seenSources.add(sourcePath);
  }
  if (duplicateSources.length) globalBlockers.push('migration_matrix_duplicate_source_paths');
  const behaviorTestCache = new Map();
  const rows = matrixEntries.map((row) => validateMatrixEntry({
    root,
    workspaceRoot,
    row,
    sourceEntry: backlogByPath.get(String(row?.source?.path || '')),
    behaviorTestCache,
  }));
  const verifiedSourcePaths = new Set(rows.filter((row) => row.verified).map((row) => row.sourcePath));
  const missingEntries = backlog.filter((entry) => !verifiedSourcePaths.has(entry.path));
  const invalidEntries = rows.filter((row) => !row.verified);
  const partialEntries = rows.filter((row) => row.semanticScopeStatus !== 'complete');
  const orphanEntries = rows.filter((row) => !backlogByPath.has(row.sourcePath));
  const blockers = [
    ...globalBlockers,
    ...(missingEntries.length ? ['p0_p1_migration_matrix_coverage_incomplete'] : []),
    ...(invalidEntries.length ? ['migration_matrix_entries_invalid'] : []),
    ...(orphanEntries.length ? ['migration_matrix_orphan_entries_present'] : []),
  ];
  return {
    version: 1,
    kind: 'LegacySemanticMigrationMatrixAudit',
    status: blockers.length ? 'blocked_legacy_semantic_migration_matrix' : 'pass_legacy_semantic_migration_matrix',
    ok: blockers.length === 0,
    matrixPath,
    matrixVersion: matrix.version || null,
    backlogCount: backlog.length,
    matrixEntryCount: matrixEntries.length,
    uniqueBehaviorTestExecutionCount: behaviorTestCache.size,
    verifiedEntryCount: rows.filter((row) => row.verified).length,
    invalidEntryCount: invalidEntries.length,
    partialEntryCount: partialEntries.length,
    orphanEntryCount: orphanEntries.length,
    missingEntryCount: missingEntries.length,
    missingByPriority: {
      P0: missingEntries.filter((entry) => entry.priority === 'P0').length,
      P1: missingEntries.filter((entry) => entry.priority === 'P1').length,
    },
    verifiedSourcePaths: [...verifiedSourcePaths].sort(),
    missingEntries: missingEntries.slice(0, 128).map((entry) => ({
      path: entry.path,
      priority: entry.priority,
      targetAdapter: entry.targetAdapter,
      migrationAction: entry.migrationAction,
    })),
    rows,
    blockers,
  };
}
