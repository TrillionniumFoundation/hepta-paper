import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANNEL_IDS,
  EXTERNAL_ACTIONS,
  PRODUCT_LINE_IDS,
  canonicalPackageRole,
  canonicalProductLineId,
  canonicalProductLineIdOrNull as canonicalProductLineOrNull,
  computeCustomerMessagePreviewHash,
  createChannelTask,
  createArtifactPackage,
  createReviewReport,
  normalizeText,
  validateWorkflowChain,
} from './contracts.mjs';
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import {
  HUMAN_FEEDBACK_PREVIEW_CLASSES,
  createHumanFeedbackRevisionContract,
  validateHumanFeedbackRevisionContract,
} from './human-feedback-contracts.mjs';
import { digest } from './hash-utils.mjs';
import {
  buildEpwkPlanOnlyMigration,
  buildHeptaPlanOnlyMigration,
  buildZbjPlanOnlyMigration,
} from './migration-shims.mjs';
import { buildPlanOnlyDraft } from './plan-only.mjs';
import { buildDispatchReadinessControlSamples } from './read-only-control-summary.mjs';
import { buildReadOnlyDashboardSnapshot } from './read-only-dashboard-snapshot.mjs';
import { buildReadOnlySampleExportStatus } from './read-only-sample-export-status.mjs';
import { writeTimestampedReportPair } from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(packageRoot, '..');

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function fileExists(filePath) {
  return Boolean(filePath && fs.existsSync(filePath));
}

function basenameList(files = []) {
  return (files || []).map((file) => {
    if (typeof file === 'string') return path.basename(file);
    return path.basename(file?.path || file?.filename || file?.name || '');
  }).filter(Boolean);
}

function fixedTime() {
  return new Date(0).toISOString();
}

function syntheticHash(kind, values = {}) {
  return digest({ kind, ...values });
}

function coverageForChain({ channelTask, brief, plan, artifactPackage, reviewReport }) {
  const fields = {
    channelTask: Boolean(channelTask?.taskKey && channelTask?.title && channelTask?.status && channelTask?.budget !== null),
    creativeBrief: Boolean(brief?.requirementText && brief?.productLineId),
    productionPlan: Boolean(plan?.workflowId && plan?.outputMode),
    artifactPackage: Boolean(artifactPackage?.artifactCount || artifactPackage?.artifacts?.length),
    reviewReport: Boolean(reviewReport?.decision),
  };
  const present = Object.values(fields).filter(Boolean).length;
  return {
    fields,
    present,
    total: Object.keys(fields).length,
    ratio: Number((present / Object.keys(fields).length).toFixed(2)),
  };
}

function mapZbjJob(job) {
  const planPath = job.productionPlanPath || (job.caseDir ? path.join(job.caseDir, 'production-plan.json') : null);
  const indexPath = job.caseDir ? path.join(job.caseDir, 'index.json') : null;
  const reviewPath = job.finalPackageReview || (job.caseDir ? path.join(job.caseDir, 'final-package-review-latest.json') : null);
  const planSource = readJson(planPath, {});
  const caseIndex = readJson(indexPath, {});
  const finalReviewSource = readJson(reviewPath, null);

  const evidenceRefs = [
    { kind: 'path', ref: path.relative(workspaceRoot, 'zbj-auto-intake/data/flow/state.json') },
    planPath ? { kind: 'path', ref: planPath } : null,
    indexPath ? { kind: 'path', ref: indexPath } : null,
    reviewPath && fileExists(reviewPath) ? { kind: 'path', ref: reviewPath } : null,
  ].filter(Boolean);
  const migration = buildZbjPlanOnlyMigration({
    job,
    planSource,
    caseIndex,
    evidenceRefs,
    includeSourceSnapshot: false,
  });
  const { channelTask, draft: planDraft } = migration;
  const { brief, plan } = planDraft.contracts;
  const { productLineId, routeDecision, workflowProfile } = planDraft;

  const reviewFiles = basenameList(finalReviewSource?.files || []);
  const indexFiles = basenameList(caseIndex.files || caseIndex.artifacts || []);
  const artifactNames = reviewFiles.length ? reviewFiles : indexFiles;
  const artifactPackage = createArtifactPackage({
    plan,
    submitReady: Boolean(artifactNames.length && ['package_ready', 'submitted_verified'].includes(job.status)),
    artifacts: artifactNames.map((filename) => ({ filename })),
    provenance: {
      providerId: planSource.providerHints?.provider || null,
      manualProvider: false,
      generatedByCore: false,
    },
    evidenceRefs: indexPath ? [{ kind: 'path', ref: indexPath }] : [],
  });

  const reviewReport = finalReviewSource
    ? createReviewReport({
      artifactPackage,
      decision: finalReviewSource.decision || (finalReviewSource.ok ? 'pass' : 'review'),
      reviewer: 'zbj-final-review',
      checks: finalReviewSource.checks || [],
      blockers: finalReviewSource.blockers || [],
      evidenceRefs: reviewPath ? [{ kind: 'path', ref: reviewPath }] : [],
    })
    : null;

  const validation = validateWorkflowChain({ channelTask, brief, plan, artifactPackage, reviewReport });
  return {
    source: 'zbj',
    taskKey: channelTask.taskKey,
    title: channelTask.title,
    status: job.status,
    productLineId,
    migrationShim: migration.compact,
    planOnly: {
      status: planDraft.status,
      warnings: planDraft.warnings,
      blockers: planDraft.blockers,
      safety: planDraft.safety,
    },
    routeDecision,
    outputMode: plan.outputMode,
    workflowProfile,
    artifactCount: artifactPackage.artifactCount,
    reviewDecision: reviewReport?.decision || null,
    coverage: coverageForChain({ channelTask, brief, plan, artifactPackage, reviewReport }),
    validation,
    contracts: {
      channelTask,
      brief,
      plan,
      artifactPackage,
      reviewReport,
    },
  };
}

function mapEpwkRecord(record) {
  const evidenceRefs = [
    { kind: 'path', ref: path.relative(workspaceRoot, 'epwk-auto-intake/data/epwk-detail-latest.json') },
    record.workDir ? { kind: 'path', ref: path.join(record.workDir, 'requirement/viewInfo.json') } : null,
  ].filter(Boolean);
  const migration = buildEpwkPlanOnlyMigration({
    record,
    evidenceRefs,
    includeSourceSnapshot: false,
  });
  const { channelTask, draft: planDraft } = migration;
  const { brief, plan } = planDraft.contracts;
  const { productLineId, routeDecision, workflowProfile } = planDraft;

  const validation = validateWorkflowChain({ channelTask, brief, plan });
  return {
    source: 'epwk',
    taskKey: channelTask.taskKey,
    title: channelTask.title,
    status: channelTask.status,
    productLineId,
    migrationShim: migration.compact,
    planOnly: {
      status: planDraft.status,
      warnings: planDraft.warnings,
      blockers: planDraft.blockers,
      safety: planDraft.safety,
    },
    routeDecision,
    outputMode: plan.outputMode,
    workflowProfile,
    artifactCount: null,
    reviewDecision: null,
    coverage: coverageForChain({ channelTask, brief, plan }),
    validation,
    contracts: {
      channelTask,
      brief,
      plan,
    },
  };
}

function mapHeptaOrder(order) {
  const evidenceRefs = [
    {
      kind: 'synthetic',
      ref: 'design-production-core/synthetic/hepta-vectorization-order',
      notes: 'Local read-only Hepta sample; no buyer account or platform state is read.',
    },
  ];
  const migration = buildHeptaPlanOnlyMigration({
    order,
    evidenceRefs,
    includeSourceSnapshot: false,
  });
  const { channelTask, draft: planDraft } = migration;
  const { brief, plan } = planDraft.contracts;
  const { productLineId, routeDecision, workflowProfile } = planDraft;
  const artifactPackage = createArtifactPackage({
    plan,
    packageRole: 'delivery_candidate',
    submitReady: true,
    artifacts: [
      {
        filename: 'hepta-vectorized-logo.svg',
        mimeType: 'image/svg+xml',
        hash: 'sha256:synthetic-hepta-vectorized-logo-svg',
      },
      {
        filename: 'hepta-vectorized-logo.pdf',
        mimeType: 'application/pdf',
        hash: 'sha256:synthetic-hepta-vectorized-logo-pdf',
      },
      {
        filename: 'hepta-vectorized-logo.png',
        mimeType: 'image/png',
        hash: 'sha256:synthetic-hepta-vectorized-logo-png',
      },
    ],
    provenance: {
      providerId: 'hepta-vectorizer-local',
      manualProvider: false,
      generatedByCore: false,
    },
    evidenceRefs,
  });
  const reviewReport = createReviewReport({
    artifactPackage,
    decision: 'pass',
    reviewer: 'hepta-readonly-synthetic-review',
    checks: [
      { id: 'vector_source_package_present', status: 'pass' },
      { id: 'preview_export_present', status: 'pass' },
      { id: 'delivery_package_read_only', status: 'pass' },
    ],
    evidenceRefs,
  });
  const validation = validateWorkflowChain({ channelTask, brief, plan, artifactPackage, reviewReport });
  return {
    source: 'hepta',
    synthetic: true,
    taskKey: channelTask.taskKey,
    title: channelTask.title,
    status: channelTask.status,
    productLineId,
    migrationShim: migration.compact,
    planOnly: {
      status: planDraft.status,
      warnings: planDraft.warnings,
      blockers: planDraft.blockers,
      safety: planDraft.safety,
    },
    routeDecision,
    outputMode: plan.outputMode,
    workflowProfile,
    artifactCount: artifactPackage.artifactCount,
    reviewDecision: reviewReport.decision,
    coverage: coverageForChain({ channelTask, brief, plan, artifactPackage, reviewReport }),
    validation,
    contracts: {
      channelTask,
      brief,
      plan,
      artifactPackage,
      reviewReport,
    },
  };
}

function selectZbjSamples(limit = 5) {
  const state = readJson(path.join(workspaceRoot, 'zbj-auto-intake/data/flow/state.json'), {});
  const jobs = Object.values(state.jobs || {});
  return jobs
    .filter((job) => job?.caseDir && job?.taskId && job?.orderId)
    .filter((job) => ['submitted_verified', 'package_ready', 'blocked_quality'].includes(job.status))
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
    .slice(0, limit)
    .map(mapZbjJob);
}

function selectEpwkSamples(limit = 5) {
  const detail = readJson(path.join(workspaceRoot, 'epwk-auto-intake/data/epwk-detail-latest.json'), {});
  return (detail.records || [])
    .filter((record) => record?.task_id && record?.title)
    .slice(0, limit)
    .map(mapEpwkRecord);
}

function selectHeptaSamples() {
  return [
    mapHeptaOrder({
      orderId: 'hv-readonly-vector-001',
      title: 'Hepta vectorization sample order',
      productLineId: 'vectorization',
      workflowId: 'vectorization',
      outputMode: 'vector_package',
      amount: 19,
      status: 'paid',
      requirementText: 'Vectorize buyer supplied logo into clean SVG, PDF, and PNG delivery files.',
      sourceAsset: {
        kind: 'synthetic',
        ref: 'design-production-core/synthetic/hepta-source-logo.png',
        hash: 'sha256:synthetic-hepta-source-logo',
      },
      artifactCount: 3,
      qualityGates: [
        'path_cleanliness',
        'visual_match_to_source',
        'svg_pdf_png_export_integrity',
      ],
    }),
  ];
}

function mapSyntheticHumanFeedbackSample({
  source,
  channelId,
  externalId,
  title,
  requirementText,
  activeChange,
  targetFilename,
}) {
  const channelTask = createChannelTask({
    channelId,
    externalId,
    title,
    status: 'human_feedback_ready',
    rawCategory: 'human feedback revision',
    sourceSnapshot: {
      kind: 'SyntheticHumanFeedbackSource',
      capturedAt: fixedTime(),
      readOnly: true,
    },
    evidenceRefs: [
      {
        kind: 'synthetic',
        ref: `design-production-core/synthetic/${channelId}/${externalId}/feedback-source`,
        hash: syntheticHash('SyntheticHumanFeedbackSourceRef', { channelId, externalId }),
      },
    ],
    createdAt: fixedTime(),
  });
  const sourceRef = {
    kind: 'synthetic',
    ref: `design-production-core/synthetic/${channelId}/${externalId}/human-feedback-thread`,
    hash: syntheticHash('SyntheticHumanFeedbackThread', { channelId, externalId, activeChange }),
    notes: 'Read-only synthetic feedback thread for cross-channel human-feedback sample coverage.',
  };
  const targetHash = syntheticHash('SyntheticHumanFeedbackTargetArtifact', { channelId, externalId, targetFilename });
  const baselineHash = syntheticHash('SyntheticHumanFeedbackBaselineInvariant', { channelId, externalId, targetFilename });
  const humanFeedbackRevisionContract = createHumanFeedbackRevisionContract({
    taskKey: channelTask.taskKey,
    channelId,
    externalId,
    workflowId: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
    sourceSnapshot: {
      refreshedAt: fixedTime(),
      refs: [sourceRef],
    },
    sourceSnapshotHash: syntheticHash('SyntheticHumanFeedbackSourceSnapshot', { channelId, externalId, sourceRefHash: sourceRef.hash }),
    targetArtifact: {
      artifactId: `${externalId}:selected-artifact`,
      filename: targetFilename,
      hash: targetHash,
      description: 'Selected baseline artifact for one atomic human-feedback revision.',
    },
    baselineInvariantLock: {
      locked: true,
      invariantHashes: [baselineHash],
      lockedFacts: [
        'Preserve accepted baseline geometry and brand text.',
        'Only the active buyer-requested correction may change.',
      ],
    },
    atomicQueue: [
      {
        id: 'change-1',
        status: 'active',
        description: activeChange,
        sourceRef: sourceRef.ref,
        targetArtifactId: `${externalId}:selected-artifact`,
      },
    ],
    activeAtomicChange: {
      id: 'change-1',
      description: activeChange,
    },
    unchangedRegressionChecklist: [
      'baseline_geometry_preserved',
      'brand_text_unchanged',
      'non_requested_regions_unchanged',
    ],
    previewClass: HUMAN_FEEDBACK_PREVIEW_CLASSES.CUSTOMER_FACING_REVISION,
    exitAction: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
    generationPolicy: {
      localOnly: false,
      providerSpendRequiresApproval: true,
    },
    evidenceRefs: [sourceRef],
    createdAt: fixedTime(),
  });
  const planDraft = buildPlanOnlyDraft({
    channelTask,
    routeInput: {
      productLineId: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
      workflowId: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
      title,
      requirementText,
    },
    requirementText,
    subject: {
      projectText: title,
      mustUseText: [activeChange],
      forbiddenText: ['Do not reinterpret unrelated accepted areas.'],
    },
    artifactCount: 1,
    humanFeedbackRevisionContract,
    evidenceRefs: [sourceRef],
    createdAt: fixedTime(),
  });
  const { channelTask: draftedTask, brief, plan } = planDraft.contracts;
  const artifactPackage = createArtifactPackage({
    plan,
    packageRole: 'human_feedback_revision',
    submitReady: false,
    artifacts: [
      {
        id: `${externalId}:revision-preview`,
        role: 'human_feedback_revision_preview',
        filename: targetFilename,
        hash: targetHash,
        mimeType: targetFilename.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
      },
    ],
    humanFeedbackRevisionContract,
    provenance: {
      providerId: `${source}-readonly-feedback-synthetic`,
      manualProvider: false,
      generatedByCore: false,
    },
    evidenceRefs: [sourceRef],
    createdAt: fixedTime(),
  });
  const reviewReport = createReviewReport({
    artifactPackage,
    decision: 'pass',
    reviewer: `${source}-readonly-feedback-review`,
    checks: [
      { id: 'one_active_correction_per_iteration', status: 'pass' },
      { id: 'baseline_invariant_lock_preserved', status: 'pass' },
      { id: 'customer_facing_preview_classified', status: 'pass' },
    ],
    evidenceRefs: [sourceRef],
    createdAt: fixedTime(),
  });
  const validation = validateWorkflowChain({
    channelTask: draftedTask,
    brief,
    plan,
    artifactPackage,
    reviewReport,
  });
  const contractValidation = validateHumanFeedbackRevisionContract(humanFeedbackRevisionContract, {
    context: {
      taskKey: draftedTask.taskKey,
      channelId: draftedTask.channelId,
      externalId: draftedTask.externalId,
    },
  });
  const customerFacingValidation = validateHumanFeedbackRevisionContract(humanFeedbackRevisionContract, {
    externalAction: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
    reviewReport,
    requireCustomerFacing: true,
    context: {
      taskKey: draftedTask.taskKey,
      channelId: draftedTask.channelId,
      externalId: draftedTask.externalId,
    },
  });
  const messagePreview = normalizeText(`We reviewed your feedback and prepared one focused revision: ${activeChange}`);
  return {
    source,
    synthetic: true,
    taskKey: draftedTask.taskKey,
    title: draftedTask.title,
    status: draftedTask.status,
    productLineId: planDraft.productLineId,
    migrationShim: {
      source,
      synthetic: true,
      humanFeedbackRevisionContractHash: humanFeedbackRevisionContract.contractHash,
    },
    planOnly: {
      status: planDraft.status,
      warnings: planDraft.warnings,
      blockers: planDraft.blockers,
      safety: planDraft.safety,
    },
    routeDecision: planDraft.routeDecision,
    outputMode: plan.outputMode,
    workflowProfile: planDraft.workflowProfile,
    artifactCount: artifactPackage.artifactCount,
    reviewDecision: reviewReport.decision,
    humanFeedback: {
      contractHash: humanFeedbackRevisionContract.contractHash,
      sourceSnapshotHash: humanFeedbackRevisionContract.sourceSnapshot.hash,
      targetArtifactHash: targetHash,
      activeAtomicChangeId: humanFeedbackRevisionContract.activeAtomicChange.id,
      previewClass: humanFeedbackRevisionContract.previewClass,
      exitAction: humanFeedbackRevisionContract.exitAction,
      messagePreviewHash: computeCustomerMessagePreviewHash(messagePreview),
      contractValidation: {
        ok: contractValidation.ok,
        blockers: contractValidation.blockers.map((blocker) => blocker.code),
        warnings: contractValidation.warnings.map((warning) => warning.code),
      },
      customerFacingValidation: {
        ok: customerFacingValidation.ok,
        blockers: customerFacingValidation.blockers.map((blocker) => blocker.code),
        warnings: customerFacingValidation.warnings.map((warning) => warning.code),
      },
    },
    coverage: coverageForChain({
      channelTask: draftedTask,
      brief,
      plan,
      artifactPackage,
      reviewReport,
    }),
    validation,
    contracts: {
      channelTask: draftedTask,
      brief,
      plan,
      artifactPackage,
      reviewReport,
    },
  };
}

function selectHumanFeedbackSamples() {
  return [
    mapSyntheticHumanFeedbackSample({
      source: 'zbj',
      channelId: CHANNEL_IDS.ZBJ,
      externalId: 'readonly-feedback-zbj-001',
      title: 'ZBJ human feedback revision sample',
      requirementText: 'Buyer asks for one post-submit logo refinement while preserving all accepted baseline regions.',
      activeChange: 'Refine the selected symbol stroke weight without changing the accepted wordmark.',
      targetFilename: 'zbj-feedback-revision-preview.png',
    }),
    mapSyntheticHumanFeedbackSample({
      source: 'epwk',
      channelId: CHANNEL_IDS.EPWK,
      externalId: 'readonly-feedback-epwk-001',
      title: 'EPWK human feedback revision sample',
      requirementText: 'Buyer feedback requests one focused preview correction before a customer-facing message handoff.',
      activeChange: 'Adjust the approved package accent color only, keeping layout and product text locked.',
      targetFilename: 'epwk-feedback-revision-preview.png',
    }),
    mapSyntheticHumanFeedbackSample({
      source: 'hepta',
      channelId: CHANNEL_IDS.HEPTA,
      externalId: 'readonly-feedback-hepta-001',
      title: 'Hepta human feedback revision sample',
      requirementText: 'Buyer requests one vector cleanup change after reviewing the previous delivery preview.',
      activeChange: 'Clean the selected curve join while preserving the accepted logo geometry.',
      targetFilename: 'hepta-feedback-revision-preview.svg',
    }),
  ];
}

function summarize(samples) {
  const bySource = {};
  const byProductLine = {};
  const byWorkflowProfile = {};
  const byPlanOnlyStatus = {};
  const humanFeedbackBySource = {};
  let confidenceTotal = 0;
  let humanFeedbackContractReady = 0;
  let humanFeedbackCustomerFacingReady = 0;
  for (const sample of samples) {
    bySource[sample.source] = (bySource[sample.source] || 0) + 1;
    const productLineId = canonicalProductLineId(sample.productLineId || '');
    byProductLine[productLineId] = (byProductLine[productLineId] || 0) + 1;
    const workflowId = canonicalProductLineId(sample.workflowProfile?.workflowId || sample.workflowId || '') || 'unknown';
    byWorkflowProfile[workflowId] = (byWorkflowProfile[workflowId] || 0) + 1;
    const planOnlyStatus = sample.planOnly?.status || 'unknown';
    byPlanOnlyStatus[planOnlyStatus] = (byPlanOnlyStatus[planOnlyStatus] || 0) + 1;
    confidenceTotal += sample.routeDecision?.confidence || 0;
    if (sampleLooksHumanFeedback(sample, { productLineId, workflowId })) {
      humanFeedbackBySource[sample.source] = (humanFeedbackBySource[sample.source] || 0) + 1;
      if (sample.humanFeedback?.contractValidation?.ok === true) humanFeedbackContractReady += 1;
      if (sample.humanFeedback?.customerFacingValidation?.ok === true) humanFeedbackCustomerFacingReady += 1;
    }
  }
  const humanFeedbackSampleCount = samples.filter((sample) => sampleLooksHumanFeedback(sample)).length;
  return {
    sampleCount: samples.length,
    bySource,
    byProductLine,
    byWorkflowProfile,
    byPlanOnlyStatus,
    planOnlyBlocked: samples.filter((sample) => sample.planOnly?.blockers?.length).length,
    validationOk: samples.every((sample) => sample.validation.ok),
    averageCoverage: Number((samples.reduce((sum, sample) => sum + sample.coverage.ratio, 0) / Math.max(samples.length, 1)).toFixed(2)),
    averageRouteConfidence: Number((confidenceTotal / Math.max(samples.length, 1)).toFixed(2)),
    humanFeedback: {
      sampleCount: humanFeedbackSampleCount,
      bySource: humanFeedbackBySource,
      requiredSources: [CHANNEL_IDS.ZBJ, CHANNEL_IDS.EPWK, CHANNEL_IDS.HEPTA],
      contractReadyCount: humanFeedbackContractReady,
      customerFacingReadyCount: humanFeedbackCustomerFacingReady,
    },
  };
}

function sampleLooksHumanFeedback(sample = {}, precomputed = {}) {
  const productLineId = precomputed.productLineId ?? canonicalProductLineId(sample.productLineId || '');
  const workflowId = precomputed.workflowId ?? canonicalProductLineId(sample.workflowProfile?.workflowId || sample.workflowId || '');
  const roleFields = [
    sample.packageRole,
    sample.reviewType,
    sample.role,
    sample.workflowProfile?.packageRole,
    sample.workflowProfile?.reviewType,
    sample.workflowProfile?.role,
    sample.humanFeedback?.packageRole,
    sample.humanFeedback?.reviewType,
    sample.humanFeedback?.role,
  ];
  return productLineId === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
    || workflowId === PRODUCT_LINE_IDS.HUMAN_FEEDBACK
    || roleFields.some((value) => canonicalProductLineId(canonicalPackageRole(value)) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK);
}

function canonicalSamplePackageRole(sample = {}) {
  return canonicalPackageRole(sample.packageRole || sample.workflowProfile?.packageRole || '') || null;
}

function canonicalSampleReviewType(sample = {}) {
  return canonicalPackageRole(sample.reviewType || sample.workflowProfile?.reviewType || '') || null;
}

function canonicalSampleRole(sample = {}) {
  return canonicalPackageRole(sample.role || sample.workflowProfile?.role || '') || null;
}

export function buildUnsupportedInventory(samples) {
  const byBlocker = {};
  const items = samples
    .filter((sample) => (sample.planOnly?.blockers || []).length > 0)
    .map((sample) => {
      for (const blocker of sample.planOnly.blockers) {
        byBlocker[blocker] = (byBlocker[blocker] || 0) + 1;
      }
      return {
        source: sample.source,
        taskKey: sample.taskKey,
        title: sample.title,
        productLineId: canonicalProductLineOrNull(sample.productLineId),
        workflowId: canonicalProductLineOrNull(sample.workflowProfile?.workflowId || sample.workflowId),
        packageRole: canonicalSamplePackageRole(sample),
        reviewType: canonicalSampleReviewType(sample),
        role: canonicalSampleRole(sample),
        planOnlyStatus: sample.planOnly?.status || null,
        blockers: sample.planOnly?.blockers || [],
        warnings: sample.planOnly?.warnings || [],
        routeConfidence: sample.routeDecision?.confidence ?? null,
        operatorDisposition: 'unsupported_or_needs_clarification',
      };
    });
  return {
    version: 1,
    count: items.length,
    byBlocker,
    items,
    safety: {
      readOnly: true,
      grantsExecutionPermission: false,
      externalActions: false,
    },
  };
}

function renderCountMap(counts = {}) {
  return Object.entries(counts || {}).map(([key, value]) => `${key}=${value}`).join(', ');
}

function renderProductCountMap(counts = {}) {
  const canonicalCounts = {};
  for (const [key, value] of Object.entries(counts || {})) {
    const canonicalKey = canonicalProductLineId(key) || 'unknown';
    const count = Number.isFinite(Number(value)) ? Number(value) : 0;
    canonicalCounts[canonicalKey] = (canonicalCounts[canonicalKey] || 0) + count;
  }
  return renderCountMap(canonicalCounts);
}

export function renderReadOnlySampleExportMarkdown(payload) {
  const rows = payload.samples.map((sample) => [
    sample.source,
    sample.taskKey,
    canonicalProductLineOrNull(sample.productLineId) || '',
    canonicalProductLineOrNull(sample.workflowProfile?.workflowId || sample.workflowId) || '',
    canonicalSamplePackageRole(sample) || '',
    canonicalSampleReviewType(sample) || '',
    canonicalSampleRole(sample) || '',
    sample.outputMode,
    sample.planOnly?.status || '',
    sample.planOnly?.blockers?.join(', ') || '',
    sample.routeDecision?.confidence ?? '',
    sample.coverage.ratio,
    sample.validation.ok ? 'ok' : sample.validation.issues.map((issue) => issue.code).join(', '),
  ]);
  const unsupportedRows = (payload.unsupportedInventory.items || []).map((item) => [
    item.source,
    item.taskKey,
    item.productLineId,
    item.workflowId || '',
    item.packageRole || '',
    item.reviewType || '',
    item.role || '',
    item.planOnlyStatus || '',
    item.blockers.join(', '),
    item.warnings.join(', '),
    item.routeConfidence ?? '',
    item.operatorDisposition,
  ]);
  const readinessRows = (payload.controlPlane.dispatchReadiness.reports || []).map((report) => [
    report.name,
    report.channelId || '',
    report.actionId || '',
    report.runnerId || '',
    report.packageRole || '',
    report.reviewType || '',
    report.role || '',
    report.status,
    report.readyForExternalRunner ? 'yes' : 'no',
    report.failedCheckIds.join(', ') || '',
    report.operatorHintCodes.join(', ') || '',
  ]);
  return [
    '# Read-only Core Sample Export',
    '',
    `Generated at: ${payload.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Export status: ${payload.status}, ok=${payload.ok ? 'yes' : 'no'}`,
    `- Samples: ${payload.summary.sampleCount}`,
    `- Sources: ${renderCountMap(payload.summary.bySource)}`,
    `- Product lines: ${renderProductCountMap(payload.summary.byProductLine)}`,
    `- Workflow profiles: ${renderProductCountMap(payload.summary.byWorkflowProfile)}`,
    `- Human feedback samples: ${payload.summary.humanFeedback.sampleCount} (sources: ${renderCountMap(payload.summary.humanFeedback.bySource) || 'none'}, contract-ready=${payload.summary.humanFeedback.contractReadyCount}, customer-facing-ready=${payload.summary.humanFeedback.customerFacingReadyCount})`,
    `- Plan-only status: ${renderCountMap(payload.summary.byPlanOnlyStatus)}`,
    `- Plan-only blocked: ${payload.summary.planOnlyBlocked}`,
    `- Unsupported inventory: ${payload.unsupportedInventory.count}`,
    `- Validation: ${payload.summary.validationOk ? 'PASS' : 'REVIEW'}`,
    `- Average coverage: ${payload.summary.averageCoverage}`,
    `- Average route confidence: ${payload.summary.averageRouteConfidence}`,
    `- Dispatch readiness: ${renderCountMap(payload.controlPlane.dispatchReadiness.summary.byStatus)}`,
    `- Dispatch hint catalog: resolved=${payload.controlPlane.dispatchReadiness.operatorHintSummary.resolvedCount}/${payload.controlPlane.dispatchReadiness.operatorHintSummary.count}, unknown=${payload.controlPlane.dispatchReadiness.operatorHintSummary.unknownCount}, catalog=${payload.controlPlane.dispatchReadiness.operatorHintSummary.catalogCount}`,
    `- Control dashboard status: ${payload.controlPlane.dispatchReadiness.dashboardStatus.status}, ready=${payload.controlPlane.dispatchReadiness.dashboardStatus.readyForDashboard ? 'yes' : 'no'}, blockedHandoffs=${payload.controlPlane.dispatchReadiness.dashboardStatus.metrics.blockedHandoffs}`,
    `- Dashboard snapshot: ${payload.dashboardSnapshot.status}, ready=${payload.dashboardSnapshot.readyForDashboard ? 'yes' : 'no'}, warnings=${payload.dashboardSnapshot.warnings.length}, blockers=${payload.dashboardSnapshot.blockers.length}`,
    `- Export status hash: ${payload.exportStatus.statusHash}`,
    '',
    '## Samples',
    '',
    '| Source | Task | Product line | Workflow | Package role | Review type | Role | Output mode | Plan-only | Plan blockers | Route confidence | Coverage | Validation |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: | --- |',
    ...rows.map((row) => `| ${row.join(' | ')} |`),
    '',
    '## Unsupported Inventory',
    '',
    '| Source | Task | Product line | Workflow | Package role | Review type | Role | Plan-only | Blockers | Warnings | Route confidence | Operator disposition |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: | --- |',
    ...(unsupportedRows.length ? unsupportedRows.map((row) => `| ${row.join(' | ')} |`) : ['| none |  |  |  |  |  |  |  |  |  |  |  |']),
    '',
    '## Dispatch Readiness',
    '',
    '| Name | Channel | Action | Runner | Package role | Review type | Role | Status | Ready | Failed checks | Operator hints |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...readinessRows.map((row) => `| ${row.join(' | ')} |`),
    '',
    '## Safety',
    '',
    '- Read-only local export only.',
    '- No provider/model spend.',
    '- No live prepare, upload, submit, acceptance, payment, profile change, or customer message.',
    '',
  ].join('\n');
}

function main() {
  const generatedAt = new Date().toISOString();
  const samples = [
    ...selectZbjSamples(5),
    ...selectEpwkSamples(5),
    ...selectHeptaSamples(),
    ...selectHumanFeedbackSamples(),
  ];
  const summary = summarize(samples);
  const unsupportedInventory = buildUnsupportedInventory(samples);
  const controlPlane = buildDispatchReadinessControlSamples();
  const dashboardSnapshot = buildReadOnlyDashboardSnapshot({
    sampleSummary: summary,
    controlPlane,
    samples,
    generatedAt,
  });
  const exportStatus = buildReadOnlySampleExportStatus({
    sampleSummary: summary,
    dashboardSnapshot,
    generatedAt,
  });
  const payload = {
    version: 1,
    generatedAt,
    status: exportStatus.status,
    ok: exportStatus.ok,
    safety: {
      readOnly: true,
      externalActions: false,
      providerSpend: false,
      livePrepare: false,
      liveSubmit: false,
    },
    summary,
    unsupportedInventory,
    controlPlane,
    dashboardSnapshot,
    exportStatus,
    samples,
  };
  const stamp = generatedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const markdown = renderReadOnlySampleExportMarkdown(payload);
  const reportFiles = writeTimestampedReportPair({
    report: payload,
    fileId: 'read-only-samples-latest.json',
    markdownFileId: 'read-only-samples-latest.md',
    timestampedFileId: `read-only-samples-${stamp}.json`,
    timestampedMarkdownFileId: `read-only-samples-${stamp}.md`,
    markdown,
  });
  console.log(JSON.stringify({
    ok: payload.ok,
    status: payload.status,
    samples: payload.summary.sampleCount,
    bySource: payload.summary.bySource,
    byProductLine: payload.summary.byProductLine,
    byPlanOnlyStatus: payload.summary.byPlanOnlyStatus,
    dispatchReadiness: payload.controlPlane.dispatchReadiness.summary.byStatus,
    dispatchHintCatalog: {
      resolved: payload.controlPlane.dispatchReadiness.operatorHintSummary.resolvedCount,
      total: payload.controlPlane.dispatchReadiness.operatorHintSummary.count,
      unknown: payload.controlPlane.dispatchReadiness.operatorHintSummary.unknownCount,
      catalog: payload.controlPlane.dispatchReadiness.operatorHintSummary.catalogCount,
    },
    dashboardStatus: {
      status: payload.controlPlane.dispatchReadiness.dashboardStatus.status,
      ready: payload.controlPlane.dispatchReadiness.dashboardStatus.readyForDashboard,
      blockedHandoffs: payload.controlPlane.dispatchReadiness.dashboardStatus.metrics.blockedHandoffs,
      unknownOperatorHintCount: payload.controlPlane.dispatchReadiness.dashboardStatus.metrics.unknownOperatorHintCount,
    },
    dashboardSnapshot: {
      status: payload.dashboardSnapshot.status,
      ready: payload.dashboardSnapshot.readyForDashboard,
      warnings: payload.dashboardSnapshot.warnings.length,
      blockers: payload.dashboardSnapshot.blockers.length,
      hash: payload.dashboardSnapshot.snapshotHash,
    },
    exportStatus: {
      status: payload.exportStatus.status,
      ok: payload.exportStatus.ok,
      warnings: payload.exportStatus.warnings.length,
      blockers: payload.exportStatus.blockers.length,
      hash: payload.exportStatus.statusHash,
    },
    planOnlyBlocked: payload.summary.planOnlyBlocked,
    unsupportedInventory: payload.unsupportedInventory.count,
    averageCoverage: payload.summary.averageCoverage,
    averageRouteConfidence: payload.summary.averageRouteConfidence,
    report: path.relative(packageRoot, reportFiles.latestMd),
  }, null, 2));
}

if (isCliEntrypoint(import.meta.url)) main();
