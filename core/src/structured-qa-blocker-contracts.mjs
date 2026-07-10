import { digest } from './hash-utils.mjs';

export const QA_BLOCKER_SCHEMA_VERSION = 1;

export const STRUCTURED_QA_BLOCKER_SAFETY = Object.freeze({
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

const CATEGORY_RULES = Object.freeze([
  {
    category: 'subject_consistency',
    severity: 'blocker',
    appliesTo: 'artifact',
    re: /主体|品牌|文字|wordmark|brand|subject|placeholder|占位|标题|更新升级|reference name|action word/i,
    hint: 'visible main subject, brand, or product text must match the semantic contract',
  },
  {
    category: 'professional_finish',
    severity: 'blocker',
    appliesTo: 'artifact',
    re: /完成度|professional|finish|low-end|低端|粗糙|hand-made|手搓|clipart|剪贴画|generic shield|leaf|drop|弱标志|rough mark/i,
    hint: 'artifact must read as finished client work rather than a rough/template mark',
  },
  {
    category: 'template_filler',
    severity: 'blocker',
    appliesTo: 'artifact',
    re: /模板|template|filler|placeholder|empty|空白|spec chip|stock|process|raw|brochure filler|fake spec/i,
    hint: 'template filler, fake specs, and empty placeholder panels cannot substitute for client-specific content',
  },
  {
    category: 'occluding_overlay',
    severity: 'blocker',
    appliesTo: 'artifact',
    re: /遮挡|overlay|title bar|顶部标题|navigation|chip|anti-copy|mask|summary header|覆盖|crowd/i,
    hint: 'OCR/anti-copy overlays that cover or crowd the logo/mockup are quality blockers',
  },
  {
    category: 'industry_fit',
    severity: 'high',
    appliesTo: 'package',
    re: /行业|industry|route|refpack|场景|application|proof|component|busbar|端子|铜排|连接器|medical|clinical|finance|insurance|家装|landscape/i,
    hint: 'visible proof must fit the selected industry/reference pack rather than a broad or wrong route',
  },
  {
    category: 'regulatory_claim',
    severity: 'blocker',
    appliesTo: 'artifact',
    re: /监管|regulatory|barcode|条码|二维码|QR|认证|certification|CE|FDA|NMPA|ISO|地址|电话|phone|license|许可证|claim/i,
    hint: 'block invented regulatory, barcode, contact, certification, or compliance content unless explicitly buyer-supplied',
  },
  {
    category: 'source_boundary',
    severity: 'blocker',
    appliesTo: 'package',
    re: /copy|copied|trademark|source|third-party|官方|品牌资产|抄|仿|侵权|old logo|attachment/i,
    hint: 'reference sources are grammar only; do not copy marks, screens, data, trade dress, or old attachment geometry',
  },
]);

function text(value) {
  return String(value || '').replace(/\r/g, '').replace(/[ \t\n]+/g, ' ').trim();
}

function list(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  const single = text(value);
  return single ? [single] : [];
}

function shortHash(value) {
  return digest(String(value || '')).replace(/^sha256:/, '').slice(0, 10);
}

function classifyQaBlocker(triggerText) {
  const normalized = text(triggerText);
  const rule = CATEGORY_RULES.find((item) => item.re.test(normalized)) || {
    category: 'quality_gate',
    severity: 'high',
    appliesTo: 'artifact',
    hint: 'treat this reference-pack QA blocker as a concrete visual quality gate',
  };
  return {
    category: rule.category,
    severity: rule.severity,
    appliesTo: rule.appliesTo,
    evidenceHint: rule.hint,
  };
}

export function normalizeStructuredQaBlocker(triggerText, {
  source = 'designReferenceSpec.qaBlockers',
  refpackId = null,
  workflowId = null,
  kind = 'qa_blocker',
  blocking = true,
  index = 0,
} = {}) {
  const normalized = text(triggerText);
  if (!normalized) return null;
  const classified = classifyQaBlocker(normalized);
  return {
    schemaVersion: QA_BLOCKER_SCHEMA_VERSION,
    id: `${kind}_${classified.category}_${shortHash([source, refpackId, workflowId, normalized, index].join('|'))}`,
    kind,
    category: classified.category,
    severity: classified.severity,
    blocking,
    appliesTo: classified.appliesTo,
    source,
    refpackId,
    workflowId,
    triggerText: normalized,
    evidenceHint: classified.evidenceHint,
    safety: STRUCTURED_QA_BLOCKER_SAFETY,
  };
}

export function buildStructuredQaBlockers({
  designReferenceSpec = {},
  designReferenceRetrieval = null,
  workflowId = null,
  includeNegativePatterns = true,
  limit = 32,
} = {}) {
  const refpackId = designReferenceSpec?.id || designReferenceRetrieval?.selectedRefpackId || null;
  const rows = [];
  let index = 0;
  for (const item of list(designReferenceSpec?.qaBlockers)) {
    rows.push(normalizeStructuredQaBlocker(item, {
      source: 'designReferenceSpec.qaBlockers',
      refpackId,
      workflowId,
      kind: 'qa_blocker',
      blocking: true,
      index: index += 1,
    }));
  }
  if (includeNegativePatterns) {
    for (const item of list(designReferenceSpec?.negativePatterns)) {
      rows.push(normalizeStructuredQaBlocker(item, {
        source: 'designReferenceSpec.negativePatterns',
        refpackId,
        workflowId,
        kind: 'negative_pattern',
        blocking: true,
        index: index += 1,
      }));
    }
  }
  for (const warning of designReferenceRetrieval?.warnings || []) {
    const code = typeof warning === 'string' ? warning : warning?.code;
    if (!code) continue;
    rows.push(normalizeStructuredQaBlocker(code, {
      source: 'designReferenceRetrieval.warnings',
      refpackId,
      workflowId,
      kind: 'retrieval_warning',
      blocking: false,
      index: index += 1,
    }));
  }
  const seen = new Set();
  return rows
    .filter(Boolean)
    .filter((item) => {
      const key = `${item.kind}|${item.triggerText}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Number(limit || 32));
}

export function summarizeStructuredQaBlockers(blockers = []) {
  const byCategory = {};
  const bySeverity = {};
  for (const item of blockers || []) {
    byCategory[item.category] = (byCategory[item.category] || 0) + 1;
    bySeverity[item.severity] = (bySeverity[item.severity] || 0) + 1;
  }
  return {
    schemaVersion: QA_BLOCKER_SCHEMA_VERSION,
    count: blockers.length,
    byCategory,
    bySeverity,
    blockingCount: blockers.filter((item) => item.blocking !== false).length,
    safety: STRUCTURED_QA_BLOCKER_SAFETY,
  };
}

export function structuredQaBlockerContractsSelftest() {
  const blockers = buildStructuredQaBlockers({
    workflowId: 'logo_brand',
    designReferenceSpec: {
      id: 'refpack_test',
      qaBlockers: [
        'artificial top title bars or anti-copy overlays that cover the logo',
        'generic shield/leaf/drop clipart with weak professional finish',
        'fake CE/FDA/NMPA certification claims',
      ],
      negativePatterns: ['busbar component maker routed into generic EV charging station visual language'],
    },
    designReferenceRetrieval: {
      selectedRefpackId: 'refpack_test',
      warnings: [{ code: 'refpack_index_overrode_static_industry' }],
    },
  });
  const categories = new Set(blockers.map((item) => item.category));
  return {
    ok: blockers.length >= 5
      && categories.has('occluding_overlay')
      && categories.has('professional_finish')
      && categories.has('regulatory_claim')
      && categories.has('industry_fit')
      && blockers.every((item) => item.schemaVersion === QA_BLOCKER_SCHEMA_VERSION && item.id),
    safety: STRUCTURED_QA_BLOCKER_SAFETY,
    blockers,
    summary: summarizeStructuredQaBlockers(blockers),
  };
}

export const qaBlockerSchemaSelftest = structuredQaBlockerContractsSelftest;
