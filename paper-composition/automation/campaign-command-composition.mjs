import {
  buildRuntimeRetentionPlan,
  executeRuntimeRetentionPlan,
  reconcileRuntimeRetentionIntents,
} from '../../paper-adapters/automation/runtime-retention.mjs';
import { CampaignCommandService } from '../../paper-application/automation/campaign-command-service.mjs';

export function composeCampaignCommandService({ runtimeRoot, services = {} } = {}) {
  return new CampaignCommandService({
    runtimeRoot,
    campaignStore: services.campaignStore,
    workspaceRegistry: services.workspaceRegistry,
    receiptLedger: services.receiptLedger,
    runtimeRetentionReceiptLedger: services.runtimeRetentionReceiptLedger,
    buildRuntimeRetentionPlan,
    executeRuntimeRetentionPlan,
    reconcileRuntimeRetentionIntents,
  });
}
