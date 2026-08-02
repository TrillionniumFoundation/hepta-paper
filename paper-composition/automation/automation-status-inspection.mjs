const REQUIRED_AUTOMATION_TABLE_COLUMNS = Object.freeze({
  paper_campaigns: Object.freeze(['campaign_id', 'status', 'updated_at']),
  campaign_nodes: Object.freeze(['node_id', 'campaign_id', 'status', 'lease_expires_at']),
  campaign_events: Object.freeze(['event_id', 'campaign_id', 'kind']),
  automation_resource_leases: Object.freeze(['lease_id', 'expires_at']),
  automation_resource_waiters: Object.freeze(['waiter_id', 'expires_at']),
});

const FULL_RESEARCH_QUALIFICATION_REQUIRED_BINDINGS = Object.freeze([
  'code_worktree_identity',
  'research_author_configuration',
  'formal_reviewer_configuration',
  'campaign_store_schema',
  'runtime_image_digests',
  'runtime_image_reproducibility_receipt',
  'global_golden_qualification_authority',
  'release_attestor_identity',
  'research_author_provider_canary',
  'formal_reviewer_provider_canary',
  'independent_hypothesis_prior_art_qualification',
]);

function queryStore(store, sql, blocker, blockers) {
  try {
    const result = store.query(sql);
    if (result?.ok !== true) {
      blockers.push(blocker);
      return null;
    }
    return result;
  } catch {
    blockers.push(blocker);
    return null;
  }
}

function inspectCount(store, { name, sql }, blockers) {
  const result = queryStore(store, sql, `automation_store_operational_query_failed:${name}`, blockers);
  if (!result) return null;
  const count = Number(result.rows?.[0]?.count);
  if (!Number.isSafeInteger(count) || count < 0) {
    blockers.push(`automation_store_operational_count_invalid:${name}`);
    return null;
  }
  return count;
}

export function inspectAutomationStoreOperationalIntegrity({
  store,
  now = new Date(),
  noProgressWindowMs = 30 * 60 * 1000,
} = {}) {
  if (!store || typeof store.query !== 'function') throw new Error('automation_status_store_query_required');
  const blockers = [];
  const inspectedAtDate = new Date(now);
  if (!Number.isFinite(inspectedAtDate.getTime())) throw new Error('automation_status_inspection_time_invalid');
  const inspectedAt = inspectedAtDate.toISOString();
  const noProgressCutoff = new Date(inspectedAtDate.getTime() - noProgressWindowMs).toISOString();

  const quickCheckResult = queryStore(
    store,
    'PRAGMA quick_check;',
    'automation_store_quick_check_query_failed',
    blockers,
  );
  const quickCheckValue = quickCheckResult
    ? String(Object.values(quickCheckResult.rows?.[0] || {})[0] || '')
    : null;
  if (quickCheckResult && quickCheckValue !== 'ok') blockers.push('automation_store_quick_check_failed');

  const requiredTableInspections = Object.entries(REQUIRED_AUTOMATION_TABLE_COLUMNS).map(([table, requiredColumns]) => {
    const result = queryStore(
      store,
      `PRAGMA table_info('${table}');`,
      `automation_store_table_info_query_failed:${table}`,
      blockers,
    );
    const observedColumns = result
      ? [...new Set((result.rows || []).map((row) => String(row.name || '')).filter(Boolean))].sort()
      : [];
    const missingColumns = requiredColumns.filter((column) => !observedColumns.includes(column));
    if (result && missingColumns.length > 0) {
      blockers.push(`automation_store_required_columns_missing:${table}:${missingColumns.join(',')}`);
    }
    return Object.freeze({
      table,
      requiredColumns,
      observedColumns: Object.freeze(observedColumns),
      missingColumns: Object.freeze(missingColumns),
      ready: Boolean(result && missingColumns.length === 0),
    });
  });

  const countQueries = [
    {
      name: 'expiredActiveNodeCount',
      sql: `SELECT count(*) AS count FROM campaign_nodes WHERE status IN ('leased','running') AND lease_expires_at IS NOT NULL AND lease_expires_at<='${inspectedAt}';`,
    },
    {
      name: 'expiredResourceLeaseCount',
      sql: `SELECT count(*) AS count FROM automation_resource_leases WHERE expires_at<='${inspectedAt}';`,
    },
    {
      name: 'expiredWaiterCount',
      sql: `SELECT count(*) AS count FROM automation_resource_waiters WHERE expires_at IS NOT NULL AND expires_at<='${inspectedAt}';`,
    },
    {
      name: 'stalledRecoverableCampaignCount',
      sql: `SELECT count(DISTINCT campaign_id) AS count FROM campaign_nodes WHERE status IN ('leased','running') AND lease_expires_at IS NOT NULL AND lease_expires_at<='${inspectedAt}';`,
    },
    {
      name: 'noProgressRunningCampaignCount',
      sql: `SELECT count(*) AS count FROM paper_campaigns c WHERE c.status='running' AND c.updated_at<='${noProgressCutoff}' AND EXISTS(SELECT 1 FROM campaign_nodes queued WHERE queued.campaign_id=c.campaign_id AND queued.status='queued') AND NOT EXISTS(SELECT 1 FROM campaign_nodes active WHERE active.campaign_id=c.campaign_id AND active.status IN ('leased','running'));`,
    },
    {
      name: 'terminalCampaignQueuedNodeCount',
      sql: "SELECT count(*) AS count FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id WHERE n.status='queued' AND c.status IN ('failed','cancelled','stopped','completed');",
    },
    {
      name: 'reconcilableTerminalCampaignQueuedNodeCount',
      sql: "SELECT count(*) AS count FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id WHERE n.status='queued' AND c.status IN ('failed','cancelled','stopped','completed') AND json_type(c.spec_json,'$.terminalSiblingSettlementPolicyVersion')='integer' AND json_extract(c.spec_json,'$.terminalSiblingSettlementPolicyVersion')=1;",
    },
    {
      name: 'preservedLegacyTerminalCampaignQueuedNodeCount',
      sql: "SELECT count(*) AS count FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id WHERE n.status='queued' AND c.status IN ('failed','cancelled','stopped','completed') AND (json_type(c.spec_json,'$.terminalSiblingSettlementPolicyVersion') IS NULL OR (json_type(c.spec_json,'$.terminalSiblingSettlementPolicyVersion')='integer' AND json_extract(c.spec_json,'$.terminalSiblingSettlementPolicyVersion')=0));",
    },
    {
      name: 'invalidTerminalCampaignSettlementPolicyQueuedNodeCount',
      sql: "SELECT count(*) AS count FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id WHERE n.status='queued' AND c.status IN ('failed','cancelled','stopped','completed') AND NOT (json_type(c.spec_json,'$.terminalSiblingSettlementPolicyVersion') IS NULL OR (json_type(c.spec_json,'$.terminalSiblingSettlementPolicyVersion')='integer' AND json_extract(c.spec_json,'$.terminalSiblingSettlementPolicyVersion') IN (0,1)));",
    },
  ];
  const counts = Object.fromEntries(countQueries.map((query) => [query.name, inspectCount(store, query, blockers)]));
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const queryReady = uniqueBlockers.length === 0;
  // Policy-v0 terminal queued nodes are immutable historical evidence. The
  // reconciler deliberately preserves them and campaign claiming also requires
  // a running parent. Keep their count observable, but do not report them as
  // live operational debt. Policy-v1 residue is reconcilable, while malformed
  // policy encodings remain fail-closed operational debt.
  const staleStateDetected = [
    counts.expiredActiveNodeCount,
    counts.expiredResourceLeaseCount,
    counts.expiredWaiterCount,
    counts.stalledRecoverableCampaignCount,
    counts.noProgressRunningCampaignCount,
    counts.reconcilableTerminalCampaignQueuedNodeCount,
    counts.invalidTerminalCampaignSettlementPolicyQueuedNodeCount,
  ].some((value) => Number.isSafeInteger(value) && value > 0);
  const degraded = !queryReady || staleStateDetected;

  return Object.freeze({
    version: 1,
    kind: 'AutomationStoreOperationalIntegrityInspection',
    status: !queryReady
      ? 'automation_store_operational_integrity_blocked'
      : staleStateDetected
        ? 'automation_store_operational_integrity_degraded'
        : 'automation_store_operational_integrity_verified',
    inspectedAt,
    quickCheck: Object.freeze({ value: quickCheckValue, ready: quickCheckValue === 'ok' }),
    requiredTableInspections: Object.freeze(requiredTableInspections),
    ...counts,
    queryReady,
    degraded,
    blockers: uniqueBlockers,
  });
}

export function inspectFullResearchQualification({
  qualificationReceipt = null,
  inputBlockers = [],
  ...verificationContext
} = {}) {
  const suppliedInputBlockers = [...new Set((inputBlockers || []).filter(Boolean))];
  if (suppliedInputBlockers.length || qualificationReceipt === null || qualificationReceipt === undefined) {
    return Object.freeze({
      version: 1,
      kind: 'FullResearchQualificationInspection',
      status: 'full_research_qualification_blocked',
      ready: false,
      receiptAccepted: false,
      maximumReceiptAgeMs: 24 * 60 * 60 * 1000,
      requiredBindings: FULL_RESEARCH_QUALIFICATION_REQUIRED_BINDINGS,
      blockers: Object.freeze(suppliedInputBlockers.length
        ? suppliedInputBlockers
        : ['golden_micro_campaign_qualification_receipt_missing']),
    });
  }
  const verification = verifyFullResearchQualificationReceipt(
    qualificationReceipt,
    verificationContext,
  );
  return Object.freeze({
    ...verification,
    kind: 'FullResearchQualificationInspection',
    requiredBindings: FULL_RESEARCH_QUALIFICATION_REQUIRED_BINDINGS,
  });
}
import { verifyFullResearchQualificationReceipt } from '../../paper-domain/automation/full-research-qualification-contract.mjs';
