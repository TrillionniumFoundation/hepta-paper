import path from 'node:path';
import {
  applyRouteContractToPlan,
  routeContractRoute,
  validateRouteContractAgainstLiveRules,
} from './route-contracts.mjs';

export const LIVE_SUBMIT_RULES_CONTRACT_VERSION = 1;

export const LIVE_SUBMIT_RULES_SAFETY = Object.freeze({
  localContractOnly: true,
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

const DEFAULT_MAX_FILES = 5;
const DEFAULT_MAX_FILE_SIZE_MB = 50;
const PDF_BOOKLET_WORKFLOWS = new Set(['proposal_board', 'presentation_deck', 'catalog_brochure']);

function normalizeDigits(input) {
  return String(input || '').replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

export function normalizeLiveRuleText(text) {
  return normalizeDigits(text).replace(/\s+/g, ' ').trim();
}

function cnNumberToInt(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  if (/^\d+$/.test(normalizeDigits(text))) return Number(normalizeDigits(text));
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (!/[十零一二两三四五六七八九]/.test(text)) return null;
  if (text.includes('十')) {
    const [tensRaw, onesRaw] = text.split('十');
    const tens = tensRaw ? digits[tensRaw] : 1;
    const ones = onesRaw ? digits[onesRaw] : 0;
    if (tens === undefined || ones === undefined) return null;
    return tens * 10 + ones;
  }
  if (text.length === 1 && digits[text] !== undefined) return digits[text];
  return null;
}

function captureNumber(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = cnNumberToInt(match[1]);
    if (Number.isFinite(value) && value > 0) return { value, evidence: match[0] };
  }
  return { value: null, evidence: null };
}

export function parseMaxFilesFromText(modalText) {
  const text = normalizeLiveRuleText(modalText);
  return captureNumber(text, [
    /最多可上传\s*(\d+|[一二两三四五六七八九十]+)\s*个(?:稿件|文件|附件|作品)?/,
    /一次交稿最多(?:可)?上传\s*(\d+|[一二两三四五六七八九十]+)\s*个(?:稿件|文件|附件|作品)?/,
    /一次最多(?:可)?上传\s*(\d+|[一二两三四五六七八九十]+)\s*个(?:稿件|文件|附件|作品)?/,
    /每次最多(?:可)?上传\s*(\d+|[一二两三四五六七八九十]+)\s*个(?:稿件|文件|附件|作品)?/,
    /最多上传\s*(\d+|[一二两三四五六七八九十]+)\s*个(?:稿件|文件|附件|作品)?/,
  ]);
}

export function parseMaxNamingItemsFromText(modalText) {
  const text = normalizeLiveRuleText(modalText);
  return captureNumber(text, [
    /一次交稿最多添加\s*(\d+|[一二两三四五六七八九十]+)\s*个方案/,
    /最多添加\s*(\d+|[一二两三四五六七八九十]+)\s*个方案/,
  ]);
}

export function parseMaxSubmissionNoteCharsFromText(modalText) {
  const text = normalizeLiveRuleText(modalText);
  const match = text.match(/知识产权声明\s*\d+\s*\/\s*(\d+)/) || text.match(/\b\d+\s*\/\s*(\d{2,5})\b/);
  if (!match) return { value: null, evidence: null };
  return { value: Number(match[1]), evidence: match[0] };
}

export function parseMaxFileSizeMbFromText(modalText) {
  const text = normalizeLiveRuleText(modalText);
  const match = text.match(/(\d+(?:\.\d+)?)\s*(?:M|MB|兆)(?:以内|以下|内)?/i);
  if (!match) return { value: null, evidence: null };
  return { value: Number(match[1]), evidence: match[0] };
}

export function parseAllowedExtensionsFromText(modalText) {
  const text = normalizeLiveRuleText(modalText);
  const match = text.match(/仅限\s*([a-z0-9,，、\s]+?)\s*格式/i);
  if (!match) return [];
  return match[1]
    .split(/[,，、\s]+/)
    .map((item) => item.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
}

function allowedExtensionsFromPitchRule(pitchRule) {
  return String(pitchRule?.worksFrom || '')
    .split(',')
    .map((item) => item.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
}

export function deriveLiveSubmitRules({ modalText = '', pitchRule = null, defaultMaxFiles = DEFAULT_MAX_FILES, defaultMaxFileSizeMb = DEFAULT_MAX_FILE_SIZE_MB } = {}) {
  const text = normalizeLiveRuleText(modalText);
  const textMaxFiles = parseMaxFilesFromText(text);
  const textMaxSize = parseMaxFileSizeMbFromText(text);
  const textNaming = parseMaxNamingItemsFromText(text);
  const textMaxSubmissionNoteChars = parseMaxSubmissionNoteCharsFromText(text);
  const textExtensions = parseAllowedExtensionsFromText(text);
  const pitchMaxFiles = Number(pitchRule?.bidNum || 0) || null;
  const pitchMaxSize = Number(pitchRule?.worksLimit || 0) || null;
  const pitchExtensions = allowedExtensionsFromPitchRule(pitchRule);
  const hasPitchRule = !!pitchRule && Object.keys(pitchRule || {}).length > 0;
  const maxFilesPerSubmit = Number(textMaxFiles.value || pitchMaxFiles || defaultMaxFiles);
  const maxFileSizeMb = Number(textMaxSize.value || pitchMaxSize || defaultMaxFileSizeMb);
  const allowedExtensions = pitchExtensions.length ? pitchExtensions : textExtensions;
  const modalNaming = /名字|释义|添加方案/.test(text);
  const workRuleType = pitchRule?.type ?? null;
  const isNamingBranch = modalNaming || Number(workRuleType || 0) === 3 || (hasPitchRule && allowedExtensions.length === 0);
  const maxNamingItems = Number(textNaming.value || (isNamingBranch ? defaultMaxFiles : defaultMaxFiles));
  const sources = {
    maxFilesPerSubmit: textMaxFiles.value ? 'live_modal_text' : (pitchMaxFiles ? 'pitch_rule_bidNum' : 'fallback_default_5'),
    maxFileSizeMb: textMaxSize.value ? 'live_modal_text' : (pitchMaxSize ? 'pitch_rule_worksLimit' : 'fallback_default_50'),
    maxSubmissionNoteChars: textMaxSubmissionNoteChars.value ? 'live_modal_text' : 'not_found',
    allowedExtensions: pitchExtensions.length ? 'pitch_rule_worksFrom' : (textExtensions.length ? 'live_modal_text' : 'not_found'),
    isNamingBranch: modalNaming ? 'live_modal_text' : (Number(workRuleType || 0) === 3 ? 'pitch_rule_type' : ((hasPitchRule && allowedExtensions.length === 0) ? 'pitch_rule_no_extensions' : 'file_upload_default')),
    maxNamingItems: textNaming.value ? 'live_modal_text' : 'fallback_default_5',
  };
  return {
    version: LIVE_SUBMIT_RULES_CONTRACT_VERSION,
    safety: LIVE_SUBMIT_RULES_SAFETY,
    maxFiles: maxFilesPerSubmit,
    maxFilesPerSubmit,
    maxFileSizeMb,
    maxSubmissionNoteChars: textMaxSubmissionNoteChars.value || null,
    allowedExtensions,
    isNamingBranch,
    maxNamingItems,
    ruleId: pitchRule?.id ?? null,
    workRuleType,
    sources,
    evidence: {
      maxFilesPerSubmit: textMaxFiles.evidence || (pitchMaxFiles ? 'pitchRule.bidNum=' + pitchMaxFiles : null),
      maxFileSizeMb: textMaxSize.evidence || (pitchMaxSize ? 'pitchRule.worksLimit=' + pitchMaxSize : null),
      maxSubmissionNoteChars: textMaxSubmissionNoteChars.evidence || null,
      maxNamingItems: textNaming.evidence || null,
    },
    text,
    derivedAt: new Date().toISOString(),
  };
}

export function normalizeLiveSubmitRules(raw) {
  if (!raw) return null;
  const derived = !raw.sources && raw.text ? deriveLiveSubmitRules({ modalText: raw.text }) : {};
  const merged = { ...derived, ...raw };
  const maxFilesPerSubmit = Number(merged.maxFilesPerSubmit || merged.maxFiles || 0) || null;
  return {
    ...merged,
    version: Number(merged.version || LIVE_SUBMIT_RULES_CONTRACT_VERSION),
    safety: {
      ...LIVE_SUBMIT_RULES_SAFETY,
      ...(merged.safety || {}),
    },
    maxFiles: maxFilesPerSubmit,
    maxFilesPerSubmit,
    maxFileSizeMb: Number(merged.maxFileSizeMb || 0) || null,
    maxSubmissionNoteChars: Number(merged.maxSubmissionNoteChars || 0) || null,
    allowedExtensions: Array.isArray(merged.allowedExtensions) ? merged.allowedExtensions : [],
    sources: merged.sources || {},
  };
}

export function packageCapacityGap(rules, { localAvailableCount = 0, selectedCount = 0, uploadedCount = null, pdfBookletSatisfied = false } = {}) {
  const liveRules = normalizeLiveSubmitRules(rules);
  const maxFiles = Number(liveRules?.maxFilesPerSubmit || 0);
  const selected = Number(selectedCount || 0);
  const available = Number(localAvailableCount || 0);
  const uploaded = uploadedCount === null || uploadedCount === undefined ? null : Number(uploadedCount || 0);
  const isNamingBranch = !!liveRules?.isNamingBranch;
  const skipSlotFill = isNamingBranch || pdfBookletSatisfied;
  const minimumFilesForSubmit = maxFiles === 10 ? 5 : maxFiles;
  return {
    maxFilesPerSubmit: maxFiles || null,
    minimumFilesForSubmit: minimumFilesForSubmit || null,
    underLimitAccepted: maxFiles === 10,
    localAvailableCount: available,
    selectedCount: selected,
    uploadedCount: uploaded,
    pdfBookletSatisfied: !!pdfBookletSatisfied,
    needsMoreLocalFiles: !skipSlotFill && minimumFilesForSubmit > 0 && available < minimumFilesForSubmit,
    needsMoreSelectedFiles: !skipSlotFill && minimumFilesForSubmit > 0 && selected < minimumFilesForSubmit,
    uploadedUnderLiveLimit: !skipSlotFill && minimumFilesForSubmit > 0 && uploaded !== null && uploaded < minimumFilesForSubmit,
  };
}

function allowsPdfUpload(rules) {
  const extensions = normalizeLiveSubmitRules(rules)?.allowedExtensions || [];
  return !extensions.length || extensions.includes('pdf');
}

export function isBookCoverPackageText(text) {
  const normalized = normalizeLiveRuleText(text);
  const bookCue = /书籍装帧|图书装帧|书籍设计|图书设计|书籍封面|图书封面|书封|书名|作者|出版社|出版|ISBN|开本|本书|封四|勒口|书脊|护封|封套/i.test(normalized);
  const jacketCue = /封面|封四|勒口|书脊|护封|封底|封套|全封|展开稿|书籍装帧|图书装帧/i.test(normalized);
  const brochureCue = /宣传册|画册|产品册|招商册|折页|三折页|目录册|手册/i.test(normalized);
  const specificBookCue = /书籍|图书|出版社|作者|书名|本书|ISBN|开本|封四|勒口|书脊|护封|装帧/i.test(normalized);
  return bookCue && jacketCue && !(brochureCue && !specificBookCue);
}

function expandedFilename(seedName, index, usedNames) {
  const ext = path.extname(String(seedName || 'artifact.jpg')) || '.jpg';
  const stem = path.basename(String(seedName || 'artifact.jpg'), ext);
  const pad = String(index).padStart(2, '0');
  let candidate = stem.replace(/(\d+)(?=[^0-9]*$)/, pad) + ext;
  if (candidate === seedName || usedNames.has(candidate)) candidate = stem + '-expanded-' + pad + ext;
  while (usedNames.has(candidate)) candidate = stem + '-expanded-' + pad + '-' + (usedNames.size + 1) + ext;
  return candidate;
}

function extendPromptsToLiveLimit(plan, targetCount) {
  const target = Number(targetCount || 0);
  if (!target || !Array.isArray(plan?.prompts) || plan.prompts.length >= target || !plan.prompts.length) return;
  const usedNames = new Set(plan.prompts.map((item) => item.filename).filter(Boolean));
  const seed = plan.prompts[plan.prompts.length - 1];
  while (plan.prompts.length < target) {
    const index = plan.prompts.length + 1;
    const filename = expandedFilename(seed.filename, index, usedNames);
    usedNames.add(filename);
    plan.prompts.push({
      ...seed,
      index,
      filename,
      role: String(seed.role || 'final_board') + '_expanded_' + String(index).padStart(2, '0'),
      prompt: String(seed.prompt || '') + '\n\nAdditional live-limit route ' + index + ': create a meaningfully different finished submission board for the same buyer brief. Do not make a minor duplicate of earlier routes; vary the concept, layout, application proof, palette, or structure while preserving the exact semantic subject and buyer constraints.',
      acceptance: [
        ...(seed.acceptance || []),
        'Additional live-limit route is meaningfully different from the earlier package routes.',
        'Still matches the exact semantic subject and buyer constraints.',
      ],
    });
  }
  plan.deliverableSpec ||= {};
  plan.deliverableSpec.expectedFileCount = target;
  plan.artifactPolicy ||= {};
  plan.artifactPolicy.maxSubmitFiles = target;
  plan.qaContract ||= {};
  plan.qaContract.expectedArtifactCount = target;
  plan.providerHints ||= {};
  plan.providerHints.defaultLimit = target;
  plan.packageRules ||= [];
  plan.packageRules.unshift('Live submit limit is larger than the workflow default; prompts were expanded to fill all live upload slots.');
}

export function recommendSubmitRoute({ workflowId = null, entry = {}, requirementText = '', rules = null } = {}) {
  const liveRules = normalizeLiveSubmitRules(rules);
  const maxFiles = Number(liveRules?.maxFilesPerSubmit || 0) || null;
  if (!liveRules) {
    return {
      route: 'live_rules_missing',
      expectedFinalFiles: null,
      source: 'missing',
      reason: 'live-submit-rules not available before planning',
    };
  }
  if (liveRules.isNamingBranch) {
    return {
      route: 'text_form',
      expectedFinalFiles: 0,
      source: liveRules.sources?.isNamingBranch || 'live_submit_rules',
      reason: 'live submit modal/rule is naming text form',
    };
  }
  if (workflowId === 'naming_text' && allowsPdfUpload(liveRules)) {
    return {
      route: 'text_document_pdf',
      expectedFinalFiles: 1,
      source: liveRules.sources?.maxFilesPerSubmit || 'live_submit_rules',
      reason: 'text/writing task uses file-upload modal; build one polished PDF document instead of filling upload slots with duplicate text files',
    };
  }
  const text = [entry.title, entry.category3Name, requirementText].filter(Boolean).join('\n');
  if (maxFiles >= 8 && isBookCoverPackageText(text)) {
    return {
      route: 'expanded_file_set',
      expectedFinalFiles: maxFiles === 10 ? 5 : maxFiles,
      source: liveRules.sources?.maxFilesPerSubmit || 'live_submit_rules',
      reason: 'book-cover/full-jacket task with large live upload limit; submit several finished cover directions instead of a PDF booklet',
    };
  }
  const pdfCue = /PDF|小册子|册子|画册|宣传册|手册|PPT|幻灯片|方案册|方案板|提案|汇报|招商|catalog|brochure|deck/i.test(text);
  if (maxFiles >= 8 && allowsPdfUpload(liveRules) && (PDF_BOOKLET_WORKFLOWS.has(String(workflowId || '')) || pdfCue)) {
    return {
      route: 'pdf_booklet',
      expectedFinalFiles: 1,
      source: liveRules.sources?.maxFilesPerSubmit || 'live_submit_rules',
      reason: 'large live upload limit plus proposal/brochure/deck cues; build a merged PDF booklet as the final submit artifact',
    };
  }
  if (maxFiles >= 8) {
    const acceptedMinimum = maxFiles === 10 ? 5 : maxFiles;
    return {
      route: 'expanded_file_set',
      expectedFinalFiles: acceptedMinimum,
      source: liveRules.sources?.maxFilesPerSubmit || 'live_submit_rules',
      reason: maxFiles === 10
        ? 'large live upload limit without PDF-booklet cues; user-approved 5-of-10 package is sufficient'
        : 'large live upload limit without PDF-booklet cues; plan should cover all upload slots',
    };
  }
  return {
    route: 'file_set',
    expectedFinalFiles: maxFiles || DEFAULT_MAX_FILES,
    source: liveRules.sources?.maxFilesPerSubmit || 'live_submit_rules',
    reason: 'standard file-upload package',
  };
}

export function applyLiveSubmitRulesToPlan(plan, { rules = null, route = null } = {}) {
  if (!plan) return plan;
  const liveRules = normalizeLiveSubmitRules(rules);
  if (plan.routeContract) applyRouteContractToPlan(plan, plan.routeContract);
  const routeDecision = plan.routeContract
    ? routeContractRoute(plan.routeContract)
    : (route || recommendSubmitRoute({ workflowId: plan.workflowId, entry: plan, requirementText: plan.requirementExcerpt || '', rules: liveRules }));
  const routeContractGate = plan.routeContract
    ? validateRouteContractAgainstLiveRules(plan.routeContract, liveRules)
    : { ok: true, issues: [] };
  plan.liveSubmitRules = liveRules;
  plan.submitLimitSpec = {
    version: LIVE_SUBMIT_RULES_CONTRACT_VERSION,
    liveRulesKnown: !!liveRules,
    maxFilesPerSubmit: liveRules?.maxFilesPerSubmit || null,
    maxFileSizeMb: liveRules?.maxFileSizeMb || null,
    allowedExtensions: liveRules?.allowedExtensions || [],
    sources: liveRules?.sources || {},
    route: routeDecision.route,
    routeReason: routeDecision.reason,
    routeSource: routeDecision.source,
    expectedFinalFiles: routeDecision.expectedFinalFiles,
    routeContractHash: routeDecision.contractHash || plan.routeContract?.contractHash || null,
    routeContractGate,
  };
  plan.deliverableSpec ||= {};
  plan.deliverableSpec.liveRulesKnown = !!liveRules;
  plan.deliverableSpec.submitLimitRoute = routeDecision.route;
  plan.deliverableSpec.submitLimitReason = routeDecision.reason;
  if (liveRules?.maxFilesPerSubmit) plan.deliverableSpec.maxSubmitFiles = liveRules.maxFilesPerSubmit;
  if (liveRules?.maxFileSizeMb) plan.deliverableSpec.maxFileSizeMb = liveRules.maxFileSizeMb;
  if (liveRules?.allowedExtensions?.length) plan.deliverableSpec.allowedExtensions = liveRules.allowedExtensions;
  plan.artifactPolicy ||= {};
  if (liveRules?.maxFilesPerSubmit) plan.artifactPolicy.maxSubmitFiles = liveRules.maxFilesPerSubmit;
  if (liveRules?.maxFileSizeMb) plan.artifactPolicy.maxFileSizeMb = liveRules.maxFileSizeMb;
  plan.preGenerationBlockers = Array.isArray(plan.preGenerationBlockers) ? plan.preGenerationBlockers : [];
  plan.packageRules = Array.isArray(plan.packageRules) ? plan.packageRules : [];
  plan.qaContract ||= {};
  plan.qaContract.importBlockers = Array.isArray(plan.qaContract.importBlockers) ? plan.qaContract.importBlockers : [];
  if (liveRules) {
    plan.preGenerationBlockers = plan.preGenerationBlockers
      .filter((item) => item !== 'live_submit_rules_missing_before_generation');
    plan.qaContract.importBlockers = plan.qaContract.importBlockers
      .filter((item) => item !== 'live_submit_rules_required_before_generation');
    plan.packageRules = plan.packageRules
      .filter((item) => item !== 'Run pitch:dryrun first so case/live-submit-rules-latest.json exists before external generation.');
  }
  if (!routeContractGate.ok) {
    plan.preGenerationBlockers.push('route_contract_conflict');
    plan.qaContract.importBlockers.push('route_contract_conflict');
    plan.packageRules.unshift('RouteContract conflicts with live submit rules; stop and re-ask the model/agent instead of changing the route deterministically.');
  }

  if (!liveRules) {
    plan.preGenerationBlockers.push('live_submit_rules_missing_before_generation');
    plan.qaContract.importBlockers.push('live_submit_rules_required_before_generation');
    plan.packageRules.unshift('Run pitch:dryrun first so case/live-submit-rules-latest.json exists before external generation.');
  } else if (routeDecision.route === 'text_form') {
    plan.deliverableSpec.submitMode = 'text_form';
    plan.deliverableSpec.expectedFileCount = 0;
    plan.deliverableSpec.finalFormats = ['text-form'];
    plan.artifactPolicy.maxSubmitFiles = 0;
    plan.packageRules.unshift('Live modal is text form; do not run file/image package generation unless the live modal changes.');
  } else if (routeDecision.route === 'text_document_pdf') {
    plan.deliverableSpec.submitMode = 'pdf_only';
    plan.deliverableSpec.expectedFileCount = 1;
    plan.deliverableSpec.finalFormats = ['pdf'];
    plan.deliverableSpec.requiresTextDocumentPdf = true;
    plan.artifactPolicy.maxSubmitFiles = 1;
    plan.qaContract.expectedArtifactCount = Math.min(1, Number(plan.qaContract.expectedArtifactCount || 1));
    plan.packageRules.unshift('Live modal is file upload for a text/writing task; submit one model-generated PDF document, not a 10-file filler set.');
  } else if (routeDecision.route === 'pdf_booklet') {
    plan.deliverableSpec.submitMode = 'pdf_only';
    plan.deliverableSpec.expectedFileCount = 1;
    plan.deliverableSpec.finalFormats = ['pdf'];
    plan.deliverableSpec.requiresPdfBooklet = true;
    plan.qaContract.importBlockers.push('pdf_booklet_route_required');
    plan.packageRules.unshift('Live limit suggests PDF booklet route: generate booklet pages, merge to one final PDF, select only that PDF before live submit.');
    if (Array.isArray(plan.productionStages) && !plan.productionStages.includes('pdf_booklet_merge_and_preflight')) plan.productionStages.push('pdf_booklet_merge_and_preflight');
  } else if (routeDecision.route === 'expanded_file_set' && (plan.prompts || []).length < Number(routeDecision.expectedFinalFiles || 0)) {
    extendPromptsToLiveLimit(plan, Number(routeDecision.expectedFinalFiles || 0));
    if ((plan.prompts || []).length < Number(routeDecision.expectedFinalFiles || 0)) {
      plan.preGenerationBlockers.push('live_limit_exceeds_plan_prompt_count');
      plan.packageRules.unshift('Live limit exceeds current prompt count; extend/rebuild the plan before external generation.');
    }
  }

  plan.preGenerationBlockers = [...new Set(plan.preGenerationBlockers)];
  plan.packageRules = [...new Set(plan.packageRules)];
  plan.qaContract.importBlockers = [...new Set(plan.qaContract.importBlockers)];
  return plan;
}

export function liveSubmitRulesContractsSelftest() {
  const five = deriveLiveSubmitRules({ modalText: '知识产权声明 0/500 最多可上传5个稿件 10M以内，仅限jpg,png,pdf格式' });
  const ten = deriveLiveSubmitRules({ modalText: '一次交稿最多上传十个作品 5MB以内，仅限jpg,png,bmp,gif,zip,rar,pdf,ppt,pptx格式' });
  const naming = deriveLiveSubmitRules({ modalText: '名字 释义 添加方案（一次交稿最多添加5个方案）' });
  const pitch = deriveLiveSubmitRules({ pitchRule: { bidNum: 10, worksLimit: 5, worksFrom: 'jpg,png,pdf', id: 123, type: 1 } });
  const acceptedGap = packageCapacityGap(ten, { localAvailableCount: 5, selectedCount: 5, uploadedCount: 5 });
  const gap = packageCapacityGap(ten, { localAvailableCount: 4, selectedCount: 4, uploadedCount: 4 });
  const pdfGap = packageCapacityGap(ten, { localAvailableCount: 1, selectedCount: 1, pdfBookletSatisfied: true });
  const pdfRoute = recommendSubmitRoute({ workflowId: 'proposal_board', entry: { title: '展厅方案设计' }, rules: pitch });
  const routedPlan = applyLiveSubmitRulesToPlan({ workflowId: 'proposal_board', deliverableSpec: {}, artifactPolicy: {}, qaContract: { importBlockers: [] }, packageRules: [], prompts: [{ index: 1 }], productionStages: [] }, { rules: pitch, route: pdfRoute });
  const fiveOfTenRoute = recommendSubmitRoute({ workflowId: 'logo_brand', entry: { title: '企业LOGO设计' }, rules: pitch });
  const fiveOfTenPlan = applyLiveSubmitRulesToPlan({ workflowId: 'logo_brand', deliverableSpec: {}, artifactPolicy: {}, qaContract: { importBlockers: [] }, packageRules: [], prompts: [{ index: 1 }, { index: 2 }, { index: 3 }, { index: 4 }, { index: 5 }], productionStages: [] }, { rules: pitch, route: fiveOfTenRoute });
  const bookContractPlan = applyLiveSubmitRulesToPlan({
    workflowId: 'catalog_brochure',
    routeContract: {
      deliverableType: 'book_cover_jacket',
      finalArtifactShape: 'image_set',
      submitRoute: 'file_set',
      expectedFinalFiles: 5,
      finalFormats: ['jpg', 'png'],
      forbiddenRoutes: ['pdf_booklet'],
    },
    deliverableSpec: {},
    artifactPolicy: {},
    qaContract: { importBlockers: [] },
    packageRules: [],
    prompts: [{ index: 1 }, { index: 2 }, { index: 3 }, { index: 4 }, { index: 5 }],
    productionStages: [],
  }, { rules: pitch });
  const noPdf = deriveLiveSubmitRules({ modalText: '最多可上传5个稿件 10M以内，仅限jpg,png格式' });
  const conflictPlan = applyLiveSubmitRulesToPlan({
    workflowId: 'proposal_board',
    routeContract: {
      deliverableType: 'proposal_board',
      finalArtifactShape: 'single_pdf',
      submitRoute: 'pdf_booklet',
      expectedFinalFiles: 1,
      finalFormats: ['pdf'],
    },
    deliverableSpec: {},
    artifactPolicy: {},
    qaContract: { importBlockers: [] },
    packageRules: [],
    prompts: [{ index: 1 }],
    productionStages: [],
  }, { rules: noPdf });
  const bookCoverRoute = recommendSubmitRoute({
    workflowId: 'catalog_brochure',
    entry: { title: '《中国人迁徙美洲的图纹学研究》封面征集', category3Name: '书籍装帧设计' },
    requirementText: '图书封面、封四、书脊、前后勒口全封展开稿，作者王先胜，中国社会科学出版社，使用太阳门、玉雕双足、玉雕船。',
    rules: pitch,
  });
  const ok = five.maxFilesPerSubmit === 5
    && ten.maxFilesPerSubmit === 10
    && ten.maxFileSizeMb === 5
    && five.maxSubmissionNoteChars === 500
    && naming.isNamingBranch
    && naming.maxNamingItems === 5
    && pitch.maxFilesPerSubmit === 10
    && acceptedGap.underLimitAccepted
    && acceptedGap.minimumFilesForSubmit === 5
    && !acceptedGap.needsMoreLocalFiles
    && !acceptedGap.needsMoreSelectedFiles
    && !acceptedGap.uploadedUnderLiveLimit
    && gap.needsMoreLocalFiles
    && gap.needsMoreSelectedFiles
    && gap.uploadedUnderLiveLimit
    && pdfGap.pdfBookletSatisfied
    && !pdfGap.needsMoreLocalFiles
    && !pdfGap.needsMoreSelectedFiles
    && pdfRoute.route === 'pdf_booklet'
    && routedPlan.deliverableSpec.submitMode === 'pdf_only'
    && routedPlan.qaContract.importBlockers.includes('pdf_booklet_route_required')
    && fiveOfTenRoute.route === 'expanded_file_set'
    && fiveOfTenRoute.expectedFinalFiles === 5
    && fiveOfTenPlan.submitLimitSpec.expectedFinalFiles === 5
    && fiveOfTenPlan.deliverableSpec.expectedFileCount !== 10
    && fiveOfTenPlan.qaContract.expectedArtifactCount !== 10
    && bookContractPlan.submitLimitSpec.route === 'file_set'
    && bookContractPlan.submitLimitSpec.routeSource === 'route_contract'
    && bookContractPlan.deliverableSpec.expectedFileCount === 5
    && !bookContractPlan.qaContract.importBlockers.includes('route_contract_conflict')
    && conflictPlan.qaContract.importBlockers.includes('route_contract_conflict')
    && bookCoverRoute.route === 'expanded_file_set'
    && bookCoverRoute.expectedFinalFiles === 5;
  return {
    ok,
    safety: LIVE_SUBMIT_RULES_SAFETY,
    five,
    ten,
    naming,
    pitch,
    acceptedGap,
    gap,
    pdfGap,
    pdfRoute,
    routedPlan: routedPlan.submitLimitSpec,
    fiveOfTenRoute,
    fiveOfTenPlan: fiveOfTenPlan.submitLimitSpec,
    bookContractPlan: bookContractPlan.submitLimitSpec,
    conflictPlan: conflictPlan.submitLimitSpec,
    bookCoverRoute,
  };
}
