#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { buildWorkspaceLineageBackfillPlan, executeWorkspaceLineageBackfill, createWorkspaceRegistry } from '../../paper-composition/bootstrap/operator-automation-composition.mjs';
import { openScopedPaperStore } from '../../paper-composition/bootstrap/context-foundation-composition.mjs';
import { createSystemClock } from '../../paper-composition/bootstrap/operator-runtime-composition.mjs';
import { composeWorkspaceSnapshotVerifierReceiptLedger } from '../../paper-composition/bootstrap/receipt-ledger-composition.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';

const execute = process.argv.includes('--execute');
const assetRoot = defaultPaperAssetRoot();
const runtimeRoot = defaultPaperRuntimeRoot();
const { store } = openScopedPaperStore({
  root: assetRoot,
  runtimeRoot,
  readOnly: !execute,
  serviceOverrides: {},
  rootKind: 'workspace-lineage-backfill',
});
const clock = createSystemClock();
try {
  const plan = buildWorkspaceLineageBackfillPlan({ store, runtimeRoot, assetRoot });
  const restoreReceiptLedger = execute ? composeWorkspaceSnapshotVerifierReceiptLedger({ store, clock }) : null;
  const result = execute ? executeWorkspaceLineageBackfill({
    plan,
    registry: createWorkspaceRegistry({ store, clock, receiptLedger: restoreReceiptLedger }),
    exportRoot: path.join(runtimeRoot, 'workspace-snapshots'),
    restoreRoot: path.join(runtimeRoot, 'workspace-restore-verification'),
    restoreReceiptLedger,
  }) : plan;
  if (execute) {
    const receiptRoot = path.join(runtimeRoot, 'workspace-lineage');
    fs.mkdirSync(receiptRoot, { recursive: true });
    fs.writeFileSync(path.join(receiptRoot, 'WORKSPACE_LINEAGE_BACKFILL_RECEIPT.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o444 });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally { store.close?.(); }
