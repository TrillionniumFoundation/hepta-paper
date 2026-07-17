#!/usr/bin/env node
import { planAutomationRuntimeReconciliation, executeAutomationRuntimeReconciliation } from '../../paper-composition/bootstrap/operator-automation-composition.mjs';
import { composeAutomationReconcilerReceiptLedger, createReadOnlyPaperStore, openExistingWritablePaperStore } from '../../paper-composition/bootstrap/operator-persistence-composition.mjs';
import { createSystemClock } from '../../paper-composition/bootstrap/operator-runtime-composition.mjs';
import { assertWorkspaceLayoutPhysicallyDecoupled, defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';

const execute = process.argv.includes('--execute');
const root = defaultPaperAssetRoot();
const runtimeRoot = defaultPaperRuntimeRoot();
if (execute) assertWorkspaceLayoutPhysicallyDecoupled({ assetRoot: root, runtimeRoot });
const clock = createSystemClock();
const store = execute ? openExistingWritablePaperStore({ root, runtimeRoot }) : createReadOnlyPaperStore({ root, runtimeRoot });
try {
  const result = execute
    ? executeAutomationRuntimeReconciliation({
        store,
        clock,
        receiptLedger: composeAutomationReconcilerReceiptLedger({ store, clock }),
      })
    : planAutomationRuntimeReconciliation({ store, clock });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  store.close?.();
}
