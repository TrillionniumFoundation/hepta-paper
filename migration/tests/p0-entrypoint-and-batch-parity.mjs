import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  PAPER_BATCH_MODES,
  runPaperBatch,
} from '../../paper-core/src/paper-batch-runner.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = path.resolve(workspaceRoot, '..');
const cli = path.join(workspaceRoot, 'paper-core', 'bin', 'paper-production-core.mjs');

assert.equal(PAPER_BATCH_MODES.INVENTORY, 'inventory');
assert.equal(PAPER_BATCH_MODES.REVIEWED_SUBMIT, 'reviewed-submit');

const directReport = await runPaperBatch({
  root,
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
});
assert.equal(cliRun.status, 0, cliRun.stderr || cliRun.stdout);
const cliReport = JSON.parse(cliRun.stdout);
assert.equal(cliReport.kind, 'PaperBatchRunReport');
assert.equal(cliReport.summary.total, 1);
assert.equal(cliReport.inventory.source, 'hepta_sqlite');
assert.equal(cliReport.safety.externalActionPerformed, false);
assert.equal(cliReport.execute, false);

process.stdout.write(JSON.stringify({
  ok: true,
  kind: 'P0EntrypointAndBatchParityTest',
  inventorySource: cliReport.inventory.source,
  directTotal: directReport.summary.total,
  cliTotal: cliReport.summary.total,
  externalActionPerformed: false,
}) + '\n');
