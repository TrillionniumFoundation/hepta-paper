import { OUTPUT_MODES, normalizeText, uniqueStrings } from './contracts.mjs';
import { digest } from './hash-utils.mjs';

export const WORKFLOW_PRODUCTION_CONTRACT_VERSION = 1;

export const WORKFLOW_SUBMIT_MODES = Object.freeze({
  FILE_UPLOAD: 'file_upload',
  TEXT_FORM: 'text_form',
  PDF_ONLY: 'pdf_only',
  MIXED: 'mixed',
  ACCEPTANCE_DELIVERY: 'acceptance_delivery',
  UNKNOWN: 'unknown',
});

export const WORKFLOW_PRODUCTION_QUALITY_GATE_SEVERITY = Object.freeze({
  BLOCKER: 'blocker',
  HIGH: 'high',
  NORMAL: 'normal',
  ADVISORY: 'advisory',
});

export const WORKFLOW_PRODUCTION_DEFAULT_ARTIFACT_POLICY = Object.freeze({
  maxSubmitFiles: 5,
  maxFileSizeMb: 10,
  submissionPlanAuthoritative: true,
  requiresHumanVisualQa: true,
  importRequiresQaPass: true,
  finalOnly: true,
});

export const WORKFLOW_PRODUCTION_DEFAULT_PROVIDER_HINTS = Object.freeze({
  preferredKind: 'image-generation',
  allowDryrun: true,
  allowManualFixture: true,
  externalCallsRequireExecute: true,
  defaultLimit: 5,
});

const BUYER_AI_RESTRICTION_RE = /AI生成|AI补充|不会接受|原始设计|原创/;

function asStringArray(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeText(item)).filter(Boolean);
  if (!value) return [];
  return [normalizeText(value)].filter(Boolean);
}

function createSubjectLock({ workflowId, subject = {} } = {}) {
  if (workflowId === 'logo_brand' && normalizeText(subject.brandText || '')) {
    return uniqueStrings([
      subject.brandText,
      ...(subject.mustUseText || []),
      ...(subject.forbiddenText || []).map((item) => `forbidden:${item}`),
    ], 20);
  }
  return uniqueStrings([
    subject.projectText,
    subject.brandText,
    subject.productText,
    ...(subject.mustUseText || []),
  ], 20);
}

export function inferWorkflowSubmitMode({ workflowId, outputMode, artifactPolicy = {} } = {}) {
  if (workflowId === 'acceptance_delivery_package') return WORKFLOW_SUBMIT_MODES.ACCEPTANCE_DELIVERY;
  if (Number(artifactPolicy?.maxSubmitFiles || 0) === 0 || outputMode === OUTPUT_MODES.TEXT_FORM) return WORKFLOW_SUBMIT_MODES.TEXT_FORM;
  if (outputMode === OUTPUT_MODES.PDF_DECK) return WORKFLOW_SUBMIT_MODES.PDF_ONLY;
  if (outputMode === OUTPUT_MODES.MIXED) return WORKFLOW_SUBMIT_MODES.MIXED;
  if (outputMode === OUTPUT_MODES.IMAGE_SET) return WORKFLOW_SUBMIT_MODES.FILE_UPLOAD;
  return WORKFLOW_SUBMIT_MODES.UNKNOWN;
}

export function inferWorkflowFinalFormats({ outputMode, submitMode } = {}) {
  if (submitMode === WORKFLOW_SUBMIT_MODES.TEXT_FORM) return ['text-form'];
  if (submitMode === WORKFLOW_SUBMIT_MODES.ACCEPTANCE_DELIVERY) return ['zip', 'pdf', 'source', 'preview'];
  if (outputMode === OUTPUT_MODES.PDF_DECK) return ['pdf'];
  if (outputMode === OUTPUT_MODES.MIXED) return ['jpg', 'png', 'pdf', 'zip'];
  return ['jpg', 'png'];
}

export function createWorkflowArtifactPolicy(policy = {}) {
  return { ...WORKFLOW_PRODUCTION_DEFAULT_ARTIFACT_POLICY, ...(policy || {}) };
}

export function createWorkflowDeliverableSpec({
  workflowId,
  outputMode,
  prompts = [],
  artifactPolicy = {},
  providerHints = {},
  subject = {},
  industrySpec = {},
  designReferenceSpec = {},
  deliverableSpec = {},
} = {}) {
  const submitMode = deliverableSpec.submitMode || inferWorkflowSubmitMode({ workflowId, outputMode, artifactPolicy });
  const buyerAiRestriction = [...(subject.mustUseText || []), ...(subject.forbiddenText || [])]
    .some((item) => BUYER_AI_RESTRICTION_RE.test(String(item || '')));
  const expectedFileCount = Number.isFinite(Number(deliverableSpec.expectedFileCount))
    ? Number(deliverableSpec.expectedFileCount)
    : (submitMode === WORKFLOW_SUBMIT_MODES.TEXT_FORM ? 0 : prompts.length);
  return {
    version: WORKFLOW_PRODUCTION_CONTRACT_VERSION,
    submitMode,
    outputMode,
    expectedFileCount,
    maxSubmitFiles: Number(artifactPolicy.maxSubmitFiles ?? expectedFileCount ?? 0),
    maxFileSizeMb: Number(artifactPolicy.maxFileSizeMb ?? 10),
    finalFormats: uniqueStrings(deliverableSpec.finalFormats || inferWorkflowFinalFormats({ outputMode, submitMode })),
    requiresLiveRuleCheck: deliverableSpec.requiresLiveRuleCheck ?? true,
    requiresSubmissionPlan: deliverableSpec.requiresSubmissionPlan ?? (submitMode !== WORKFLOW_SUBMIT_MODES.TEXT_FORM),
    finalOnly: artifactPolicy.finalOnly !== false,
    importRequiresQaPass: artifactPolicy.importRequiresQaPass !== false,
    providerKind: providerHints.preferredKind || null,
    providerPolicy: buyerAiRestriction ? 'original_design_required_no_raw_ai' : (deliverableSpec.providerPolicy || 'provider_allowed_with_qa'),
    industryId: industrySpec.id || null,
    industryLabel: industrySpec.label || null,
    industryDomain: industrySpec.domain || null,
    designReferenceId: designReferenceSpec.id || null,
    designReferenceLabel: designReferenceSpec.label || null,
    subjectLock: createSubjectLock({ workflowId, subject }),
  };
}

export function createWorkflowDriftGuard({
  id,
  label,
  appliesTo = 'package',
  severity = WORKFLOW_PRODUCTION_QUALITY_GATE_SEVERITY.BLOCKER,
  blocking = true,
  source = 'production_plan',
  check = 'manual_review',
  fields = [],
} = {}) {
  if (!id) throw new Error('drift guard requires id');
  if (!label) throw new Error(`drift guard ${id} requires label`);
  return { id, label, appliesTo, severity, blocking, source, check, fields };
}

export function createWorkflowDefaultDriftGuards({
  subject,
  industrySpec = {},
  designReferenceSpec = {},
  deliverableSpec = {},
  workflow = {},
} = {}) {
  const guards = [
    createWorkflowDriftGuard({
      id: 'subject_lock',
      label: 'Generated/imported artifacts preserve extracted brand/product/project text and do not drift to another subject.',
      appliesTo: 'artifact',
      fields: ['subject.projectText', 'subject.brandText', 'subject.productText', 'subject.mustUseText'],
    }),
    createWorkflowDriftGuard({
      id: 'deliverable_match',
      label: 'Artifact matches the requested deliverable type and workflow, not a generic filler board.',
      appliesTo: 'artifact',
      fields: ['workflowId', 'deliverableSpec.submitMode', 'workflowProfile.deliverableClass'],
    }),
    createWorkflowDriftGuard({
      id: 'submit_mode_guard',
      label: 'The final package shape matches the expected submit mode before direct submit.',
      appliesTo: 'package',
      fields: ['deliverableSpec.submitMode', 'deliverableSpec.expectedFileCount', 'artifactPolicy.maxSubmitFiles'],
    }),
  ];
  if (subject?.forbiddenText?.length) {
    guards.push(createWorkflowDriftGuard({
      id: 'forbidden_text_guard',
      label: 'Buyer-forbidden directions, terms, or exclusions must not appear in final artifacts.',
      appliesTo: 'artifact',
      fields: ['subject.forbiddenText'],
    }));
  }
  if (industrySpec?.id && industrySpec.id !== 'general_business_service') {
    guards.push(createWorkflowDriftGuard({
      id: 'industry_fit',
      label: `Final artifacts fit the classified industry context: ${industrySpec.label}.`,
      appliesTo: 'artifact',
      fields: ['industrySpec.id', 'industrySpec.visualCues', 'industrySpec.applicationContexts', 'industrySpec.forbiddenCliches'],
    }));
  }
  if (designReferenceSpec?.id) {
    guards.push(createWorkflowDriftGuard({
      id: 'design_reference_fit',
      label: `Artifacts adapt the design reference pack as grammar only without cloning: ${designReferenceSpec.label}.`,
      appliesTo: 'artifact',
      fields: ['designReferenceSpec.systemId', 'designReferenceSpec.referencePackage', 'designReferenceSpec.id', 'designReferenceSpec.referenceKeys', 'designReferenceSpec.referenceSourceStatus', 'designReferenceSpec.referenceSourceDigests', 'designReferenceSpec.designGrammar', 'designReferenceSpec.avoidPatterns', 'designReferenceSpec.negativePatterns', 'designReferenceSpec.sourcePolicy'],
    }));
    guards.push(createWorkflowDriftGuard({
      id: 'design_reference_application_fit',
      label: `Artifacts use credible application/material/layout cues from the reference pack: ${designReferenceSpec.label}.`,
      appliesTo: 'artifact',
      fields: ['designReferenceSpec.applicationScenes', 'designReferenceSpec.materialPreferences', 'designReferenceSpec.layoutPreferences', 'designReferenceSpec.surfacePatterns'],
    }));
    guards.push(createWorkflowDriftGuard({
      id: 'design_reference_negative_patterns',
      label: `Artifacts avoid hard negative patterns from the reference pack: ${designReferenceSpec.label}.`,
      appliesTo: 'artifact',
      fields: ['designReferenceSpec.negativePatterns', 'designReferenceSpec.qaBlockers'],
    }));
    guards.push(createWorkflowDriftGuard({
      id: 'design_reference_pack_checks',
      label: `Artifacts pass the reference pack QA checks: ${designReferenceSpec.label}.`,
      appliesTo: 'artifact',
      fields: ['designReferenceSpec.qaChecks', 'designReferenceSpec.qaBlockers'],
    }));
    if (designReferenceSpec.successPatterns?.length || designReferenceSpec.rejectedPatterns?.length || designReferenceSpec.buyerCorrections?.length) {
      guards.push(createWorkflowDriftGuard({
        id: 'design_reference_case_ledger_fit',
        label: `Artifacts respect learned case-ledger feedback for the reference pack: ${designReferenceSpec.label}.`,
        appliesTo: 'artifact',
        fields: ['designReferenceSpec.successPatterns', 'designReferenceSpec.rejectedPatterns', 'designReferenceSpec.buyerCorrections'],
      }));
    }
  }
  if ([...(subject?.mustUseText || []), ...(subject?.forbiddenText || [])].some((item) => BUYER_AI_RESTRICTION_RE.test(String(item || '')))) {
    guards.push(createWorkflowDriftGuard({
      id: 'no_raw_ai_artifact',
      label: 'Buyer requires original/non-AI-looking logo work; raw AI-generated marks cannot be imported without manual originality/vector finishing review.',
      appliesTo: 'package',
      fields: ['subject.mustUseText', 'subject.forbiddenText', 'deliverableSpec.providerPolicy'],
    }));
  }
  if (deliverableSpec?.submitMode === WORKFLOW_SUBMIT_MODES.TEXT_FORM) {
    guards.push(createWorkflowDriftGuard({
      id: 'text_form_not_file_upload',
      label: 'Naming/text tasks stay on the text-form branch unless the live modal proves otherwise.',
      appliesTo: 'package',
      fields: ['deliverableSpec.submitMode'],
    }));
  }
  return guards.map((guard) => ({
    ...guard,
    workflowId: workflow?.id || workflow?.workflowId || null,
  }));
}

export function createWorkflowQualityGate({
  id,
  label,
  severity = WORKFLOW_PRODUCTION_QUALITY_GATE_SEVERITY.BLOCKER,
  appliesTo = 'package',
  blocking = true,
  notes = null,
} = {}) {
  if (!id) throw new Error('quality gate requires id');
  if (!label) throw new Error(`quality gate ${id} requires label`);
  return { id, label, severity, appliesTo, blocking, notes };
}

function gateToQaCheck(gate, source = 'quality_gate') {
  return {
    id: gate.id,
    label: gate.label,
    source,
    severity: gate.severity || WORKFLOW_PRODUCTION_QUALITY_GATE_SEVERITY.NORMAL,
    appliesTo: gate.appliesTo || 'package',
    blocking: gate.blocking !== false,
    notes: gate.notes || null,
  };
}

export function createWorkflowQaContract({
  prompts = [],
  qualityGates = [],
  qaChecklist = [],
  driftGuards = [],
  artifactPolicy = {},
  deliverableSpec = {},
} = {}) {
  const artifactChecks = [
    ...qualityGates.filter((gate) => ['artifact', 'all'].includes(gate.appliesTo || 'package')).map((gate) => gateToQaCheck(gate, 'quality_gate')),
    ...driftGuards.filter((guard) => ['artifact', 'all'].includes(guard.appliesTo || 'package')).map((guard) => gateToQaCheck(guard, 'drift_guard')),
  ];
  const packageChecks = [
    ...qualityGates.filter((gate) => !['artifact', 'all'].includes(gate.appliesTo || 'package')).map((gate) => gateToQaCheck(gate, 'quality_gate')),
    ...driftGuards.filter((guard) => !['artifact', 'all'].includes(guard.appliesTo || 'package')).map((guard) => gateToQaCheck(guard, 'drift_guard')),
  ];
  return {
    version: WORKFLOW_PRODUCTION_CONTRACT_VERSION,
    requiredHumanReview: artifactPolicy.requiresHumanVisualQa !== false,
    importRequiresQaPass: artifactPolicy.importRequiresQaPass !== false,
    expectedArtifactCount: prompts.length,
    submitMode: deliverableSpec.submitMode || WORKFLOW_SUBMIT_MODES.UNKNOWN,
    artifactChecks,
    packageChecks,
    qaChecklist: asStringArray(qaChecklist),
    importBlockers: [
      ...(artifactPolicy.importRequiresQaPass !== false ? ['qa_pass_required'] : []),
      ...(artifactPolicy.importRequiresQaPass !== false ? ['package_review_pass_required'] : []),
      ...(artifactPolicy.finalOnly !== false ? ['final_only_artifacts'] : []),
      ...(deliverableSpec.requiresSubmissionPlan ? ['submission_plan_required_before_live_submit'] : []),
      ...(deliverableSpec.providerPolicy === 'original_design_required_no_raw_ai' ? ['manual_originality_review_required'] : []),
    ],
  };
}

export function workflowProductionContractsSelftest() {
  const artifactPolicy = createWorkflowArtifactPolicy({ maxSubmitFiles: 2 });
  const deliverable = createWorkflowDeliverableSpec({
    workflowId: 'logo_brand',
    outputMode: OUTPUT_MODES.IMAGE_SET,
    prompts: [{ index: 1 }, { index: 2 }],
    artifactPolicy,
    providerHints: WORKFLOW_PRODUCTION_DEFAULT_PROVIDER_HINTS,
    subject: {
      brandText: 'NOVA',
      mustUseText: ['NOVA'],
      forbiddenText: ['no AI生成 raw logo'],
    },
    industrySpec: {
      id: 'general_business_service',
      label: 'General business service',
    },
    designReferenceSpec: {
      id: 'refpack_general_business_service_v1',
      label: 'General business service',
      qaChecks: ['brand text present'],
      qaBlockers: ['copies third-party logo'],
    },
  });
  const qualityGate = createWorkflowQualityGate({ id: 'brand_visible', label: 'Brand text is visible.', appliesTo: 'artifact' });
  const driftGuards = createWorkflowDefaultDriftGuards({
    subject: { brandText: 'NOVA', forbiddenText: ['no AI生成 raw logo'] },
    industrySpec: { id: 'general_business_service', label: 'General business service' },
    designReferenceSpec: { id: 'refpack_general_business_service_v1', label: 'General business service', qaChecks: ['brand text present'] },
    deliverableSpec: deliverable,
    workflow: { id: 'logo_brand' },
  });
  const qa = createWorkflowQaContract({
    prompts: [{ index: 1 }, { index: 2 }],
    qualityGates: [qualityGate],
    driftGuards,
    artifactPolicy,
    deliverableSpec: deliverable,
  });
  const textDeliverable = createWorkflowDeliverableSpec({
    workflowId: 'naming_text',
    outputMode: OUTPUT_MODES.TEXT_FORM,
    prompts: [{ index: 1 }, { index: 2 }],
    artifactPolicy: createWorkflowArtifactPolicy({ maxSubmitFiles: 0 }),
  });
  return {
    ok: deliverable.submitMode === WORKFLOW_SUBMIT_MODES.FILE_UPLOAD
      && deliverable.expectedFileCount === 2
      && deliverable.providerPolicy === 'original_design_required_no_raw_ai'
      && driftGuards.some((guard) => guard.id === 'design_reference_pack_checks')
      && qa.importBlockers.includes('manual_originality_review_required')
      && textDeliverable.submitMode === WORKFLOW_SUBMIT_MODES.TEXT_FORM
      && textDeliverable.expectedFileCount === 0,
    deliverable,
    qa,
    driftGuardCount: driftGuards.length,
    textDeliverable,
    workflowProductionHash: digest({
      deliverable,
      qa,
      driftGuardIds: driftGuards.map((guard) => guard.id),
      textDeliverable,
    }),
    safety: {
      localContractOnly: true,
      executesExternalAction: false,
      callsProviderOrModel: false,
      grantsExecutionPermission: false,
    },
  };
}
