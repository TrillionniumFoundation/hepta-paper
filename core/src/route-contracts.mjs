import { digest } from './hash-utils.mjs';

export const ROUTE_CONTRACT_VERSION = 1;

export const ROUTE_CONTRACT_SAFETY = Object.freeze({
  localContractOnly: true,
  callsProviderOrModel: false,
  fetchesChannelState: false,
  mutatesChannelState: false,
  grantsExecutionPermission: false,
});

const IMAGE_EXTENSIONS = ['jpg', 'png'];
const PDF_EXTENSIONS = ['pdf'];
const DEFAULT_WORKFLOW_PACKAGE_FILE_COUNT = 5;
const WORKFLOW_PACKAGE_TYPES = new Set([
  'logo_vi',
  'logo_brand',
  'packaging_design',
  'proposal_board',
  'poster_design',
  'catalog_brochure',
  'generic_design',
  'product_design',
]);
const WORKFLOW_PACKAGE_IDS = new Set([
  'logo_brand',
  'packaging_design',
  'proposal_board',
  'poster_design',
  'catalog_brochure',
  'product_design',
]);

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function uniqueStrings(values = [], limit = 50) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = compact(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function evidenceToString(value) {
  if (!value || typeof value !== 'object') return compact(value);
  const source = compact(value.source || value.id || value.type || 'evidence');
  const quote = compact(value.quote || value.excerpt || value.text || value.reason || value.value || value.notes || '');
  if (source && quote) return `${source}: ${quote}`;
  if (quote) return quote;
  return compact(JSON.stringify(stable(value)));
}

function normalizeEvidence(values = [], limit = 12) {
  return uniqueStrings((values || []).map((item) => evidenceToString(item)), limit);
}

function normalizeRouteNames(values = [], limit = 20) {
  return uniqueStrings((values || []).map((item) => String(item || '').toLowerCase()), limit);
}

function normalizeRouteLocks(raw = {}, { finalArtifactShape, submitRoute, forbiddenRoutes = [] } = {}) {
  const locks = raw && typeof raw === 'object' ? Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, !!value])
  ) : {};
  const pdfRoute = finalArtifactShape === 'single_pdf' || submitRoute === 'pdf_booklet';
  const textRoute = finalArtifactShape === 'text_form' || submitRoute === 'text_form';
  const pdfForbidden = forbiddenRoutes.includes('pdf_booklet');
  if (!pdfRoute && (locks.pdfBooklet || pdfForbidden)) locks.pdfBooklet = false;
  if (!textRoute && locks.textForm) locks.textForm = false;
  return locks;
}

function normalizeFormats(values = []) {
  return uniqueStrings(values.map((item) => String(item || '').toLowerCase().replace(/^\./, '')), 12);
}

function stable(value) {
  if (Array.isArray(value)) return value.map((item) => stable(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function hashRouteContract(contract = {}) {
  const payload = { ...contract };
  delete payload.contractHash;
  return digest(stable(payload)).replace(/^sha256:/, '');
}

export function isBookCoverRouteText(text) {
  const value = compact(text);
  const bookCue = /book cover|book jacket|full[- ]?jacket|spine|back cover|front flap|back flap|ISBN|publisher|author|书籍装帧|图书装帧|书籍封面|图书封面|书封|书名|作者|出版社|出版|开本|封四|勒口|书脊|护封|封套/i.test(value);
  const coverCue = /cover|jacket|spine|flap|封面|封四|封底|勒口|书脊|护封|封套|全封|展开稿/i.test(value);
  const brochureCue = /brochure|catalog|leaflet|宣传册|画册|产品册|招商册|折页|三折页|目录册|手册/i.test(value);
  const specificBookCue = /book|ISBN|publisher|author|spine|flap|书籍|图书|出版社|作者|书名|本书|开本|封四|勒口|书脊|护封|装帧/i.test(value);
  return bookCue && coverCue && !(brochureCue && !specificBookCue);
}

function submitModeForShape(shape) {
  if (shape === 'text_form') return 'text_form';
  if (shape === 'single_pdf') return 'pdf_only';
  if (shape === 'mixed') return 'mixed';
  return 'file_upload';
}

function submitRouteForShape(shape) {
  if (shape === 'text_form') return 'text_form';
  if (shape === 'single_pdf') return 'pdf_booklet';
  return 'file_set';
}

function finalFormatsForShape(shape, rawFormats = []) {
  const formats = normalizeFormats(rawFormats);
  if (formats.length) return formats;
  if (shape === 'text_form') return ['text-form'];
  if (shape === 'single_pdf') return PDF_EXTENSIONS;
  if (shape === 'mixed') return ['jpg', 'png', 'pdf'];
  return IMAGE_EXTENSIONS;
}

function normalizeArtifactRoles(raw = [], expectedFinalFiles = null) {
  const roles = Array.isArray(raw) ? raw : [];
  const normalized = roles.map((item, index) => ({
    index: Number(item?.index || index + 1),
    role: compact(item?.role || item?.name || `artifact_${index + 1}`),
    required: item?.required !== false,
    notes: compact(item?.notes || item?.description || ''),
  }));
  if (normalized.length || !expectedFinalFiles) return normalized;
  return Array.from({ length: expectedFinalFiles }, (_, index) => ({
    index: index + 1,
    role: `final_artifact_${index + 1}`,
    required: true,
    notes: '',
  }));
}

function positiveInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number);
}

function promptArtifactRoles(plan = {}, target = 0, fallbackRoles = []) {
  const prompts = Array.isArray(plan?.prompts) ? plan.prompts.slice(0, target) : [];
  const roles = [];
  for (let index = 0; index < target; index += 1) {
    const prompt = prompts[index] || {};
    const fallback = fallbackRoles[index] || {};
    roles.push({
      index: index + 1,
      role: compact(prompt.role || fallback.role || fallback.name || `final_artifact_${index + 1}`),
      required: prompt.required !== false && fallback.required !== false,
      notes: compact(prompt.filename || prompt.description || fallback.notes || fallback.description || ''),
    });
  }
  return roles;
}

function workflowPackageTargetCount(plan = {}) {
  const promptCount = Array.isArray(plan?.prompts) ? plan.prompts.length : 0;
  const maxSubmitFiles = positiveInteger(plan?.artifactPolicy?.maxSubmitFiles ?? plan?.deliverableSpec?.maxSubmitFiles);
  const providerLimit = positiveInteger(plan?.providerHints?.defaultLimit);
  const workflowDefault = positiveInteger(plan?.workflow?.profile?.defaultOutputCount ?? plan?.profile?.defaultOutputCount);
  const seed = promptCount || providerLimit || workflowDefault || maxSubmitFiles || DEFAULT_WORKFLOW_PACKAGE_FILE_COUNT;
  if (!seed || seed <= 1) return null;
  return Math.max(2, Math.min(
    seed,
    maxSubmitFiles || seed,
    DEFAULT_WORKFLOW_PACKAGE_FILE_COUNT
  ));
}

function routeContractNeedsWorkflowPackageDefault(contract, plan = {}, target = null) {
  if (!contract || !plan) return false;
  const packageTarget = positiveInteger(target) || DEFAULT_WORKFLOW_PACKAGE_FILE_COUNT;
  if (Number(contract.expectedFinalFiles || 0) >= packageTarget) return false;
  if (!['image_set', 'mixed'].includes(contract.finalArtifactShape)) return false;
  if (!['file_set', 'expanded_file_set'].includes(contract.submitRoute)) return false;
  const pdfLocked = contract.routeLocks?.pdfBooklet && (contract.finalArtifactShape === 'single_pdf' || contract.submitRoute === 'pdf_booklet');
  if (pdfLocked || contract.routeLocks?.textForm || contract.routeLocks?.presentationDeck) return false;
  if (WORKFLOW_PACKAGE_TYPES.has(contract.deliverableType)) return true;
  if (WORKFLOW_PACKAGE_IDS.has(contract.workflowId || plan.workflowId)) return true;
  return !!(contract.routeLocks?.logo || contract.routeLocks?.packaging || contract.routeLocks?.proposalBoard);
}

function applyWorkflowPackageDefault(contract, plan = {}) {
  const target = workflowPackageTargetCount(plan);
  if (!target || target <= 1) return contract;
  if (!routeContractNeedsWorkflowPackageDefault(contract, plan, target)) return contract;
  const adjusted = {
    ...contract,
    expectedFinalFiles: target,
    artifactRoles: promptArtifactRoles(plan, target, contract.artifactRoles || []),
    evidence: uniqueStrings([
      ...(contract.evidence || []),
      `semantic expectedFinalFiles=${Number(contract.expectedFinalFiles || 0)} is below package target; ${plan.workflowId || contract.workflowId || 'workflow'} requires a ${target}-file client-facing package`,
    ], 12),
  };
  adjusted.contractHash = hashRouteContract(adjusted);
  return adjusted;
}

function contractFromWorkflow({ workflowId, entry = {}, requirementText = '', subject = {} } = {}) {
  const plannedExpectedFiles = Number(
    entry.routeContract?.expectedFinalFiles
    ?? entry.deliverableSpec?.expectedFileCount
    ?? entry.qaContract?.expectedArtifactCount
    ?? entry.expectedFinalFiles
    ?? entry.outputCount
    ?? NaN
  );
  const imageSetExpectedFiles = Number.isFinite(plannedExpectedFiles) && plannedExpectedFiles > 0
    ? Math.round(plannedExpectedFiles)
    : 5;
  const text = [
    entry.title,
    entry.category3Name,
    subject.projectText,
    subject.brandText,
    subject.productText,
    subject.deliverableText,
    ...(subject.mustUseText || []),
    requirementText,
  ].filter(Boolean).join('\n');
  if (workflowId === 'naming_text') {
    return {
      deliverableType: 'naming_text',
      finalArtifactShape: 'text_form',
      submitRoute: 'text_form',
      expectedFinalFiles: 0,
      finalFormats: ['text-form'],
      artifactRoles: [],
      routeLocks: { textForm: true },
      evidence: ['workflow requires live text-form submission'],
    };
  }
  if (isBookCoverRouteText(text)) {
    return {
      deliverableType: 'book_cover_jacket',
      finalArtifactShape: 'image_set',
      submitRoute: 'file_set',
      expectedFinalFiles: 5,
      finalFormats: IMAGE_EXTENSIONS,
      artifactRoles: [
        { index: 1, role: 'book_jacket_full_wrap', required: true },
        { index: 2, role: 'book_cover_front_hero', required: true },
        { index: 3, role: 'book_back_cover_flap_system', required: true },
        { index: 4, role: 'book_jacket_cultural_direction', required: true },
        { index: 5, role: 'book_cover_print_handoff_overview', required: true },
      ],
      mustPreserve: uniqueStrings([
        subject.projectText,
        subject.productText,
        ...(subject.mustUseText || []),
      ], 24),
      forbiddenRoutes: ['pdf_booklet', 'generic_catalog_brochure'],
      routeLocks: { bookCover: true, pdfBooklet: false, imageSet: true },
      evidence: ['buyer text describes a book cover/jacket/full-cover deliverable'],
    };
  }
  if (workflowId === 'presentation_deck') {
    return {
      deliverableType: 'presentation_deck',
      finalArtifactShape: 'single_pdf',
      submitRoute: 'pdf_booklet',
      expectedFinalFiles: 1,
      finalFormats: PDF_EXTENSIONS,
      forbiddenRoutes: ['loose_image_set_without_deck'],
      routeLocks: { presentationDeck: true, pdfBooklet: true },
      evidence: ['workflow requires deck-style final delivery'],
    };
  }
  if (workflowId === 'proposal_board') {
    return {
      deliverableType: 'proposal_board',
      finalArtifactShape: 'single_pdf',
      submitRoute: 'pdf_booklet',
      expectedFinalFiles: 1,
      finalFormats: PDF_EXTENSIONS,
      forbiddenRoutes: ['loose_raw_render_set'],
      routeLocks: { proposalBoard: true, pdfBooklet: true },
      evidence: ['workflow requires formal proposal package'],
    };
  }
  return {
    deliverableType: workflowId || 'generic_design',
    finalArtifactShape: 'image_set',
    submitRoute: 'file_set',
    expectedFinalFiles: imageSetExpectedFiles,
    finalFormats: IMAGE_EXTENSIONS,
    routeLocks: { imageSet: true },
    evidence: ['default workflow-owned route contract'],
  };
}

export function normalizeRouteContract(raw = null, context = {}) {
  const fallback = raw && typeof raw === 'object' ? raw : contractFromWorkflow(context);
  const shape = compact(fallback.finalArtifactShape || fallback.finalShape || fallback.artifactShape || '').toLowerCase() || 'image_set';
  const submitRoute = compact(fallback.submitRoute || fallback.route || submitRouteForShape(shape)).toLowerCase();
  const forbiddenRoutes = normalizeRouteNames(fallback.forbiddenRoutes || [], 20);
  const expectedFinalFiles = Number.isFinite(Number(fallback.expectedFinalFiles ?? fallback.expectedFileCount))
    ? Math.max(0, Number(fallback.expectedFinalFiles ?? fallback.expectedFileCount))
    : (shape === 'text_form' ? 0 : (shape === 'single_pdf' ? 1 : 5));
  const contract = {
    version: ROUTE_CONTRACT_VERSION,
    source: compact(fallback.source || (raw ? 'semantic_intake_route_contract' : 'agent_workflow_contract')),
    deliverableType: compact(fallback.deliverableType || fallback.type || context.workflowId || 'generic_design'),
    workflowId: compact(fallback.workflowId || context.workflowId || ''),
    finalArtifactShape: shape,
    submitRoute,
    submitMode: compact(fallback.submitMode || submitModeForShape(shape)),
    expectedFinalFiles,
    finalFormats: finalFormatsForShape(shape, fallback.finalFormats || fallback.formats || []),
    artifactRoles: normalizeArtifactRoles(fallback.artifactRoles || fallback.roles || [], expectedFinalFiles),
    mustPreserve: uniqueStrings([...(fallback.mustPreserve || []), ...(fallback.mustPreserveText || [])], 40),
    forbiddenRoutes,
    routeLocks: normalizeRouteLocks(fallback.routeLocks, { finalArtifactShape: shape, submitRoute, forbiddenRoutes }),
    evidence: normalizeEvidence(fallback.evidence || [], 12),
  };
  contract.contractHash = hashRouteContract(contract);
  return contract;
}

export function buildRouteContract({ semanticIntake = null, workflowId = null, entry = {}, requirementText = '', subject = null } = {}) {
  const parsed = semanticIntake?.routeContract
    || semanticIntake?.modelResponse?.parsed?.routeContract
    || null;
  return normalizeRouteContract(parsed, {
    workflowId: workflowId || semanticIntake?.taskUnderstanding?.workflowId || null,
    entry,
    requirementText,
    subject: subject || semanticIntake?.subject || {},
  });
}

export function routeContractRoute(contract = null) {
  const normalized = normalizeRouteContract(contract);
  return {
    route: normalized.submitRoute,
    expectedFinalFiles: normalized.expectedFinalFiles,
    source: 'route_contract',
    reason: `RouteContract ${normalized.deliverableType}/${normalized.finalArtifactShape}`,
    contractHash: normalized.contractHash,
  };
}

export function applyRouteContractToPlan(plan, contract) {
  if (!plan) return plan;
  const normalized = applyWorkflowPackageDefault(normalizeRouteContract(contract, {
    workflowId: plan.workflowId,
    entry: plan,
    requirementText: plan.requirementExcerpt || '',
    subject: plan.subject || {},
  }), plan);
  plan.routeContract = normalized;
  plan.routeContractHash = normalized.contractHash;
  plan.deliverableSpec ||= {};
  plan.deliverableSpec.submitMode = normalized.submitMode;
  plan.deliverableSpec.expectedFileCount = normalized.expectedFinalFiles;
  plan.deliverableSpec.finalFormats = normalized.finalFormats;
  plan.deliverableSpec.routeContractHash = normalized.contractHash;
  plan.deliverableSpec.routeContractDeliverableType = normalized.deliverableType;
  plan.submitLimitSpec ||= {};
  plan.submitLimitSpec.route = normalized.submitRoute;
  plan.submitLimitSpec.expectedFinalFiles = normalized.expectedFinalFiles;
  plan.submitLimitSpec.routeContractHash = normalized.contractHash;
  plan.qaContract ||= {};
  plan.qaContract.submitMode = normalized.submitMode;
  plan.qaContract.routeContractHash = normalized.contractHash;
  plan.packageRules = [...new Set([
    `RouteContract owns business route: ${normalized.deliverableType}/${normalized.finalArtifactShape}/${normalized.submitRoute}.`,
    ...(plan.packageRules || []),
  ])];
  return plan;
}

export function validateRouteContractAgainstLiveRules(contract = null, rules = null) {
  const normalized = normalizeRouteContract(contract);
  if (!rules) return { ok: true, issues: [], contract: normalized, liveRulesKnown: false };
  const issues = [];
  const maxFiles = Number(rules?.maxFilesPerSubmit || rules?.maxFiles || 0) || null;
  const allowedExtensions = Array.isArray(rules?.allowedExtensions)
    ? rules.allowedExtensions.map((item) => String(item || '').toLowerCase().replace(/^\./, '')).filter(Boolean)
    : [];
  const pdfAllowed = !allowedExtensions.length || allowedExtensions.includes('pdf');
  const isNamingBranch = !!rules?.isNamingBranch;
  if (isNamingBranch && normalized.finalArtifactShape !== 'text_form') {
    issues.push({
      id: 'route_contract_live_mode_conflict',
      message: 'live modal is text-form but RouteContract expects file artifacts',
      details: { routeContract: normalized.finalArtifactShape },
    });
  }
  if (!isNamingBranch && normalized.finalArtifactShape === 'text_form') {
    issues.push({
      id: 'route_contract_text_form_conflict',
      message: 'RouteContract expects text-form but live modal is file upload',
      details: { routeContract: normalized.finalArtifactShape },
    });
  }
  if (normalized.finalArtifactShape === 'single_pdf' && !pdfAllowed) {
    issues.push({
      id: 'route_contract_pdf_not_allowed',
      message: 'RouteContract expects one PDF but live upload rules do not allow PDF',
      details: { allowedExtensions },
    });
  }
  if (maxFiles !== null && normalized.expectedFinalFiles > maxFiles) {
    issues.push({
      id: 'route_contract_file_count_exceeds_live_limit',
      message: 'RouteContract expected final file count exceeds live upload limit',
      details: { expectedFinalFiles: normalized.expectedFinalFiles, maxFilesPerSubmit: maxFiles },
    });
  }
  return { ok: issues.length === 0, issues, contract: normalized };
}

export function routeContractPackageChecks({ plan = null, manifest = null, files = [], countOverrideAccepted = false } = {}) {
  const explicitContract = plan?.routeContract || manifest?.routeContract || null;
  const fallbackEntry = {
    ...(manifest || {}),
    ...(plan || {}),
    deliverableSpec: plan?.deliverableSpec || manifest?.deliverableSpec || {},
    qaContract: plan?.qaContract || manifest?.qaContract || {},
  };
  const contract = explicitContract || ((plan || manifest) ? buildRouteContract({
    semanticIntake: plan?.semanticIntake || manifest?.semanticIntake || null,
    workflowId: plan?.workflowId || manifest?.workflowId || null,
    entry: fallbackEntry,
    requirementText: plan?.requirementExcerpt || manifest?.requirementExcerpt || '',
    subject: plan?.subject || manifest?.subject || null,
  }) : null);
  if (!contract) return [];
  const normalized = applyWorkflowPackageDefault(normalizeRouteContract(contract, {
    workflowId: plan?.workflowId || manifest?.workflowId || null,
    entry: plan || manifest || {},
    requirementText: plan?.requirementExcerpt || '',
    subject: plan?.subject || manifest?.subject || {},
  }), plan || {});
  const manifestHash = manifest?.routeContract?.contractHash || manifest?.routeContractHash || null;
  const checks = [{
    id: 'route_contract_present',
    label: 'RouteContract is present and owns the business delivery route.',
    status: 'pass',
    notes: `${normalized.deliverableType}/${normalized.finalArtifactShape}/${normalized.submitRoute}`,
  }];
  if (manifest && manifestHash && manifestHash !== normalized.contractHash) {
    checks.push({
      id: 'route_contract_manifest_stale',
      label: 'Generation manifest RouteContract matches the current production plan.',
      status: 'fail',
      notes: `plan=${normalized.contractHash}; manifest=${manifestHash}`,
    });
  } else if (manifest) {
    checks.push({
      id: 'route_contract_manifest_current',
      label: 'Generation manifest RouteContract matches the current production plan.',
      status: 'pass',
      notes: normalized.contractHash,
    });
  }
  const singlePdfIntermediate = manifest
    && normalized.finalArtifactShape === 'single_pdf'
    && files.length
    && !files.every((file) => /\.pdf$/i.test(String(file || '')));
  if (singlePdfIntermediate) {
    checks.push({
      id: 'route_contract_generation_intermediate',
      label: 'Generation package is an intermediate set for a RouteContract single-PDF final.',
      status: 'pass',
      notes: `${files.length} intermediate source file(s); final review enforces the single-PDF shape`,
    });
  } else if (files.length) {
    const expected = normalized.expectedFinalFiles;
    const countOk = normalized.finalArtifactShape === 'text_form'
      ? files.length === 0
      : files.length === expected;
    const legacyOverrideOk = !explicitContract && countOverrideAccepted && normalized.finalArtifactShape === 'image_set';
    checks.push({
      id: 'route_contract_final_count',
      label: 'Final package file count matches RouteContract.',
      status: (countOk || legacyOverrideOk) ? 'pass' : 'fail',
      notes: legacyOverrideOk ? `${files.length}/${expected}; accepted by package policy for legacy inferred contract` : `${files.length}/${expected}`,
    });
    if (normalized.finalArtifactShape === 'single_pdf') {
      const pdfOk = files.length === 1 && /\.pdf$/i.test(String(files[0] || ''));
      checks.push({
        id: 'route_contract_single_pdf_shape',
        label: 'Final package follows the RouteContract single-PDF shape.',
        status: pdfOk ? 'pass' : 'fail',
        notes: files.map((file) => String(file || '').split('/').pop()).join(', '),
      });
    }
  }
  return checks;
}

export function routeContractSelftest() {
  const liveTenPdf = { maxFilesPerSubmit: 10, allowedExtensions: ['jpg', 'png', 'pdf'], isNamingBranch: false };
  const semanticLogoOne = {
    deliverableType: 'logo_vi',
    workflowId: 'logo_brand',
    finalArtifactShape: 'image_set',
    submitRoute: 'file_set',
    expectedFinalFiles: 1,
    finalFormats: ['jpg', 'png'],
    artifactRoles: [{ index: 1, role: 'logo_vi_board', required: true }],
    routeLocks: { logo: true },
  };
  const logoPlan = applyRouteContractToPlan({
    workflowId: 'logo_brand',
    prompts: Array.from({ length: 5 }, (_, index) => ({
      index: index + 1,
      role: 'finished_vi_board',
      filename: `logo-route-${index + 1}.jpg`,
    })),
    artifactPolicy: { maxSubmitFiles: 5 },
    providerHints: { defaultLimit: 5 },
    deliverableSpec: {},
    qaContract: {},
    packageRules: [],
  }, semanticLogoOne);
  const explicitPackagingPlan = applyRouteContractToPlan({
    workflowId: 'packaging_design',
    prompts: Array.from({ length: 5 }, (_, index) => ({
      index: index + 1,
      role: `packaging_board_${index + 1}`,
      filename: `packaging-${index + 1}.jpg`,
    })),
    artifactPolicy: { maxSubmitFiles: 5 },
    deliverableSpec: {},
    qaContract: {},
    packageRules: [],
  }, {
    deliverableType: 'packaging_design',
    workflowId: 'packaging_design',
    finalArtifactShape: 'image_set',
    submitRoute: 'file_set',
    expectedFinalFiles: 3,
    finalFormats: ['jpg', 'png'],
    artifactRoles: [{ index: 1, role: 'front' }, { index: 2, role: 'back' }, { index: 3, role: 'mockup' }],
    routeLocks: { packaging: true },
  });
  const contradictoryPackagingPlan = applyRouteContractToPlan({
    workflowId: 'packaging_design',
    prompts: Array.from({ length: 5 }, (_, index) => ({
      index: index + 1,
      role: `packaging_board_${index + 1}`,
      filename: `packaging-conflict-${index + 1}.jpg`,
    })),
    artifactPolicy: { maxSubmitFiles: 5 },
    deliverableSpec: {},
    qaContract: {},
    packageRules: [],
  }, {
    deliverableType: 'packaging_design',
    workflowId: 'packaging_design',
    finalArtifactShape: 'image_set',
    submitRoute: 'file_set',
    expectedFinalFiles: 2,
    finalFormats: ['jpg', 'png'],
    artifactRoles: [{ index: 1, role: 'bottle_mockup' }, { index: 2, role: 'box_mockup' }],
    forbiddenRoutes: ['pdf_booklet'],
    routeLocks: { packaging: true, pdfBooklet: true },
    evidence: [{ source: 'requirement', quote: 'single product bottle and box packaging' }],
  });
  const productPlan = applyRouteContractToPlan({
    workflowId: 'product_design',
    prompts: Array.from({ length: 5 }, (_, index) => ({
      index: index + 1,
      role: index < 4 ? 'product_route_board' : 'product_overview',
      filename: `product-route-${index + 1}.jpg`,
    })),
    artifactPolicy: { maxSubmitFiles: 5 },
    providerHints: { defaultLimit: 5 },
    deliverableSpec: {},
    qaContract: {},
    packageRules: [],
  }, {
    deliverableType: 'product_design',
    workflowId: 'product_design',
    finalArtifactShape: 'image_set',
    submitRoute: 'file_set',
    expectedFinalFiles: 1,
    finalFormats: ['jpg', 'png'],
    artifactRoles: [{ index: 1, role: 'final_artifact', required: true }],
  });
  const book = buildRouteContract({
    workflowId: 'catalog_brochure',
    entry: { title: 'Book cover design' },
    requirementText: 'Book cover, spine, back cover, front flap and back flap. Author and publisher must be preserved.',
  });
  const bookRoute = routeContractRoute(book);
  const bookLive = validateRouteContractAgainstLiveRules(book, liveTenPdf);
  const pdf = normalizeRouteContract({
    deliverableType: 'proposal_board',
    finalArtifactShape: 'single_pdf',
    expectedFinalFiles: 1,
    finalFormats: ['pdf'],
  }, { workflowId: 'proposal_board' });
  const pdfBlocked = validateRouteContractAgainstLiveRules(pdf, { maxFilesPerSubmit: 5, allowedExtensions: ['jpg', 'png'], isNamingBranch: false });
  const ok = book.deliverableType === 'book_cover_jacket'
    && bookRoute.route === 'file_set'
    && bookRoute.expectedFinalFiles === 5
    && bookLive.ok
    && pdfBlocked.issues.some((item) => item.id === 'route_contract_pdf_not_allowed')
    && logoPlan.routeContract.expectedFinalFiles === 5
    && logoPlan.deliverableSpec.expectedFileCount === 5
    && logoPlan.routeContract.artifactRoles.length === 5
    && explicitPackagingPlan.routeContract.expectedFinalFiles === 5
    && explicitPackagingPlan.deliverableSpec.expectedFileCount === 5
    && contradictoryPackagingPlan.routeContract.expectedFinalFiles === 5
    && contradictoryPackagingPlan.routeContract.routeLocks.pdfBooklet === false
    && contradictoryPackagingPlan.routeContract.evidence.some((item) => item.includes('requirement: single product bottle and box packaging'))
    && productPlan.routeContract.expectedFinalFiles === 5
    && productPlan.deliverableSpec.expectedFileCount === 5
    && productPlan.routeContract.artifactRoles.length === 5;
  return { ok, safety: ROUTE_CONTRACT_SAFETY, logoPlan: logoPlan.routeContract, explicitPackagingPlan: explicitPackagingPlan.routeContract, contradictoryPackagingPlan: contradictoryPackagingPlan.routeContract, productPlan: productPlan.routeContract, book, bookRoute, bookLive, pdfBlocked };
}
