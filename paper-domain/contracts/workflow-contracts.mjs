import { normalizeText, uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import {
  PAPER_CORE_VERSION,
  PAPER_MANIFEST_STATUS,
  PAPER_RUN_RECEIPT_STATUS,
  PAPER_SEMANTIC_IDENTITY_VERSION,
  hashPaperRecord,
  hashPaperSemanticIdentity,
  normalizedId,
  normalizeRefs,
} from './primitives.mjs';
import { PAPER_ACTIONS, PAPER_CHANNEL_IDS, PAPER_OUTPUT_MODES, PAPER_PRODUCT_IDS, PAPER_PRODUCT_PROFILE, PAPER_WORKFLOW_STAGES } from './product-profile.mjs';

export function createPaperTask({
  paperId,
  title = null,
  status = null,
  venueTarget = null,
  paperType = null,
  canonicalDir = null,
  sourceWorkspace = null,
  mainTex = null,
  registry = null,
  source = null,
  evidenceRefs = [],
  createdAt = null,
  paperQualityProfile = null,
  paperQualityProfiles = [],
} = {}) {
  const id = normalizeText(paperId);
  if (!id) throw new Error('PaperTask requires paperId');
  const task = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperTask',
    channelId: PAPER_CHANNEL_IDS.PAPER_FACTORY,
    productLineId: PAPER_PRODUCT_IDS.MANUSCRIPT_PRODUCTION,
    workflowId: PAPER_PRODUCT_PROFILE.workflowId,
    paperId: id,
    taskKey: `${PAPER_CHANNEL_IDS.PAPER_FACTORY}:${id}`,
    title: normalizeText(title) || id,
    status: normalizeText(status) || null,
    venueTarget: normalizeText(venueTarget) || null,
    paperType: normalizeText(paperType) || null,
    canonicalDir: normalizeText(canonicalDir) || null,
    sourceWorkspace: normalizeText(sourceWorkspace) || null,
    mainTex: normalizeText(mainTex) || null,
    registry: registry || null,
    source: source || null,
    evidenceRefs: normalizeRefs(evidenceRefs),
    paperQualityProfile: normalizeText(paperQualityProfile || '') || null,
    paperQualityProfiles: uniqueStrings([
      ...(Array.isArray(paperQualityProfiles) ? paperQualityProfiles : []),
      paperQualityProfile,
    ].filter(Boolean), 16),
    createdAt: createdAt || null,
  };
  return {
    ...task,
    taskHash: hashPaperRecord('PaperTask', task),
    semanticIdentityVersion: PAPER_SEMANTIC_IDENTITY_VERSION,
    semanticIdentityHash: hashPaperSemanticIdentity('PaperTask', task),
  };
}

export function bindPaperTaskQualityProfile(paperTask, paperQualityProfile) {
  if (!paperTask?.taskKey) throw new Error('PaperTask required for quality profile binding');
  const {
    taskHash: _taskHash,
    semanticIdentityVersion: _semanticIdentityVersion,
    semanticIdentityHash: _semanticIdentityHash,
    ...subject
  } = paperTask;
  const normalizedProfile = normalizeText(paperQualityProfile || '') || null;
  const task = {
    ...subject,
    paperQualityProfile: normalizedProfile,
    paperQualityProfiles: uniqueStrings([
      ...(Array.isArray(subject.paperQualityProfiles) ? subject.paperQualityProfiles : []),
      normalizedProfile,
    ].filter(Boolean), 16),
  };
  return Object.freeze({
    ...task,
    taskHash: hashPaperRecord('PaperTask', task),
    semanticIdentityVersion: PAPER_SEMANTIC_IDENTITY_VERSION,
    semanticIdentityHash: hashPaperSemanticIdentity('PaperTask', task),
  });
}

export function createPaperBuildArtifactAcceptance({
  paperTask,
  execute = false,
  command = [],
  buildDir = null,
  sourceWorkspace = null,
  mainTex = null,
  builtPdf = null,
  execution = null,
  blockers = [],
  warnings = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('PaperBuildArtifactAcceptance requires paperTask');
  const acceptanceBlockers = [...(blockers || [])];
  if (execute && !builtPdf?.hash) acceptanceBlockers.push('compiled_pdf_missing_after_build');
  const status = acceptanceBlockers.length
    ? 'build_artifact_acceptance_blocked'
    : execute
      ? 'compiled_pdf_accepted_for_local_package'
      : 'build_artifact_acceptance_dry_run_only';
  const acceptance = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperBuildArtifactAcceptance',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status,
    accepted: status === 'compiled_pdf_accepted_for_local_package',
    execute: Boolean(execute),
    command: (command || []).map((part) => normalizeText(part)),
    buildDir: normalizeText(buildDir) || null,
    sourceWorkspace: normalizeText(sourceWorkspace || paperTask.sourceWorkspace) || null,
    mainTex: normalizeText(mainTex || paperTask.mainTex) || null,
    builtPdf: builtPdf ? {
      role: normalizeText(builtPdf.role || 'compiled_pdf') || 'compiled_pdf',
      path: normalizeText(builtPdf.path),
      filename: normalizeText(builtPdf.filename),
      sizeBytes: Number.isFinite(Number(builtPdf.sizeBytes)) ? Number(builtPdf.sizeBytes) : null,
      hash: normalizeText(builtPdf.hash) || null,
    } : null,
    execution: execution ? {
      executed: Boolean(execution.executed),
      status: Number.isFinite(Number(execution.status)) ? Number(execution.status) : null,
      signal: normalizeText(execution.signal) || null,
    } : null,
    blockers: uniqueStrings(acceptanceBlockers, 32),
    warnings: uniqueStrings(warnings, 32),
    safety: {
      localBuildOnly: true,
      outputUnderRuntime: true,
      sourceMutation: false,
      externalActionPerformed: false,
      acceptsForLiveSubmit: false,
    },
    createdAt: createdAt || null,
  };
  return {
    ...acceptance,
    paperBuildArtifactAcceptanceHash: hashPaperRecord('PaperBuildArtifactAcceptance', acceptance),
    semanticIdentityVersion: PAPER_SEMANTIC_IDENTITY_VERSION,
    semanticIdentityHash: hashPaperSemanticIdentity('PaperBuildArtifactAcceptance', acceptance),
  };
}

export function createPaperArtifactPackage({
  paperTask,
  mode = 'local-package',
  artifacts = [],
  packageStatus = 'package_unknown',
  buildStatus = 'build_unknown',
  submitReady = false,
  provenance = null,
  evidenceRefs = [],
  candidateArtifactPackageHash = null,
  packageVerificationReceipt = null,
  sourceSnapshotHash = null,
  sourceTreeManifestHash = null,
  sourcePackageContractHash = null,
  promotionGate = null,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('PaperArtifactPackage requires paperTask');
  const normalizedArtifacts = (artifacts || []).map((artifact, index) => ({
    id: normalizedId(artifact.id, `${paperTask.paperId}:artifact:${index + 1}`),
    role: normalizeText(artifact.role || 'artifact') || 'artifact',
    filename: normalizeText(artifact.filename || artifact.name || ''),
    path: normalizeText(artifact.path || '') || null,
    mimeType: normalizeText(artifact.mimeType || '') || null,
    sizeBytes: Number.isFinite(Number(artifact.sizeBytes)) ? Number(artifact.sizeBytes) : null,
    hash: normalizeText(artifact.hash || '') || null,
    source: normalizeText(artifact.source || '') || null,
  })).filter((artifact) => artifact.filename || artifact.path);
  const pkg = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperArtifactPackage',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    channelId: paperTask.channelId,
    productLineId: paperTask.productLineId,
    workflowId: paperTask.workflowId,
    outputMode: PAPER_OUTPUT_MODES.MANUSCRIPT_PACKAGE,
    mode: normalizeText(mode) || 'local-package',
    packageStatus: normalizeText(packageStatus) || 'package_unknown',
    buildStatus: normalizeText(buildStatus) || 'build_unknown',
    artifactCount: normalizedArtifacts.length,
    artifacts: normalizedArtifacts,
    submitReady: Boolean(submitReady),
    candidateArtifactPackageHash: normalizeText(candidateArtifactPackageHash || '') || null,
    packageVerificationStatus: packageVerificationReceipt?.status || null,
    packageVerificationReceiptHash: packageVerificationReceipt?.packageVerificationReceiptHash || null,
    artifactSettlementStatus: packageVerificationReceipt?.artifactSettlement?.status || null,
    artifactSettlementHash: packageVerificationReceipt?.artifactSettlement?.artifactSettlementHash || null,
    sourceSnapshotHash: normalizeText(sourceSnapshotHash || '') || null,
    sourceTreeManifestHash: normalizeText(sourceTreeManifestHash || '') || null,
    sourcePackageContractHash: normalizeText(sourcePackageContractHash || '') || null,
    manuscriptPromotionStatus: promotionGate?.status || null,
    manuscriptPromotionGateHash: promotionGate?.manuscriptPromotionGateHash || null,
    provenance: provenance || {
      generatedByPaperCore: true,
      sourceMutation: false,
      externalActionPerformed: false,
    },
    evidenceRefs: normalizeRefs(evidenceRefs),
    createdAt: createdAt || null,
  };
  return {
    ...pkg,
    artifactPackageHash: hashPaperRecord('PaperArtifactPackage', pkg),
    semanticIdentityVersion: PAPER_SEMANTIC_IDENTITY_VERSION,
    semanticIdentityHash: hashPaperSemanticIdentity('PaperArtifactPackage', pkg),
  };
}

export function createPaperWorkflowState({
  paperTask,
  draftStatus,
  compileStatus,
  researchVerifyStatus,
  packageStatus,
  readinessStatus,
  runnerStatus = 'not_started',
  submissionStatus = 'not_started',
  nextAction = null,
  autoLevel = null,
  stage = null,
  submissionIntent = null,
  blockers = [],
  warnings = [],
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('PaperWorkflowState requires paperTask');
  const state = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperWorkflowState',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    venue: paperTask.venueTarget || null,
    sourceWorkspace: paperTask.sourceWorkspace || null,
    draftStatus: normalizeText(draftStatus) || 'unknown',
    compileStatus: normalizeText(compileStatus) || 'unknown',
    researchVerifyStatus: normalizeText(researchVerifyStatus) || 'unknown',
    packageStatus: normalizeText(packageStatus) || 'unknown',
    readinessStatus: normalizeText(readinessStatus) || 'unknown',
    runnerStatus: normalizeText(runnerStatus) || 'not_started',
    submissionStatus: normalizeText(submissionStatus) || 'not_started',
    nextAction: normalizeText(nextAction) || null,
    autoLevel: normalizeText(autoLevel) || null,
    stage: normalizeText(stage) || null,
    submissionIntent: submissionIntent || null,
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(warnings, 32),
    evidenceRefs: normalizeRefs(evidenceRefs),
    createdAt: createdAt || null,
  };
  return {
    ...state,
    stateHash: hashPaperRecord('PaperWorkflowState', state),
    semanticIdentityVersion: PAPER_SEMANTIC_IDENTITY_VERSION,
    semanticIdentityHash: hashPaperSemanticIdentity('PaperWorkflowState', state),
  };
}

export function paperWorkflowRow(state) {
  return {
    paper_id: state.paperId,
    venue: state.venue || '',
    source_workspace: state.sourceWorkspace || '',
    draft_status: state.draftStatus,
    compile_status: state.compileStatus,
    research_verify_status: state.researchVerifyStatus,
    package_status: state.packageStatus,
    readiness_status: state.readinessStatus,
    runner_status: state.runnerStatus,
    submission_status: state.submissionStatus,
    next_action: state.nextAction || '',
    auto_level: state.autoLevel || '',
    submission_intent: state.submissionIntent?.status || '',
    production_disposition: state.submissionIntent?.disposition || '',
  };
}

export function inferPaperStage(state) {
  if (state.blockers?.length) return PAPER_WORKFLOW_STAGES.BLOCKED;
  if (state.submissionStatus === 'venue_state_proof_recorded') return PAPER_WORKFLOW_STAGES.SUBMITTED_VERIFIED;
  if (state.runnerStatus === 'dry_run_receipt_recorded') return PAPER_WORKFLOW_STAGES.HANDOFF_READY;
  if (state.readinessStatus === 'ready_for_local_dry_run') return PAPER_WORKFLOW_STAGES.READINESS_GATE_READY;
  if (state.packageStatus === 'package_present' || state.packageStatus === 'package_ready') return PAPER_WORKFLOW_STAGES.PACKAGE_READY;
  if (state.researchVerifyStatus === 'verified' || state.researchVerifyStatus === 'evidence_present') return PAPER_WORKFLOW_STAGES.RESEARCH_VERIFIED;
  if (state.compileStatus === 'compiled_pdf_present' || state.compileStatus === 'build_ready') return PAPER_WORKFLOW_STAGES.BUILD_READY;
  if (state.draftStatus === 'source_tex_present') return PAPER_WORKFLOW_STAGES.SOURCE_READY;
  if (state.draftStatus === 'source_present') return PAPER_WORKFLOW_STAGES.INVENTORY_READY;
  return PAPER_WORKFLOW_STAGES.BLOCKED;
}

export function nextActionForState(state) {
  const blockerSet = new Set(state.blockers || []);
  if (state.draftStatus === 'missing_source') return PAPER_ACTIONS.INVENTORY_SCAN;
  if (state.draftStatus !== 'source_tex_present') return 'paper.source.adapt';
  if (!['compiled_pdf_present', 'build_ready', 'build_passed'].includes(state.compileStatus)) {
    return PAPER_ACTIONS.LATEX_BUILD;
  }
  if (!['verified', 'evidence_present', 'proposal_seed_present', 'manual_review_only'].includes(state.researchVerifyStatus)) {
    return PAPER_ACTIONS.RESEARCH_VERIFY;
  }
  if (!['package_present', 'package_ready'].includes(state.packageStatus)) return PAPER_ACTIONS.SOURCE_PACKAGE;
  if (blockerSet.has('venue_target_missing') || blockerSet.has('venue_submission_plan_not_ready')) {
    return 'paper.venue.resolve';
  }
  if (blockerSet.has('artifact_package_not_submit_ready')) return PAPER_ACTIONS.SOURCE_PACKAGE;
  if (blockerSet.has('live_submit_not_implemented_in_overlay')
    || blockerSet.has('explicit_reviewed_submit_approval_required')
    || blockerSet.has('attested_academic_evidence_required_for_reviewed_submit')
    || blockerSet.has('independent_referee_acceptance_authority_required')
    || blockerSet.has('live_submission_authorization_required')) {
    return PAPER_ACTIONS.REVIEWED_SUBMIT;
  }
  if (state.readinessStatus !== 'ready_for_local_dry_run') return 'paper.readiness.gate';
  if (state.runnerStatus !== 'dry_run_receipt_recorded') return PAPER_ACTIONS.VENUE_DRY_RUN;
  return PAPER_ACTIONS.REVIEWED_SUBMIT;
}

export function autoLevelForState(state) {
  const blockerSet = new Set(state.blockers || []);
  if (state.draftStatus === 'missing_source') return 'inventory_only';
  if (state.draftStatus !== 'source_tex_present') return 'source_adapt_needed';
  if (!['compiled_pdf_present', 'build_ready', 'build_passed'].includes(state.compileStatus)) return 'local_build';
  if (!['package_present', 'package_ready'].includes(state.packageStatus)) return 'local_package';
  if (blockerSet.has('artifact_package_not_submit_ready')) return 'local_package';
  if (blockerSet.has('live_submit_not_implemented_in_overlay')
    || blockerSet.has('explicit_reviewed_submit_approval_required')
    || blockerSet.has('attested_academic_evidence_required_for_reviewed_submit')
    || blockerSet.has('independent_referee_acceptance_authority_required')
    || blockerSet.has('live_submission_authorization_required')) {
    return 'reviewed_submit_blocked';
  }
  if (state.runnerStatus === 'dry_run_receipt_recorded') return 'reviewed_submit_blocked';
  return 'local_dry_run';
}

export function createPaperActionManifest({
  paperTask,
  action,
  mode = 'local-dry-run',
  artifactPackage = null,
  researchReport = null,
  venuePlan = null,
  venueEvidenceBundle = null,
  dryRun = true,
  approvalPacket = null,
  promotionGate = null,
  semanticPromotionLock = null,
  extraBlockers = [],
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('PaperActionManifest requires paperTask');
  const normalizedAction = normalizeText(action);
  const blockers = [];
  const warnings = [];
  if (!Object.values(PAPER_ACTIONS).includes(normalizedAction)) blockers.push('unknown_paper_action');
  if (normalizedAction === PAPER_ACTIONS.REVIEWED_SUBMIT) {
    if (!approvalPacket?.approved) blockers.push('explicit_reviewed_submit_approval_required');
    if (promotionGate?.status !== 'manuscript_promotion_ready') blockers.push('manuscript_promotion_gate_not_ready');
    if (semanticPromotionLock?.status !== 'semantic_promotion_unlocked') blockers.push('semantic_promotion_lock_not_ready');
  }
  if (normalizedAction !== PAPER_ACTIONS.INVENTORY_SCAN && !paperTask.sourceWorkspace) {
    blockers.push('source_workspace_required');
  }
  if ([PAPER_ACTIONS.VENUE_DRY_RUN, PAPER_ACTIONS.REVIEWED_SUBMIT].includes(normalizedAction)) {
    if (!artifactPackage?.submitReady) blockers.push('artifact_package_not_submit_ready');
    if (researchReport?.status === 'blocked') blockers.push('research_verify_blocked');
    if (venuePlan?.status !== 'local_dry_run_ready') blockers.push('venue_submission_plan_not_ready');
  }
  blockers.push(...(extraBlockers || []));
  const manifest = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperActionManifest',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    channelId: paperTask.channelId,
    productLineId: paperTask.productLineId,
    workflowId: paperTask.workflowId,
    action: normalizedAction,
    mode: normalizeText(mode) || 'local-dry-run',
    status: blockers.length ? PAPER_MANIFEST_STATUS.BLOCKED : PAPER_MANIFEST_STATUS.READY,
    readyForAdapter: blockers.length === 0,
    adapter: {
      runnerId: 'hepta-paper.paper-adapters',
      actionId: normalizedAction,
      sideEffectClass: normalizedAction === PAPER_ACTIONS.REVIEWED_SUBMIT ? 'external_blocked' : 'local_only',
      dryRun: dryRun !== false,
    },
    payload: {
      paperId: paperTask.paperId,
      title: paperTask.title,
      venueTarget: paperTask.venueTarget || null,
      sourceWorkspace: paperTask.sourceWorkspace || null,
      mainTex: paperTask.mainTex || null,
      artifactPackageHash: artifactPackage?.artifactPackageHash || null,
      artifactHashes: (artifactPackage?.artifacts || []).map((artifact) => artifact.hash).filter(Boolean),
      researchReportHash: researchReport?.researchReportHash || null,
      venueSubmissionPlanHash: venuePlan?.venueSubmissionPlanHash || null,
      freshVenueEvidenceBundleHash: venueEvidenceBundle?.freshVenueEvidenceBundleHash || null,
      approvalHash: approvalPacket?.approvalHash || null,
      manuscriptPromotionGateHash: promotionGate?.manuscriptPromotionGateHash || null,
      semanticPromotionLockHash: semanticPromotionLock?.semanticPromotionLockHash || null,
      independentRefereeAuthorityReceiptHash:
        approvalPacket?.independentRefereeAuthorityReceiptHash || null,
      liveSubmissionAuthorizationReceiptHash:
        approvalPacket?.liveSubmissionAuthorizationReceiptHash || null,
      externalActionAuthorized: normalizedAction === PAPER_ACTIONS.REVIEWED_SUBMIT && approvalPacket?.approved === true,
      controlledExternalExecutorRequired: normalizedAction === PAPER_ACTIONS.REVIEWED_SUBMIT,
    },
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(warnings, 32),
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      dryRun: dryRun !== false,
      sourceMutation: false,
      executesExternalAction: false,
      liveSubmitBlocked: false,
      controlledExecutorBoundary: normalizedAction === PAPER_ACTIONS.REVIEWED_SUBMIT,
      cryptographicDualControlRequired: normalizedAction === PAPER_ACTIONS.REVIEWED_SUBMIT,
    },
    createdAt: createdAt || null,
  };
  const manifestHash = hashPaperRecord('PaperActionManifest', manifest);
  return {
    ...manifest,
    manifestHash,
    hash: manifestHash,
    semanticIdentityVersion: PAPER_SEMANTIC_IDENTITY_VERSION,
    semanticIdentityHash: hashPaperSemanticIdentity('PaperActionManifest', manifest),
  };
}

export function buildPaperHandoffEnvelope({ manifest, createdAt = null } = {}) {
  if (!manifest?.kind) throw new Error('PaperHandoffEnvelope requires manifest');
  const blocked = manifest.status !== PAPER_MANIFEST_STATUS.READY || !manifest.readyForAdapter;
  const envelope = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperHandoffEnvelope',
    taskKey: manifest.taskKey,
    paperId: manifest.paperId,
    action: manifest.action,
    status: blocked ? 'blocked_handoff' : 'dry_run_ready',
    readyForDryRun: !blocked,
    readyForExecution: false,
    manifestHash: manifest.manifestHash,
    commandPreview: [
      'paper-adapter-runner',
      'handoff',
      '--action-id',
      manifest.action,
      '--paper',
      manifest.paperId,
      '--manifest-hash',
      manifest.manifestHash,
      '--dry-run',
    ].join(' '),
    blockers: blocked ? uniqueStrings(manifest.blockers || ['manifest_not_ready'], 32) : [],
    safety: {
      commandPreviewOnly: true,
      executesExternalAction: false,
      sourceMutation: false,
    },
    createdAt: createdAt || null,
  };
  return {
    ...envelope,
    envelopeHash: hashPaperRecord('PaperHandoffEnvelope', envelope),
    semanticIdentityVersion: PAPER_SEMANTIC_IDENTITY_VERSION,
    semanticIdentityHash: hashPaperSemanticIdentity('PaperHandoffEnvelope', {
      ...envelope,
      manifestHash: manifest.semanticIdentityHash || manifest.manifestHash,
    }),
  };
}

export function buildPaperAdapterRunReceipt({ envelope, manifest, createdAt = null } = {}) {
  if (!envelope?.kind || !manifest?.kind) throw new Error('PaperAdapterRunReceipt requires envelope and manifest');
  const blocked = envelope.status !== 'dry_run_ready';
  const receipt = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperAdapterRunReceipt',
    taskKey: manifest.taskKey,
    paperId: manifest.paperId,
    action: manifest.action,
    status: blocked ? PAPER_RUN_RECEIPT_STATUS.BLOCKED : PAPER_RUN_RECEIPT_STATUS.DRY_RUN_RECORDED,
    result: blocked ? 'blocked' : 'dry_run_success',
    manifestHash: manifest.manifestHash,
    envelopeHash: envelope.envelopeHash,
    externalActionPerformed: false,
    sourceMutationPerformed: false,
    createdAt: createdAt || null,
  };
  return {
    ...receipt,
    receiptHash: hashPaperRecord('PaperAdapterRunReceipt', receipt),
    semanticIdentityVersion: PAPER_SEMANTIC_IDENTITY_VERSION,
    semanticIdentityHash: hashPaperSemanticIdentity('PaperAdapterRunReceipt', {
      ...receipt,
      manifestHash: manifest.semanticIdentityHash || manifest.manifestHash,
      envelopeHash: envelope.semanticIdentityHash || envelope.envelopeHash,
    }),
  };
}
