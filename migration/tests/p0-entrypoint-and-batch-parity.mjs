import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultLegacyPaperFactoryRoot } from '../../paper-adapters/runtime/workspace-layout.mjs';
import { prepareIsolatedRuntimeStore } from '../../paper-core/bin/isolated-runtime-store.mjs';
import {
  PAPER_BATCH_MODES,
  runPaperBatch,
} from '../../paper-core/src/paper-batch-runner.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = defaultLegacyPaperFactoryRoot();
const cli = path.join(workspaceRoot, 'paper-core', 'bin', 'paper-production-core.mjs');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-p0-entrypoint-parity-'));
const runtimeRoot = path.join(fixtureRoot, 'runtime');
const dbPath = path.join(runtimeRoot, 'hepta-paper.sqlite');

assert.equal(PAPER_BATCH_MODES.INVENTORY, 'inventory');
assert.equal(PAPER_BATCH_MODES.REVIEWED_SUBMIT, 'reviewed-submit');

let directReport;
let cliReport;
try {
  prepareIsolatedRuntimeStore({
    root,
    runtimeRoot,
    dbPath,
    initialize(store) {
      const inserted = store.run(
        `INSERT INTO papers(
          slug,title,canonical_dir,source_dir,status,updated_at
        ) VALUES(?,?,?,?,?,?);`,
        [
          'p0-entrypoint-parity-fixture',
          'P0 entrypoint parity fixture',
          'p0-entrypoint-parity-fixture',
          '',
          'draft',
          '2026-07-01T00:00:00.000Z',
        ],
      );
      assert.equal(inserted.ok, true, inserted.error || inserted.stderr);
      assert.equal(inserted.changes, 1);
    },
  });

  directReport = await runPaperBatch({
    root,
    runtimeRoot,
    mode: PAPER_BATCH_MODES.INVENTORY,
    limit: 1,
    inventorySource: 'hepta',
    execute: false,
    writeReport: false,
  });
  assert.equal(directReport.kind, 'PaperBatchRunReport');
  assert.equal(directReport.mode, PAPER_BATCH_MODES.INVENTORY);
  assert.equal(directReport.inventory.source, 'hepta_sqlite');
  assert.equal(directReport.summary.total, 1);
  assert.equal(directReport.safety.externalActionPerformed, false);
  assert.equal(directReport.execute, false);

  const cliRun = spawnSync(process.execPath, [
    cli,
    'batch-run',
    '--mode',
    'inventory',
    '--limit',
    '1',
    '--inventory-source',
    'hepta',
    '--root',
    root,
    '--json',
  ], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      HEPTA_PAPER_RUNTIME_ROOT: runtimeRoot,
      HEPTA_PAPER_RUNTIME_ISOLATED: '1',
    },
  });
  assert.equal(cliRun.status, 0, cliRun.stderr || cliRun.stdout);
  cliReport = JSON.parse(cliRun.stdout);
  assert.equal(cliReport.kind, 'PaperBatchRunReport');
  assert.equal(cliReport.summary.total, 1);
  assert.equal(cliReport.inventory.source, 'hepta_sqlite');
  assert.equal(cliReport.safety.externalActionPerformed, false);
  assert.equal(cliReport.execute, false);
  assert.equal(cliReport.summary.total, directReport.summary.total);
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

process.stdout.write(JSON.stringify({
  ok: true,
  kind: 'P0EntrypointAndBatchParityTest',
  inventorySource: cliReport.inventory.source,
  directTotal: directReport.summary.total,
  cliTotal: cliReport.summary.total,
  externalActionPerformed: false,
}) + '\n');
