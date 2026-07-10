import { buildPlanOnlyDraft } from './plan-only.mjs';
import { canonicalProductLineId } from './contracts.mjs';
import {
  channelTaskFromEpwk,
  channelTaskFromHepta,
  channelTaskFromZbj,
} from './adapters/index.mjs';

export const MIGRATION_SHIM_VERSION = 1;

function basenameLike(value) {
  return value || null;
}

function evidenceRefsFrom(...values) {
  return values
    .flat()
    .filter(Boolean)
    .map((item) => {
      if (typeof item === 'string') return { kind: 'path', ref: item };
      return item;
    });
}

function epwkDefaultLiveRules(record = {}) {
  return {
    platform: 'epwk',
    maxFilesPerSubmit: record.maxFilesPerSubmit || 3,
    maxFileSizeMb: record.maxFileSizeMb || 2,
    allowedExtensions: record.allowedExtensions || ['jpg', 'png', 'gif'],
    source: 'epwk read-only manuscript schema probe',
  };
}

function compactDraft(draft) {
  return {
    taskKey: draft.taskKey,
    channelId: draft.channelId,
    productLineId: draft.productLineId,
    workflowId: draft.workflowId,
    outputMode: draft.outputMode,
    status: draft.status,
    warnings: draft.warnings,
    blockers: draft.blockers,
    safety: draft.safety,
  };
}

export function buildZbjPlanOnlyMigration({
  job = {},
  planSource = {},
  caseIndex = {},
  evidenceRefs = [],
  includeSourceSnapshot = false,
} = {}) {
  const channelTask = channelTaskFromZbj({
    taskId: job.taskId || planSource.taskId,
    orderId: job.orderId || planSource.orderId,
    title: job.title || planSource.title,
    amount: job.amount || planSource.amount,
    categoryName: job.category3Name || planSource.category3Name || planSource.categoryName,
    status: job.status || planSource.status,
    url: job.orderId ? `https://task.zbj.com/speed/${job.orderId}` : job.url || planSource.url,
    evidenceRefs,
  }, { includeSourceSnapshot });

  const subject = planSource.semanticContract?.subject || planSource.subject || {};
  const liveRules = planSource.submitLimitSpec || planSource.liveSubmitRules || null;
  const draft = buildPlanOnlyDraft({
    channelTask,
    routeInput: {
      channelId: 'zbj',
      productLineId: planSource.productLineId,
      kind: planSource.kind || job.kind,
      workflowId: planSource.workflowId,
      semanticRoute: planSource.semanticRoute || planSource.routeContract || planSource.semanticContract?.route || null,
      routeContract: planSource.routeContract || planSource.semanticRoute || planSource.semanticContract?.routeContract || null,
      title: planSource.title || job.title,
      category: job.category3Name || planSource.category3Name || planSource.categoryName,
      requirementText: planSource.requirementExcerpt || planSource.requirementText,
    },
    requirementText: planSource.requirementExcerpt || planSource.requirementText || planSource.title || job.title || 'ZBJ task brief unavailable in local sample.',
    subject: {
      projectText: subject.projectText || planSource.projectText || job.title,
      brandText: subject.brandText || planSource.brandText || job.brandText,
      productText: subject.productText || planSource.subject?.productText,
      mustUseText: subject.mustUseText || [],
      forbiddenText: subject.forbiddenText || [],
    },
    industrySpec: planSource.industrySpec || null,
    semanticContract: planSource.semanticContract || null,
    designReferenceSpec: planSource.designReferenceSpec || null,
    liveRules,
    artifactCount: planSource.outputCount || liveRules?.expectedFinalFiles || caseIndex.submitReadyCount || job.caseSubmitReadyCount || null,
    providerPolicy: planSource.providerHints || null,
    qualityGates: planSource.qualityGates || null,
    evidenceRefs,
  });

  return {
    version: MIGRATION_SHIM_VERSION,
    source: 'zbj',
    channelTask,
    draft,
    compact: compactDraft(draft),
  };
}

export function buildEpwkPlanOnlyMigration({
  record = {},
  liveRules = null,
  evidenceRefs = [],
  includeSourceSnapshot = false,
} = {}) {
  const channelTask = channelTaskFromEpwk({
    task_id: record.task_id || record.taskId,
    task_title: record.title || record.task_title,
    task_cash: record.cashStr || record.cash?.raw || record.task_cash,
    status_name: record.statusName || record.status_name,
    category_name: record.categoryTitle || record.category,
    deadline: record.process?.deadlineIso || record.deadline,
    url: record.url,
    evidenceRefs,
  }, { includeSourceSnapshot });

  const draft = buildPlanOnlyDraft({
    channelTask,
    routeInput: {
      channelId: 'epwk',
      title: record.title,
      categoryTitle: record.categoryTitle,
      category: record.category,
      workflowId: record.workflowId,
      productLineId: record.productLineId,
      semanticRoute: record.semanticRoute || record.routeContract || record.semanticContract?.route || null,
      routeContract: record.routeContract || record.semanticRoute || record.semanticContract?.routeContract || null,
      productionType: record.productionType,
      requirementText: record.requirementText,
      deliverables: record.deliverables,
    },
    requirementText: record.requirementText || record.title || 'EPWK task brief unavailable in local sample.',
    subject: {
      projectText: record.title,
      brandText: record.brandText || '',
      productText: record.categoryTitle || record.category || '',
      mustUseText: record.mustUseText || [],
      forbiddenText: record.forbiddenText || [],
    },
    attachmentRefs: (record.downloadedAttachments || record.attachments || []).map((attachment) => ({
      kind: 'path',
      ref: basenameLike(attachment.path || attachment.url || attachment.name),
    })).filter((item) => item.ref),
    buyerConstraints: record.productionType ? [`productionType:${record.productionType}`] : [],
    liveRules: liveRules || epwkDefaultLiveRules(record),
    artifactCount: record.productionType === 'packaging' ? 3 : record.artifactCount || null,
    qualityGates: record.qualityGates || ['semantic_subject_review', 'professional_finish', 'platform_upload_constraints'],
    evidenceRefs,
  });

  return {
    version: MIGRATION_SHIM_VERSION,
    source: 'epwk',
    channelTask,
    draft,
    compact: compactDraft(draft),
  };
}

export function buildHeptaPlanOnlyMigration({
  order = {},
  evidenceRefs = [],
  includeSourceSnapshot = false,
} = {}) {
  const channelTask = channelTaskFromHepta({
    orderId: order.orderId || order.id,
    title: order.title || order.productName || order.skuName,
    amount: order.amount || order.price || order.total,
    status: order.status || order.paymentStatus || order.orderStatus,
    url: order.url || order.orderUrl || order.deliveryUrl,
    category: order.productLineId || order.workflowId || order.sku,
    evidenceRefs,
  }, { includeSourceSnapshot });

  const draft = buildPlanOnlyDraft({
    channelTask,
    routeInput: {
      channelId: 'hepta',
      productLineId: order.productLineId,
      workflowId: order.workflowId,
      semanticRoute: order.semanticRoute || order.routeContract || order.semanticContract?.route || null,
      routeContract: order.routeContract || order.semanticRoute || order.semanticContract?.routeContract || null,
      title: order.title || order.productName || order.skuName,
      category: order.category || order.sku,
      requirementText: order.requirementText || order.notes,
      outputMode: order.outputMode,
    },
    requirementText: order.requirementText || order.notes || order.title || 'Hepta order brief unavailable in local sample.',
    subject: {
      projectText: order.title || order.productName,
      brandText: order.brandText || '',
      productText: order.productText || '',
      mustUseText: order.mustUseText || [],
      forbiddenText: order.forbiddenText || [],
    },
    attachmentRefs: evidenceRefsFrom(order.sourceAsset, order.sourceAssets, order.attachmentRefs),
    buyerConstraints: order.buyerConstraints || [],
    artifactCount: order.artifactCount || null,
    qualityGates: order.qualityGates || null,
    evidenceRefs,
  });

  return {
    version: MIGRATION_SHIM_VERSION,
    source: 'hepta',
    channelTask,
    draft,
    compact: compactDraft(draft),
  };
}

export function summarizeMigrationResults(results = []) {
  const bySource = {};
  const byStatus = {};
  const byProductLine = {};
  for (const result of results) {
    bySource[result.source] = (bySource[result.source] || 0) + 1;
    byStatus[result.draft.status] = (byStatus[result.draft.status] || 0) + 1;
    const productLineId = canonicalProductLineId(result.draft.productLineId || '') || 'unknown';
    byProductLine[productLineId] = (byProductLine[productLineId] || 0) + 1;
  }
  return {
    version: MIGRATION_SHIM_VERSION,
    count: results.length,
    bySource,
    byStatus,
    byProductLine,
    blocked: results.filter((result) => result.draft.blockers?.length).length,
    externalActions: false,
  };
}
