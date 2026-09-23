#!/usr/bin/env node
import {
  executeAutomationRuntimeReconciliation,
  planAutomationRuntimeReconciliation,
} from '../../paper-composition/bootstrap/operator-automation-composition.mjs';
import {
  composeLegacyTerminalActiveResidueMaintenanceService,
} from '../../paper-composition/bootstrap/operator-maintenance-composition.mjs';
import { composeAutomationReconcilerReceiptLedger, createReadOnlyPaperStore } from '../../paper-composition/bootstrap/operator-persistence-composition.mjs';
import { runWithScopedFoundationWriter } from '../../paper-composition/bootstrap/context-foundation-composition.mjs';
import { createSystemClock } from '../../paper-composition/bootstrap/operator-runtime-composition.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';

const execute = process.argv.includes('--execute');
const legacyTerminalActiveResidue = process.argv.includes(
  '--legacy-terminal-active-residue',
);
const campaignIdArguments = process.argv.slice(2).flatMap((argument, index, values) => {
  if (argument.startsWith('--campaign-id=')) return [argument.slice('--campaign-id='.length)];
  if (argument === '--campaign-id') return [values[index + 1] || ''];
  return [];
});
if (campaignIdArguments.length > 1) {
  throw new Error('automation_runtime_reconciliation_campaign_id_duplicate');
}
const campaignId = campaignIdArguments.length ? campaignIdArguments[0] : null;
const root = defaultPaperAssetRoot();
const runtimeRoot = defaultPaperRuntimeRoot();
const clock = createSystemClock();
const legacyResidueMaintenance = composeLegacyTerminalActiveResidueMaintenanceService();

function reconcile(store) {
  return legacyTerminalActiveResidue
    ? execute
      ? legacyResidueMaintenance.execute({
          store,
          clock,
          campaignId,
          receiptLedger: composeAutomationReconcilerReceiptLedger({ store, clock }),
        })
      : legacyResidueMaintenance.plan({ store, clock, campaignId })
    : execute
      ? executeAutomationRuntimeReconciliation({
          store,
          clock,
          campaignId,
          receiptLedger: composeAutomationReconcilerReceiptLedger({ store, clock }),
        })
      : planAutomationRuntimeReconciliation({ store, clock, campaignId });
}

let result;
if (execute) {
  result = runWithScopedFoundationWriter({
    root,
    runtimeRoot,
    writerId: 'automation-reconcile-entrypoint',
    rootKind: 'automation-reconcile',
    serviceOverrides: { clock },
  }, ({ store }) => reconcile(store));
} else {
  const store = createReadOnlyPaperStore({ root, runtimeRoot });
  try { result = reconcile(store); }
  finally { store.close?.(); }
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
