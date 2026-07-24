import {
  NATIVE_STORE_LEDGER_STATEMENT_IDS,
} from '../persistence/native-store-ledger-mutation-plan.mjs';
import {
  compileExternallyFencedSqliteMutationOperation,
  defineExternallyFencedSqliteMutationStatement as statement,
  externallyFencedSqliteWriterPlanHash,
} from './externally-fenced-sqlite-mutation-plan.mjs';

export const NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_WRITER_ID =
  'writer:native-store:automation-runtime-reconciler:v1';

export const NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_OPERATION_ID =
  'native-store.automation-runtime-reconciler.executeAutomationRuntimeReconciliation.v1';

export const NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_STATEMENT_IDS =
  Object.freeze({
    closeTerminalQueuedNode:
      'native-store.automation-runtime-reconciliation.close-terminal-node.v1',
    deleteExpiredResourceLeases:
      'native-store.automation-runtime-reconciliation.delete-resource-leases.v1',
    deleteExpiredResourceWaiters:
      'native-store.automation-runtime-reconciliation.delete-resource-waiters.v1',
    insertCampaignEvent:
      'native-store.automation-runtime-reconciliation.insert-campaign-event.v1',
    insertReceipt: NATIVE_STORE_LEDGER_STATEMENT_IDS.insertReceipt,
    pauseNoProgressCampaign:
      'native-store.automation-runtime-reconciliation.pause-campaign.v1',
    recoverExpiredNode:
      'native-store.automation-runtime-reconciliation.recover-node.v1',
  });

const S = NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_STATEMENT_IDS;

const RECEIPT_COLUMNS = `receipt_id,stream,paper_id,kind,status,receipt_json,
  receipt_sha256,created_at,environment,evidence_class,release_commit,writer_id,
  writer_kind,writer_trusted,issuer_policy_id,issuer_policy_hash,issuer_assurance`;

const operationPlan = compileExternallyFencedSqliteMutationOperation(
  NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_OPERATION_ID,
  [
    statement(S.closeTerminalQueuedNode, `UPDATE campaign_nodes SET
      status='skipped',failure_class='terminal_campaign_reconciled',
      failure_json=NULL,failure_sha256=NULL,lease_owner=NULL,
      lease_expires_at=NULL,updated_at=?
      WHERE node_id=? AND status='queued'
        AND EXISTS(SELECT 1 FROM paper_campaigns c
          WHERE c.campaign_id=campaign_nodes.campaign_id
            AND c.status IN ('failed','cancelled','stopped','completed'))`),
    statement(S.deleteExpiredResourceLeases,
      'DELETE FROM automation_resource_leases WHERE expires_at<=?'),
    statement(S.deleteExpiredResourceWaiters, `DELETE FROM automation_resource_waiters
      WHERE expires_at IS NOT NULL AND expires_at<=?`),
    statement(S.insertCampaignEvent, `INSERT OR IGNORE INTO campaign_events(
      event_id,campaign_id,node_id,kind,event_json,event_sha256,created_at
    ) VALUES(?,?,?,?,?,?,?)`),
    statement(S.insertReceipt,
      `INSERT INTO receipt_ledger(${RECEIPT_COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    statement(S.pauseNoProgressCampaign, `UPDATE paper_campaigns SET
      status='paused',current_phase='paused',
      stop_reason='reconciliation_no_progress_timeout',
      accumulated_run_ms=accumulated_run_ms+CASE WHEN last_resumed_at IS NULL
        THEN 0 ELSE max(0,CAST((julianday(?)-julianday(last_resumed_at))*86400000
          AS INTEGER)) END,
      last_resumed_at=NULL,revision=revision+1,updated_at=?
      WHERE campaign_id=? AND status='running'`),
    statement(S.recoverExpiredNode, `UPDATE campaign_nodes SET
      status='queued',lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,
      node_revision=node_revision+1,failure_class='lease_expired_recovered',
      updated_at=?
      WHERE node_id=? AND status=?
        AND ((? IS NULL AND lease_owner IS NULL) OR lease_owner=?)
        AND ((? IS NULL AND attempt_id IS NULL) OR attempt_id=?)
        AND lease_generation=? AND node_revision=?
        AND julianday(lease_expires_at)<=julianday(?)
        AND EXISTS(SELECT 1 FROM paper_campaigns c
          WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running')`),
  ],
);

export const NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_MUTATION_PLANS =
  Object.freeze({
    [NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_OPERATION_ID]: operationPlan,
  });

export const NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_WRITER_PLAN_HASH =
  externallyFencedSqliteWriterPlanHash({
    writerId: NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_WRITER_ID,
    operationPlans: Object.values(
      NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_MUTATION_PLANS,
    ),
  });
