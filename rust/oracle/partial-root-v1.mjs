// Build an actual historical 5+5 runtime from the incumbent Node constructors.
// Test fixture only: no production credential, provider, portal, or release authority.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  schemaTransitionTargetSchema,
} from '../../paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs';
import {
  buildAutonomousResearchStatePartialRootWriterQuiescenceReceipt,
  PARTIAL_ROOT_EXISTING_ROLES,
  PARTIAL_ROOT_MISSING_ROLES,
  PARTIAL_ROOT_REQUIRED_QUIESCED_SERVICES,
  SUPERVISOR_BUSINESS_REPAIR_OBJECTS,
} from '../../paper-adapters/automation/autonomous-research-state-partial-root-maintenance-inspection.mjs';
import {
  resolveAutonomousResearchStateDatabaseInventory,
} from '../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import {
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (typeof process.argv[2] !== 'string' || Buffer.byteLength(process.argv[2]) > 65536) {
  throw new Error('fixture_argument_bound');
}
const input = JSON.parse(process.argv[2]);
const root = path.resolve(input.root);
const run = spawnSync(process.execPath, [
  path.join(ROOT, 'rust/oracle/state-provision-v1.mjs'),
  JSON.stringify({ root }),
], {
  encoding: 'utf8',
  timeout: 120000,
  maxBuffer: 4 * 1024 * 1024,
  env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8' },
});
if (run.status !== 0) throw new Error(`full_fixture_failed:${run.stderr}`);
const original = JSON.parse(run.stdout);
const value = original.value;
const runtimeRoot = value.root ? path.join(value.root, 'node-runtime') : path.join(root, 'node-runtime');
const rescueRoot = path.join(root, 'rescue');
fs.mkdirSync(rescueRoot, { mode: 0o700 });
const manifest = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'paper-core/config/autonomous-research-state-databases.v1.json'), 'utf8',
));

function quote(value) {
  return '"' + String(value).replaceAll('"', '""') + '"';
}
function dropObject(database, type, name) {
  if (type === 'index' || type === 'trigger' || type === 'view') {
    database.exec(`DROP ${type.toUpperCase()} IF EXISTS ${quote(name)};`);
  } else if (type === 'table') {
    database.exec(`DROP TABLE IF EXISTS ${quote(name)};`);
  } else {
    throw new Error(`unsupported_schema_object:${type}:${name}`);
  }
}
for (const definition of manifest.databases) {
  const candidate = path.join(runtimeRoot, definition.relativePath);
  if (PARTIAL_ROOT_MISSING_ROLES.includes(definition.role)) {
    fs.rmSync(candidate, { force: true });
    continue;
  }
  if (!PARTIAL_ROOT_EXISTING_ROLES.includes(definition.role)) {
    throw new Error(`unexpected_role:${definition.role}`);
  }
  const target = [...schemaTransitionTargetSchema({ role: definition.role }).objects.values()]
    .map((row) => ({ type: row.type, name: row.name }));
  if (definition.role === 'supervisor-state') {
    for (const entry of SUPERVISOR_BUSINESS_REPAIR_OBJECTS) {
      const [type, name] = entry.split(':');
      target.push({ type, name });
    }
  }
  const database = new DatabaseSync(candidate);
  try {
    database.exec('PRAGMA foreign_keys=OFF;');
    for (const kind of ['trigger', 'view', 'index', 'table']) {
      for (const row of target.filter((entry) => entry.type === kind)) {
        dropObject(database, row.type, row.name);
      }
    }
    const quick = database.prepare('PRAGMA quick_check').get();
    if (quick.integrity_check !== 'ok' && quick.quick_check !== 'ok') {
      throw new Error(`fixture_quick_check_failed:${definition.role}`);
    }
  } finally {
    database.close();
  }
  fs.chmodSync(candidate, 0o600);
}
const inventory = resolveAutonomousResearchStateDatabaseInventory({
  runtimeRoot,
  manifest,
});
if (inventory.instances.length !== PARTIAL_ROOT_EXISTING_ROLES.length) {
  throw new Error('partial_inventory_shape_invalid');
}
const now = new Date();
const receipt = buildAutonomousResearchStatePartialRootWriterQuiescenceReceipt({
  runtimeRoot,
  databaseScopeHash: inventory.databaseScopeHash,
  writerManifestHash: autonomousResearchOnlineWriterOperationManifestHash(
    AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
  ),
  quiescedWriterServices: PARTIAL_ROOT_REQUIRED_QUIESCED_SERVICES,
  activeWriterProcessIds: [],
  serviceInspectionComplete: true,
  processInspectionComplete: true,
  observedAt: new Date(now.getTime() - 60_000),
  expiresAt: new Date(now.getTime() + 30 * 60_000),
});
const receiptPath = path.join(root, 'partial-root-quiescence.json');
fs.writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
process.stdout.write(JSON.stringify({
  profile: original.profile,
  value: {
    root,
    runtimeRoot,
    rescueRoot,
    machine: value.machine,
    topic: value.topic,
    datasets: value.datasets,
    quiescence: receiptPath,
  },
}));
