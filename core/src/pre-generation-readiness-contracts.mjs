export const PRE_GENERATION_READINESS_VERSION = 1;

export const PRE_GENERATION_BLOCKERS = Object.freeze({
  GENERIC_BRIEF_REQUIRES_DOMAIN_EVIDENCE: 'generic_brief_requires_detail_or_semantic_industry_cue',
});

export const PRE_GENERATION_READINESS_SAFETY = Object.freeze({
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

const GENERIC_DOMAIN_WORKFLOWS = new Set(['logo_brand', 'packaging_design', 'naming_text']);

const GENERIC_INDUSTRY_CUE_RE = /^(?:LOGO设计|Logo设计|logo设计|标志设计|商标设计|VI设计|字体设计|全新LOGO设计|全新Logo设计|企业LOGO设计|品牌\/产品LOGO\+字体设计|包装设计|其他包装设计|包装盒设计|礼盒包装盒设计|天地盖礼盒包装盒设计|其他写作服务|其他写作服务需求|写作服务|命名|命名服务|取名|起名|品牌命名|公司命名|店铺取名|文案写作)$/i;
const REAL_DOMAIN_SIGNAL_RE = /(?:科技|生物|农业|食品|餐饮|茶|酒|医|健康|营养|游戏|短视频|印刷|纸|烟|电烟|叉车|汽车|宠物|玩具|物业|地产|工业|安全|培训|新能源|半导体|芯片|AI|人工智能|文玩|珠宝|服装|服饰|衣服|帽子|家具|家装|酒店|旅游|旅.?业|航空|物流|教育|文化|传媒|零售|超市|生鲜|优鲜|商贸|贸易|制造|设备|机械|包装盒|水果|柑橘|巧克力|茶油)/i;

function normalizeText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function unique(values, limit = 24) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function meaningfulDomainCue(value) {
  const text = normalizeText(value)
    .replace(/^[的地得\s]+/, '')
    .replace(/[，。；;\n].*$/g, '')
    .trim();
  if (!text || text.length < 2) return null;
  if (GENERIC_INDUSTRY_CUE_RE.test(text)) return null;
  if (/^(?:全新|现有|我需要|其他|普通|企业|公司|品牌|产品|项目|需求|设计|图案|字体|纯中文|英文|中文)$/i.test(text)) return null;
  if (text.length <= 4 && !REAL_DOMAIN_SIGNAL_RE.test(text)) return null;
  return text;
}

function semanticIndustryCue({ subject = {}, semanticIntake = {} } = {}) {
  const directCue = meaningfulDomainCue(
    subject.semanticIndustryCue
    || semanticIntake.subject?.industryCue
    || semanticIntake.taskUnderstanding?.industryCue
    || subject.industryText
    || null,
  );
  if (directCue) return directCue;
  const buyerConstraintCue = [
    ...(subject.mustUseText || []),
    ...(semanticIntake.subject?.mustUseText || []),
  ].map(meaningfulDomainCue).find(Boolean);
  return buyerConstraintCue || null;
}

function meaningfulProductOrProject({ workflowId, subject = {} } = {}) {
  const candidates = workflowId === 'packaging_design'
    ? [subject.productText, subject.projectText]
    : workflowId === 'naming_text'
      ? [subject.productText, subject.projectText]
      : [];
  return candidates.map(meaningfulDomainCue).find(Boolean) || null;
}

function hasAttachmentEvidence(attachmentSpec = {}) {
  return Boolean(
    Number(attachmentSpec.downloadedCount || 0) > 0
    && (
      attachmentSpec.required
      || Number(attachmentSpec.referenceCount || 0) > 0
      || Number(attachmentSpec.semanticReferenceCount || 0) > 0
      || (attachmentSpec.referenceFiles || []).length > 0
      || (attachmentSpec.semanticReferenceFiles || []).length > 0
      || (attachmentSpec.documentTextSnippets || []).length > 0
    ),
  );
}

function titleLooksGeneric({ title, workflowId } = {}) {
  const text = normalizeText(title);
  if (!text) return true;
  if (workflowId === 'logo_brand') {
    return /(?:我需要\s*)?(?:全新)?(?:企业|品牌|产品|公司)?(?:英文|中文|纯中文)?\s*(?:LOGO|logo|标志|商标)(?:图案|\+字体|字体)?设计/.test(text)
      || /设计一个企业英文LOGO/.test(text)
      || /全新个人纯中文字体LOGO设计/.test(text);
  }
  if (workflowId === 'packaging_design') {
    return /(?:我需要)?(?:其他)?包装设计|包装盒设计|礼盒包装盒设计|天地盖礼盒包装盒设计/.test(text);
  }
  if (workflowId === 'naming_text') {
    return /其他写作服务需求|写作服务需求|命名|取名|起名/.test(text);
  }
  return false;
}

function hasSpecificIndustrySelection(industrySpec = {}) {
  return Boolean(
    industrySpec?.id
    && industrySpec.id !== 'general_business_service'
    && Number(industrySpec.confidence || 0) >= 0.55,
  );
}

export function createPreGenerationReadiness({
  entry = {},
  workflowId = null,
  subject = {},
  industrySpec = {},
  semanticIntake = {},
  attachmentSpec = {},
} = {}) {
  const title = entry.title || '';
  const cues = {
    semanticIndustryCue: semanticIndustryCue({ subject, semanticIntake }),
    productOrProjectDomain: meaningfulProductOrProject({ workflowId, subject }),
    attachmentEvidence: hasAttachmentEvidence(attachmentSpec),
    specificIndustrySelection: hasSpecificIndustrySelection(industrySpec),
  };
  const genericDomainWorkflow = GENERIC_DOMAIN_WORKFLOWS.has(String(workflowId || ''));
  const genericTitleOnlyRisk = genericDomainWorkflow
    && titleLooksGeneric({ title, workflowId })
    && !cues.semanticIndustryCue
    && !cues.productOrProjectDomain
    && !cues.attachmentEvidence
    && !cues.specificIndustrySelection;
  const blockers = genericTitleOnlyRisk ? [PRE_GENERATION_BLOCKERS.GENERIC_BRIEF_REQUIRES_DOMAIN_EVIDENCE] : [];
  return {
    version: PRE_GENERATION_READINESS_VERSION,
    ok: blockers.length === 0,
    blockers,
    checks: [
      {
        id: 'generic_brief_domain_evidence',
        status: genericTitleOnlyRisk ? 'fail' : 'pass',
        blocking: true,
        notes: genericTitleOnlyRisk
          ? 'generic title-only logo/packaging/naming brief lacks real buyer-domain evidence before provider generation'
          : 'provider generation has enough domain/detail evidence or this workflow is not a generic title-only risk',
      },
    ],
    evidence: {
      workflowId: workflowId || null,
      title,
      industryId: industrySpec?.id || null,
      industryConfidence: industrySpec?.confidence ?? null,
      semanticIndustryCue: cues.semanticIndustryCue,
      productOrProjectDomain: cues.productOrProjectDomain,
      attachmentEvidence: cues.attachmentEvidence,
      specificIndustrySelection: cues.specificIndustrySelection,
    },
    safety: PRE_GENERATION_READINESS_SAFETY,
    next: blockers.length
      ? 'fetch seller details/attachments or run semantic intake that returns a real buyer industryCue before provider spend'
      : null,
  };
}

export function applyPreGenerationReadiness(plan = {}, readiness = null) {
  const gate = readiness || createPreGenerationReadiness({
    entry: plan.entry || plan,
    workflowId: plan.workflowId,
    subject: plan.subject || {},
    industrySpec: plan.industrySpec || {},
    semanticIntake: plan.semanticIntake || {},
    attachmentSpec: plan.attachmentSpec || {},
  });
  plan.preGenerationReadiness = gate;
  plan.preGenerationBlockers = unique([
    ...(plan.preGenerationBlockers || []),
    ...(gate.blockers || []),
  ], 32);
  plan.qaContract ||= {};
  plan.qaContract.importBlockers = unique([
    ...(plan.qaContract.importBlockers || []),
    ...((gate.blockers || []).length ? ['pre_generation_readiness_pass_required'] : []),
  ], 32);
  return plan;
}

export function preGenerationReadinessContractsSelftest() {
  const blocked = createPreGenerationReadiness({
    entry: { title: '我需要 LOGO设计' },
    workflowId: 'logo_brand',
    subject: { projectText: '待确认中英文品牌名', brandText: '待确认中英文品牌名', industryText: 'LOGO设计' },
    industrySpec: { id: 'general_business_service', confidence: 0.36 },
    semanticIntake: { subject: { industryCue: 'LOGO设计' } },
    attachmentSpec: { required: false },
  });
  const semanticCuePass = createPreGenerationReadiness({
    entry: { title: '全新企业LOGO图案+字体设计' },
    workflowId: 'logo_brand',
    subject: { projectText: '彩冠科技', brandText: '彩冠科技', industryText: '彩色印刷，纸质成品' },
    industrySpec: { id: 'general_business_service', confidence: 0.36 },
    semanticIntake: { subject: { industryCue: '彩色印刷，纸质成品' } },
    attachmentSpec: { required: false },
  });
  const packagingAttachmentPass = createPreGenerationReadiness({
    entry: { title: '我需要其他包装设计' },
    workflowId: 'packaging_design',
    subject: { projectText: '云润祥', productText: '柑橘类', industryText: '其他包装设计' },
    industrySpec: { id: 'general_business_service', confidence: 0.36 },
    semanticIntake: { subject: { industryCue: null } },
    attachmentSpec: { required: true, downloadedCount: 2, referenceCount: 2 },
  });
  const packagingDocumentPass = createPreGenerationReadiness({
    entry: { title: '我需要其他包装设计' },
    workflowId: 'packaging_design',
    subject: { projectText: 'Uvore', productText: '美妆个护保养品包装盒与瓶器', industryText: '其他包装设计' },
    industrySpec: { id: 'general_business_service', confidence: 0.36 },
    semanticIntake: { subject: { industryCue: null } },
    attachmentSpec: { required: false, downloadedCount: 1, semanticReferenceCount: 1, documentTextSnippets: [{ filename: 'brief.docx', text: '瓶子底色都是黑色哑光，外包装颜色是黑色' }] },
  });
  const namingPass = createPreGenerationReadiness({
    entry: { title: '其他写作服务需求' },
    workflowId: 'naming_text',
    subject: { projectText: '3分钟左右游戏类搞笑短视频脚本', productText: '3分钟左右游戏类搞笑短视频脚本', industryText: '游戏类搞笑短视频' },
    industrySpec: { id: 'general_business_service', confidence: 0.36 },
    semanticIntake: { subject: { industryCue: '游戏类搞笑短视频' } },
    attachmentSpec: { required: false },
  });
  const logoApplicationSurfacePass = createPreGenerationReadiness({
    entry: { title: '途动客全新英文+图案品牌LOGO设计' },
    workflowId: 'logo_brand',
    subject: { projectText: '途动客', brandText: '途动客', industryText: null },
    industrySpec: { id: 'general_business_service', confidence: 0.35 },
    semanticIntake: { subject: { industryCue: null, mustUseText: ['设计出能印在帽子或衣服上的品牌LOGO'] } },
    attachmentSpec: { required: false },
  });
  return {
    ok: !blocked.ok
      && semanticCuePass.ok
      && packagingAttachmentPass.ok
      && packagingDocumentPass.ok
      && packagingDocumentPass.evidence.attachmentEvidence
      && namingPass.ok
      && logoApplicationSurfacePass.ok,
    safety: PRE_GENERATION_READINESS_SAFETY,
    blocked,
    semanticCuePass,
    packagingAttachmentPass,
    packagingDocumentPass,
    namingPass,
    logoApplicationSurfacePass,
  };
}

export const preGenerationReadinessSelftest = preGenerationReadinessContractsSelftest;
