#!/usr/bin/env node
import { planAutomationRuntimeReconciliation, executeAutomationRuntimeReconciliation } from '../../paper-adapters/automation/automation-runtime-reconciler.mjs';
import { issueReceiptWriterCapability } from '../../paper-adapters/persistence/receipt-issuer-policy.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createDefaultPaperStore, createReadOnlyPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';

const execute = process.argv.includes('--execute');
const root = defaultPaperAssetRoot();
const runtimeRoot = defaultPaperRuntimeRoot();
const clock = createSystemClock();
const store = execute ? createDefaultPaperStore({ root, runtimeRoot }) : createReadOnlyPaperStore({ root, runtimeRoot });
try {
  const result = execute
    ? executeAutomationRuntimeReconciliation({
        store,
        clock,
        receiptLedger: createSqliteReceiptLedger({ store, clock, issuerCapability: issueReceiptWriterCapability('automation-reconciler') }),
      })
    : planAutomationRuntimeReconciliation({ store, clock });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  store.close?.();
}
