import path from 'node:path';
import { digest } from './hash-utils.mjs';
import {
  QA_DECISION,
  validateGenerationJob,
} from './generation-contracts.mjs';
import {
  applyRouteContractToPlan,
  buildRouteContract,
  routeContractPackageChecks,
} from './route-contracts.mjs';
import {
  semanticIntakeAcceptedForGate,
  validateGenerationSemanticContract,
} from './semantic-intake-contracts.mjs';
import {
  finalReviewCurrentSync,
} from './submit-ready-lifecycle-contracts.mjs';
import {
  approvalPacketBodyHash,
  approvalPolicyState,
  evidenceBundleBodyHash,
} from './approval-packets.mjs';
import {
  STANDARD_SUBMISSION_NOTE,
  STANDARD_SUBMISSION_NOTE_MAX_CHARS,
  submissionNoteCompliance,
} from './submission-description-contracts.mjs';

export const IMPORT_READY_ARTIFACT_CONTRACT_VERSION = 1;
export const PRODUCTION_EXECUTION_INVARIANT_CONTRACT_VERSION = 1;

export const IMPORT_READY_ALLOWED_EXTENSIONS = Object.freeze([
  'jpg',
  'jpeg',
  'png',
  'bmp',
  'gif',
  'jpep',
  'tif',
  'tiff',
  'eps',
  'pdf',
  'zip',
  'rar',
  'ai',
  'ppt',
  'pptx',
  'doc',
  'docx',
  'xls',
  'xlsx',
]);

export const DEFAULT_ARTIFACT_GATE_MAX_FILES = 5;
export const DEFAULT_ARTIFACT_GATE_MAX_SIZE_MB = 10;

export const PRODUCTION_EXECUTION_INVARIANT_SAFETY = Object.freeze({
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

const IMAGE_FILE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tif', '.tiff', '.webp']);
const HASH_RE = /^sha256:[0-9a-f]{64}$/;

function cloneJson(value) {
  return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
}

function unique(values = []) {
  return [...new Set((values || []).filter(Boolean))];
}

function normalizedStageName(stage = null) {
  return String(stage || '').trim().toLowerCase();
}

function normalizePathRef(value) {
  const text = String(value || '').trim();
  return text ? path.resolve(text) : '';
}

function normalizeFileRefs(files = []) {
  return unique((Array.isArray(files) ? files : [files]).map(normalizePathRef)).filter(Boolean);
}

function sameSortedFiles(left = [], right = []) {
  const a = normalizeFileRefs(left).sort();
  const b = normalizeFileRefs(right).sort();
  return a.length === b.length && a.every((file, idx) => file === b[idx]);
}

function sameSortedBasenames(left = [], right = []) {
  const normalize = (items) => unique((items || [])
    .map((item) => path.basename(String(item || '').trim()))
    .filter(Boolean))
    .sort();
  const a = normalize(left);
  const b = normalize(right);
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function issue(severity, id, message, details = {}) {
  return { severity, id, message, details };
}

function artifactKey(item) {
  return item?.relativePath || item?.name || item?.path || '';
}

function itemFileRef(item) {
  return item?.path || item?.file || item?.relativePath || item?.name || item;
}

function isImageFile(file) {
  return IMAGE_FILE_EXTS.has(path.extname(String(file || '')).toLowerCase());
}

export function parseSubmissionPlan(raw) {
  const ordered = [];
  const seen = new Set();
  const push = (name) => {
    const cleaned = String(name || '').trim();
    if (!cleaned || cleaned.includes('/') || cleaned.includes('\\') || seen.has(cleaned)) return;
    seen.add(cleaned);
    ordered.push(cleaned);
  };
  for (const match of String(raw || '').matchAll(/`([^`]+\.([a-z0-9]+))`/gi)) {
    const ext = match[2].toLowerCase();
    if (IMPORT_READY_ALLOWED_EXTENSIONS.includes(ext)) push(match[1]);
  }
  if (ordered.length) return ordered;
  for (const line of String(raw || '').split(/\r?\n/)) {
    const m = line.match(/^\s*\d+\.\s+([^\s`]+\.([a-z0-9]+))\s*$/i);
    if (m && IMPORT_READY_ALLOWED_EXTENSIONS.includes(m[2].toLowerCase())) push(m[1]);
  }
  return ordered;
}

export function resolveArtifactPackage({ artifacts = [], plannedNames = [], strict = true } = {}) {
  const byName = new Map();
  const byRel = new Map();
  for (const item of artifacts || []) {
    if (item?.name) byName.set(item.name, item);
    if (item?.relativePath) byRel.set(item.relativePath, item);
  }
  const ordered = [];
  const seen = new Set();
  const push = (item) => {
    const key = artifactKey(item);
    if (!item || !key || seen.has(key)) return;
    seen.add(key);
    ordered.push(item);
  };
  for (const name of plannedNames || []) push(byName.get(name) || byRel.get(name));
  if ((plannedNames || []).length) return ordered;
  push((artifacts || []).find((item) => item?.selectedForSubmit) || null);
  for (const item of (artifacts || []).filter((row) => row?.submitReady)) push(item);
  if (!ordered.length && !strict) push([...(artifacts || [])].reverse()[0]);
  return ordered;
}

export function effectivePlanWithRouteContract(plan = null, manifest = null) {
  if (!plan) return { plan: null, authoritative: !!manifest?.routeContract };
  const effectivePlan = cloneJson(plan);
  const sourceRouteContract = effectivePlan.routeContract
    || manifest?.routeContract
    || effectivePlan.semanticIntake?.routeContract
    || effectivePlan.semanticIntake?.modelResponse?.parsed?.routeContract
    || null;
  const rawRouteContract = sourceRouteContract || buildRouteContract({
    semanticIntake: effectivePlan.semanticIntake || manifest?.semanticIntake || null,
    workflowId: effectivePlan.workflowId || manifest?.workflowId || null,
    entry: effectivePlan,
    requirementText: effectivePlan.requirementExcerpt || '',
    subject: effectivePlan.subject || null,
  });
  return {
    plan: rawRouteContract ? applyRouteContractToPlan(effectivePlan, rawRouteContract) : effectivePlan,
    authoritative: !!sourceRouteContract,
  };
}

export function validateImportReadyQaContract(manifest = {}, files = []) {
  const issues = [];
  const normalizedFiles = normalizeFileRefs(files);
  const requests = manifest?.requests || [];
  const qa = manifest?.qa || [];
  for (const file of normalizedFiles) {
    const request = requests.find((item) => item?.result?.path && path.resolve(String(item.result.path)) === file);
    if (!request) {
      issues.push(`import-ready file has no matching generation request: ${file}`);
      continue;
    }
    const record = qa.find((item) => item?.requestId === request.id);
    if (!record) {
      issues.push(`import-ready file has no QA record: ${file}`);
      continue;
    }
    if (record.decision !== QA_DECISION.PASS) issues.push(`import-ready file is not QA PASS (${record.decision || 'missing'}): ${file}`);
    const attachmentSpec = request.attachmentSpec || manifest.attachmentSpec || null;
    if (attachmentSpec?.required) {
      if (!Array.isArray(request.referenceImages) || request.referenceImages.length === 0) issues.push(`import-ready file has no attachment referenceImages: ${file}`);
      if (!request.result?.usedAttachmentReferences) issues.push(`import-ready file was not generated with attachment references: ${file}`);
      if (!request.result?.attachmentSpecHash || request.result.attachmentSpecHash !== attachmentSpec.hash) issues.push(`import-ready file has stale/missing attachmentSpecHash: ${file}`);
    } else if (attachmentSpec?.generationUsage === 'negative_no_copy') {
      if (request.result?.usedAttachmentReferences) issues.push(`import-ready file copied an existing-logo no-copy attachment through edit mode: ${file}`);
      if (!request.result?.attachmentSpecHash || request.result.attachmentSpecHash !== attachmentSpec.hash) issues.push(`import-ready file has stale/missing no-copy attachmentSpecHash: ${file}`);
    }
    const failedBlockingChecks = (record.checks || []).filter((check) => check?.blocking !== false && check?.status !== QA_DECISION.PASS);
    if (failedBlockingChecks.length) issues.push(`import-ready file has unpassed blocking checks ${failedBlockingChecks.map((check) => check.id).join(', ')}: ${file}`);
  }
  return {
    version: IMPORT_READY_ARTIFACT_CONTRACT_VERSION,
    ok: issues.length === 0,
    files: normalizedFiles,
    issues,
    safety: PRODUCTION_EXECUTION_INVARIANT_SAFETY,
  };
}

export function validateImportBlockersContract(manifest = {}, { plan = null } = {}) {
  const issues = [];
  const effective = effectivePlanWithRouteContract(plan, manifest);
  const effectivePlan = effective.plan || plan;
  const blockers = manifest?.qaContract?.importBlockers || [];
  if (blockers.includes('semantic_intake_pass_required')) {
    const intake = plan?.semanticIntake || manifest?.semanticIntake || null;
    if (!intake) issues.push('semantic intake is required before import-ready');
    else if (!semanticIntakeAcceptedForGate({ plan, manifest })) issues.push(`semantic intake is not accepted for import-ready: provider=${intake.provider || 'missing'} decision=${intake.decision || 'missing'}`);
  }
  if (blockers.includes('semantic_contract_lock_required')) {
    const semanticGate = validateGenerationSemanticContract({ plan: effectivePlan, manifest, includeRequests: true });
    if (!semanticGate.ok) issues.push(`semantic contract lock is missing or stale: ${semanticGate.issues.map((item) => item.id).join(', ')}`);
  }
  if (blockers.includes('manual_originality_review_required') && !manifest?.importApprovals?.manualOriginalityReviewed?.ok) {
    issues.push('manual originality review approval is required before import-ready');
  }
  if (blockers.includes('package_review_pass_required')) {
    const review = manifest?.packageReview;
    if (!review) {
      issues.push('package-level generation review is required before import-ready');
    } else {
      if (review.decision !== QA_DECISION.PASS) issues.push(`package-level generation review is not PASS: ${review.decision || 'missing'}`);
      if (!sameSortedFiles(review.importReadyFiles || [], manifest.importReadyFiles || [])) {
        issues.push('package-level generation review is stale or does not cover current import-ready files');
      }
      const failedChecks = (review.checks || []).filter((check) => check?.blocking !== false && check?.status !== QA_DECISION.PASS);
      if (failedChecks.length) issues.push(`package-level generation review has unpassed blocking checks: ${failedChecks.map((check) => check.id).join(', ')}`);
      const currentRouteFiles = normalizeFileRefs(manifest.importReadyFiles || []);
      const currentRouteChecks = effective.authoritative
        ? routeContractPackageChecks({ plan: effectivePlan, manifest, files: currentRouteFiles })
        : [];
      const reviewAcceptedCheckIds = new Set(
        (review.checks || [])
          .filter((check) => check?.blocking !== false && check?.status === QA_DECISION.PASS)
          .map((check) => check.id),
      );
      const failedRouteChecks = currentRouteChecks.filter((check) => {
        if (!(check.status === QA_DECISION.FAIL || check.status === 'fail')) return false;
        if (check.id === 'route_contract_final_count' && reviewAcceptedCheckIds.has(check.id)) return false;
        return true;
      });
      if (failedRouteChecks.length) issues.push(`package-level generation review is stale against current RouteContract: ${failedRouteChecks.map((check) => `${check.id} ${check.notes || ''}`).join('; ')}`);
    }
  }
  return {
    version: IMPORT_READY_ARTIFACT_CONTRACT_VERSION,
    ok: issues.length === 0,
    issues,
    blockers,
    safety: PRODUCTION_EXECUTION_INVARIANT_SAFETY,
  };
}

export function isPdfBookletRoute(manifest = null, plan = null) {
  return plan?.routeContract?.finalArtifactShape === 'single_pdf'
    || manifest?.routeContract?.finalArtifactShape === 'single_pdf'
    || plan?.submitLimitSpec?.route === 'pdf_booklet'
    || plan?.deliverableSpec?.submitLimitRoute === 'pdf_booklet'
    || plan?.deliverableSpec?.submitMode === 'pdf_only'
    || manifest?.submitLimitSpec?.route === 'pdf_booklet'
    || manifest?.deliverableSpec?.submitLimitRoute === 'pdf_booklet'
    || manifest?.deliverableSpec?.submitMode === 'pdf_only';
}

export function buildPdfBookletPlanContract({ manifest = {}, plan = null, files = [], caseDir = null } = {}) {
  const route = isPdfBookletRoute(manifest, plan);
  const normalizedFiles = normalizeFileRefs(files);
  const sourceFiles = normalizedFiles.filter(isImageFile);
  const finalPdf = caseDir ? path.join(caseDir, `${manifest.taskId}-pdf-booklet-final.pdf`) : null;
  return {
    version: IMPORT_READY_ARTIFACT_CONTRACT_VERSION,
    required: route,
    ready: route && sourceFiles.length >= 1 && sourceFiles.length === normalizedFiles.length,
    sourceFiles,
    finalPdf,
    safety: PRODUCTION_EXECUTION_INVARIANT_SAFETY,
  };
}

export function validateExplicitPdfBookletImportContract({ manifest = {}, plan = null, manifestFiles = [], explicitFiles = [], caseDir = null } = {}) {
  const sourceGate = validateImportReadyQaContract(manifest, manifestFiles);
  const issues = [...(sourceGate.issues || [])];
  const normalizedExplicitFiles = normalizeFileRefs(explicitFiles);
  if (!isPdfBookletRoute(manifest, plan)) issues.push('explicit artifact file import is only allowed for pdf_booklet/pdf_only routes');
  if (normalizedExplicitFiles.length !== 1) issues.push('pdf_booklet explicit import must select exactly one final PDF');
  const finalPdf = caseDir ? path.resolve(path.join(caseDir, `${manifest.taskId}-pdf-booklet-final.pdf`)) : null;
  const selected = normalizedExplicitFiles[0] || null;
  if (!selected || path.extname(selected).toLowerCase() !== '.pdf') issues.push('pdf_booklet explicit import file must be a PDF');
  if (finalPdf && selected && selected !== finalPdf) issues.push(`pdf_booklet explicit import must use expected final PDF: ${finalPdf}`);
  return {
    version: IMPORT_READY_ARTIFACT_CONTRACT_VERSION,
    ok: issues.length === 0,
    issues,
    sourceGate,
    explicitPdfBooklet: true,
    files: normalizedExplicitFiles,
    safety: PRODUCTION_EXECUTION_INVARIANT_SAFETY,
  };
}

export function buildArtifactPackageGateContract({
  artifacts = [],
  plannedNames = [],
  selectedCases = [],
  noteText = '',
  productionPlan = null,
  generationManifest = null,
  maxFiles = DEFAULT_ARTIFACT_GATE_MAX_FILES,
  maxSizeMb = DEFAULT_ARTIFACT_GATE_MAX_SIZE_MB,
} = {}) {
  const issues = [];
  const warnings = [];
  if (!artifacts.length) issues.push('case has no artifacts');
  if (!selectedCases.length) issues.push('no resolved submit package');
  if (selectedCases.length > maxFiles) issues.push(`resolved package has ${selectedCases.length} files > maxFiles ${maxFiles}`);
  if (!plannedNames.length) warnings.push('submission-plan has no explicit filename list');
  const noteGate = submissionNoteCompliance(noteText, { required: true });
  if (!noteGate.ok) issues.push(noteGate.reason === 'missing_standard_submission_note' ? 'missing submission-note.md content' : 'submission-note.md must exactly match the fixed standard ZBJ submission note');
  if (String(noteText || '').length > STANDARD_SUBMISSION_NOTE_MAX_CHARS) issues.push(`submission note too long: ${String(noteText || '').length}/${STANDARD_SUBMISSION_NOTE_MAX_CHARS}`);

  const plannedMissing = (plannedNames || []).filter((name) => !(artifacts || []).some((item) => item?.name === name || item?.relativePath === name));
  if (plannedMissing.length) issues.push(`planned filenames not found in case index: ${plannedMissing.join(', ')}`);

  const selectedFileRefs = selectedCases.map(itemFileRef).filter(Boolean);
  const packageReview = generationManifest?.packageReview || null;
  const packageReviewAcceptedCheckIds = new Set(
    (packageReview?.checks || [])
      .filter((check) => check?.blocking !== false && check?.status === QA_DECISION.PASS)
      .map((check) => check.id),
  );
  const packageReviewCoversSelectedFiles = packageReview?.decision === QA_DECISION.PASS
    && sameSortedBasenames(packageReview.importReadyFiles || [], selectedFileRefs);
  const routeChecks = routeContractPackageChecks({
    plan: productionPlan,
    manifest: generationManifest,
    files: selectedFileRefs,
  }).map((check) => {
    if (check.status !== 'fail') return check;
    if (
      check.id === 'route_contract_final_count'
      && packageReviewCoversSelectedFiles
      && packageReviewAcceptedCheckIds.has(check.id)
    ) {
      return { ...check, status: 'pass', notes: `${check.notes || check.label || ''}; accepted by package review` };
    }
    return check;
  });
  for (const check of routeChecks) {
    if (check.status === 'fail') issues.push(`route contract ${check.id}: ${check.notes || check.label}`);
  }

  const badFiles = [];
  for (const item of selectedCases) {
    const name = item?.name || item?.relativePath || item?.path || 'unknown';
    const ext = String(item?.ext || path.extname(name).replace(/^\./, '')).toLowerCase();
    if (!item?.submitReady) warnings.push(`resolved artifact is not submitReady: ${name}`);
    if (!item?.exists) badFiles.push(`${name}: missing local file`);
    if (item?.actualSize && item.actualSize > maxSizeMb * 1024 * 1024) badFiles.push(`${name}: size ${(item.actualSize / 1024 / 1024).toFixed(2)}MB > ${maxSizeMb}MB`);
    if (!IMPORT_READY_ALLOWED_EXTENSIONS.includes(ext)) badFiles.push(`${name}: unsupported ext ${ext || '-'}`);
    if (/reject|rejected|superseded|old|backup|contact-sheet|review|tmp/i.test(name)) warnings.push(`suspicious filename in resolved package: ${name}`);
  }
  if (badFiles.length) issues.push(...badFiles);

  const contract = {
    version: IMPORT_READY_ARTIFACT_CONTRACT_VERSION,
    ok: issues.length === 0,
    reason: issues.length ? 'artifact_gate_failed' : 'pass',
    plannedNames: [...(plannedNames || [])],
    selectedCount: selectedCases.length,
    routeChecks,
    selectedCases: selectedCases.map((item) => ({
      version: item?.version ?? null,
      name: item?.name ?? null,
      relativePath: item?.relativePath ?? null,
      path: item?.path ?? null,
      size: item?.actualSize ?? item?.size ?? null,
      ext: item?.ext ?? path.extname(item?.name || '').replace(/^\./, '').toLowerCase(),
      submitReady: !!item?.submitReady,
      selectedForSubmit: !!item?.selectedForSubmit,
      label: item?.label ?? null,
    })),
    noteLength: String(noteText || '').length,
    noteGate,
    issues,
    warnings,
    safety: PRODUCTION_EXECUTION_INVARIANT_SAFETY,
  };
  return {
    ...contract,
    contractHash: digest({
      version: contract.version,
      reason: contract.reason,
      plannedNames: contract.plannedNames,
      selectedCases: contract.selectedCases,
      routeChecks: contract.routeChecks,
      noteGate: contract.noteGate,
      issues: contract.issues,
      warnings: contract.warnings,
    }),
  };
}

function caseSubmitReadyFiles(caseIndex = null) {
  return [
    ...(caseIndex?.artifacts || []),
    ...(caseIndex?.files || []),
  ]
    .filter((item) => item?.submitReady)
    .map((item) => item.path || item.file || item.name)
    .filter(Boolean);
}

function reviewAcceptedCheckIds(review = null) {
  return new Set(
    (review?.checks || [])
      .filter((check) => check?.blocking !== false && check?.status === QA_DECISION.PASS)
      .map((check) => check.id)
      .filter(Boolean),
  );
}

function finalDecision(finalReview = null) {
  return finalReview?.decision || finalReview?.packageReview?.decision || null;
}

function packageDecision(packageReview = null, manifest = null) {
  return packageReview?.decision || packageReview?.packageReview?.decision || manifest?.packageReview?.decision || null;
}

function finalReviewAcceptsRouteCheck(finalReview = null, submitReadyFiles = [], checkId = '') {
  if (!checkId || finalDecision(finalReview) !== QA_DECISION.PASS) return false;
  if (!sameSortedBasenames(finalReview?.files || finalReview?.reviewedFiles || finalReview?.selectedFiles || [], submitReadyFiles)) return false;
  return reviewAcceptedCheckIds(finalReview).has(checkId);
}

function providerIdFromManifest(manifest = null) {
  return manifest?.provider?.providerId || manifest?.providerId || null;
}

function hasManualSubmitApproval(manifest = null) {
  return manifest?.importApprovals?.manualSubmitApproved?.ok === true
    || manifest?.submitApprovals?.manualSubmitApproved?.ok === true;
}

function isEvidenceBundleHashValue(value) {
  return HASH_RE.test(String(value || ''));
}

export function evaluateProductionExecutionInvariantContract({
  taskId = null,
  entry = {},
  files = {},
  plan = null,
  manifest = null,
  packageReview = null,
  finalReview = null,
  finalReviewGate = null,
  approvalPacket = null,
  evidenceBundle = null,
  evidenceFreshnessIssues = [],
  caseIndex = null,
  stage = null,
  submissionNoteText = STANDARD_SUBMISSION_NOTE,
  fileEvidenceMap = {},
  now = new Date().toISOString(),
  currentTimeMs = Date.now(),
  maxEvidenceAgeMinutes = 60,
} = {}) {
  const issues = [];
  const effective = effectivePlanWithRouteContract(plan, manifest);
  const effectivePlan = effective.plan || plan;
  const normalizedStage = normalizedStageName(stage);
  const spendStage = normalizedStage === 'spend';
  const acceptanceStage = normalizedStage === 'acceptance' || normalizedStage === 'acceptance-prepare';
  const allowPartialImportReady = normalizedStage === 'expand5' || spendStage;
  const allowPreFinalImport = allowPartialImportReady || normalizedStage === 'import';
  const providerId = providerIdFromManifest(manifest);
  const importReadyFiles = normalizeFileRefs(manifest?.importReadyFiles || []);
  const effectiveTaskId = taskId || entry?.taskId || manifest?.taskId || null;

  if (!plan) issues.push(issue('warning', 'missing_production_plan', 'production plan is missing'));
  if (!manifest) {
    issues.push(issue('warning', 'missing_generation_manifest', 'generation manifest is missing'));
  } else {
    const validation = validateGenerationJob(manifest, {
      semanticValidator: ({ manifest: job, includeRequests = true } = {}) => (
        validateGenerationSemanticContract({ manifest: job, includeRequests })
      ),
    });
    if (!validation.ok) issues.push(issue('error', 'invalid_generation_manifest', 'generation manifest violates the generation contract', { validation }));
    if (importReadyFiles.length && !allowPartialImportReady) {
      const qaGate = validateImportReadyQaContract(manifest, importReadyFiles);
      const importBlockerGate = validateImportBlockersContract(manifest, { plan: effectivePlan });
      if (!qaGate.ok) issues.push(issue('error', 'import_ready_qa_inconsistent', 'manifest has import-ready files that are not fully QA PASS', { qaGate }));
      if (!importBlockerGate.ok) issues.push(issue('error', 'import_ready_blockers_inconsistent', 'manifest import-ready files do not satisfy blocking import gates', { importBlockerGate }));
      if (packageDecision(packageReview, manifest) !== QA_DECISION.PASS) issues.push(issue('error', 'import_ready_without_package_pass', 'import-ready files exist without a PASS package review', { decision: packageDecision(packageReview, manifest) }));
    }
    const semanticGate = validateGenerationSemanticContract({ plan: effectivePlan, manifest, includeRequests: true });
    if (semanticGate.required && importReadyFiles.length && !allowPartialImportReady && !semanticGate.ok) {
      issues.push(issue('error', 'semantic_contract_lock_invalid', 'import-ready manifest is not locked to the current model semantic intake', { semanticGate }));
    }
  }

  const final = finalDecision(finalReview);
  if (final === QA_DECISION.PASS && caseIndex && !acceptanceStage && !allowPreFinalImport) {
    const finalGate = finalReviewGate || finalReviewCurrentSync(finalReview, caseIndex, { plan: effectivePlan, manifest });
    if (!finalGate.ok) {
      issues.push(issue('error', 'final_review_not_current', 'final-review PASS is not bound to the current submit-ready files', { finalGate }));
    }
    const submitReadyFiles = caseSubmitReadyFiles(caseIndex);
    const routeChecks = effective.authoritative
      ? routeContractPackageChecks({ plan: effectivePlan, manifest, files: submitReadyFiles })
      : [];
    const failedRouteChecks = routeChecks.filter((check) => {
      if (check.status !== 'fail') return false;
      if (check.id === 'route_contract_final_count' && finalReviewAcceptsRouteCheck(finalReview, submitReadyFiles, check.id)) return false;
      return true;
    });
    if (failedRouteChecks.length) {
      issues.push(issue('error', 'final_review_route_contract_mismatch', 'final-review PASS does not satisfy the current RouteContract', { failedRouteChecks }));
    }
  }

  if (['prepare', 'submit'].includes(normalizedStage) && providerId === 'manual' && !hasManualSubmitApproval(manifest)) {
    issues.push(issue('error', 'manual_provider_submit_requires_explicit_approval', 'manual/local-import packages cannot be prepared or submitted without explicit manualSubmitApproved approval', { providerId }));
  }
  if (['prepare', 'submit'].includes(normalizedStage)) {
    const noteGate = submissionNoteCompliance(submissionNoteText, { required: true });
    if (!noteGate.ok) {
      issues.push(issue('error', noteGate.reason, 'submission-note.md must match the fixed ZBJ live submit note exactly except trailing newlines', { noteGate }));
    }
  }
  if (!allowPreFinalImport && final === QA_DECISION.FAIL && importReadyFiles.length) {
    issues.push(issue('error', 'final_fail_with_import_ready', 'final reviewer is FAIL while import-ready files remain selected'));
  }

  if (approvalPacket) {
    const recomputedPacketHash = approvalPacketBodyHash(approvalPacket);
    if (!approvalPacket.packetHash) {
      issues.push(issue('error', 'approval_packet_hash_missing', 'approval packet must bind its immutable body hash before any invariant pass', { actual: recomputedPacketHash }));
    } else if (approvalPacket.packetHash !== recomputedPacketHash) {
      issues.push(issue('error', 'approval_packet_hash_mismatch', 'approval packet hash no longer matches its immutable body', { expected: approvalPacket.packetHash, actual: recomputedPacketHash }));
    }
  }

  if (evidenceBundle) {
    const recomputedBundleHash = evidenceBundleBodyHash(evidenceBundle);
    if (!evidenceBundle.bundleHash) {
      issues.push(issue('error', 'evidence_bundle_hash_missing', 'evidence bundle must bind its immutable body hash before any invariant pass', { actual: recomputedBundleHash }));
    } else if (evidenceBundle.bundleHash !== recomputedBundleHash) {
      issues.push(issue('error', 'evidence_bundle_hash_mismatch', 'evidence bundle hash no longer matches its immutable body', { expected: evidenceBundle.bundleHash, actual: recomputedBundleHash }));
    }
    if (String(evidenceBundle.task?.taskId) !== String(effectiveTaskId || '')) {
      issues.push(issue('error', 'evidence_task_mismatch', 'evidence bundle belongs to a different task', { evidenceTaskId: evidenceBundle.task?.taskId, taskId: effectiveTaskId }));
    }
    for (const stale of unique(evidenceFreshnessIssues)) issues.push(issue('error', 'evidence_source_stale', stale));
    const generatedAt = Date.parse(evidenceBundle.generatedAt || '');
    if (!Number.isFinite(generatedAt)) issues.push(issue('warning', 'evidence_missing_generated_at', 'evidence bundle has no generatedAt'));
    else if (currentTimeMs - generatedAt > Number(maxEvidenceAgeMinutes || 60) * 60000) {
      issues.push(issue('warning', 'evidence_age_exceeded', 'evidence bundle exceeds the normal execution max age', { generatedAt: evidenceBundle.generatedAt, maxEvidenceAgeMinutes }));
    }
    if (approvalPacket?.packetHash && !evidenceBundle.approval?.packetHash) {
      issues.push(issue('error', 'evidence_approval_hash_missing', 'evidence bundle does not bind the current latest approval packet', { currentPacketHash: approvalPacket.packetHash }));
    }
    if (approvalPacket?.packetHash && evidenceBundle.approval?.packetHash && evidenceBundle.approval.packetHash !== approvalPacket.packetHash) {
      issues.push(issue('error', 'evidence_approval_hash_stale', 'evidence bundle references a different approval packet than the current latest packet', { evidencePacketHash: evidenceBundle.approval.packetHash, currentPacketHash: approvalPacket.packetHash }));
    }
    const currentApprovalState = approvalPacket ? approvalPolicyState(approvalPacket) : null;
    if (currentApprovalState && evidenceBundle.approval?.approvalState?.status !== currentApprovalState.status) {
      issues.push(issue('error', 'evidence_approval_state_stale', 'evidence bundle approval state differs from the current approval packet', { evidenceStatus: evidenceBundle.approval?.approvalState?.status, currentStatus: currentApprovalState.status }));
    }
    if (Number(evidenceBundle.gates?.importReadyFiles || 0) !== importReadyFiles.length) {
      issues.push(issue('error', 'evidence_gate_count_stale', 'evidence bundle import-ready count differs from the current manifest', { evidenceCount: evidenceBundle.gates?.importReadyFiles || 0, currentCount: importReadyFiles.length }));
    }
    if (evidenceBundle.bundleHash && !isEvidenceBundleHashValue(evidenceBundle.bundleHash)) {
      issues.push(issue('warning', 'evidence_bundle_hash_noncanonical', 'evidence bundle hash is not canonical sha256:<hex64>', { bundleHash: evidenceBundle.bundleHash }));
    }
  } else {
    issues.push(issue('warning', 'missing_evidence_bundle', 'no latest evidence bundle exists yet'));
  }

  const errorCount = issues.filter((item) => item.severity === 'error').length;
  const warningCount = issues.filter((item) => item.severity === 'warning').length;
  const report = {
    version: PRODUCTION_EXECUTION_INVARIANT_CONTRACT_VERSION,
    ok: errorCount === 0,
    taskId: effectiveTaskId,
    orderId: entry?.orderId || manifest?.orderId || null,
    generatedAt: now,
    summary: {
      errors: errorCount,
      warnings: warningCount,
      importReadyFiles: importReadyFiles.length,
      providerId,
      packageDecision: packageDecision(packageReview, manifest),
      finalDecision: final,
      approvalStatus: approvalPacket ? approvalPolicyState(approvalPacket).status : null,
      evidenceHash: evidenceBundle?.bundleHash || null,
    },
    issues,
    fileEvidence: fileEvidenceMap,
    safety: PRODUCTION_EXECUTION_INVARIANT_SAFETY,
  };
  return {
    ...report,
    invariantHash: digest({
      version: report.version,
      taskId: report.taskId,
      orderId: report.orderId,
      summary: report.summary,
      issues: report.issues,
    }),
  };
}

export function productionExecutionInvariantContractsSelftest() {
  const manifest = {
    version: 1,
    id: 'invariant-selftest',
    taskId: 88,
    orderId: '99',
    workflowId: 'logo_design',
    outputMode: 'image_set',
    provider: { providerId: 'manual' },
    requests: [{ id: 'r1', taskId: 88, workflowId: 'logo_design', filename: 'a.jpg', prompt: 'p', acceptance: [], result: { ok: true, path: '/tmp/invariant-a.jpg' } }],
    qaContract: { importBlockers: ['qa_pass_required', 'package_review_pass_required'] },
    qa: [{ requestId: 'r1', decision: QA_DECISION.PASS, checks: [] }],
    importReadyFiles: ['/tmp/invariant-a.jpg'],
  };
  const files = normalizeFileRefs(manifest.importReadyFiles);
  const qaGate = validateImportReadyQaContract(manifest, files);
  const blockedImport = validateImportBlockersContract(manifest, { plan: { workflowId: 'logo_design' } });
  manifest.packageReview = { decision: QA_DECISION.PASS, importReadyFiles: ['/tmp/invariant-a.jpg'], checks: [] };
  const passedImport = validateImportBlockersContract(manifest, { plan: { workflowId: 'logo_design' } });
  const artifactGate = buildArtifactPackageGateContract({
    artifacts: [{ name: 'final.png', path: '/tmp/final.png', submitReady: true, exists: true, actualSize: 1000, ext: 'png' }],
    plannedNames: ['final.png'],
    selectedCases: [{ name: 'final.png', path: '/tmp/final.png', submitReady: true, exists: true, actualSize: 1000, ext: 'png' }],
    noteText: STANDARD_SUBMISSION_NOTE,
  });
  const evidenceBundle = {
    version: 1,
    generatedAt: '2026-06-21T00:00:00.000Z',
    stage: 'spend',
    task: { taskId: 88 },
    gates: { importReadyFiles: 1 },
    blockers: [],
  };
  evidenceBundle.bundleHash = evidenceBundleBodyHash(evidenceBundle);
  const staleEvidenceReport = evaluateProductionExecutionInvariantContract({
    taskId: 88,
    entry: { taskId: 88 },
    manifest: { ...manifest, packageReview: undefined },
    evidenceBundle,
    evidenceFreshnessIssues: ['evidence source file hash changed: source'],
    currentTimeMs: Date.parse('2026-06-21T00:01:00.000Z'),
  });
  const staleFinalReport = evaluateProductionExecutionInvariantContract({
    taskId: 89,
    entry: { taskId: 89 },
    finalReview: { decision: 'pass', files: ['/tmp/old-final.png'] },
    caseIndex: { artifacts: [{ submitReady: true, name: 'new-final.png', path: '/tmp/new-final.png' }] },
  });
  const pdfBookletReport = evaluateProductionExecutionInvariantContract({
    taskId: 90,
    entry: { taskId: 90 },
    plan: { submitLimitSpec: { route: 'pdf_booklet' } },
    manifest: { ...manifest, taskId: 90, orderId: '90', provider: { providerId: 'openclaw-image' }, importReadyFiles: [] },
    finalReview: { decision: 'pass', files: ['/tmp/final-booklet.pdf'] },
    caseIndex: { artifacts: [{ submitReady: true, name: 'final-booklet.pdf', path: '/tmp/final-booklet.pdf' }] },
    stage: 'submit',
  });
  const nonstandardNoteReport = evaluateProductionExecutionInvariantContract({
    taskId: 91,
    entry: { taskId: 91 },
    plan: { submitLimitSpec: { route: 'pdf_booklet' } },
    manifest: { ...manifest, taskId: 91, orderId: '91', provider: { providerId: 'openclaw-image' }, importReadyFiles: [] },
    finalReview: { decision: 'pass', files: ['/tmp/final-booklet.pdf'] },
    caseIndex: { artifacts: [{ submitReady: true, name: 'final-booklet.pdf', path: '/tmp/final-booklet.pdf' }] },
    stage: 'submit',
    submissionNoteText: '客户您好，这是生成出来的交稿说明。',
  });
  const approvalPacket = {
    version: 1,
    generatedAt: '2026-06-21T00:00:00.000Z',
    taskId: 92,
    action: 'spend',
    policyProfile: 'spend-allowed',
    ok: true,
    approvalState: { status: 'issued', issuedAt: '2026-06-21T00:00:00.000Z', consumeCount: 0 },
  };
  approvalPacket.packetHash = approvalPacketBodyHash(approvalPacket);
  const missingApprovalHashEvidence = {
    version: 1,
    generatedAt: '2026-06-21T00:00:00.000Z',
    stage: 'spend',
    task: { taskId: 92 },
    approval: {
      packetHash: null,
      policyProfile: 'spend-allowed',
      approvalState: { status: 'issued' },
    },
    gates: { importReadyFiles: 0 },
    blockers: [],
  };
  missingApprovalHashEvidence.bundleHash = evidenceBundleBodyHash(missingApprovalHashEvidence);
  const missingApprovalHashReport = evaluateProductionExecutionInvariantContract({
    taskId: 92,
    entry: { taskId: 92 },
    approvalPacket,
    evidenceBundle: missingApprovalHashEvidence,
  });
  const ids = new Set(staleEvidenceReport.issues.map((item) => item.id));
  const staleIds = new Set(staleFinalReport.issues.map((item) => item.id));
  const noteIds = new Set(nonstandardNoteReport.issues.map((item) => item.id));
  const approvalIds = new Set(missingApprovalHashReport.issues.map((item) => item.id));
  const ok = qaGate.ok
    && !blockedImport.ok
    && passedImport.ok
    && artifactGate.ok
    && !staleEvidenceReport.ok
    && ids.has('import_ready_without_package_pass')
    && ids.has('evidence_source_stale')
    && !staleFinalReport.ok
    && staleIds.has('final_review_not_current')
    && pdfBookletReport.ok
    && !nonstandardNoteReport.ok
    && noteIds.has('nonstandard_submission_note')
    && !missingApprovalHashReport.ok
    && approvalIds.has('evidence_approval_hash_missing');
  return {
    ok,
    qaGate,
    blockedImport,
    passedImport,
    artifactGate,
    staleEvidenceSummary: staleEvidenceReport.summary,
    staleFinalSummary: staleFinalReport.summary,
    pdfBookletSummary: pdfBookletReport.summary,
    nonstandardNoteSummary: nonstandardNoteReport.summary,
    missingApprovalHashSummary: missingApprovalHashReport.summary,
    safety: PRODUCTION_EXECUTION_INVARIANT_SAFETY,
  };
}
