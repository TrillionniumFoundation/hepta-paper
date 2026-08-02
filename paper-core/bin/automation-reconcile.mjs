#!/usr/bin/env node
import {
  executeAutomationRuntimeReconciliation,
  planAutomationRuntimeReconciliation,
} from '../../paper-composition/bootstrap/operator-automation-composition.mjs';
import {
  composeLegacyTerminalActiveResidueMaintenanceService,
} from '../../paper-composition/bootstrap/operator-maintenance-composition.mjs';
import { composeAutomationReconcilerReceiptLedger, createReadOnlyPaperStore, openExistingWritablePaperStore } from '../../paper-composition/bootstrap/operator-persistence-composition.mjs';
import { createSystemClock } from '../../paper-composition/bootstrap/operator-runtime-composition.mjs';
import { assertWorkspaceLayoutPhysicallyDecoupled, defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';

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
if (execute) assertWorkspaceLayoutPhysicallyDecoupled({ assetRoot: root, runtimeRoot });
const clock = createSystemClock();
const store = execute ? openExistingWritablePaperStore({ root, runtimeRoot }) : createReadOnlyPaperStore({ root, runtimeRoot });
const legacyResidueMaintenance = composeLegacyTerminalActiveResidueMaintenanceService();
try {
  const result = legacyTerminalActiveResidue
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
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  store.close?.();
}
