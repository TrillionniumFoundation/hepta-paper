export const PRODUCTION_PLANNER_GATE_CONTRACT_VERSION = 1;

export const CAD_SOURCE_FINAL_FORMATS = Object.freeze([
  'stp',
  'step',
  'stl',
  'obj',
  'fbx',
  'glb',
  'gltf',
  'igs',
  'iges',
  '3dm',
  'x_t',
  'x_b',
  'sldprt',
  'sldasm',
  'prt',
]);

export const PRODUCTION_PLAN_FAILURE_TYPES = Object.freeze({
  MODEL_GATEWAY_TIMEOUT: 'model_gateway_timeout',
  MODEL_CALL_FAILED: 'model_call_failed',
  SELLER_DETAIL_UNAVAILABLE: 'seller_detail_unavailable',
  ATTACHMENT_REFERENCE_BLOCKED: 'attachment_reference_blocked',
  CAD_SOURCE_ATTACHMENT_MISSING: 'cad_source_attachment_missing',
  OFFLINE_VIDEO_SHOOT_NOT_SUPPORTED: 'offline_video_shoot_not_supported',
  SEMANTIC_INTAKE_BLOCKED: 'semantic_intake_blocked',
  SEMANTIC_INDUSTRY_BLOCKED: 'semantic_industry_blocked',
  REFUND_BLOCKED: 'refund_blocked',
  POLICY_BLOCKED: 'policy_blocked',
  PRODUCTION_PLAN_FAILED: 'production_plan_failed',
});

export const PRODUCTION_PLAN_FAILURE_LAST_STEPS = Object.freeze({
  [PRODUCTION_PLAN_FAILURE_TYPES.MODEL_GATEWAY_TIMEOUT]: 'production_plan_failed_model_gateway_timeout',
  [PRODUCTION_PLAN_FAILURE_TYPES.MODEL_CALL_FAILED]: 'production_plan_failed_model_call',
  [PRODUCTION_PLAN_FAILURE_TYPES.SELLER_DETAIL_UNAVAILABLE]: 'production_plan_failed_seller_detail',
  [PRODUCTION_PLAN_FAILURE_TYPES.ATTACHMENT_REFERENCE_BLOCKED]: 'production_plan_failed_attachment_reference',
  [PRODUCTION_PLAN_FAILURE_TYPES.CAD_SOURCE_ATTACHMENT_MISSING]: 'cad_source_attachment_gate',
  [PRODUCTION_PLAN_FAILURE_TYPES.OFFLINE_VIDEO_SHOOT_NOT_SUPPORTED]: 'offline_video_shoot_gate',
  [PRODUCTION_PLAN_FAILURE_TYPES.POLICY_BLOCKED]: 'production_plan_failed_policy',
  [PRODUCTION_PLAN_FAILURE_TYPES.SEMANTIC_INTAKE_BLOCKED]: PRODUCTION_PLAN_FAILURE_TYPES.SEMANTIC_INTAKE_BLOCKED,
  [PRODUCTION_PLAN_FAILURE_TYPES.SEMANTIC_INDUSTRY_BLOCKED]: PRODUCTION_PLAN_FAILURE_TYPES.SEMANTIC_INDUSTRY_BLOCKED,
  [PRODUCTION_PLAN_FAILURE_TYPES.REFUND_BLOCKED]: PRODUCTION_PLAN_FAILURE_TYPES.REFUND_BLOCKED,
  [PRODUCTION_PLAN_FAILURE_TYPES.PRODUCTION_PLAN_FAILED]: PRODUCTION_PLAN_FAILURE_TYPES.PRODUCTION_PLAN_FAILED,
});

export const PRODUCTION_PLANNER_GATE_SAFETY = Object.freeze({
  localGateOnly: true,
  callsProviderOrModel: false,
  opensBrowserOrPlatform: false,
  uploadsOrSubmits: false,
  sendsMessages: false,
  acceptsDelivery: false,
  paysOrDeploys: false,
  grantsExecutionPermission: false,
});

const CAD_SOURCE_FINAL_FORMAT_SET = new Set(CAD_SOURCE_FINAL_FORMATS);

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeFormat(value) {
  return normalizeText(value).toLowerCase().replace(/^\./, '');
}

function attachmentFilename(item = {}) {
  return normalizeText(item.filename || item.name || item.localPath || item.path || '');
}

function attachmentExtension(item = {}) {
  const match = attachmentFilename(item).match(/\.([A-Za-z0-9_+-]+)(?:[?#].*)?$/);
  return match ? normalizeFormat(match[1]) : '';
}

function isCadSourceFormat(value) {
  return CAD_SOURCE_FINAL_FORMAT_SET.has(normalizeFormat(value));
}

export function hasCadSourceAttachment(attachmentSpec = {}) {
  const files = [
    ...(attachmentSpec.attachments || []),
    ...(attachmentSpec.referenceFiles || []),
    ...(attachmentSpec.semanticReferenceFiles || []),
    ...(attachmentSpec.unsupportedFiles || []),
  ];
  return files.some((item) => isCadSourceFormat(attachmentExtension(item)));
}

export function cadSourceAttachmentGate({ task = {}, routeContract = {}, attachmentSpec = {} } = {}) {
  const finalFormats = (routeContract?.finalFormats || []).map(normalizeFormat).filter(Boolean);
  const needsCadSource = finalFormats.some(isCadSourceFormat);
  if (!needsCadSource || hasCadSourceAttachment(attachmentSpec)) return null;
  return {
    ok: false,
    taskId: task.taskId,
    orderId: task.orderId || null,
    blockerType: PRODUCTION_PLAN_FAILURE_TYPES.CAD_SOURCE_ATTACHMENT_MISSING,
    reason: `route contract requires CAD delivery (${finalFormats.join(', ') || 'unknown'}), but no STL/STEP/CAD source attachment is available`,
    finalFormats,
    attachmentCount: attachmentSpec?.attachmentCount || 0,
    attachments: (attachmentSpec?.attachments || []).map((item) => ({
      filename: item.filename || null,
      contentType: item.contentType || null,
      localPath: item.localPath || null,
    })),
    routeContractHash: routeContract?.contractHash || null,
    safety: { ...PRODUCTION_PLANNER_GATE_SAFETY },
  };
}

export function offlineVideoShootGate({ task = {}, requirementText = '' } = {}) {
  const text = [task?.title, task?.category3Name, requirementText].filter(Boolean).join('\n');
  const looksLikeVideoTask = /(?:短视频|视频制作|抖音|快手|拍摄)/i.test(text);
  const needsPhysicalShoot = /(?:本地|店铺|门店|到店|实地|线下|拍摄|模特|工作服|出镜|探店)/i.test(text);
  const isScriptOnly = /(?:脚本|文案|分镜|口播稿|剪辑|字幕|配音)/i.test(text) && !/(?:拍摄|模特|到店|线下|实地)/i.test(text);
  if (!looksLikeVideoTask || !needsPhysicalShoot || isScriptOnly) return null;
  return {
    ok: false,
    taskId: task.taskId,
    orderId: task.orderId || null,
    blockerType: PRODUCTION_PLAN_FAILURE_TYPES.OFFLINE_VIDEO_SHOOT_NOT_SUPPORTED,
    reason: 'task requires local/offline short-video shooting or model/storefront filming, which the local image/package pipeline cannot honestly deliver',
    category3Name: task.category3Name || null,
    title: task.title || null,
    safety: { ...PRODUCTION_PLANNER_GATE_SAFETY },
  };
}

export function actionableGenericRouteContractAccepted(plan = {}, semanticIntake = {}) {
  const routeContract = plan.routeContract || semanticIntake.routeContract || {};
  const subject = plan.subject || semanticIntake.subject || {};
  const workflowId = plan.workflowId || semanticIntake.taskUnderstanding?.workflowId || null;
  const expectedFinalFiles = Number(routeContract.expectedFinalFiles || 0);
  const mustPreserve = Array.isArray(routeContract.mustPreserve) ? routeContract.mustPreserve : [];
  const mustUseText = Array.isArray(subject.mustUseText) ? subject.mustUseText : [];
  const genericRoutePassed = (semanticIntake.checks || []).some((check) => (
    check?.id === 'semantic_workflow_understanding'
    && check?.status === 'pass'
    && /generic_actionable_route_contract/.test(String(check?.notes || ''))
  ));
  return workflowId === 'generic_design'
    && semanticIntake.decision === 'pass'
    && genericRoutePassed
    && routeContract.deliverableType === 'generic_design'
    && ['image_set', 'single_pdf', 'mixed'].includes(String(routeContract.finalArtifactShape || ''))
    && expectedFinalFiles > 0
    && (mustPreserve.length >= 2 || mustUseText.length >= 2);
}

export function softenActionableGenericCorePlanBlocker(coreWorkflowContracts = {}, plan = {}, semanticIntake = {}) {
  if (!actionableGenericRouteContractAccepted(plan, semanticIntake)) return coreWorkflowContracts;
  const originalBlockers = coreWorkflowContracts.blockers || [];
  const blockers = originalBlockers.filter((item) => item !== 'core_plan:generic_design_requires_clarification');
  if (blockers.length === originalBlockers.length) return coreWorkflowContracts;
  return {
    ...coreWorkflowContracts,
    ok: blockers.length === 0,
    blockers,
    actionableGenericRouteContractAccepted: true,
  };
}

export function shouldPromoteNamingLogoToLogoBrand({ kind, semanticIntake, requirementText = '', liveSubmitRules = null } = {}) {
  if (kind !== 'naming_text') return false;
  if (liveSubmitRules?.isNamingBranch === true) return false;
  const subject = semanticIntake?.subject || {};
  const evidence = [
    requirementText,
    subject.projectText,
    subject.productText,
    ...(subject.mustUseText || []),
  ].filter(Boolean).join('\n');
  return /(?:LOGO|logo|标志|商标)/.test(evidence)
    && /(?:中文名|名称|名字|命名|取名|起名|征名)/.test(evidence)
    && /(?:设计对应|搭配|配套|同时|及|和|与).{0,18}(?:LOGO|logo|标志|商标)|(?:LOGO|logo|标志|商标).{0,18}(?:对应|搭配|配套|中文名|名称|名字)/.test(evidence);
}

export function classifyProductionPlanFailure(error) {
  const text = String(error?.stack || error?.message || error || '');
  if (/GatewayTransportError: gateway timeout/i.test(text) || /gateway timeout after \d+ms/i.test(text)) return PRODUCTION_PLAN_FAILURE_TYPES.MODEL_GATEWAY_TIMEOUT;
  if (/model_call_failed/i.test(text) || /openclaw infer model run/i.test(text)) return PRODUCTION_PLAN_FAILURE_TYPES.MODEL_CALL_FAILED;
  if (/seller task detail unavailable/i.test(text)) return PRODUCTION_PLAN_FAILURE_TYPES.SELLER_DETAIL_UNAVAILABLE;
  if (/attachment reference gate failed/i.test(text)) return PRODUCTION_PLAN_FAILURE_TYPES.ATTACHMENT_REFERENCE_BLOCKED;
  if (/cad source attachment missing/i.test(text)) return PRODUCTION_PLAN_FAILURE_TYPES.CAD_SOURCE_ATTACHMENT_MISSING;
  if (/offline video shoot not supported/i.test(text)) return PRODUCTION_PLAN_FAILURE_TYPES.OFFLINE_VIDEO_SHOOT_NOT_SUPPORTED;
  if (/semantic intake blocked/i.test(text)) return PRODUCTION_PLAN_FAILURE_TYPES.SEMANTIC_INTAKE_BLOCKED;
  if (/semantic industry blocked/i.test(text)) return PRODUCTION_PLAN_FAILURE_TYPES.SEMANTIC_INDUSTRY_BLOCKED;
  if (/refund blocked/i.test(text)) return PRODUCTION_PLAN_FAILURE_TYPES.REFUND_BLOCKED;
  if (/policy profile blocks requested actions/i.test(text)) return PRODUCTION_PLAN_FAILURE_TYPES.POLICY_BLOCKED;
  return PRODUCTION_PLAN_FAILURE_TYPES.PRODUCTION_PLAN_FAILED;
}

export function summarizeProductionPlanFailure(error, maxLength = 1200) {
  const text = String(error?.message || error?.stack || error || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

export function productionPlanFailureLastStep(type) {
  return PRODUCTION_PLAN_FAILURE_LAST_STEPS[type] || PRODUCTION_PLAN_FAILURE_TYPES.PRODUCTION_PLAN_FAILED;
}

export function productionPlannerGateContractsSelftest() {
  const cadBlocked = cadSourceAttachmentGate({
    task: { taskId: 1, orderId: 'o1' },
    routeContract: { finalFormats: ['step'], contractHash: 'route1' },
    attachmentSpec: { attachmentCount: 1, attachments: [{ filename: 'brief.pdf', contentType: 'application/pdf' }] },
  });
  const cadPassed = cadSourceAttachmentGate({
    routeContract: { finalFormats: ['stl'] },
    attachmentSpec: { attachments: [{ filename: 'model.STL' }] },
  });
  const offlineVideo = offlineVideoShootGate({
    task: { taskId: 2, title: '短视频拍摄', category3Name: '短视频' },
    requirementText: '需要到店拍摄，模特出镜，展示工作服。',
  });
  const scriptOnly = offlineVideoShootGate({
    task: { title: '短视频脚本', category3Name: '文案' },
    requirementText: '只要脚本、分镜和口播稿。',
  });
  const genericPlan = {
    workflowId: 'generic_design',
    routeContract: {
      deliverableType: 'generic_design',
      finalArtifactShape: 'image_set',
      expectedFinalFiles: 5,
      mustPreserve: ['尺寸', '品牌名'],
    },
    subject: { mustUseText: ['尺寸', '品牌名'] },
  };
  const genericSemantic = {
    decision: 'pass',
    taskUnderstanding: { workflowId: 'generic_design' },
    checks: [{ id: 'semantic_workflow_understanding', status: 'pass', notes: 'generic_actionable_route_contract' }],
  };
  const genericAccepted = actionableGenericRouteContractAccepted(genericPlan, genericSemantic);
  const softened = softenActionableGenericCorePlanBlocker({
    ok: false,
    blockers: ['core_plan:generic_design_requires_clarification'],
  }, genericPlan, genericSemantic);
  const promoted = shouldPromoteNamingLogoToLogoBrand({
    kind: 'naming_text',
    requirementText: '品牌中文名命名，同时设计对应LOGO标志。',
    semanticIntake: { subject: { mustUseText: ['中文名与LOGO配套'] } },
  });
  const failureType = classifyProductionPlanFailure(new Error('GatewayTransportError: gateway timeout after 180000ms'));
  const lastStep = productionPlanFailureLastStep(PRODUCTION_PLAN_FAILURE_TYPES.CAD_SOURCE_ATTACHMENT_MISSING);
  const ok = cadBlocked?.blockerType === PRODUCTION_PLAN_FAILURE_TYPES.CAD_SOURCE_ATTACHMENT_MISSING
    && cadPassed === null
    && offlineVideo?.blockerType === PRODUCTION_PLAN_FAILURE_TYPES.OFFLINE_VIDEO_SHOOT_NOT_SUPPORTED
    && scriptOnly === null
    && genericAccepted === true
    && softened.ok === true
    && softened.actionableGenericRouteContractAccepted === true
    && promoted === true
    && failureType === PRODUCTION_PLAN_FAILURE_TYPES.MODEL_GATEWAY_TIMEOUT
    && lastStep === 'cad_source_attachment_gate';
  return {
    ok,
    cadBlocked,
    offlineVideo,
    genericAccepted,
    softened,
    promoted,
    failureType,
    lastStep,
    safety: { ...PRODUCTION_PLANNER_GATE_SAFETY },
  };
}
