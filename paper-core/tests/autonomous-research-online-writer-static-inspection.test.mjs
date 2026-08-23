import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'espree';

import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import {
  discoverAutonomousResearchOnlineWriterMutationEntrypoints,
  inspectAutonomousResearchOnlineWriterStaticCoverage,
} from '../../paper-adapters/automation/autonomous-research-online-writer-static-inspection.mjs';
import {
  AUTHORITY_PRINCIPAL_WRITER_ENTRYPOINTS,
  PRIVATE_COPY_SIMULATION_WRITER_ENTRYPOINTS,
  QUIESCED_MAINTENANCE_WRITER_ENTRYPOINTS,
  STAGED_PROVISIONING_WRITER_ENTRYPOINTS,
} from '../../paper-adapters/automation/autonomous-research-online-writer-static-config.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { relativeModuleSpecifiers } from '../verification/javascript-module-specifiers.mjs';

const workspaceRoot = process.cwd();

function productionModules() {
  const modules = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && entry.name.endsWith('.mjs')) modules.push(candidate);
    }
  };
  for (const root of [
    'paper-adapters',
    'paper-application',
    'paper-composition',
    'paper-core/bin',
    'paper-core/src',
    'paper-domain',
    'paper-ports',
    'workflow-kernel',
  ]) visit(path.join(workspaceRoot, root));
  return modules;
}

function resolveRelativeImport(importer, specifier) {
  const candidate = path.resolve(path.dirname(importer), specifier);
  return [candidate, `${candidate}.mjs`, path.join(candidate, 'index.mjs')]
    .find((file) => fs.existsSync(file) && fs.statSync(file).isFile()) || null;
}

function authoritySchemaRebindReverseReachability() {
  const reverse = new Map();
  for (const importer of productionModules()) {
    const source = fs.readFileSync(importer, 'utf8');
    for (const specifier of relativeModuleSpecifiers(source)) {
      const imported = resolveRelativeImport(importer, specifier);
      if (!imported) continue;
      if (!reverse.has(imported)) reverse.set(imported, new Set());
      reverse.get(imported).add(importer);
    }
  }
  const target = path.join(
    workspaceRoot,
    'paper-adapters/automation/local-autonomous-research-state-authority-schema-rebind.mjs',
  );
  const pending = [target];
  const reached = new Set();
  while (pending.length) {
    const dependency = pending.pop();
    if (reached.has(dependency)) continue;
    reached.add(dependency);
    pending.push(...(reverse.get(dependency) || []));
  }
  return [...reached]
    .map((file) => path.relative(workspaceRoot, file).replaceAll(path.sep, '/'))
    .sort();
}

function source(relative) {
  return fs.readFileSync(path.join(workspaceRoot, relative), 'utf8');
}

function parseProductionModule(candidate) {
  return parse(fs.readFileSync(candidate, 'utf8'), {
    ecmaVersion: 'latest', sourceType: 'module',
  });
}

function walkAst(node, visit, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  visit(node, ancestors.at(-1) || null, ancestors);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visit, [...ancestors, node]);
    } else if (value && typeof value === 'object') {
      walkAst(value, visit, [...ancestors, node]);
    }
  }
}

function productionModuleConsumers(targetRelative) {
  const target = path.join(workspaceRoot, targetRelative);
  const consumers = [];
  for (const importer of productionModules()) {
    const forms = [];
    walkAst(parseProductionModule(importer), (node) => {
      const sourceNode = ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration']
        .includes(node.type) ? node.source : node.type === 'ImportExpression' ? node.source : null;
      if (typeof sourceNode?.value !== 'string'
        || resolveRelativeImport(importer, sourceNode.value) !== target) return;
      if (node.type === 'ImportDeclaration') {
        forms.push(Object.freeze({
          kind: 'import',
          specifiers: Object.freeze(node.specifiers.map((specifier) => Object.freeze({
            kind: specifier.type === 'ImportSpecifier' ? 'named' : specifier.type,
            imported: specifier.imported?.name || null,
            local: specifier.local.name,
          }))),
        }));
      } else {
        forms.push(Object.freeze({ kind: node.type }));
      }
    });
    if (!forms.length) continue;
    consumers.push(Object.freeze({
      importer: path.relative(workspaceRoot, importer).replaceAll(path.sep, '/'),
      forms: Object.freeze(forms),
    }));
  }
  return consumers;
}

function namedImportBindingUses(targetRelative, importedName) {
  const target = path.join(workspaceRoot, targetRelative);
  const imports = [];
  for (const importer of productionModules()) {
    const ast = parseProductionModule(importer);
    const bindings = [];
    for (const statement of ast.body) {
      if (statement.type !== 'ImportDeclaration'
        || resolveRelativeImport(importer, statement.source.value) !== target) continue;
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportSpecifier' && specifier.imported.name === importedName) {
          bindings.push(specifier);
        }
      }
    }
    for (const binding of bindings) {
      const uses = [];
      walkAst(ast, (node, parent, ancestors) => {
        if (node.type !== 'Identifier'
          || node === binding.local
          || node.name !== binding.local.name) return;
        const owner = [...ancestors].reverse().find((entry) => (
          entry.type === 'FunctionDeclaration'
        ));
        uses.push(Object.freeze({
          directCall: parent?.type === 'CallExpression' && parent.callee === node,
          owner: owner?.id?.name || null,
        }));
      });
      imports.push(Object.freeze({
        importer: path.relative(workspaceRoot, importer).replaceAll(path.sep, '/'),
        uses: Object.freeze(uses),
      }));
    }
  }
  return imports;
}

test('production writer discovery is complete and binds derived-cache provenance', () => {
  const inspection = inspectAutonomousResearchOnlineWriterStaticCoverage({
    workspaceRoot: process.cwd(),
    manifest: AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
  });
  assert.equal(inspection.status, 'autonomous_research_online_writer_static_coverage_complete');
  assert.equal(inspection.operationCount, 206);
  assert.equal(
    AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST.operations
      .filter((operation) => operation.coordinatorIntegrated).length,
    134,
  );
  assert.deepEqual(inspection.blockers, []);
  const legacySettlementOperationId =
    'native-store.legacy-terminal-active-residue-settlement.executeLegacyTerminalActiveResidueSettlement.v1';
  assert.deepEqual(
    inspection.coordinatorBindings.filter(
      (binding) => binding.operationId === legacySettlementOperationId,
    ),
    [{
      sourceFile: 'paper-adapters/automation/legacy-terminal-active-residue-settlement.mjs',
      entrypoint: 'executeLegacyTerminalActiveResidueSettlement',
      databaseRole: 'native-store',
      operationId: legacySettlementOperationId,
    }],
  );
  const sources = new Set(inspection.codeProvenanceSources.map((entry) => entry.sourceFile));
  assert.equal(
    sources.has(
      'paper-adapters/automation/autonomous-research-online-authority-evidence-cache.mjs',
    ),
    true,
  );
  assert.equal(
    sources.has(
      'paper-domain/automation/autonomous-research-online-authority-evidence-cache-contract.mjs',
    ),
    true,
  );
  assert.equal(
    sources.has(
      'paper-adapters/automation/autonomous-research-online-authority-evidence-renewal.mjs',
    ),
    true,
  );
  assert.equal(
    sources.has(
      'paper-application/automation/autonomous-research-online-authority-evidence-renewal-controller.mjs',
    ),
    true,
  );
  for (const sourceFile of [
    'paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs',
    'paper-adapters/automation/autonomous-research-online-writer-static-callback-boundary.mjs',
    'paper-adapters/automation/autonomous-research-online-writer-static-config.mjs',
    'paper-adapters/automation/autonomous-research-online-writer-static-discovery.mjs',
    'paper-adapters/automation/autonomous-research-online-writer-static-inspection.mjs',
    'paper-adapters/automation/autonomous-research-public-deployment-identity-readers.mjs',
    'paper-adapters/automation/autonomous-research-qualification-attempt-infrastructure-operations.mjs',
    'paper-adapters/automation/autonomous-research-online-mutation-startup-reconciliation.mjs',
    'paper-adapters/automation/autonomous-research-state-backup-authority.mjs',
    'paper-adapters/automation/autonomous-research-state-backup-journal-replay.mjs',
    'paper-adapters/automation/autonomous-research-state-backup-repository.mjs',
    'paper-adapters/automation/autonomous-research-state-backup-source-operations.mjs',
    'paper-adapters/automation/autonomous-research-state-reconciliation-database.mjs',
    'paper-adapters/automation/autonomous-research-state-restore-receipt-validation.mjs',
    'paper-adapters/automation/externally-fenced-sqlite-mutation-coordinator-validation.mjs',
    'paper-adapters/persistence/native-store-campaign-parameter-projection.mjs',
    'paper-application/automation/autonomous-research-resident-lifecycle.mjs',
    'paper-application/automation/autonomous-research-resident-reactivation-required.mjs',
    'paper-application/automation/autonomous-research-supervisor-campaign-processor.mjs',
    'paper-application/automation/autonomous-research-state-backup-renewal.mjs',
    'paper-application/automation/autonomous-research-state-reconcile-and-renew.mjs',
    'paper-application/automation/autonomous-research-state-recoverability-controller.mjs',
    'paper-application/automation/autonomous-research-supervisor-autonomy-fence.mjs',
    'paper-application/automation/autonomous-research-supervisor.mjs',
    'paper-application/automation/autonomous-submission-delivery.mjs',
    'paper-application/automation/campaign-engine.mjs',
    'paper-application/automation/campaign-node-infrastructure-control.mjs',
    'paper-adapters/build-package/research-evidence-capsule-attestation.mjs',
    'paper-composition/automation/autonomous-research-provider-canary.mjs',
    'paper-composition/automation/autonomous-research-resident-deployment-identity.mjs',
    'paper-composition/automation/autonomous-research-state-safety-inspection.mjs',
    'paper-composition/automation/autonomous-research-supervisor-composition.mjs',
    'paper-composition/automation/autonomous-research-supervisor-external-action-composition.mjs',
    'paper-composition/automation/autonomous-research-supervisor-prerequisites.mjs',
    'paper-composition/bootstrap/autonomous-research-online-mutation-composition.mjs',
    'paper-composition/bootstrap/autonomous-research-state-business-schema-provisioning-composition.mjs',
    'paper-core/bin/autonomous-research-supervisor.mjs',
    'paper-core/config/autonomous-research-state-databases.v1.json',
    'paper-domain/automation/autonomous-research-online-writer-manifest.mjs',
    'paper-domain/automation/autonomous-research-state-safety-contract.mjs',
  ]) {
    assert.equal(sources.has(sourceFile), true);
  }
  const journalExclusions = inspection.excludedCandidates.filter((entry) => (
    entry.sourceFile ===
      'paper-adapters/automation/autonomous-research-online-authority-journal.mjs'
  ));
  assert.deepEqual(
    journalExclusions.map((entry) => entry.entrypoint).sort(),
    ['expectedAuthorityJournalSqliteSchemaIdentity', 'moduleSchemaProvisioning'],
  );
  assert.deepEqual(
    inspection.excludedCandidates.filter((entry) => (
      entry.sourceFile ===
        'paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs'
    )),
    [{
      sourceFile:
        'paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs',
      reason:
        'append-only one-shot control-state journal in a dedicated root outside every registered research runtime database',
    }],
  );
  const authoritySchemaRebindWriters = inspection.excludedCandidates.filter((entry) => (
    entry.sourceFile ===
      'paper-adapters/automation/local-autonomous-research-state-authority-schema-rebind.mjs'
  ));
  assert.deepEqual(authoritySchemaRebindWriters.map((entry) => entry.entrypoint).sort(), [
    'activateFinalizedLocalAutonomousResearchStateAuthoritySchemaRebind',
    'finalize',
    'reserve',
  ]);
  assert.equal(authoritySchemaRebindWriters.every(
    (entry) => entry.classification === 'authority-principal-writer'
      && entry.reason === AUTHORITY_PRINCIPAL_WRITER_ENTRYPOINTS[
        `${entry.sourceFile}:${entry.entrypoint}`
      ],
  ), true);
  assert.equal(
    inspection.excludedCandidates.some((entry) => entry.sourceFile ===
      'paper-adapters/submission/handoff-bundle-staging-owner-repository.mjs'),
    false,
  );
  const excludedEntrypointsFor = (sourceFile) => inspection.excludedCandidates
    .filter((entry) => entry.sourceFile === sourceFile && entry.entrypoint)
    .map((entry) => entry.entrypoint)
    .sort();
  assert.deepEqual(excludedEntrypointsFor(
    'paper-adapters/automation/automation-runtime-reconciler.mjs',
  ), [
    'applyStrictReconciliation',
    'executeOfflineReconciliation',
    'insertStrictEvent',
    'offlineExactEventSql',
    'offlineExactMutationSql',
    'offlineExactlyOneGuardSql',
  ]);
  assert.deepEqual(excludedEntrypointsFor(
    'paper-adapters/automation/legacy-terminal-active-residue-settlement.mjs',
  ), [
    'applyStrictSettlement',
    'executeOfflineSettlement',
    'offlineExact',
    'offlineExactlyOneGuardSql',
    'offlineScopeGuardSql',
    'offlineSettlementSql',
    'runExactlyOne',
  ]);
  assert.deepEqual(excludedEntrypointsFor(
    'paper-adapters/automation/autonomous-research-supervisor-external-action-journal-storage.mjs',
  ), ['installAutonomousResearchSupervisorExternalActionJournalCoreSchema']);
  assert.deepEqual(excludedEntrypointsFor(
    'paper-composition/bootstrap/autonomous-research-state-partial-root-maintenance-composition.mjs',
  ), ['provisionMissingBusinessSchemas']);
  for (const [classification, registry] of [
    ['quiesced-maintenance-writer', QUIESCED_MAINTENANCE_WRITER_ENTRYPOINTS],
    ['private-copy-simulation-writer', PRIVATE_COPY_SIMULATION_WRITER_ENTRYPOINTS],
    ['staged-provisioning-writer', STAGED_PROVISIONING_WRITER_ENTRYPOINTS],
  ]) {
    for (const [key, reason] of Object.entries(registry)) {
      const separator = key.lastIndexOf(':');
      const sourceFile = key.slice(0, separator);
      const entrypoint = key.slice(separator + 1);
      assert.deepEqual(
        inspection.excludedCandidates.filter((entry) => (
          entry.sourceFile === sourceFile && entry.entrypoint === entrypoint
        )),
        [{ sourceFile, entrypoint, classification, reason }],
      );
    }
  }
  const maintenanceEntrypoints = AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST.operations
    .filter((operation) => operation.mutationClass === 'cross-database-maintenance')
    .map((operation) => `${operation.sourceFile}:${operation.entrypoint}`);
  for (const entrypoint of [
    'paper-adapters/automation/autonomous-research-resident-cycle-intent-repository.mjs:complete',
    'paper-adapters/automation/autonomous-research-resident-cycle-intent-repository.mjs:completeAutonomousResearchResidentCycleIntent',
    'paper-adapters/automation/autonomous-research-state-backup-journal-replay.mjs:drillDatabaseCopiesWithReplay',
    'paper-adapters/automation/autonomous-research-state-backup-journal-replay.mjs:insertReplayedAuthorityRecords',
    'paper-adapters/automation/runtime-image-reproducibility-receipt-repository.mjs:recoverPendingPublication',
    'paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs:recoverPendingPublication',
  ]) {
    assert.equal(maintenanceEntrypoints.includes(entrypoint), true);
  }
});

test('an added journal business writer cannot hide behind the exact DDL exclusions', () => {
  const source = `
import { DatabaseSync } from 'node:sqlite';
export function businessWriter(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec('INSERT INTO business_state(value) VALUES(1);');
  database.close();
}
`;
  const discovery = discoverAutonomousResearchOnlineWriterMutationEntrypoints(
    'paper-adapters/automation/autonomous-research-online-authority-journal.mjs',
    source,
  );
  assert.deepEqual(discovery.entrypoints, ['businessWriter']);
  assert.equal(discovery.exclusionReason, null);
});

test('authority schema-rebind writers stay capability-routed and exact registration cannot hide a new write', () => {
  assert.deepEqual(authoritySchemaRebindReverseReachability(), [
    'paper-adapters/automation/local-autonomous-research-state-authority-runtime.mjs',
    'paper-adapters/automation/local-autonomous-research-state-authority-schema-rebind.mjs',
    'paper-composition/automation/local-autonomous-research-state-authority-composition.mjs',
    'paper-core/bin/hepta-paper-state-authority-client.mjs',
    'paper-core/bin/hepta-paper-state-authority-daemon.mjs',
  ]);
  const schemaRebindSource = `${fs.readFileSync(
    path.join(
      workspaceRoot,
      'paper-adapters/automation/local-autonomous-research-state-authority-schema-rebind.mjs',
    ),
    'utf8',
  )}\nexport function residentBypass(database) {\n`
    + "  database.exec('INSERT INTO resident_state(value) VALUES(1);');\n}\n";
  const discovery = discoverAutonomousResearchOnlineWriterMutationEntrypoints(
    'paper-adapters/automation/local-autonomous-research-state-authority-schema-rebind.mjs',
    schemaRebindSource,
  );
  assert.equal(discovery.entrypoints.includes('residentBypass'), true);
  assert.equal(
    discovery.excludedEntrypoints.some((entry) => entry.entrypoint === 'residentBypass'),
    false,
  );
  const runtimeSource = source(
    'paper-adapters/automation/local-autonomous-research-state-authority-runtime.mjs',
  );
  const clientSource = source('paper-core/bin/hepta-paper-state-authority-client.mjs');
  const daemonSource = source('paper-core/bin/hepta-paper-state-authority-daemon.mjs');
  const socketSource = source(
    'paper-adapters/automation/local-autonomous-research-state-authority-socket.mjs',
  );
  const serviceSource = source('paper-core/deploy/hepta-paper-state-authority.service');
  assert.match(runtimeSource, /assertAutonomousResearchOnlineSchemaTransitionReserveRequest/);
  assert.match(runtimeSource, /schemaRebindHandlers\.reserve\(request\)/);
  assert.match(runtimeSource, /schemaRebindHandlers\.finalize\(request\)/);
  assert.match(runtimeSource,
    /activateFinalizedLocalAutonomousResearchStateAuthoritySchemaRebind\(\{/);
  assert.match(clientSource, /stateAuthorityRuntime\.requestAuthority\(/);
  assert.doesNotMatch(clientSource, /stateAuthorityRuntime\.createAuthority\(/);
  assert.doesNotMatch(clientSource, /DatabaseSync|privateKeyPath|stateDatabasePath/);
  assert.match(daemonSource, /stateAuthorityRuntime\.createAuthority\(/);
  assert.match(socketSource, /socketMode = 0o660/);
  for (const expected of [
    /^User=hepta-state-authority$/m,
    /^Group=hepta-paper$/m,
    /^NoNewPrivileges=yes$/m,
    /^PrivateNetwork=yes$/m,
    /^ProtectSystem=strict$/m,
    /^ProtectHome=yes$/m,
    /^RestrictAddressFamilies=AF_UNIX$/m,
    /^ReadOnlyPaths=\/opt\/hepta-paper \/etc\/hepta-paper\/state-authority$/m,
    /^ReadWritePaths=\/run\/hepta-paper-state-authority \/var\/lib\/hepta-paper-state-authority$/m,
    /^UMask=0007$/m,
  ]) assert.match(serviceSource, expected);
});

test('maintenance, private-copy, and staging writers retain exact production call paths', () => {
  const normalizationSource = source(
    'paper-adapters/automation/autonomous-research-online-schema-transition-journal-normalization.mjs',
  );
  const schemaSource = source(
    'paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs',
  );
  const provisioningSource = source(
    'paper-composition/bootstrap/autonomous-research-state-business-schema-provisioning-composition.mjs',
  );
  assert.doesNotMatch(normalizationSource,
    /export function normalizeAutonomousResearchOnlineSchemaTransitionJournals/);
  assert.equal((normalizationSource.match(
    /\bnormalizeAutonomousResearchOnlineSchemaTransitionJournals\s*\(/g,
  ) || []).length, 2);
  const normalizationConsumers = productionModuleConsumers(
    'paper-adapters/automation/autonomous-research-online-schema-transition-journal-normalization.mjs',
  );
  assert.deepEqual(normalizationConsumers.map((entry) => entry.importer), [
    'paper-adapters/automation/autonomous-research-online-schema-transition.mjs',
  ]);
  assert.equal(normalizationConsumers[0].forms.length, 1);
  assert.equal(normalizationConsumers[0].forms[0].kind, 'import');
  assert.equal(normalizationConsumers[0].forms[0].specifiers.every(
    (specifier) => specifier.kind === 'named',
  ), true);
  assert.deepEqual(namedImportBindingUses(
    'paper-adapters/automation/autonomous-research-online-schema-transition-journal-normalization.mjs',
    'executeAutonomousResearchOnlineSchemaTransitionJournalNormalization',
  ), [{
    importer: 'paper-adapters/automation/autonomous-research-online-schema-transition.mjs',
    uses: [{ directCall: true, owner: 'executeAutonomousResearchOnlineSchemaTransition' }],
  }]);
  const transitionConsumers = productionModuleConsumers(
    'paper-adapters/automation/autonomous-research-online-schema-transition.mjs',
  );
  assert.equal(transitionConsumers.every((entry) => entry.forms.every((form) => (
    form.kind === 'import' && form.specifiers.every((specifier) => specifier.kind === 'named')
  ))), true);
  assert.deepEqual(namedImportBindingUses(
    'paper-adapters/automation/autonomous-research-online-schema-transition.mjs',
    'executeAutonomousResearchOnlineSchemaTransition',
  ), [{
    importer:
      'paper-composition/automation/autonomous-research-online-schema-transition-composition.mjs',
    uses: [{
      directCall: true,
      owner: 'composeAutonomousResearchOnlineSchemaTransitionService',
    }],
  }]);
  for (const relative of [
    'paper-composition/automation/autonomous-research-online-schema-transition-composition.mjs',
    'paper-core/bin/autonomous-research-online-schema-transition.mjs',
  ]) assert.doesNotMatch(source(relative), /createAuthorityClient/);
  assert.doesNotMatch(schemaSource,
    /export function (?:expectedNormalizedSourceSha256|normalizeCopiedDatabaseJournal)/);
  assert.equal((schemaSource.match(/\bexpectedNormalizedSourceSha256\s*\(/g) || []).length, 3);
  assert.equal((schemaSource.match(/\bnormalizeCopiedDatabaseJournal\s*\(/g) || []).length, 3);
  assert.deepEqual(namedImportBindingUses(
    'paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs',
    'schemaTransitionNormalizedProjectionMatches',
  ), [{
    importer:
      'paper-adapters/automation/autonomous-research-online-schema-transition-journal-normalization.mjs',
    uses: [
      { directCall: true, owner: 'exactSchemaTransitionScope' },
      {
        directCall: true,
        owner: 'normalizeAutonomousResearchOnlineSchemaTransitionJournals',
      },
    ],
  }]);
  assert.doesNotMatch(provisioningSource,
    /export function provisionCanonicalAutonomousResearchBusinessSchemas/);
  assert.equal((provisioningSource.match(
    /\bprovisionCanonicalAutonomousResearchBusinessSchemas\s*\(/g,
  ) || []).length, 2);

  for (const relative of [
    'paper-adapters/automation/autonomous-research-online-schema-transition-installation.mjs',
    'paper-adapters/automation/autonomous-research-online-schema-transition-journal-normalization.mjs',
    'paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs',
    'paper-composition/bootstrap/autonomous-research-state-business-schema-provisioning-composition.mjs',
  ]) {
    const candidate = `${source(relative)}\nexport function residentBypass(database) {\n`
      + "  database.exec('INSERT INTO resident_state(value) VALUES(1);');\n}\n";
    const bypassDiscovery = discoverAutonomousResearchOnlineWriterMutationEntrypoints(
      relative,
      candidate,
    );
    assert.equal(bypassDiscovery.entrypoints.includes('residentBypass'), true, relative);
    assert.equal(bypassDiscovery.excludedEntrypoints.some(
      (entry) => entry.entrypoint === 'residentBypass',
    ), false, relative);
  }
});

test('changing a provenance-only cache source necessarily changes the provenance hash', () => {
  const inspection = inspectAutonomousResearchOnlineWriterStaticCoverage({
    workspaceRoot: process.cwd(),
    manifest: AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
  });
  const changed = inspection.codeProvenanceSources.map((entry) => (
    entry.sourceFile
      === 'paper-adapters/automation/autonomous-research-online-authority-evidence-cache.mjs'
      ? Object.freeze({ ...entry, sourceHash: hashRecord('ChangedCacheSource', entry) })
      : entry
  ));
  assert.notEqual(
    hashRecord('AutonomousResearchOnlineWriterCodeProvenance', changed),
    inspection.codeProvenanceHash,
  );
});
