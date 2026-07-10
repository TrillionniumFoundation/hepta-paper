import { digest } from './hash-utils.mjs';

export const STRUCTURE_MODELING_CONTRACT_VERSION = 1;

export const STRUCTURE_MODELING_SAFETY = Object.freeze({
  localContractOnly: true,
  readsFiles: false,
  writesFiles: false,
  callsProviderOrModel: false,
  fetchesChannelState: false,
  mutatesChannelState: false,
  uploads: false,
  submits: false,
  sendsMessages: false,
  acceptsDelivery: false,
  pays: false,
  grantsExecutionPermission: false,
});

export const STRUCTURE_FEEDBACK_BRANCHES = Object.freeze({
  GENERAL_REVISION: 'general_revision',
  STRUCTURE_MODELING: 'structure_modeling',
});

export const STRUCTURE_DELIVERABLES = Object.freeze({
  VISUAL_STRUCTURE_PROPOSAL: 'visual_structure_proposal',
  STRUCTURAL_DRAWING: 'structural_drawing',
  CAD_MODEL: 'cad_model',
});

export const STRUCTURE_CAD_CLAIM_POLICIES = Object.freeze({
  VISUAL_PROPOSAL_ONLY: 'visual_proposal_only',
  SOURCE_CAD_BOUND: 'source_cad_bound',
});

export const STRUCTURE_REQUIRED_VIEW_ALIASES = Object.freeze({
  front: Object.freeze(['front', 'zhengshi', 'main', '正视', '正面', '主视']),
  side: Object.freeze(['side', 'ceshi', '侧视', '侧面']),
  top: Object.freeze(['top', 'fushi', '俯视', '顶视']),
  section: Object.freeze(['section', 'cutaway', '剖面', '剖视']),
  exploded: Object.freeze(['exploded', 'assembly-exploded', 'explode', '爆炸', '拆解', '分解']),
  assembly: Object.freeze(['assembly', 'install', '装配', '安装', '组装']),
});

export const STRUCTURE_DEFAULT_REQUIRED_VIEWS = Object.freeze(['front', 'side', 'top', 'exploded']);

export const STRUCTURE_DEFAULT_REQUIRED_EVIDENCE = Object.freeze([
  'dimensioned orthographic view coverage',
  'assembly or exploded support logic',
  'material, thickness, joint, or manufacturability notes',
  'customer-facing notice: visual structure proposal only when no source CAD is bound',
]);

export const MIN_STRUCTURE_REFEREE_VIEW_BYTES = 50_000;

function text(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function compact(value, limit = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function asList(value) {
  if (value === undefined || value === null || value === false) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap((item) => String(item).split(/\s*,\s*/))
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueStrings(values = [], limit = 128) {
  const raw = Array.isArray(values) ? values : [values];
  const seen = new Set();
  const out = [];
  for (const value of raw.flatMap((item) => (
    Array.isArray(item)
      ? item
      : String(item ?? '').split(/\s*,\s*/)
  ))) {
    const normalized = text(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function explicitBoolean(value, fallback = false) {
  if (value === true || value === false) return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'y', '有', '是'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', '无', '否'].includes(normalized)) return false;
  return fallback;
}

function normalizeRefs(values = []) {
  const raw = Array.isArray(values) ? values : [values];
  return raw.map((item) => {
    if (typeof item === 'string') return { kind: 'path', ref: text(item) };
    return {
      kind: text(item?.kind || 'path') || 'path',
      ref: text(item?.ref || item?.path || item?.url || item?.id || ''),
      hash: text(item?.hash || '') || null,
      notes: text(item?.notes || '') || null,
    };
  }).filter((item) => item.ref);
}

function issue(code, notes = null, level = 'error') {
  return {
    level,
    code,
    notes: text(notes || '') || null,
  };
}

function decisionFromChecks(checks = []) {
  if (checks.some((item) => item.blocking !== false && item.status === 'fail')) return 'fail';
  if (checks.some((item) => item.blocking !== false && item.status !== 'pass')) return 'review';
  return 'pass';
}

function refereeCheck(ok, id, label, notes = null, {
  blocking = true,
  severity = 'normal',
  reviewedAt = new Date().toISOString(),
} = {}) {
  return {
    id,
    label,
    status: ok ? 'pass' : 'fail',
    notes: notes || null,
    blocking,
    severity,
    source: 'structure_modeling_referee',
    appliesTo: 'structure_modeling_revision',
    reviewedAt,
  };
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function viewPattern(view) {
  const aliases = STRUCTURE_REQUIRED_VIEW_ALIASES[view] || [view];
  return new RegExp(aliases.map(escapeRe).join('|'), 'i');
}

export function normalizeStructureFeedbackBranch(value) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[ -]+/g, '_');
  if (!normalized) return STRUCTURE_FEEDBACK_BRANCHES.GENERAL_REVISION;
  if (normalized === STRUCTURE_FEEDBACK_BRANCHES.STRUCTURE_MODELING
    || normalized === 'structure'
    || normalized === 'structural'
    || normalized === 'cad'
    || normalized === 'cad_modeling'
    || normalized === 'modeling'
    || /(?:结构|建模|画结构|cad|stp|step|3d)/i.test(normalized)) {
    return STRUCTURE_FEEDBACK_BRANCHES.STRUCTURE_MODELING;
  }
  if (normalized === STRUCTURE_FEEDBACK_BRANCHES.GENERAL_REVISION || normalized === 'general') {
    return STRUCTURE_FEEDBACK_BRANCHES.GENERAL_REVISION;
  }
  return normalized;
}

export function normalizeStructureDeliverable(value) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[ -]+/g, '_');
  if (!normalized) return STRUCTURE_DELIVERABLES.VISUAL_STRUCTURE_PROPOSAL;
  if ([
    STRUCTURE_DELIVERABLES.CAD_MODEL,
    'cad',
    'cad_source',
    'source_cad',
    'stp',
    'step',
    'stl',
    '3d_model',
  ].includes(normalized)) return STRUCTURE_DELIVERABLES.CAD_MODEL;
  if ([
    STRUCTURE_DELIVERABLES.STRUCTURAL_DRAWING,
    'structure_drawing',
    'drawing',
    'technical_drawing',
    'orthographic',
  ].includes(normalized)) return STRUCTURE_DELIVERABLES.STRUCTURAL_DRAWING;
  if ([
    STRUCTURE_DELIVERABLES.VISUAL_STRUCTURE_PROPOSAL,
    'visual_proposal',
    'structure_proposal',
    'proposal',
    'visual',
    'image_set',
  ].includes(normalized)) return STRUCTURE_DELIVERABLES.VISUAL_STRUCTURE_PROPOSAL;
  return normalized;
}

export function normalizeStructureCadClaimPolicy(value, { deliverableType, sourceCadAvailable } = {}) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[ -]+/g, '_');
  if (!normalized) {
    return deliverableType === STRUCTURE_DELIVERABLES.CAD_MODEL || sourceCadAvailable
      ? STRUCTURE_CAD_CLAIM_POLICIES.SOURCE_CAD_BOUND
      : STRUCTURE_CAD_CLAIM_POLICIES.VISUAL_PROPOSAL_ONLY;
  }
  if ([
    STRUCTURE_CAD_CLAIM_POLICIES.SOURCE_CAD_BOUND,
    'source_bound',
    'cad_source_bound',
    'real_cad',
    'source_cad',
  ].includes(normalized)) return STRUCTURE_CAD_CLAIM_POLICIES.SOURCE_CAD_BOUND;
  if ([
    STRUCTURE_CAD_CLAIM_POLICIES.VISUAL_PROPOSAL_ONLY,
    'visual_only',
    'proposal_only',
    'non_cad',
    'no_cad_claim',
  ].includes(normalized)) return STRUCTURE_CAD_CLAIM_POLICIES.VISUAL_PROPOSAL_ONLY;
  return normalized;
}

export function normalizeStructureRequiredViews(values = []) {
  const rawViews = uniqueStrings(
    Array.isArray(values) && values.length ? values : STRUCTURE_DEFAULT_REQUIRED_VIEWS,
    24,
  ).map((view) => {
    const normalized = String(view ?? '').trim().toLowerCase().replace(/[ -]+/g, '_');
    for (const [canonical, aliases] of Object.entries(STRUCTURE_REQUIRED_VIEW_ALIASES)) {
      if (aliases.some((alias) => normalized.includes(String(alias).toLowerCase()))) return canonical;
    }
    return normalized;
  });
  return uniqueStrings(rawViews, 24);
}

export function normalizeStructureModelingPolicy(policy = {}) {
  const input = policy && typeof policy === 'object' ? policy : {};
  const deliverableType = normalizeStructureDeliverable(
    input.deliverableType
      || input.deliverable
      || input.outputType
      || input.mode
      || input.kind,
  );
  const sourceCadAvailable = explicitBoolean(
    input.sourceCadAvailable
      ?? input.hasSourceCad
      ?? input.cadSourceAvailable
      ?? input.sourceAvailable,
    false,
  );
  const cadClaimPolicy = normalizeStructureCadClaimPolicy(
    input.cadClaimPolicy || input.claimPolicy,
    { deliverableType, sourceCadAvailable },
  );
  const outputFormat = text(input.outputFormat || input.finalArtifactShape || (
    deliverableType === STRUCTURE_DELIVERABLES.CAD_MODEL ? 'cad_source' : 'image_set'
  )) || null;
  return {
    version: STRUCTURE_MODELING_CONTRACT_VERSION,
    deliverableType,
    sourceCadAvailable,
    sourceCadRefs: normalizeRefs(input.sourceCadRefs || input.cadSourceRefs || input.sourceRefs || []),
    geometrySourceRefs: normalizeRefs(input.geometrySourceRefs || input.referenceRefs || input.geometryRefs || []),
    requiredViews: normalizeStructureRequiredViews(input.requiredViews || input.views || []),
    requiredEvidence: uniqueStrings(
      input.requiredEvidence || input.evidenceRequirements || STRUCTURE_DEFAULT_REQUIRED_EVIDENCE,
      32,
    ),
    mustPreserve: uniqueStrings(input.mustPreserve || input.preserve || input.preservedGeometry || [], 64),
    outputFormat,
    cadClaimPolicy,
    customerFacingNoticeRequired: input.customerFacingNoticeRequired !== false
      && cadClaimPolicy === STRUCTURE_CAD_CLAIM_POLICIES.VISUAL_PROPOSAL_ONLY,
    safety: STRUCTURE_MODELING_SAFETY,
  };
}

function checklistText(contract = {}) {
  return [
    ...(contract.unchangedRegressionChecklist || []),
    ...(contract.structureModeling?.requiredEvidence || []),
    ...(contract.structureModeling?.mustPreserve || []),
    contract.activeAtomicChange?.description || '',
    ...(contract.atomicQueue || []).map((item) => item.description || ''),
  ].join('\n');
}

function hasChecklistPattern(contract, pattern) {
  return pattern.test(checklistText(contract));
}

export function validateStructureModelingContract(contract = {}, { stage = null } = {}) {
  const blockers = [];
  const warnings = [];
  const branch = normalizeStructureFeedbackBranch(contract?.humanFeedbackBranch || null);
  if (branch !== STRUCTURE_FEEDBACK_BRANCHES.STRUCTURE_MODELING) {
    return { ok: true, blockers, warnings, safety: STRUCTURE_MODELING_SAFETY };
  }

  const policy = normalizeStructureModelingPolicy(contract.structureModeling || {});
  const customerFacingStage = /human_feedback_(message|im|handoff|delivery|acceptance)/.test(String(stage || '').trim().toLowerCase());
  const validDeliverables = new Set(Object.values(STRUCTURE_DELIVERABLES));
  const validClaimPolicies = new Set(Object.values(STRUCTURE_CAD_CLAIM_POLICIES));

  if (!contract.structureModeling || typeof contract.structureModeling !== 'object') {
    blockers.push(issue('human_feedback_structure_policy_required'));
  }
  if (!validDeliverables.has(policy.deliverableType)) {
    blockers.push(issue('human_feedback_structure_deliverable_invalid', policy.deliverableType));
  }
  if (!validClaimPolicies.has(policy.cadClaimPolicy)) {
    blockers.push(issue('human_feedback_structure_cad_claim_policy_invalid', policy.cadClaimPolicy));
  }
  if (policy.requiredViews.length < 2) {
    blockers.push(issue('human_feedback_structure_views_required'));
  }
  if (!hasChecklistPattern(contract, /(?:dimension|orthographic|front|side|top|尺寸|正视|侧视|俯视|三视图|视图)/i)) {
    blockers.push(issue('human_feedback_structure_dimension_view_check_required'));
  }
  if (!hasChecklistPattern(contract, /(?:assembly|exploded|support|joint|结构|支撑|装配|安装|爆炸|连接|接缝|骨架)/i)) {
    blockers.push(issue('human_feedback_structure_assembly_check_required'));
  }

  if (policy.deliverableType === STRUCTURE_DELIVERABLES.CAD_MODEL) {
    if (policy.sourceCadAvailable !== true || !policy.sourceCadRefs.length) {
      blockers.push(issue('human_feedback_structure_cad_source_required'));
    }
    if (policy.cadClaimPolicy !== STRUCTURE_CAD_CLAIM_POLICIES.SOURCE_CAD_BOUND) {
      blockers.push(issue('human_feedback_structure_cad_source_claim_policy_required'));
    }
  } else {
    if (policy.cadClaimPolicy !== STRUCTURE_CAD_CLAIM_POLICIES.VISUAL_PROPOSAL_ONLY) {
      blockers.push(issue('human_feedback_structure_visual_proposal_claim_policy_required'));
    }
    if (!hasChecklistPattern(contract, /(?:visual proposal only|proposal only|not.*cad|no.*cad|不得.{0,12}(?:cad|stp|step)|非.{0,12}(?:cad|stp|step)|仅.{0,12}(?:结构|方案|示意|图))/i)) {
      blockers.push(issue('human_feedback_structure_visual_proposal_notice_required'));
    }
    if (policy.sourceCadAvailable === true && policy.sourceCadRefs.length) {
      warnings.push(issue('human_feedback_structure_source_cad_available_for_visual_proposal', null, 'warning'));
    }
  }
  if (customerFacingStage && policy.customerFacingNoticeRequired !== true && policy.deliverableType !== STRUCTURE_DELIVERABLES.CAD_MODEL) {
    blockers.push(issue('human_feedback_structure_customer_notice_required'));
  }
  return { ok: blockers.length === 0, blockers, warnings, safety: STRUCTURE_MODELING_SAFETY };
}

export function inspectStructureStepBuffer(buffer) {
  const headText = buffer.subarray(0, Math.min(buffer.length, 2_000_000)).toString('latin1');
  const sampleText = buffer.length <= 25_000_000
    ? buffer.toString('latin1')
    : Buffer.concat([
      buffer.subarray(0, 2_000_000),
      buffer.subarray(Math.max(0, buffer.length - 2_000_000)),
    ]).toString('latin1');
  const tailText = buffer.subarray(Math.max(0, buffer.length - 2_000_000)).toString('latin1');
  const entityMatches = sampleText.match(/#[0-9]+\s*=/g) || [];
  const headerOk = /ISO-10303-21/i.test(headText) && /HEADER\s*;/i.test(headText);
  const dataOk = /DATA\s*;/i.test(sampleText) && /ENDSEC\s*;/i.test(sampleText);
  const endOk = /END-ISO-10303-21\s*;/i.test(tailText);
  return {
    kind: 'step',
    headerOk,
    dataOk,
    endOk,
    entityCountApprox: entityMatches.length,
    ok: headerOk && dataOk && endOk && entityMatches.length > 0,
  };
}

export function inspectStructureStlBuffer(buffer) {
  const size = buffer.length;
  if (size < 84) return { kind: 'stl', ok: false, blocker: 'stl_too_small' };
  const declared = buffer.readUInt32LE(80);
  const binarySize = 84 + declared * 50;
  const binaryLooksValid = declared > 0 && binarySize === size;
  let triangleCount = 0;
  let bbox = null;
  if (binaryLooksValid) {
    triangleCount = declared;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < declared; i += 1) {
      const off = 84 + i * 50 + 12;
      for (let v = 0; v < 3; v += 1) {
        const base = off + v * 12;
        const coords = [buffer.readFloatLE(base), buffer.readFloatLE(base + 4), buffer.readFloatLE(base + 8)];
        for (let axis = 0; axis < 3; axis += 1) {
          const value = coords[axis];
          if (!Number.isFinite(value)) continue;
          min[axis] = Math.min(min[axis], value);
          max[axis] = Math.max(max[axis], value);
        }
      }
    }
    bbox = Number.isFinite(min[0]) ? { min, max, size: max.map((value, axis) => value - min[axis]) } : null;
  } else {
    const textValue = buffer.subarray(0, Math.min(size, 5_000_000)).toString('utf8');
    const vertices = [...textValue.matchAll(/vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g)];
    triangleCount = Math.floor(vertices.length / 3);
    if (vertices.length) {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (const match of vertices) {
        const coords = [Number(match[1]), Number(match[2]), Number(match[3])];
        for (let axis = 0; axis < 3; axis += 1) {
          const value = coords[axis];
          if (!Number.isFinite(value)) continue;
          min[axis] = Math.min(min[axis], value);
          max[axis] = Math.max(max[axis], value);
        }
      }
      bbox = Number.isFinite(min[0]) ? { min, max, size: max.map((value, axis) => value - min[axis]) } : null;
    }
  }
  return {
    kind: 'stl',
    encoding: binaryLooksValid ? 'binary' : 'ascii_or_unknown',
    declaredTriangleCount: declared,
    triangleCount,
    bbox,
    ok: triangleCount > 0 && !!bbox,
  };
}

export function structureViewSatisfied(view, outputs = []) {
  const pattern = viewPattern(view);
  return outputs.some((item) => (
    item.evidence?.exists
    && ['png', 'jpg', 'jpeg', 'svg', 'pdf'].includes(item.ext)
    && pattern.test(item.filename)
  ));
}

export function structureRevisedViewOutput(view, outputs = []) {
  const pattern = viewPattern(view);
  return outputs.find((item) => (
    item.evidence?.exists
    && ['png', 'jpg', 'jpeg', 'svg', 'pdf'].includes(item.ext)
    && pattern.test(item.filename)
    && !/^source-baseline-/i.test(item.filename)
    && /revised|revision|结构|修订|方案|assembly|exploded|section|front|side|top/i.test(item.filename)
  )) || null;
}

export function bestStructureCadOutput(outputs = [], extSet = new Set()) {
  return outputs.find((item) => item.evidence?.exists && extSet.has(item.ext) && item.cad?.ok === true)
    || outputs.find((item) => item.evidence?.exists && extSet.has(item.ext))
    || null;
}

export function primaryStructureManifest(evidence = {}) {
  const manifests = Array.isArray(evidence.manifests) ? evidence.manifests : [];
  return manifests.find((item) => item.json?.kind && /Revised|Structure|Model/i.test(item.json.kind))
    || manifests[0]
    || null;
}

export function partNamesFromStructureManifest(manifest = null) {
  const names = new Set();
  for (const part of manifest?.json?.parts || []) {
    if (part?.name) names.add(String(part.name));
  }
  for (const key of Object.keys(manifest?.json?.outputs?.partStls || {})) names.add(key);
  return [...names];
}

export function structureZMaxFromCadItem(item = null) {
  const value = item?.cad?.bbox?.max?.[2];
  return Number.isFinite(value) ? value : null;
}

export function classifyStructureOutputPackage({ contract = {}, sources = [], outputs = [] } = {}) {
  const blockers = [];
  const warnings = [];
  const policy = normalizeStructureModelingPolicy(contract.structureModeling || {});
  const deliverable = policy.deliverableType || STRUCTURE_DELIVERABLES.VISUAL_STRUCTURE_PROPOSAL;
  const requiredViews = asList(policy.requiredViews || []);
  const existingOutputs = outputs.filter((item) => item.evidence?.exists && item.evidence?.isFile !== false);
  const formats = new Set(existingOutputs.map((item) => item.ext));
  const revisedStepOutputs = existingOutputs.filter((item) => ['stp', 'step'].includes(item.ext));
  const revisedStlOutputs = existingOutputs.filter((item) => item.ext === 'stl');
  const sourceBlockers = sources.flatMap((item) => item.blockers || []);
  for (const blocker of sourceBlockers) blockers.push(blocker);
  for (const source of sources) {
    if (source.cad && source.cad.ok === false) blockers.push(`source_cad_${source.cad.kind || 'file'}_invalid`);
  }
  if (deliverable === STRUCTURE_DELIVERABLES.CAD_MODEL) {
    if (!sources.some((item) => item.caseEvidence?.exists || item.evidence?.exists)) blockers.push('source_cad_required');
    if (!revisedStepOutputs.length) blockers.push('revised_step_output_required');
    else if (!revisedStepOutputs.some((item) => item.cad?.ok === true)) blockers.push('revised_step_output_invalid');
    if (!revisedStlOutputs.length) blockers.push('revised_stl_output_required');
    else if (!revisedStlOutputs.some((item) => item.cad?.ok === true)) blockers.push('revised_stl_output_invalid');
  }
  if (!existingOutputs.length) blockers.push('structure_modeling_output_required');
  for (const view of requiredViews) {
    if (!structureViewSatisfied(view, existingOutputs)) blockers.push(`required_view_missing:${view}`);
  }
  if (formats.has('pdf') && existingOutputs.length === 1 && requiredViews.length) {
    warnings.push('single_pdf_must_contain_all_required_views_manual_or_model_review_required');
  }
  return {
    ok: blockers.length === 0,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    deliverable,
    requiredViews,
    outputCount: existingOutputs.length,
    formats: [...formats].sort(),
    safety: STRUCTURE_MODELING_SAFETY,
  };
}

export function buildStructureRefereePrompt({
  task = {},
  contract = {},
  sources = [],
  outputs = [],
  packageGate = {},
  refereeInputs = {},
} = {}) {
  const requiredViews = asList(contract.structureModeling?.requiredViews || []);
  const revisedStep = bestStructureCadOutput(outputs, new Set(['stp', 'step']));
  const revisedStl = bestStructureCadOutput(outputs, new Set(['stl']));
  const sourceStl = sources.find((item) => item.cad?.kind === 'stl' && item.cad?.ok);
  return [
    '# Structure Modeling Referee Prompt',
    '',
    `Task: ${task.taskId || ''}`,
    `Order: ${task.orderId || ''}`,
    `Branch: ${contract.humanFeedbackBranch || ''}`,
    `Deliverable: ${contract.structureModeling?.deliverableType || ''}`,
    `Contract hash: ${contract.contractHash || ''}`,
    '',
    '## Active Correction',
    compact(contract.activeAtomicChange?.description || contract.activeAtomicChange || contract.activeAtomicChangeId || ''),
    '',
    '## Must Preserve / Regression Locks',
    ...(contract.unchangedRegressionChecklist || []).map((item) => `- ${item}`),
    '',
    '## Source CAD Binding',
    ...sources.map((item) => `- ${item.casePath || item.resolvedPath || item.sourceRef?.ref}: hash=${item.actualHash || 'missing'} expected=${item.expectedHash || 'none'} cadOk=${item.cad?.ok === true}`),
    sourceStl?.cad?.bbox ? `- source STL bbox maxZ=${sourceStl.cad.bbox.max[2]}` : '- source STL bbox unavailable',
    '',
    '## Revised Outputs',
    `- revised STEP: ${revisedStep?.ref || 'missing'} cadOk=${revisedStep?.cad?.ok === true}`,
    `- revised STL: ${revisedStl?.ref || 'missing'} cadOk=${revisedStl?.cad?.ok === true} maxZ=${structureZMaxFromCadItem(revisedStl) ?? 'unknown'}`,
    ...requiredViews.map((view) => `- revised ${view} view: ${structureRevisedViewOutput(view, outputs)?.ref || 'missing'}`),
    '',
    '## Referee Rubric',
    '- PASS only if the active correction is visibly and geometrically represented, not merely described.',
    '- PASS only if unchanged baseline facts are preserved: whale humidifier identity, top cover, lower water tank, support/assembly logic, and no unrelated redesign.',
    '- PASS only if CAD_MODEL has bound source CAD plus revised STEP/STL that parse as CAD/mesh and all required revised views are present.',
    '- FAIL if source baseline renders are counted as revised views, if source files are renamed as outputs, if the active tail-height/split-line correction lacks evidence, or if the model is just a file-shape placeholder.',
    '- When failing, return concrete repair targets that the next repair loop can execute.',
    '',
    '## Local Evidence Summary',
    JSON.stringify({
      packageGate,
      structureManifestRefs: (refereeInputs.evidence?.manifests || []).map((item) => item.ref),
      noteRefs: (refereeInputs.evidence?.notes || []).map((item) => item.ref),
      partNames: refereeInputs.partNames || [],
    }, null, 2),
  ].join('\n');
}

export function buildStructureRefereeReport({
  task = {},
  contract = {},
  sources = [],
  outputs = [],
  packageGate = {},
  evidence = {},
  generatedAt = new Date().toISOString(),
  promptRef = null,
} = {}) {
  const normalizedEvidence = {
    manifests: Array.isArray(evidence.manifests) ? evidence.manifests : [],
    notes: Array.isArray(evidence.notes) ? evidence.notes : [],
    combinedText: String(evidence.combinedText || ''),
  };
  const manifest = primaryStructureManifest(normalizedEvidence);
  const partNames = partNamesFromStructureManifest(manifest);
  const allText = [normalizedEvidence.combinedText, partNames.join('\n')].join('\n').toLowerCase();
  const deliverable = contract.structureModeling?.deliverableType || STRUCTURE_DELIVERABLES.VISUAL_STRUCTURE_PROPOSAL;
  const requiredViews = asList(contract.structureModeling?.requiredViews || []);
  const revisedStep = bestStructureCadOutput(outputs, new Set(['stp', 'step']));
  const revisedStl = bestStructureCadOutput(outputs, new Set(['stl']));
  const sourceStl = sources.find((item) => item.cad?.kind === 'stl' && item.cad?.ok);
  const sourceStep = sources.find((item) => item.cad?.kind === 'step' && item.cad?.ok);
  const sourceMaxZ = structureZMaxFromCadItem(sourceStl);
  const revisedMaxZ = structureZMaxFromCadItem(revisedStl);
  const manifestParams = manifest?.json?.parameters || {};
  const manifestChecks = manifest?.json?.checks || {};
  const tailHeightTargetMode = text(
    manifestChecks.tailHeightTargetMode
      || manifestParams.tail_height_target_mode
      || manifestParams.tailHeightTargetMode
      || '',
  );
  const tailHeightToleranceRaw = Number(
    manifestChecks.tailHeightTolerance
      ?? manifestParams.tail_height_tolerance
      ?? manifestParams.tailHeightTolerance
      ?? 0.002,
  );
  const tailHeightTolerance = Number.isFinite(tailHeightToleranceRaw) ? tailHeightToleranceRaw : 0.002;
  const sourceMaxZTargetRaw = Number(
    manifestChecks.sourceMaxZTarget
      ?? manifestParams.source_max_z_target
      ?? manifestParams.sourceMaxZTarget
      ?? sourceMaxZ,
  );
  const sourceMaxZTarget = Number.isFinite(sourceMaxZTargetRaw) ? sourceMaxZTargetRaw : sourceMaxZ;
  const tailHeightReferenceZ = Number.isFinite(sourceMaxZTarget) ? sourceMaxZTarget : sourceMaxZ;
  const tailHeightDelta = Number.isFinite(tailHeightReferenceZ) && Number.isFinite(revisedMaxZ)
    ? Math.abs(revisedMaxZ - tailHeightReferenceZ)
    : null;
  const tailHeightMatchesSourceByBbox = tailHeightDelta !== null && tailHeightDelta <= tailHeightTolerance;
  const tailLoweredByBbox = Number.isFinite(sourceMaxZ) && Number.isFinite(revisedMaxZ)
    ? revisedMaxZ <= sourceMaxZ * 0.85
    : false;
  const tailHeightTargetIsSourceMatch = /match[_ -]?source[_ -]?max[_ -]?z/i.test(tailHeightTargetMode)
    || manifestChecks.tailHeightMatchesSource === true;
  const tailHeightTargetOk = tailHeightTargetIsSourceMatch
    ? (tailHeightMatchesSourceByBbox || manifestChecks.tailHeightMatchesSource === true)
    : (tailLoweredByBbox || manifestChecks.tailTipBelowOriginal === true);
  const tailHeightTargetLabel = tailHeightTargetIsSourceMatch
    ? 'Revised tail/source-height target matches source maxZ within tolerance.'
    : 'Raised tail is demonstrably lowered versus source for manufacturable tooling.';
  const tailHeightTargetNotes = tailHeightTargetIsSourceMatch
    ? `mode=${tailHeightTargetMode || 'match_source_max_z'} sourceMaxZ=${sourceMaxZ ?? 'unknown'} targetMaxZ=${tailHeightReferenceZ ?? 'unknown'} revisedMaxZ=${revisedMaxZ ?? 'unknown'} delta=${tailHeightDelta ?? 'unknown'} tolerance=${tailHeightTolerance} manifestMatch=${manifestChecks.tailHeightMatchesSource}`
    : `mode=${tailHeightTargetMode || 'tail_lowered'} sourceMaxZ=${sourceMaxZ ?? 'unknown'} revisedMaxZ=${revisedMaxZ ?? 'unknown'} threshold=${Number.isFinite(sourceMaxZ) ? sourceMaxZ * 0.85 : 'unknown'} manifestTail=${manifestChecks.tailTipBelowOriginal}`;
  const revisedViews = requiredViews.map((view) => ({ view, output: structureRevisedViewOutput(view, outputs) }));
  const revisedViewFailures = revisedViews.filter((item) => !item.output);
  const smallViews = revisedViews.filter((item) => item.output && (item.output.evidence?.size || 0) < MIN_STRUCTURE_REFEREE_VIEW_BYTES);
  const hasPartingEvidence = /(parting|split[_ -]?line|smooth[_ -]?parting|分模|分型|开模|合模)/i.test(allText);
  const hasHumidifierEvidence = /(humidifier|mist|ultrasonic|雾化|加湿)/i.test(allText);
  const hasTopCoverEvidence = /(top[_ -]?cover|upper[_ -]?cover|上盖|顶盖)/i.test(allText);
  const hasLowerTankEvidence = /(lower[_ -]?water[_ -]?tank|water[_ -]?tank|水箱|下壳|下水箱)/i.test(allText);
  const hasSupportAssemblyEvidence = /(support|frame|assembly|exploded|支撑|骨架|装配|爆炸)/i.test(allText);
  const repairTraceFiles = outputs.filter((item) => /revised/i.test(item.filename)).length
    + normalizedEvidence.manifests.length
    + normalizedEvidence.notes.length;
  const checkedAt = generatedAt || new Date().toISOString();
  const checks = [
    refereeCheck(packageGate.ok, 'structure_referee_package_gate_passed', 'Deterministic package gate passed before referee.', packageGate.ok ? null : (packageGate.blockers || []).join('; '), { reviewedAt: checkedAt }),
    refereeCheck(
      sources.length > 0 && sources.every((item) => !(item.blockers || []).length && item.hashMatches !== false && item.cad?.ok !== false),
      'structure_referee_source_cad_bound',
      'Source CAD refs are present, hash-bound, and parseable.',
      sources.map((item) => `${item.sourceRef?.ref || item.casePath}: hashMatches=${item.hashMatches} cadOk=${item.cad?.ok}`).join('; ') || 'no source CAD refs',
      { reviewedAt: checkedAt },
    ),
    refereeCheck(
      deliverable !== STRUCTURE_DELIVERABLES.CAD_MODEL || (!!sourceStl && !!sourceStep),
      'structure_referee_cad_model_has_step_and_stl_source',
      'CAD model branch has both source mesh and source STEP/STP evidence.',
      `sourceStl=${!!sourceStl}; sourceStep=${!!sourceStep}`,
      { reviewedAt: checkedAt },
    ),
    refereeCheck(
      deliverable !== STRUCTURE_DELIVERABLES.CAD_MODEL || (revisedStep?.cad?.ok === true && revisedStl?.cad?.ok === true),
      'structure_referee_revised_cad_valid',
      'Revised CAD outputs include parseable STEP/STP and STL.',
      `step=${revisedStep?.ref || 'missing'} ok=${revisedStep?.cad?.ok}; stl=${revisedStl?.ref || 'missing'} ok=${revisedStl?.cad?.ok}`,
      { reviewedAt: checkedAt },
    ),
    refereeCheck(
      revisedViewFailures.length === 0 && smallViews.length === 0,
      'structure_referee_required_revised_views_present',
      'All required views are revised views, not source baselines, and are non-trivial files.',
      revisedViewFailures.length ? `missing: ${revisedViewFailures.map((item) => item.view).join(', ')}` : (smallViews.length ? `too small: ${smallViews.map((item) => item.output.ref).join(', ')}` : revisedViews.map((item) => `${item.view}:${item.output?.ref}`).join('; ')),
      { reviewedAt: checkedAt },
    ),
    refereeCheck(
      tailHeightTargetOk,
      'structure_referee_active_change_tail_height_target',
      tailHeightTargetLabel,
      tailHeightTargetNotes,
      { reviewedAt: checkedAt },
    ),
    refereeCheck(
      hasPartingEvidence,
      'structure_referee_active_change_parting_line_evidence',
      'Smooth front/back shell split or parting-line correction has explicit CAD/manifest evidence.',
      hasPartingEvidence ? partNames.filter((name) => /parting|split|分模|分型/i.test(name)).join(', ') : 'missing parting/split-line evidence',
      { reviewedAt: checkedAt },
    ),
    refereeCheck(
      hasHumidifierEvidence,
      'structure_referee_preserve_humidifier_identity',
      'Unchanged whale humidifier identity is preserved in the revised structure evidence.',
      hasHumidifierEvidence ? 'humidifier/mist/ultrasonic evidence present' : 'missing humidifier/mist/ultrasonic evidence',
      { reviewedAt: checkedAt },
    ),
    refereeCheck(
      hasTopCoverEvidence && hasLowerTankEvidence,
      'structure_referee_preserve_cover_and_tank_layout',
      'Top cover plus lower water-tank functional layout is preserved.',
      `topCover=${hasTopCoverEvidence}; lowerTank=${hasLowerTankEvidence}`,
      { reviewedAt: checkedAt },
    ),
    refereeCheck(
      hasSupportAssemblyEvidence && revisedViews.some((item) => item.view === 'assembly' && item.output) && revisedViews.some((item) => item.view === 'exploded' && item.output),
      'structure_referee_support_assembly_evidence',
      'Support frame, assembly relationship, and exploded relation are represented.',
      `supportEvidence=${hasSupportAssemblyEvidence}; assembly=${!!structureRevisedViewOutput('assembly', outputs)}; exploded=${!!structureRevisedViewOutput('exploded', outputs)}`,
      { reviewedAt: checkedAt },
    ),
    refereeCheck(
      repairTraceFiles > 0 && !!manifest,
      'structure_referee_repair_trace_present',
      'Repair trace includes manifest/notes or revised-generation artifacts for future repair loops.',
      manifest ? `${manifest.ref}; partCount=${partNames.length}` : 'missing structure manifest',
      { reviewedAt: checkedAt },
    ),
  ];
  const decision = decisionFromChecks(checks);
  const blockers = checks.filter((item) => item.blocking !== false && item.status !== 'pass').map((item) => item.id);
  const refereeInputs = { evidence: normalizedEvidence, partNames };
  const prompt = buildStructureRefereePrompt({ task, contract, sources, outputs, packageGate, refereeInputs });
  const promptHash = digest({ contractHash: contract.contractHash || null, prompt });
  const repairTargets = checks
    .filter((item) => item.blocking !== false && item.status !== 'pass')
    .map((item) => ({
      checkId: item.id,
      label: item.label,
      notes: item.notes,
      target: item.id.includes('source') ? 'source_binding'
        : item.id.includes('view') ? 'revised_views'
          : item.id.includes('cad') ? 'revised_cad'
            : item.id.includes('tail') || item.id.includes('parting') ? 'cad_geometry'
              : item.id.includes('preserve') || item.id.includes('support') ? 'baseline_regression'
                : 'structure_package',
    }));
  return {
    version: STRUCTURE_MODELING_CONTRACT_VERSION,
    kind: 'StructureModelingRefereeReport',
    ok: decision === 'pass',
    decision,
    status: decision === 'pass' ? 'referee_pass' : 'referee_repair_required',
    mode: 'local_referee_repair',
    externalCalls: false,
    generatedAt: checkedAt,
    prompt,
    promptHash,
    promptRef,
    manifestRef: manifest?.ref || null,
    evidenceRefs: {
      manifests: normalizedEvidence.manifests.map((item) => item.ref),
      notes: normalizedEvidence.notes.map((item) => item.ref),
    },
    sourceVsRevisedMetrics: {
      sourceStl: sourceStl ? { ref: sourceStl.casePath || sourceStl.resolvedPath || '', maxZ: sourceMaxZ, bbox: sourceStl.cad?.bbox || null } : null,
      revisedStl: revisedStl ? { ref: revisedStl.ref, maxZ: revisedMaxZ, bbox: revisedStl.cad?.bbox || null } : null,
      tailHeightTargetMode: tailHeightTargetMode || (tailHeightTargetIsSourceMatch ? 'match_source_max_z' : 'tail_lowered'),
      tailHeightTargetZ: tailHeightReferenceZ,
      tailHeightTolerance,
      tailHeightDelta,
      tailHeightMatchesSourceByBbox,
      tailLoweredByBbox,
    },
    checks,
    blockers,
    warnings: [],
    repairTargets,
    repairInstruction: repairTargets.length
      ? 'Repair the targets above, regenerate revised STEP/STL/views, rerun flow:structure-modeling-loop, and do not attach/send human feedback until referee passes.'
      : 'No repair target remains; referee passed.',
    safety: STRUCTURE_MODELING_SAFETY,
  };
}

export function structureModelingContractsSelftest() {
  const makeStl = (maxZ) => {
    const buffer = Buffer.alloc(84 + 50);
    buffer.writeUInt32LE(1, 80);
    const verts = [0, 0, 0, 10, 0, 0, 0, 10, maxZ];
    for (let i = 0; i < verts.length; i += 1) buffer.writeFloatLE(verts[i], 84 + 12 + i * 4);
    return buffer;
  };
  const stlInspection = inspectStructureStlBuffer(makeStl(10));
  const stepInspection = inspectStructureStepBuffer(Buffer.from('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=CARTESIAN_POINT((0,0,0));\nENDSEC;\nEND-ISO-10303-21;\n', 'utf8'));
  const policy = normalizeStructureModelingPolicy({
    deliverableType: 'cad',
    sourceCadAvailable: true,
    sourceCadRefs: ['source.stl', 'source.stp'],
    requiredViews: ['front', 'side', 'assembly', 'exploded'],
  });
  const contract = {
    humanFeedbackBranch: STRUCTURE_FEEDBACK_BRANCHES.STRUCTURE_MODELING,
    contractHash: 'sha256:' + '1'.repeat(64),
    activeAtomicChange: { description: 'revise split line' },
    unchangedRegressionChecklist: [
      'structure: include dimensioned orthographic front side top views',
      'structure: include exploded assembly support logic',
    ],
    structureModeling: policy,
  };
  const validation = validateStructureModelingContract(contract, { stage: 'human_feedback_step' });
  const sources = [
    { sourceRef: { ref: 'source.stl' }, casePath: 'source.stl', actualHash: 'sha256:a', hashMatches: true, cad: stlInspection, caseEvidence: { exists: true } },
    { sourceRef: { ref: 'source.stp' }, casePath: 'source.stp', actualHash: 'sha256:b', hashMatches: true, cad: stepInspection, caseEvidence: { exists: true } },
  ];
  const outputs = [
    { ref: 'revised-front.png', filename: 'revised-front.png', ext: 'png', evidence: { exists: true, size: 60_000 } },
    { ref: 'revised-side.png', filename: 'revised-side.png', ext: 'png', evidence: { exists: true, size: 60_000 } },
    { ref: 'revised-assembly.png', filename: 'revised-assembly.png', ext: 'png', evidence: { exists: true, size: 60_000 } },
    { ref: 'revised-exploded.png', filename: 'revised-exploded.png', ext: 'png', evidence: { exists: true, size: 60_000 } },
    { ref: 'revised.stp', filename: 'revised.stp', ext: 'stp', evidence: { exists: true }, cad: stepInspection },
    { ref: 'revised.stl', filename: 'revised.stl', ext: 'stl', evidence: { exists: true }, cad: stlInspection },
  ];
  const packageGate = classifyStructureOutputPackage({ contract, sources, outputs });
  const evidence = {
    manifests: [{
      ref: 'structure/revised.json',
      json: {
        kind: 'RevisedTestStructureManifest',
        outputs: { partStls: { upper_cover: 'upper.stl', lower_water_tank: 'lower.stl', rear_ultrasonic_module: 'rear.stl', internal_support_frame_bridge: 'support.stl', left_smooth_parting_line: 'parting.stl' } },
        parts: [
          { name: 'upper_cover' },
          { name: 'lower_water_tank' },
          { name: 'rear_ultrasonic_module' },
          { name: 'internal_support_frame_bridge' },
          { name: 'left_smooth_parting_line' },
        ],
        checks: {
          tailHeightTargetMode: 'match_source_max_z',
          sourceMaxZTarget: 10,
          tailHeightTolerance: 0.01,
          tailHeightMatchesSource: true,
        },
      },
    }],
    notes: [{ ref: 'structure/notes.md', text: 'whale humidifier mist support assembly exploded smooth parting split line top cover lower water tank' }],
    combinedText: 'whale humidifier mist support assembly exploded smooth parting split line top cover lower water tank',
  };
  const referee = buildStructureRefereeReport({
    task: { taskId: '900090', orderId: 'order-structure' },
    contract,
    sources,
    outputs,
    packageGate,
    evidence,
    generatedAt: '2026-06-21T00:00:00.000Z',
    promptRef: 'structure-modeling/structure-modeling-referee-prompt-latest.md',
  });
  const failedPackage = classifyStructureOutputPackage({
    contract,
    sources: [],
    outputs: outputs.filter((item) => item.ext === 'png'),
  });
  const ok = policy.deliverableType === STRUCTURE_DELIVERABLES.CAD_MODEL
    && validation.ok === true
    && stlInspection.ok === true
    && stepInspection.ok === true
    && packageGate.ok === true
    && referee.ok === true
    && referee.promptHash?.startsWith('sha256:')
    && failedPackage.blockers.includes('source_cad_required')
    && failedPackage.blockers.includes('revised_step_output_required')
    && STRUCTURE_MODELING_SAFETY.callsProviderOrModel === false;
  return { ok, policy, validation, stlInspection, stepInspection, packageGate, referee, failedPackage, safety: STRUCTURE_MODELING_SAFETY };
}
