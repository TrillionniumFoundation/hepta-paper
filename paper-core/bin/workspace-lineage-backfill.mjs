#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { buildWorkspaceLineageBackfillPlan, executeWorkspaceLineageBackfill } from '../../paper-adapters/automation/workspace-lineage-backfill.mjs';
import { createWorkspaceRegistry } from '../../paper-adapters/automation/workspace-registry.mjs';
import { createDefaultPaperStore, createReadOnlyPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';

const execute = process.argv.includes('--execute');
const assetRoot = defaultPaperAssetRoot();
const runtimeRoot = defaultPaperRuntimeRoot();
const store = execute ? createDefaultPaperStore({ root: assetRoot, runtimeRoot }) : createReadOnlyPaperStore({ root: assetRoot, runtimeRoot });
const clock = createSystemClock();
try {
  const plan = buildWorkspaceLineageBackfillPlan({ store, runtimeRoot, assetRoot });
  const result = execute ? executeWorkspaceLineageBackfill({
    plan,
    registry: createWorkspaceRegistry({ store, clock }),
    exportRoot: path.join(runtimeRoot, 'workspace-snapshots'),
    restoreRoot: path.join(runtimeRoot, 'workspace-restore-verification'),
  }) : plan;
  if (execute) {
    const receiptRoot = path.join(runtimeRoot, 'workspace-lineage');
    fs.mkdirSync(receiptRoot, { recursive: true });
    fs.writeFileSync(path.join(receiptRoot, 'WORKSPACE_LINEAGE_BACKFILL_RECEIPT.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o444 });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally { store.close?.(); }
