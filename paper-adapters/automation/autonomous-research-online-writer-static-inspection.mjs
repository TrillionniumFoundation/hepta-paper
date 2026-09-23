import fs from 'node:fs';
import path from 'node:path';

import {
  assertAutonomousResearchOnlineWriterOperationManifest,
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  fileSha256HashSync,
  openPinnedRegularFileSync,
  readRegularJsonFileSync,
  samePinnedFileIdentity,
} from '../runtime/pinned-file-reader.mjs';
import {
  MUTATION_SQL,
  PROVENANCE_ONLY_SOURCES,
  SCAN_ROOTS,
  SQL_MIGRATION_ROOT,
} from './autonomous-research-online-writer-static-config.mjs';
import {
  discoverAutonomousResearchOnlineWriterMutationEntrypoints,
} from './autonomous-research-online-writer-static-discovery.mjs';

export { discoverAutonomousResearchOnlineWriterMutationEntrypoints };

function toPosix(candidate) {
  return candidate.split(path.sep).join('/');
}

function walkModules(root) {
  if (!fs.existsSync(root)) return [];
  const modules = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && entry.name.endsWith('.mjs')) modules.push(candidate);
    }
  };
  visit(root);
  return modules.sort();
}

function readPinnedText(candidate) {
  const pinned = openPinnedRegularFileSync(candidate, {
    errorCode: 'autonomous_research_online_writer_source_not_regular',
  });
  try {
    const source = fs.readFileSync(pinned.descriptor, 'utf8');
    const after = fs.fstatSync(pinned.descriptor, { bigint: true });
    if (!samePinnedFileIdentity(pinned.opened, after)
      || !samePinnedFileIdentity(after, fs.lstatSync(candidate, { bigint: true }))) {
      throw new Error('autonomous_research_online_writer_source_changed_during_scan');
    }
    return source;
  } finally { fs.closeSync(pinned.descriptor); }
}

export function loadAutonomousResearchOnlineWriterOperationManifest({
  manifestPath,
} = {}) {
  return assertAutonomousResearchOnlineWriterOperationManifest(
    readRegularJsonFileSync(manifestPath),
  );
}

export function inspectAutonomousResearchOnlineWriterStaticCoverage({
  workspaceRoot,
  manifest,
} = {}) {
  const checkedManifest = assertAutonomousResearchOnlineWriterOperationManifest(manifest);
  const resolvedRoot = path.resolve(String(workspaceRoot || ''));
  const manifestHash = autonomousResearchOnlineWriterOperationManifestHash(checkedManifest);
  const declared = new Set(checkedManifest.operations.map(
    (operation) => `${operation.sourceFile}\0${operation.entrypoint}`,
  ));
  const discovered = [];
  const coordinatorBindings = [];
  const callbackBoundaryViolations = [];
  const excludedCandidates = [];
  const scanBlockers = [];
  const allFunctionsByFile = new Map();
  const sourceHashes = new Map();
  for (const scanRoot of SCAN_ROOTS) {
    for (const absolute of walkModules(path.join(resolvedRoot, scanRoot))) {
      const relative = toPosix(path.relative(resolvedRoot, absolute));
      const source = readPinnedText(absolute);
      const inspection = discoverAutonomousResearchOnlineWriterMutationEntrypoints(
        relative,
        source,
      );
      if (inspection.exclusionReason) excludedCandidates.push(Object.freeze({
        sourceFile: relative,
        reason: inspection.exclusionReason,
      }));
      excludedCandidates.push(...(inspection.excludedEntrypoints || []));
      allFunctionsByFile.set(relative, new Set(inspection.allFunctions));
      if (inspection.entrypoints.length
        || inspection.exclusionReason
        || inspection.excludedEntrypoints?.length) {
        sourceHashes.set(relative, fileSha256HashSync(absolute));
      }
      for (const entrypoint of inspection.entrypoints) {
        discovered.push(Object.freeze({ sourceFile: relative, entrypoint }));
      }
      for (const binding of inspection.coordinatorBindings) {
        coordinatorBindings.push(Object.freeze({ sourceFile: relative, ...binding }));
      }
      for (const violation of inspection.callbackBoundaryViolations) {
        callbackBoundaryViolations.push(Object.freeze({ sourceFile: relative, ...violation }));
      }
    }
  }
  for (const relative of [...PROVENANCE_ONLY_SOURCES].sort()) {
    const absolute = path.join(resolvedRoot, relative);
    if (!fs.existsSync(absolute)) {
      scanBlockers.push(
        `autonomous_research_online_writer_provenance_source_missing:${relative}`,
      );
    } else {
      sourceHashes.set(relative, fileSha256HashSync(absolute));
    }
  }
  for (const absolute of fs.existsSync(path.join(resolvedRoot, SQL_MIGRATION_ROOT))
    ? fs.readdirSync(path.join(resolvedRoot, SQL_MIGRATION_ROOT))
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => path.join(resolvedRoot, SQL_MIGRATION_ROOT, name))
    : []) {
    const relative = toPosix(path.relative(resolvedRoot, absolute));
    if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(path.basename(absolute))) {
      scanBlockers.push(
        `autonomous_research_online_writer_migration_filename_invalid:${relative}`,
      );
      continue;
    }
    const source = readPinnedText(absolute);
    const entrypoint = `migration${path.basename(absolute, '.sql')}`;
    allFunctionsByFile.set(relative, new Set([entrypoint]));
    sourceHashes.set(relative, fileSha256HashSync(absolute));
    if (MUTATION_SQL.test(source)) {
      discovered.push(Object.freeze({ sourceFile: relative, entrypoint }));
    }
  }
  const blockers = [...scanBlockers];
  for (const violation of callbackBoundaryViolations) {
    blockers.push([
      'autonomous_research_online_writer_mutate_callback_capability_bypass',
      violation.sourceFile,
      violation.entrypoint,
      violation.operationId || 'unknown-operation',
      violation.capabilityBinding,
      violation.method,
      `${violation.line}:${violation.column}`,
    ].join(':'));
  }
  const operationsById = new Map(checkedManifest.operations.map((operation) => [
    operation.operationId,
    operation,
  ]));
  for (const operation of checkedManifest.operations) {
    const absolute = path.join(resolvedRoot, operation.sourceFile);
    if (!fs.existsSync(absolute)) {
      blockers.push(`autonomous_research_online_writer_source_missing:${operation.sourceFile}`);
      continue;
    }
    if (!sourceHashes.has(operation.sourceFile)) {
      sourceHashes.set(operation.sourceFile, fileSha256HashSync(absolute));
    }
    if (!allFunctionsByFile.get(operation.sourceFile)?.has(operation.entrypoint)) {
      blockers.push(
        `autonomous_research_online_writer_entrypoint_missing:${operation.sourceFile}:${operation.entrypoint}`,
      );
    }
  }
  for (const row of discovered) {
    if (!declared.has(`${row.sourceFile}\0${row.entrypoint}`)) {
      blockers.push(
        `autonomous_research_online_writer_mutation_unregistered:${row.sourceFile}:${row.entrypoint}`,
      );
    }
  }
  for (const binding of coordinatorBindings) {
    const operation = operationsById.get(binding.operationId);
    if (!operation
      || binding.databaseRole !== operation.databaseRole
      || binding.sourceFile !== operation.sourceFile
      || binding.entrypoint !== operation.entrypoint
      || operation.coordinatorIntegrated !== true) {
      blockers.push(
        `autonomous_research_online_writer_coordinator_binding_invalid:${binding.sourceFile}:${binding.entrypoint}`,
      );
    }
  }
  for (const operation of checkedManifest.operations.filter(
    (candidate) => candidate.coordinatorIntegrated,
  )) {
    const matches = coordinatorBindings.filter((binding) => (
      binding.sourceFile === operation.sourceFile
      && binding.entrypoint === operation.entrypoint
      && binding.databaseRole === operation.databaseRole
      && binding.operationId === operation.operationId
    ));
    if (matches.length !== 1) {
      blockers.push(
        `autonomous_research_online_writer_coordinator_binding_required:${operation.operationId}`,
      );
    }
  }
  const discoveredSet = new Set(discovered.map(
    (row) => `${row.sourceFile}\0${row.entrypoint}`,
  ));
  for (const operation of checkedManifest.operations) {
    if (!discoveredSet.has(`${operation.sourceFile}\0${operation.entrypoint}`)) {
      blockers.push(
        `autonomous_research_online_writer_declared_operation_not_discovered:${operation.operationId}`,
      );
    }
  }
  const sourceProvenance = [...sourceHashes]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceFile, sourceHash]) => Object.freeze({ sourceFile, sourceHash }));
  const coveredDatabaseRoles = Object.freeze(
    [...new Set(checkedManifest.writers.flatMap((writer) => writer.databaseRoles))].sort(),
  );
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineWriterStaticCoverageInspection',
    status: blockers.length === 0
      ? 'autonomous_research_online_writer_static_coverage_complete'
      : 'autonomous_research_online_writer_static_coverage_blocked',
    inspectionSource: 'repository-ast-import-gate-v1',
    manifestHash,
    coveredDatabaseRoles,
    operationCount: checkedManifest.operations.length,
    operationIds: Object.freeze(checkedManifest.operations
      .map((operation) => operation.operationId)
      .sort()),
    discoveredMutationEntrypoints: Object.freeze(discovered.sort((left, right) => (
      left.sourceFile.localeCompare(right.sourceFile)
        || left.entrypoint.localeCompare(right.entrypoint)
    ))),
    coordinatorBindings: Object.freeze(coordinatorBindings.sort((left, right) => (
      left.sourceFile.localeCompare(right.sourceFile)
        || left.entrypoint.localeCompare(right.entrypoint)
        || String(left.operationId).localeCompare(String(right.operationId))
    ))),
    callbackBoundaryViolations: Object.freeze(callbackBoundaryViolations.sort((left, right) => (
      left.sourceFile.localeCompare(right.sourceFile)
        || left.entrypoint.localeCompare(right.entrypoint)
        || left.line - right.line
        || left.column - right.column
    ))),
    codeProvenanceHash: hashRecord(
      'AutonomousResearchOnlineWriterCodeProvenance', sourceProvenance,
    ),
    codeProvenanceSources: Object.freeze(sourceProvenance),
    excludedCandidates: Object.freeze(excludedCandidates.sort((left, right) => (
      left.sourceFile.localeCompare(right.sourceFile)
    ))),
    blockers: Object.freeze([...new Set(blockers)].sort()),
  });
  return Object.freeze({
    ...payload,
    astGateReceiptHash: hashRecord(
      'AutonomousResearchOnlineWriterStaticCoverageInspection', payload,
    ),
  });
}
