import fs from 'node:fs';
import path from 'node:path';
import { paperWorkflowRow } from '../../paper-domain/contracts/index.mjs';
import { directoryMerkleHash } from '../../paper-adapters/runtime/execution-snapshot.mjs';
import { PAPER_BATCH_MODES, assertPaperMode } from '../../paper-domain/workflow/mode-registry.mjs';
import {
  defaultPaperAssetRoot,
  defaultPaperRuntimeRoot,
} from '../../paper-adapters/runtime/workspace-layout.mjs';
import { withArtifactWriteContext } from '../../paper-adapters/artifacts/artifact-write-context.mjs';
import { bootstrapAutomationContext } from '../bootstrap/automation-context-bootstrap.mjs';
import { bootstrapBatchInventoryContext } from '../bootstrap/batch-inventory-context-bootstrap.mjs';
import { buildBatchReport, persistBatchReport, renderBatchConsole } from '../reporting/batch-report-writer.mjs';
import { buildTargetScopeReceipt } from '../../paper-domain/automation/target-scope-policy.mjs';
import { assertPaperCampaignModeExecutable } from '../../paper-domain/automation/campaign-plan.mjs';
import { bindPaperTaskQualityProfile } from '../../paper-domain/contracts/workflow-contracts.mjs';
import {
  buildCanonicalPaperStatusReadProjection,
  buildWorkflowAuthorityLineage,
} from '../../paper-domain/workflow/operational-authority-policy.mjs';
import {
  buildBatchCampaignCommand,
  submitBatchCampaignCommand,
} from '../../paper-application/automation/batch-campaign-command.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import {
  authorizeOperatorDatasetMount,
  loadOperatorDatasetAuthorityTrustStoreSync,
} from '../../paper-adapters/automation/operator-dataset-harness-reader.mjs';

export { PAPER_BATCH_MODES } from '../../paper-domain/workflow/mode-registry.mjs';

const LEGACY_PROJECTION_BOUNDARY = 'explicit-legacy-workflow-projection-compatibility';

function defaultRoot() {
  return defaultPaperAssetRoot();
}

function defaultRuntimeRoot() {
  return defaultPaperRuntimeRoot();
}

function resolveSourceWorkspace(root, paperTask, { required = false } = {}) {
  const logical = String(paperTask?.sourceWorkspace || '').trim();
  if (!logical) {
    if (required) throw new Error(`batch_campaign_source_workspace_missing:${paperTask?.paperId || 'unknown'}`);
    return null;
  }
  const candidate = path.resolve(root, logical);
  try {
    const canonical = fs.realpathSync(candidate);
    if (!fs.statSync(canonical).isDirectory()) throw new Error('not_directory');
    return canonical;
  } catch {
    if (required) throw new Error(`batch_campaign_source_workspace_invalid:${paperTask?.paperId || 'unknown'}`);
    return null;
  }
}

function resolveBatchDatasetMounts({
  root, runtimeRoot, datasetRoot, benchmarkId, datasetLicenseId, datasetAuthorizationHash,
  datasetHarnessEnvelope, persistPrivateEnvelope = false,
} = {}) {
  const requested = String(datasetRoot || '').trim();
  if (!requested) return Object.freeze([]);
  const candidates = path.isAbsolute(requested)
    ? [path.resolve(requested)]
    : [path.resolve(root, requested), path.resolve(runtimeRoot, requested)];
  const selected = candidates.find((candidate) => {
    try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
  });
  if (!selected) throw new Error('batch_campaign_dataset_root_missing_or_not_directory');
  const canonical = fs.realpathSync(selected);
  const allowedScopes = [root, runtimeRoot].map((scope) => {
    try { return fs.realpathSync(scope); } catch { return path.resolve(scope); }
  });
  if (!allowedScopes.some((scope) => isPathWithin(scope, canonical))) {
    throw new Error('batch_campaign_dataset_root_outside_authorized_workspace');
  }
  const name = String(benchmarkId || 'batch-dataset')
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'batch-dataset';
  const manifestHash = directoryMerkleHash(canonical);
  const licenseId = String(datasetLicenseId || '').trim();
  if (!licenseId) throw new Error('batch_campaign_dataset_license_required');
  const operatorAuthorizationHash = String(datasetAuthorizationHash || '').trim() || null;
  if (licenseId.startsWith('LicenseRef-') && !/^sha256:[0-9a-f]{64}$/i.test(String(operatorAuthorizationHash || ''))) {
    throw new Error('batch_campaign_dataset_operator_authorization_required');
  }
  const mount = Object.freeze({
    name,
    source: canonical,
    readOnly: true,
    manifestHash,
    licenseId,
    ...(operatorAuthorizationHash ? { operatorAuthorizationHash } : {}),
  });
  const authorizedMount = datasetHarnessEnvelope
    ? authorizeOperatorDatasetMount(mount, {
      envelopePath: path.resolve(String(datasetHarnessEnvelope)),
      authorityTrustStore: loadOperatorDatasetAuthorityTrustStoreSync({ runtimeRoot }),
      runtimeRoot,
      persistPrivateEnvelope,
    })
    : mount;
  return Object.freeze([authorizedMount]);
}

export async function runPaperBatch({
  root = defaultRoot(),
  runtimeRoot = null,
  mode = PAPER_BATCH_MODES.INVENTORY,
  limit = null,
  paperIds = [],
  includeRetired = false,
  includeQuarantined = false,
  inventorySource = 'auto',
  execute = false,
  writeReport = false,
  maxRounds = 6,
  targetOverride = null,
  datasetRoot = null,
  benchmarkId = null,
  datasetLicenseId = null,
  datasetAuthorizationHash = null,
  datasetHarnessEnvelope = null,
  applyManuscript = false,
  qualityProfile = null,
  languages = ['python', 'latex'],
  legacyWorkflowProjection = false,
  compatibilityBoundary = null,
  serviceOverrides = {},
  submissionHandoffMutationCoordinator = null,
} = {}) {
  assertPaperMode(mode);
  if (execute && mode === PAPER_BATCH_MODES.INVENTORY) {
    throw new Error('batch_inventory_execute_forbidden_use_read_only_preview');
  }
  if (mode !== PAPER_BATCH_MODES.INVENTORY) assertPaperCampaignModeExecutable(mode);
  if (legacyWorkflowProjection && compatibilityBoundary !== LEGACY_PROJECTION_BOUNDARY) {
    throw new Error('legacy_workflow_projection_requires_explicit_compatibility_boundary');
  }
  const resolvedRoot = path.resolve(root);
  const resolvedRuntimeRoot = runtimeRoot ? path.resolve(runtimeRoot) : defaultRuntimeRoot();
  const contextOptions = {
    maxRounds,
    targetOverride,
    datasetRoot,
    benchmarkId,
    datasetLicenseId,
    datasetAuthorizationHash,
    applyManuscript,
    qualityProfile,
    languages,
  };
  const executionContext = execute
    ? bootstrapAutomationContext({
      root: resolvedRoot,
      runtimeRoot: resolvedRuntimeRoot,
      mode: 'paper-batch-campaign-command',
      execute: true,
      writeReport,
      options: contextOptions,
      serviceOverrides,
      submissionHandoffMutationCoordinator,
    })
    : bootstrapBatchInventoryContext({
      root: resolvedRoot,
      runtimeRoot: resolvedRuntimeRoot,
      mode,
      execute: false,
      writeReport,
      readOnly: true,
      allowMissingReadOnlyStore: true,
      options: contextOptions,
      serviceOverrides,
    });
  try {
    const scan = await executionContext.services.inventoryRepository.discover({
      root: resolvedRoot,
      limit,
      paperIds,
      includeRetired,
      includeQuarantined,
      inventorySource,
      proposalStagingRoot: path.join(resolvedRuntimeRoot, 'proposal-staging'),
    });
    const selectedRows = scan.rows.map((row) => qualityProfile
      ? { ...row, task: bindPaperTaskQualityProfile(row.task, qualityProfile) }
      : row);
    const targetScopeReceipt = buildTargetScopeReceipt({
      mode,
      execute,
      requestedPaperIds: paperIds,
      selectedTasks: selectedRows.map((row) => row.task),
      inventorySource: scan.inventorySource,
      inventoryFallback: scan.inventoryFallback,
      limit,
      requireExplicitScope: Boolean(execute),
    });
    if (execute && targetScopeReceipt.status !== 'target_scope_verified') {
      throw new Error(`Target scope gate blocked execution: ${targetScopeReceipt.blockers.join(',')}`);
    }
    const datasetMounts = mode === PAPER_BATCH_MODES.INVENTORY
      ? Object.freeze([])
      : resolveBatchDatasetMounts({
        root: resolvedRoot,
        runtimeRoot: resolvedRuntimeRoot,
        datasetRoot,
        benchmarkId,
        datasetLicenseId,
        datasetAuthorizationHash,
        datasetHarnessEnvelope,
        persistPrivateEnvelope: Boolean(execute),
    });
    const results = [];
    for (const row of selectedRows) {
      const sourceWorkspace = resolveSourceWorkspace(resolvedRoot, row.task, { required: execute });
      const command = sourceWorkspace && targetScopeReceipt.status === 'target_scope_verified'
        ? buildBatchCampaignCommand({
          paperTask: row.task,
          paperState: row.state,
          sourceWorkspace,
          mode,
          maxRounds,
          targetScopeReceipt,
          venueTarget: targetOverride,
          datasetRoot,
          datasetMounts,
          benchmarkId,
          applyManuscript,
          qualityProfile,
          languages,
        })
        : null;
      const campaignSubmission = execute
        ? submitBatchCampaignCommand({
          command,
          campaignStore: executionContext.services.campaignStore,
        })
        : null;
      const recordedAt = campaignSubmission?.campaign?.createdAt || executionContext.services.clock.nowIso();
      const campaignQueue = Object.freeze({
        version: 1,
        kind: 'PaperBatchCampaignQueueStatus',
        status: campaignSubmission?.status || (command ? 'paper_campaign_planned_not_queued' : 'paper_campaign_not_applicable'),
        executionStatus: campaignSubmission?.executionStatus || (command ? 'planned_not_queued' : 'not_applicable'),
        workflowExecutionPerformed: false,
        campaignId: command?.campaignId || null,
        campaignPlanHash: command?.campaignPlanHash || null,
        nodeCount: command?.campaignPlan?.nodes?.length || 0,
        nodeKinds: Object.freeze([...new Set((command?.campaignPlan?.nodes || []).map((node) => node.kind))].sort()),
        requestedMode: command?.requestedMode || mode,
        effectiveMode: command?.campaignPlan?.mode || null,
        releaseHandoffRequired: command?.campaignPlan?.releaseHandoffRequired === true,
        externalSubmissionEnabled: command?.campaignPlan?.externalSubmissionEnabled === true,
        idempotentReplay: Boolean(campaignSubmission?.idempotentReplay),
      });
      const workflowAuthorityLineage = buildWorkflowAuthorityLineage({
        paperId: row.task.paperId,
        mode,
        execute,
        workflowReceiptHash: null,
        campaignId: command?.campaignId || null,
        campaignPlanHash: command?.campaignPlanHash || null,
        legacyProjectionRequested: legacyWorkflowProjection,
        recordedAt,
      });
      const workflowAuthorityLedgerEntry = execute
        ? executionContext.services.receiptLedger.record(workflowAuthorityLineage, {
          stream: 'workflow-authority',
          paperId: row.task.paperId,
        })
        : null;
      const state = row.state;
      const paperStatusProjection = buildCanonicalPaperStatusReadProjection({
        paperId: row.task.paperId,
        observedStatus: row.task.registry?.status || null,
        state,
        recordedAt,
      });
      results.push({
        paperId: row.task.paperId,
        task: row.task,
        state,
        campaignCommand: command,
        campaignPlan: command?.campaignPlan || null,
        campaignSubmission,
        campaignQueue,
        workflowStateProjection: null,
        workflowAuthorityLineage,
        workflowAuthorityLedgerEntry,
        paperStatusProjection,
        workflowRow: paperWorkflowRow(state),
      });
    }
    const report = buildBatchReport({
      root: resolvedRoot,
      runtimeRoot: resolvedRuntimeRoot,
      mode,
      execute,
      targetOverride,
      datasetRoot,
      benchmarkId,
      applyManuscript,
      scan: { ...scan, rows: selectedRows },
      results,
      targetScopeReceipt,
    });
    if (writeReport) {
      await withArtifactWriteContext(executionContext.services, () => persistBatchReport(report));
    }
    return report;
  } finally {
    executionContext.services.persistenceSession.close?.();
  }
}

export const EXPLICIT_LEGACY_WORKFLOW_PROJECTION_BOUNDARY = LEGACY_PROJECTION_BOUNDARY;
export { renderBatchConsole };
