import { digest } from './hash-utils.mjs';

export const REFPACK_SELECTION_CONTRACT_VERSION = 1;

export const REFPACK_SELECTION_SAFETY = Object.freeze({
  localContractOnly: true,
  readsFiles: false,
  writesFiles: false,
  usesDatabase: false,
  callsProviderOrModel: false,
  fetchesChannelState: false,
  mutatesChannelState: false,
  uploads: false,
  submits: false,
  sendsMessages: false,
  acceptsDelivery: false,
  pays: false,
  grantsExecutionPermission: false,
  refpackIndexMayOverride: true,
});

export const BASE_CJK_REFPACK_QUERY_KEYWORDS = Object.freeze([
  '大端子',
  '端子',
  '铜排',
  '连接器',
  '电连接',
  '线束',
  '新能源汽车',
  '医疗器械',
  '医疗设备',
  '临床',
  '诊断',
  '金融',
  '保险',
  '理赔',
  '支付',
  '家装',
  '装修',
  '室内装修',
  '全屋定制',
  '包装',
  '标签',
  '瓶贴',
  '画册',
  '宣传册',
  '折页',
  '农业',
  '肥料',
  '粮油',
  '半导体',
  '电子',
  '人工智能',
  '软件',
  '科技企业',
  '软件平台',
  '企业软件',
  '智能硬件',
  '数字化',
  '餐饮',
  '食品',
  '酒店',
  '旅游',
  '航空',
  '交通',
  '服装',
  '家居',
  '家具',
  '床垫',
  '陶瓷',
  '陶瓷贴花',
  '卡通形象',
  '平面卡通',
  '英文名',
  '能源',
  '充电',
  '景观',
  '公共艺术',
  '教育',
  '地产',
  '物业',
  '安全培训',
]);

export const REFPACK_QUERY_NEGATION_PREFIX_TOKENS = Object.freeze([
  '不要使用',
  '不要出现',
  '不应出现',
  '不准出现',
  '不能出现',
  '禁止使用',
  '禁止出现',
  '不要',
  '不得',
  '禁止',
  '禁用',
  '拒绝',
  '避免',
  '不使用',
  '不用',
  '不能',
  '不准',
  '无',
  '去掉',
  '去除',
]);

const QUERY_NEGATION_PREFIX_RE = /(不要使用|不要出现|不应出现|不准出现|不能出现|禁止使用|禁止出现|不要|不得|禁止|禁用|拒绝|避免|不使用|不用|不能|不准|无|去掉|去除)([^，。；;、\n\r|]{0,36})/giu;

function text(value) {
  const normalized = String(value ?? '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
  return normalized || null;
}

function list(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  const single = text(value);
  return single ? [single] : [];
}

function synonymsForIndustry(synonymConfig = {}, industryId = null) {
  return synonymConfig?.industries?.[industryId] || {};
}

export function refpackKeywordList({ synonymConfig = {} } = {}) {
  const keywords = [...BASE_CJK_REFPACK_QUERY_KEYWORDS];
  for (const item of Object.values(synonymConfig.industries || {})) {
    for (const key of ['aliases', 'strongTriggers', 'negativeRouteTriggers', 'demoteWhenQueryContains', 'workflowHints']) {
      keywords.push(...list(item[key]));
    }
  }
  return [...new Set(keywords)].filter((item) => item.length >= 2);
}

export function tokenMatchesRefpackPattern(token, pattern) {
  const left = String(token || '').toLowerCase();
  const right = String(pattern || '').toLowerCase();
  return !!left && !!right && (left === right || left.includes(right) || right.includes(left));
}

export function tokenMatchesAnyRefpackPattern(token, patterns = []) {
  return patterns.some((pattern) => tokenMatchesRefpackPattern(token, pattern));
}

export function normalizeRefpackQuery(value) {
  return String(value || '').replace(/\r/g, ' ').replace(/[ \t\n]+/g, ' ').trim();
}

function rawTokenMatches(value) {
  return String(value || '').match(/[\p{Script=Han}]{2,}|[a-z0-9][a-z0-9_.:/+-]*/giu) || [];
}

function addExpandedToken(out, seen, item) {
  const token = String(item || '').toLowerCase();
  if (token.length < 2 || seen.has(token)) return;
  seen.add(token);
  out.push(token);
}

function addHanKeywordTokens(out, seen, item, { synonymConfig = {} } = {}) {
  if (!/[\p{Script=Han}]/u.test(item)) return;
  for (const keyword of refpackKeywordList({ synonymConfig })) {
    if (item.includes(keyword)) addExpandedToken(out, seen, keyword);
  }
}

export function extractSuppressedRefpackQueryTokens(query, { synonymConfig = {} } = {}) {
  const normalized = normalizeRefpackQuery(query).toLowerCase();
  const suppressed = [];
  const seen = new Set();
  for (const match of normalized.matchAll(QUERY_NEGATION_PREFIX_RE)) {
    const phrase = normalizeRefpackQuery(`${match[1] || ''}${match[2] || ''}`);
    if (!phrase) continue;
    for (const item of rawTokenMatches(phrase)) {
      const token = item.toLowerCase();
      if (REFPACK_QUERY_NEGATION_PREFIX_TOKENS.includes(token)) continue;
      addExpandedToken(suppressed, seen, token);
      addHanKeywordTokens(suppressed, seen, item, { synonymConfig });
    }
  }
  return suppressed;
}

export function refpackQueryTokenInfo(query, { synonymConfig = {} } = {}) {
  const normalized = normalizeRefpackQuery(query).toLowerCase();
  if (!normalized) return { tokens: [], suppressedTokens: [] };
  const suppressedTokens = extractSuppressedRefpackQueryTokens(normalized, { synonymConfig });
  const suppressedSet = new Set(suppressedTokens);
  const matches = rawTokenMatches(normalized);
  const seen = new Set();
  const out = [];
  const add = (item) => {
    const token = item.toLowerCase();
    if (REFPACK_QUERY_NEGATION_PREFIX_TOKENS.includes(token)) return;
    if (suppressedSet.has(token)) return;
    addExpandedToken(out, seen, token);
  };
  for (const item of matches) {
    add(item);
    addHanKeywordTokens(out, seen, item, { synonymConfig });
  }
  return {
    tokens: out.slice(0, 16),
    suppressedTokens,
  };
}

export function refpackQueryTokens(query, options = {}) {
  return refpackQueryTokenInfo(query, options).tokens;
}

export function scoreRefpackCandidate(candidate = {}, { tokens = [], industryId = null, workflowId = null, synonymConfig = {} } = {}) {
  let score = 40;
  const reasons = [];
  if (industryId && candidate.industryId === industryId) {
    score += 35;
    reasons.push('industry_exact_match');
  }
  if (workflowId && candidate.workflowId === workflowId) {
    score += 22;
    reasons.push('workflow_exact_match');
  }
  if (!candidate.missingSourceCount) {
    score += 10;
    reasons.push('sources_resolved');
  }
  score += Math.min(12, Number(candidate.activeSourceCount || 0) * 0.25);
  score += Math.min(12, Number(candidate.caseFeedback?.successCount || 0) * 3);
  score -= Math.min(24, Number(candidate.caseFeedback?.rejectedCount || 0) * 6);
  score -= Math.min(10, Number(candidate.caseFeedback?.correctionCount || 0) * 2);
  const outcomeScore = Number(candidate.outcomeScore?.score);
  if (Number.isFinite(outcomeScore)) {
    const outcomeDelta = Math.max(-10, Math.min(10, Number(((outcomeScore - 50) * 0.2).toFixed(2))));
    score += outcomeDelta;
    reasons.push(`outcome_score:${outcomeScore}`);
    if (candidate.outcomeScore?.status) reasons.push(`outcome_status:${candidate.outcomeScore.status}`);
  }
  if ((candidate.outcomeScore?.blockers || []).length) {
    score -= 18;
    reasons.push('outcome_blocker');
  }
  if (candidate.outcomeScore?.status === 'outcome_learning_strong') {
    score += 4;
    reasons.push('outcome_learning_strong');
  }

  const lower = {
    label: String(candidate.label || '').toLowerCase(),
    industry: String(candidate.industryId || '').toLowerCase(),
    search: String(candidate.text?.search || '').toLowerCase(),
    positive: String(candidate.text?.positive || '').toLowerCase(),
    negative: String(candidate.text?.negative || '').toLowerCase(),
    proof: String(candidate.text?.proof || '').toLowerCase(),
    qa: String(candidate.text?.qa || '').toLowerCase(),
  };
  const industrySynonyms = synonymsForIndustry(synonymConfig, candidate.industryId);
  const strongTriggers = list(industrySynonyms.strongTriggers);
  const demoteTriggers = list(industrySynonyms.demoteWhenQueryContains);
  let tokenHits = 0;
  for (const token of tokens || []) {
    let tokenScore = 0;
    if (lower.industry.includes(token)) tokenScore += 16;
    if (lower.label.includes(token)) tokenScore += 14;
    if (lower.positive.includes(token)) tokenScore += 12;
    if (lower.proof.includes(token)) tokenScore += 12;
    if (lower.qa.includes(token)) tokenScore += 7;
    if (lower.search.includes(token)) tokenScore += 5;
    if (tokenMatchesAnyRefpackPattern(token, strongTriggers)) tokenScore += 18;
    if (tokenScore > 0) {
      tokenHits += 1;
      score += tokenScore;
      reasons.push(`token:${token}`);
      if (tokenMatchesAnyRefpackPattern(token, strongTriggers)) reasons.push(`strong_trigger:${token}`);
    }
    if (lower.negative.includes(token)) {
      score -= 6;
      reasons.push(`candidate_negative_pattern:${token}`);
    }
    if (tokenMatchesAnyRefpackPattern(token, demoteTriggers)) {
      score -= 18;
      reasons.push(`demote_trigger:${token}`);
    }
  }
  if (tokens.length && tokenHits === 0) score -= 40;
  if (tokens.length && tokenHits === tokens.length) {
    score += 14;
    reasons.push('all_query_tokens_matched');
  }
  return {
    score: Number(score.toFixed(2)),
    reasons: [...new Set(reasons)].slice(0, 16),
    tokenHits,
  };
}

export function rankRefpackCandidates(candidates = [], { tokens = [], industryId = null, workflowId = null, limit = 8, synonymConfig = {} } = {}) {
  return (candidates || [])
    .map((candidate) => {
      const scoring = scoreRefpackCandidate(candidate, { tokens, industryId, workflowId, synonymConfig });
      return {
        ...candidate,
        score: scoring.score,
        matchReasons: scoring.reasons,
        tokenHits: scoring.tokenHits,
      };
    })
    .filter((candidate) => !tokens.length || candidate.tokenHits > 0)
    .sort((left, right) => right.score - left.score || String(left.refpackKey || '').localeCompare(String(right.refpackKey || '')))
    .slice(0, Number(limit || 8));
}

export function summarizeRefpackRetrievalResult(result = {}) {
  return {
    count: Number(result?.count || 0),
    topCandidates: (result?.results || []).slice(0, 5).map((item) => ({
      refpackId: item.refpackId,
      industryId: item.industryId,
      workflowId: item.workflowId,
      score: item.score,
      tokenHits: item.tokenHits,
      matchReasons: item.matchReasons,
      missingSourceCount: item.missingSourceCount,
      caseFeedback: item.caseFeedback,
      outcomeScore: item.outcomeScore ? {
        status: item.outcomeScore.status,
        score: item.outcomeScore.score,
        counts: item.outcomeScore.counts,
        blockers: item.outcomeScore.blockers || [],
      } : null,
      refpackHash: item.refpackHash,
    })),
  };
}

export function decideRefpackStaticSelection({
  staticSpec = {},
  broadResult = {},
  strictResult = null,
  overrideScoreDelta = 24,
  overrideMinimumScore = 90,
  overrideMinimumTokenHits = 2,
} = {}) {
  const broadCandidates = broadResult.results || [];
  const strictCandidates = strictResult?.results || [];
  const top = broadCandidates[0] || null;
  const staticCandidates = [
    broadCandidates.find((item) => item.refpackId === staticSpec.id),
    strictCandidates.find((item) => item.refpackId === staticSpec.id),
  ].filter(Boolean);
  const staticCandidate = staticCandidates
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))[0]
    || null;
  const strictTop = strictCandidates[0] || null;
  const canOverride = !!(top
    && top.refpackId !== staticSpec.id
    && Number(top.tokenHits || 0) >= overrideMinimumTokenHits
    && Number(top.score || 0) >= overrideMinimumScore
    && (!staticCandidate || Number(top.score || 0) >= Number(staticCandidate.score || 0) + overrideScoreDelta));
  const selectedCandidate = canOverride
    ? top
    : (staticCandidate || strictTop || top || null);
  const selectedRefpackId = canOverride && selectedCandidate
    ? selectedCandidate.refpackId
    : (selectedCandidate?.refpackId || staticSpec.id || null);
  const selectedIndustryId = canOverride && selectedCandidate
    ? selectedCandidate.industryId
    : (selectedCandidate?.industryId || staticSpec.industryId || null);
  const selectionReason = selectedCandidate?.refpackId === staticSpec.id
    ? 'index_confirmed_static_reference_pack'
    : (canOverride && selectedCandidate
      ? 'index_override_stronger_query_match'
      : (!selectedCandidate ? 'static_reference_pack_no_index_match' : 'static_reference_pack'));
  const selectionAuthority = canOverride
    ? 'refpack_index_override'
    : (selectedCandidate?.refpackId === staticSpec.id
      ? 'semantic_static_confirmed_by_index'
      : (selectedCandidate
        ? 'semantic_static_retained_index_insufficient'
        : 'semantic_static_no_index_match'));
  const warnings = canOverride ? [{
    code: 'refpack_index_overrode_static_industry',
    staticIndustryId: staticSpec.industryId || null,
    selectedIndustryId,
    score: selectedCandidate?.score ?? null,
  }] : [];
  const decision = {
    version: REFPACK_SELECTION_CONTRACT_VERSION,
    kind: 'RefpackSelectionDecision',
    ok: true,
    status: canOverride ? 'refpack_index_override_selected' : 'refpack_index_static_selected',
    canOverride,
    selectedRefpackId,
    selectedIndustryId,
    selectedCandidate,
    staticCandidate,
    strictTop,
    top,
    selectionReason,
    selectionAuthority,
    overridePolicy: { overrideScoreDelta, overrideMinimumScore, overrideMinimumTokenHits },
    warnings,
    blockers: [],
    safety: REFPACK_SELECTION_SAFETY,
  };
  return { ...decision, decisionHash: digest(decision) };
}

export function buildRefpackRetrievalContract({
  dbPath = null,
  query = '',
  workflowId = null,
  staticSpec = {},
  selectedSpec = {},
  broadResult = {},
  strictResult = null,
  selectionDecision = null,
  built = false,
  warnings = [],
  blockers = [],
} = {}) {
  const decision = selectionDecision || decideRefpackStaticSelection({ staticSpec, broadResult, strictResult });
  const retrieval = {
    ok: blockers.length === 0,
    version: REFPACK_SELECTION_CONTRACT_VERSION,
    kind: 'DesignReferenceRetrieval',
    status: decision.status,
    routingMode: 'index_routing',
    selectionAuthority: decision.selectionAuthority,
    indexRoutingActive: true,
    indexOverrideAllowed: true,
    dbPath,
    query: normalizeRefpackQuery(query),
    tokens: broadResult.tokens || [],
    suppressedTokens: broadResult.suppressedTokens || [],
    workflowId: workflowId || null,
    staticRefpackId: staticSpec.id || null,
    staticIndustryId: staticSpec.industryId || null,
    selectedRefpackId: selectedSpec.id || decision.selectedRefpackId || null,
    selectedIndustryId: selectedSpec.industryId || decision.selectedIndustryId || null,
    topRefpackId: decision.top?.refpackId || null,
    topIndustryId: decision.top?.industryId || null,
    selectedCandidate: decision.selectedCandidate ? {
      refpackId: decision.selectedCandidate.refpackId,
      industryId: decision.selectedCandidate.industryId,
      score: decision.selectedCandidate.score,
      tokenHits: decision.selectedCandidate.tokenHits,
      matchReasons: decision.selectedCandidate.matchReasons,
      caseFeedback: decision.selectedCandidate.caseFeedback,
      outcomeScore: decision.selectedCandidate.outcomeScore ? {
        status: decision.selectedCandidate.outcomeScore.status,
        score: decision.selectedCandidate.outcomeScore.score,
        successRate: decision.selectedCandidate.outcomeScore.successRate ?? null,
        counts: decision.selectedCandidate.outcomeScore.counts,
        patterns: decision.selectedCandidate.outcomeScore.patterns || {},
        blockers: decision.selectedCandidate.outcomeScore.blockers || [],
        recommendations: decision.selectedCandidate.outcomeScore.recommendations || [],
      } : null,
      refpackHash: decision.selectedCandidate.refpackHash,
    } : null,
    broad: summarizeRefpackRetrievalResult(broadResult),
    strict: strictResult ? summarizeRefpackRetrievalResult(strictResult) : null,
    selectionReason: decision.selectionReason,
    overridePolicy: decision.overridePolicy,
    built: Boolean(built),
    warnings: [...(warnings || []), ...(decision.warnings || [])],
    blockers,
    selectionDecisionHash: decision.decisionHash || null,
    safety: REFPACK_SELECTION_SAFETY,
  };
  return { ...retrieval, retrievalHash: digest(retrieval) };
}

export function refpackSelectionContractsSelftest() {
  const synonymConfig = {
    industries: {
      ev_electrical_components_b2b: {
        strongTriggers: ['busbar', '大端子', '铜排', '连接器'],
      },
      energy_ev_infrastructure: {
        strongTriggers: ['充电站'],
        demoteWhenQueryContains: ['busbar', '大端子', '铜排', '连接器'],
      },
    },
  };
  const tokenInfo = refpackQueryTokenInfo('Longlit busbar 大端子 铜排 连接器，不要AI渐变', { synonymConfig });
  const suppressed = refpackQueryTokenInfo('文具LOGO 不要AI 不要渐变', { synonymConfig });
  const evCandidate = {
    refpackKey: 'refpack_ev_electrical_components_b2b_v1::logo_brand',
    refpackId: 'refpack_ev_electrical_components_b2b_v1',
    industryId: 'ev_electrical_components_b2b',
    workflowId: 'logo_brand',
    label: 'EV electrical components',
    activeSourceCount: 4,
    missingSourceCount: 0,
    caseFeedback: { successCount: 2, rejectedCount: 0, correctionCount: 0 },
    outcomeScore: { score: 72, status: 'outcome_learning_strong', blockers: [] },
    text: {
      search: 'busbar 大端子 铜排 连接器 电连接件',
      positive: 'B2B电气部件 产品目录 工厂制造',
      negative: '',
      proof: '规格书 展会物料',
      qa: '工程可信',
    },
  };
  const infraCandidate = {
    ...evCandidate,
    refpackKey: 'refpack_energy_ev_infrastructure_v1::logo_brand',
    refpackId: 'refpack_energy_ev_infrastructure_v1',
    industryId: 'energy_ev_infrastructure',
    label: 'EV infrastructure',
    caseFeedback: { successCount: 0, rejectedCount: 0, correctionCount: 0 },
    outcomeScore: { score: 50, status: 'learning_cold_start', blockers: [] },
    text: { search: '充电站 能源运营', positive: '充电站 光储充', negative: '铜排 连接器', proof: '', qa: '' },
  };
  const ranked = rankRefpackCandidates([infraCandidate, evCandidate], {
    tokens: tokenInfo.tokens,
    workflowId: 'logo_brand',
    synonymConfig,
  });
  const staticSpec = { id: 'refpack_energy_ev_infrastructure_v1', industryId: 'energy_ev_infrastructure' };
  const decision = decideRefpackStaticSelection({
    staticSpec,
    broadResult: { results: ranked, tokens: tokenInfo.tokens, suppressedTokens: tokenInfo.suppressedTokens },
    strictResult: { results: [infraCandidate] },
    overrideMinimumScore: 80,
    overrideMinimumTokenHits: 2,
  });
  const retrieval = buildRefpackRetrievalContract({
    dbPath: ':memory:',
    query: 'Longlit busbar 大端子 铜排 连接器',
    workflowId: 'logo_brand',
    staticSpec,
    selectedSpec: { id: decision.selectedRefpackId, industryId: decision.selectedIndustryId },
    broadResult: { results: ranked, tokens: tokenInfo.tokens, suppressedTokens: tokenInfo.suppressedTokens },
    strictResult: { results: [infraCandidate] },
    selectionDecision: decision,
  });
  return {
    ok: tokenInfo.tokens.includes('busbar')
      && tokenInfo.tokens.includes('大端子')
      && !suppressed.tokens.includes('ai')
      && suppressed.suppressedTokens.includes('ai')
      && ranked[0]?.refpackId === 'refpack_ev_electrical_components_b2b_v1'
      && decision.canOverride === true
      && decision.selectionReason === 'index_override_stronger_query_match'
      && retrieval.retrievalHash?.startsWith('sha256:')
      && retrieval.safety.callsProviderOrModel === false
      && retrieval.safety.grantsExecutionPermission === false,
    tokenInfo,
    suppressed,
    ranked,
    decision,
    retrieval,
    safety: REFPACK_SELECTION_SAFETY,
  };
}
