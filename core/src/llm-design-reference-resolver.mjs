import { canonicalProductLineId, normalizeText, uniqueStrings } from './contracts.mjs';
import { digest } from './hash-utils.mjs';
import { buildDesignReferenceSpec } from './design-reference-contracts.mjs';
import { convertLegacyDesignReferenceSpecToCore } from './design-reference-adapter.mjs';

export const LLM_DESIGN_REFERENCE_RESOLVER_VERSION = 2;

export const MODEL_INDUSTRY_CONFIDENCE_POLICY = Object.freeze({
  blockBelow: 0.55,
  reviewBelow: 0.75,
  conflictBlockBelow: 0.62,
});

export const CORE_MODEL_INDUSTRIES = Object.freeze([
  { id: 'agriculture_fertilizer', label: '农业 / 粮油 / 农资', domain: 'agriculture' },
  { id: 'semiconductor_electronics', label: '半导体 / 芯片 / 电子科技', domain: 'advanced_technology' },
  { id: 'ev_electrical_components_b2b', label: '新能源电连接件 / Busbar / 连接器 B2B', domain: 'ev_electrical_components_b2b' },
  { id: 'ai_research_software_b2b', label: 'AI / 研究型软件 / 知识科技 B2B', domain: 'ai_research_software_b2b' },
  { id: 'general_technology_b2b', label: '科技企业 / 软件平台 / 智能硬件 B2B', domain: 'general_technology_b2b' },
  { id: 'food_beverage_restaurant', label: '餐饮 / 食品 / 饮品', domain: 'food_service' },
  { id: 'hospitality_hotel_tourism', label: '酒店 / 文旅 / 民宿', domain: 'hospitality' },
  { id: 'sports_fitness_outdoor', label: '运动 / 健身 / 户外', domain: 'sports' },
  { id: 'pet_toy_character_product', label: '宠物 / 玩具 / 角色产品', domain: 'pet_toy_character_product' },
  { id: 'ceramic_decal_character_design', label: '日用陶瓷贴花 / 原创卡通形象', domain: 'ceramic_decal_character_ip' },
  { id: 'fashion_apparel_accessories', label: '服装 / 时尚 / 配饰', domain: 'fashion' },
  { id: 'home_furniture_bedding', label: '家居 / 家具 / 床垫', domain: 'home_furnishing' },
  { id: 'home_improvement_decoration', label: '家装 / 装修 / 装饰服务', domain: 'home_improvement_service' },
  { id: 'property_facility_real_estate_service', label: '物业 / 楼宇 / 地产服务', domain: 'property_facility_service' },
  { id: 'financial_insurance_service', label: '金融 / 保险 / 支付服务', domain: 'financial_insurance_service' },
  { id: 'medical_device_healthcare_b2b', label: '医疗器械 / 医疗科技 / 医疗服务 B2B', domain: 'medical_device_healthcare_b2b' },
  { id: 'beauty_health_wellness', label: '美业 / 健康 / 营养', domain: 'health_wellness' },
  { id: 'energy_ev_infrastructure', label: '新能源 / 换电 / 基础设施', domain: 'energy_infrastructure' },
  { id: 'automotive_trade_mobility', label: '汽车 / 汽配 / 出行贸易', domain: 'automotive_mobility' },
  { id: 'aviation_transport_service', label: '航空 / 交通 / 高端服务', domain: 'transport_aviation' },
  { id: 'government_public_service', label: '政府 / 公共服务 / 事业单位', domain: 'public_service' },
  { id: 'spatial_retail_exhibition', label: '商业空间 / 门店 / 展示', domain: 'spatial_design' },
  { id: 'landscape_public_art', label: '景观 / 公共艺术 / 户外方案', domain: 'landscape' },
  { id: 'industrial_manufacturing_b2b', label: '工业制造 / B2B 企业', domain: 'industrial_b2b' },
  { id: 'industrial_safety_training', label: '工业安全 / 培训手册', domain: 'industrial_safety_training' },
  { id: 'education_culture_media', label: '教育 / 文化 / 传媒', domain: 'education_culture' },
  { id: 'general_business_service', label: '通用商业 / 服务业', domain: 'general_business' },
]);

export const CORE_MODEL_INDUSTRY_IDS = Object.freeze(CORE_MODEL_INDUSTRIES.map((item) => item.id));

const INDUSTRY_BY_ID = new Map(CORE_MODEL_INDUSTRIES.map((item) => [item.id, item]));

function firstText(values = []) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return '';
}

function normalizedConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0.5;
  return Math.max(0, Math.min(1, numeric));
}

function listEvidence(values = []) {
  return (values || []).map((item) => {
    if (typeof item === 'string') {
      return {
        source: 'llm-semantic-intake/industry',
        signal: 'model-industry-evidence',
        excerpt: normalizeText(item),
        weight: 80,
      };
    }
    return {
      source: normalizeText(item?.source || 'llm-semantic-intake/industry'),
      signal: normalizeText(item?.signal || item?.id || 'model-industry-evidence'),
      excerpt: normalizeText(item?.excerpt || item?.quote || item?.text || ''),
      weight: Number.isFinite(Number(item?.weight)) ? Number(item.weight) : 80,
    };
  }).filter((item) => item.excerpt || item.signal);
}

function canonicalWorkflowId(value) {
  return canonicalProductLineId(value || '') || '';
}

export function industryDefinitionById(industryId) {
  return INDUSTRY_BY_ID.get(normalizeText(industryId)) || null;
}

export function industryIdsForSemanticPrompt() {
  return CORE_MODEL_INDUSTRY_IDS.join(' | ');
}

export function modelIndustrySpecFromLlmSemantic({ semantic = {}, subject = {}, audit = null } = {}) {
  const taskUnderstanding = semantic.taskUnderstanding || {};
  const extracted = semantic.extracted || {};
  const routeSeed = semantic.routeSeed || semantic.routeContract || {};
  const modelIndustry = semantic.modelIndustry || {};
  const industryId = normalizeText(firstText([
    taskUnderstanding.industryId,
    modelIndustry.industryId,
    semantic.subject?.industryId,
    extracted.industryId,
    routeSeed.industryId,
    subject.semanticIndustryId,
    subject.industryId,
  ]));
  if (!industryId) {
    return {
      blocked: true,
      blockerType: 'model_industry_required',
      reason: 'LLM semantic intake did not return industryId; regex/refpack-index routing is disabled',
      source: 'llm_semantic_intake',
      audit,
    };
  }
  const def = industryDefinitionById(industryId);
  if (!def) {
    return {
      blocked: true,
      blockerType: 'model_industry_invalid',
      reason: `LLM semantic intake returned unknown industryId: ${industryId}`,
      industryId,
      allowedIndustryIds: CORE_MODEL_INDUSTRY_IDS,
      source: 'llm_semantic_intake',
      audit,
    };
  }
  const industryCue = firstText([
    taskUnderstanding.industryCue,
    modelIndustry.industryCue,
    extracted.industry,
    extracted.industryCue,
    routeSeed.industryCue,
    subject.semanticIndustryCue,
    subject.industryText,
  ]) || def.label;
  const confidence = normalizedConfidence(
    taskUnderstanding.industryConfidence
      ?? modelIndustry.industryConfidence
      ?? extracted.industryConfidence
      ?? routeSeed.industryConfidence
      ?? subject.industryConfidence
      ?? 0.5,
  );
  const evidence = listEvidence([
    ...(Array.isArray(taskUnderstanding.industryEvidence) ? taskUnderstanding.industryEvidence : []),
    ...(Array.isArray(modelIndustry.industryEvidence) ? modelIndustry.industryEvidence : []),
    ...(Array.isArray(extracted.industryEvidence) ? extracted.industryEvidence : []),
  ]);
  if (!evidence.length && industryCue) {
    evidence.push({
      source: 'llm-semantic-intake/industryCue',
      signal: 'model-industry-cue',
      excerpt: industryCue.slice(0, 240),
      weight: Math.round(confidence * 100),
    });
  }
  return {
    version: LLM_DESIGN_REFERENCE_RESOLVER_VERSION,
    id: def.id,
    label: def.label,
    domain: def.domain,
    confidence,
    evidence,
    alternatives: uniqueStrings([
      ...(Array.isArray(taskUnderstanding.industryAlternatives) ? taskUnderstanding.industryAlternatives : []),
      ...(Array.isArray(modelIndustry.industryAlternatives) ? modelIndustry.industryAlternatives : []),
    ], 12),
    source: 'llm_semantic_intake',
    audit,
  };
}

function auditSelectedIndustryId(audit = null) {
  return normalizeText(
    audit?.id
      || audit?.selectedIndustryId
      || audit?.retrieval?.selectedIndustryId
      || audit?.designReferenceRetrieval?.selectedIndustryId
      || '',
  ) || null;
}

export function buildModelIndustryArbitration({ industrySpec = null, audit = null } = {}) {
  const auditIndustryId = auditSelectedIndustryId(audit);
  const modelIndustryId = normalizeText(industrySpec?.id || industrySpec?.industryId || '') || null;
  const confidence = normalizedConfidence(industrySpec?.confidence);
  const confidenceOverride = industrySpec?.confidencePolicyOverride || null;
  const allowBelowFloorByOverride = confidenceOverride?.allowBelowFloor === true
    && confidence >= normalizedConfidence(confidenceOverride.minimumConfidence ?? MODEL_INDUSTRY_CONFIDENCE_POLICY.blockBelow);
  const warnings = [];
  const blockers = [];

  if (!modelIndustryId) {
    blockers.push({
      code: 'model_industry_required',
      message: 'LLM semantic intake did not return an allowed model industry id.',
    });
  } else if (confidence < MODEL_INDUSTRY_CONFIDENCE_POLICY.blockBelow) {
    if (allowBelowFloorByOverride) {
      warnings.push({
        code: 'model_industry_confidence_below_floor_allowed',
        reasonCode: normalizeText(confidenceOverride.code || '') || null,
        message: confidenceOverride.reason || `LLM model industry confidence ${confidence.toFixed(2)} is below ${MODEL_INDUSTRY_CONFIDENCE_POLICY.blockBelow.toFixed(2)} but a narrow workflow-specific override allows it.`,
        modelIndustryId,
        confidence,
        threshold: MODEL_INDUSTRY_CONFIDENCE_POLICY.blockBelow,
        minimumConfidence: normalizedConfidence(confidenceOverride.minimumConfidence ?? MODEL_INDUSTRY_CONFIDENCE_POLICY.blockBelow),
      });
    } else {
      blockers.push({
        code: 'model_industry_confidence_below_floor',
        message: `LLM model industry confidence ${confidence.toFixed(2)} is below ${MODEL_INDUSTRY_CONFIDENCE_POLICY.blockBelow.toFixed(2)}.`,
        modelIndustryId,
        confidence,
        threshold: MODEL_INDUSTRY_CONFIDENCE_POLICY.blockBelow,
      });
    }
  } else if (confidence < MODEL_INDUSTRY_CONFIDENCE_POLICY.reviewBelow) {
    warnings.push({
      code: 'model_industry_confidence_needs_review',
      message: `LLM model industry confidence ${confidence.toFixed(2)} is below review threshold ${MODEL_INDUSTRY_CONFIDENCE_POLICY.reviewBelow.toFixed(2)}.`,
      modelIndustryId,
      confidence,
      threshold: MODEL_INDUSTRY_CONFIDENCE_POLICY.reviewBelow,
    });
  }

  if (auditIndustryId && modelIndustryId && auditIndustryId !== modelIndustryId) {
    if (confidence < MODEL_INDUSTRY_CONFIDENCE_POLICY.conflictBlockBelow) {
      blockers.push({
        code: 'model_industry_audit_conflict_low_confidence',
        message: `Audit/index suggested ${auditIndustryId}; LLM semantic industry ${modelIndustryId} is below conflict threshold ${MODEL_INDUSTRY_CONFIDENCE_POLICY.conflictBlockBelow.toFixed(2)}.`,
        auditIndustryId,
        modelIndustryId,
        confidence,
        threshold: MODEL_INDUSTRY_CONFIDENCE_POLICY.conflictBlockBelow,
      });
    } else {
      warnings.push({
        code: 'audit_industry_disagrees_with_llm_industry',
        message: `Audit/index suggested ${auditIndustryId}; high-confidence LLM semantic industry ${modelIndustryId} remains authoritative.`,
        auditIndustryId,
        modelIndustryId,
        confidence,
      });
    }
  }

  return {
    version: LLM_DESIGN_REFERENCE_RESOLVER_VERSION,
    kind: 'ModelIndustryArbitration',
    status: blockers.length
      ? 'blocked_model_industry_arbitration'
      : (warnings.length ? 'pass_model_industry_arbitration_with_warnings' : 'pass_model_industry_arbitration'),
    ok: blockers.length === 0,
	    modelIndustryId,
	    confidence,
	    policy: MODEL_INDUSTRY_CONFIDENCE_POLICY,
	    confidencePolicyOverride: allowBelowFloorByOverride ? confidenceOverride : null,
	    auditIndustryId,
	    warnings,
	    blockers,
    safety: {
      llmIndustryAuthoritative: blockers.length === 0,
      auditMayOverride: false,
      refpackIndexMayOverride: false,
      executesExternalAction: false,
    },
  };
}

export function buildModelLockedDesignReferenceRetrieval({
  designReferenceSpec = null,
  workflowId = null,
  industrySpec = null,
  audit = null,
  catalogSource = null,
} = {}) {
  const selectedRefpackId = designReferenceSpec?.id || designReferenceSpec?.referencePackage?.selectedPackId || null;
  const industryArbitration = buildModelIndustryArbitration({ industrySpec, audit });
  const blockers = [
    ...(selectedRefpackId ? [] : [{
      code: 'model_locked_refpack_missing',
      message: 'No static design reference pack exists for the LLM-selected industry/workflow.',
    }]),
    ...industryArbitration.blockers,
  ];
  const retrieval = {
    version: LLM_DESIGN_REFERENCE_RESOLVER_VERSION,
    kind: 'DesignReferenceRetrieval',
    status: !selectedRefpackId
      ? 'blocked_model_locked_refpack_missing'
      : (industryArbitration.ok ? 'model_locked_static_refpack' : 'blocked_model_industry_arbitration'),
    ok: Boolean(selectedRefpackId) && industryArbitration.ok,
    routingMode: 'model_semantic_locked',
    selectionAuthority: 'semantic_intake',
    indexRoutingActive: false,
    indexOverrideAllowed: false,
    workflowId: canonicalWorkflowId(workflowId || designReferenceSpec?.workflowId),
    selectedRefpackId,
    staticRefpackId: selectedRefpackId,
    topRefpackId: null,
    selectedIndustryId: industrySpec?.id || null,
    selectionReason: 'llm_semantic_industry_static_refpack',
    catalogSource: normalizeText(catalogSource || '') || null,
    industryArbitration,
    audit,
    warnings: industryArbitration.warnings,
    blockers,
    safety: {
      llmIndustryAuthoritative: industryArbitration.ok,
      regexMayOverride: false,
      refpackIndexMayOverride: false,
      executesExternalAction: false,
    },
  };
  return {
    ...retrieval,
    retrievalHash: digest({
      version: retrieval.version,
      kind: retrieval.kind,
      status: retrieval.status,
      routingMode: retrieval.routingMode,
      selectionAuthority: retrieval.selectionAuthority,
      indexRoutingActive: retrieval.indexRoutingActive,
      indexOverrideAllowed: retrieval.indexOverrideAllowed,
      workflowId: retrieval.workflowId,
      selectedRefpackId: retrieval.selectedRefpackId,
      staticRefpackId: retrieval.staticRefpackId,
      topRefpackId: retrieval.topRefpackId,
      selectedIndustryId: retrieval.selectedIndustryId,
      selectionReason: retrieval.selectionReason,
      catalogSource: retrieval.catalogSource,
	      industryArbitration: retrieval.industryArbitration,
	      confidencePolicyOverride: retrieval.industryArbitration?.confidencePolicyOverride || null,
	      warnings: retrieval.warnings,
	      blockers: retrieval.blockers,
	      safety: retrieval.safety,
    }),
  };
}

export function buildDisabledDesignReferenceRetrieval({
  designReferenceSpec = null,
  workflowId = null,
  industrySpec = null,
  reason = 'operator_disabled_refpack_index',
  warningCode = 'refpack_index_disabled_by_flag',
} = {}) {
  const selectedRefpackId = designReferenceSpec?.id || designReferenceSpec?.referencePackage?.selectedPackId || null;
  const retrieval = {
    version: LLM_DESIGN_REFERENCE_RESOLVER_VERSION,
    kind: 'DesignReferenceRetrieval',
    routingMode: 'operator_disabled',
    selectionAuthority: 'operator_flag',
    indexRoutingActive: false,
    indexOverrideAllowed: false,
    status: 'refpack_index_disabled',
    ok: false,
    workflowId: canonicalWorkflowId(workflowId || designReferenceSpec?.workflowId),
    staticRefpackId: selectedRefpackId,
    staticIndustryId: designReferenceSpec?.industryId || industrySpec?.id || null,
    selectedRefpackId,
    selectedIndustryId: designReferenceSpec?.industryId || industrySpec?.id || null,
    selectionReason: normalizeText(reason || '') || 'operator_disabled_refpack_index',
    warnings: [{ code: normalizeText(warningCode || '') || 'refpack_index_disabled_by_flag' }],
    blockers: [],
    safety: {
      llmIndustryAuthoritative: Boolean(industrySpec?.id),
      regexMayOverride: false,
      refpackIndexMayOverride: false,
      callsProviderOrModel: false,
      opensBrowserOrPlatform: false,
      uploadsOrSubmits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      paysOrDeploys: false,
      grantsExecutionPermission: false,
      executesExternalAction: false,
    },
  };
  return {
    ...retrieval,
    retrievalHash: digest({
      version: retrieval.version,
      kind: retrieval.kind,
      routingMode: retrieval.routingMode,
      selectionAuthority: retrieval.selectionAuthority,
      indexRoutingActive: retrieval.indexRoutingActive,
      indexOverrideAllowed: retrieval.indexOverrideAllowed,
      status: retrieval.status,
      workflowId: retrieval.workflowId,
      staticRefpackId: retrieval.staticRefpackId,
      staticIndustryId: retrieval.staticIndustryId,
      selectedRefpackId: retrieval.selectedRefpackId,
      selectedIndustryId: retrieval.selectedIndustryId,
      selectionReason: retrieval.selectionReason,
      warnings: retrieval.warnings,
      blockers: retrieval.blockers,
      safety: retrieval.safety,
    }),
  };
}

function blockedCoreDesignReferenceSpec({
  taskKey = null,
  channelId = null,
  productLineId = null,
  workflowId = null,
  industrySpec = null,
  blockerCode = 'model_locked_refpack_missing',
  blockerMessage = null,
  extraBlockerCodes = [],
  blockerMessages = [],
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  const qaBlockers = uniqueStrings([
    blockerMessage || blockerCode,
    ...blockerMessages,
  ], 24);
  const spec = buildDesignReferenceSpec({
    taskKey,
    channelId,
    productLineId,
    workflowId,
    referencePackage: {
      selectedPackId: null,
      industryId: industrySpec?.id || null,
      workflowId,
      selectionReason: blockerCode,
      sourcePolicy: { use: 'structure_and_design_grammar_only', digestOnly: true, rewriteRequired: true },
      qaBlockers,
    },
    evidenceRefs,
    createdAt,
  });
  return {
    ...spec,
    blockers: uniqueStrings([...spec.blockers, blockerCode, ...extraBlockerCodes], 16),
    resolver: {
      version: LLM_DESIGN_REFERENCE_RESOLVER_VERSION,
      status: 'blocked_llm_design_reference_resolution',
      blockerCode,
      blockerMessage: blockerMessage || blockerCode,
      blockers: uniqueStrings([blockerCode, ...extraBlockerCodes], 16),
      executesExternalAction: false,
    },
  };
}

export function resolveLlmDesignReferenceSpec({
  taskKey = null,
  channelId = null,
  productLineId = null,
  workflowId = null,
  semantic = {},
  subject = {},
  evidenceRefs = [],
  legacyDesignReferenceSpecProvider = null,
  audit = null,
  catalogSource = null,
  createdAt = null,
  industrySpecOverride = null,
} = {}) {
  const industrySpec = industrySpecOverride || modelIndustrySpecFromLlmSemantic({ semantic, subject, audit });
  if (industrySpec.blocked) {
    const designReferenceSpec = blockedCoreDesignReferenceSpec({
      taskKey,
      channelId,
      productLineId,
      workflowId,
      industrySpec: null,
      blockerCode: industrySpec.blockerType || 'model_industry_required',
      blockerMessage: industrySpec.reason,
      evidenceRefs,
      createdAt,
    });
    return {
      ok: false,
      status: 'blocked_llm_design_reference_resolution',
      industrySpec,
      legacyDesignReferenceSpec: null,
      designReferenceSpec,
      designReferenceRetrieval: {
        version: LLM_DESIGN_REFERENCE_RESOLVER_VERSION,
        kind: 'DesignReferenceRetrieval',
        status: 'blocked_model_industry',
        ok: false,
        routingMode: 'model_semantic_locked',
        selectionAuthority: 'semantic_intake',
        indexRoutingActive: false,
        indexOverrideAllowed: false,
        workflowId: canonicalWorkflowId(workflowId),
        selectedRefpackId: null,
        staticRefpackId: null,
        topRefpackId: null,
        selectedIndustryId: null,
        selectionReason: industrySpec.blockerType || 'model_industry_required',
        blockers: [{ code: industrySpec.blockerType || 'model_industry_required', message: industrySpec.reason }],
        audit,
        safety: {
          llmIndustryAuthoritative: false,
          regexMayOverride: false,
          refpackIndexMayOverride: false,
          executesExternalAction: false,
        },
      },
      subject,
    };
  }
  let legacyDesignReferenceSpec = null;
  try {
    legacyDesignReferenceSpec = legacyDesignReferenceSpecProvider
      ? legacyDesignReferenceSpecProvider({ industrySpec, workflowId, semantic, subject })
      : null;
  } catch (error) {
    const designReferenceSpec = blockedCoreDesignReferenceSpec({
      taskKey,
      channelId,
      productLineId,
      workflowId,
      industrySpec,
      blockerCode: 'model_locked_refpack_provider_exception',
      blockerMessage: error.message,
      evidenceRefs,
      createdAt,
    });
    return {
      ok: false,
      status: 'blocked_llm_design_reference_resolution',
      industrySpec,
      legacyDesignReferenceSpec: null,
      designReferenceSpec,
      designReferenceRetrieval: buildModelLockedDesignReferenceRetrieval({
        designReferenceSpec: null,
        workflowId,
        industrySpec,
        audit,
        catalogSource,
      }),
      subject,
    };
  }
  const designReferenceRetrieval = buildModelLockedDesignReferenceRetrieval({
    designReferenceSpec: legacyDesignReferenceSpec,
    workflowId,
    industrySpec,
    audit,
    catalogSource,
  });
  if (!legacyDesignReferenceSpec?.id) {
    const designReferenceSpec = blockedCoreDesignReferenceSpec({
      taskKey,
      channelId,
      productLineId,
      workflowId,
      industrySpec,
      blockerCode: 'model_locked_refpack_missing',
      blockerMessage: 'No static design reference pack exists for the LLM-selected industry/workflow.',
      evidenceRefs,
      createdAt,
    });
    return {
      ok: false,
      status: 'blocked_llm_design_reference_resolution',
      industrySpec,
      legacyDesignReferenceSpec,
      designReferenceSpec,
      designReferenceRetrieval,
      subject,
    };
  }
  if (!designReferenceRetrieval.ok) {
    const arbitrationBlockers = designReferenceRetrieval.blockers.filter((item) => item.code !== 'model_locked_refpack_missing');
    if (arbitrationBlockers.length) {
      const [primaryBlocker] = arbitrationBlockers;
      const designReferenceSpec = blockedCoreDesignReferenceSpec({
        taskKey,
        channelId,
        productLineId,
        workflowId,
        industrySpec,
        blockerCode: primaryBlocker.code || 'model_industry_arbitration_blocked',
        blockerMessage: primaryBlocker.message || primaryBlocker.code || 'model_industry_arbitration_blocked',
        extraBlockerCodes: arbitrationBlockers.slice(1).map((item) => item.code).filter(Boolean),
        blockerMessages: arbitrationBlockers.slice(1).map((item) => item.message || item.code).filter(Boolean),
        evidenceRefs,
        createdAt,
      });
      return {
        ok: false,
        status: 'blocked_llm_design_reference_resolution',
        industrySpec,
        legacyDesignReferenceSpec,
        designReferenceSpec,
        designReferenceRetrieval,
        subject,
      };
    }
  }
  const designReferenceSpec = convertLegacyDesignReferenceSpecToCore({
    taskKey,
    channelId,
    productLineId,
    workflowId,
    legacySpec: legacyDesignReferenceSpec,
    retrieval: designReferenceRetrieval,
    evidenceRefs,
    createdAt,
  });
  return {
    ok: designReferenceSpec.ok === true,
    status: designReferenceSpec.ok ? 'pass_llm_design_reference_resolution' : 'blocked_llm_design_reference_resolution',
    industrySpec,
    legacyDesignReferenceSpec,
    designReferenceSpec: {
      ...designReferenceSpec,
      resolver: {
        version: LLM_DESIGN_REFERENCE_RESOLVER_VERSION,
        source: 'llm_design_reference_resolver',
        llmIndustryAuthoritative: true,
        regexMayOverride: false,
        refpackIndexMayOverride: false,
        executesExternalAction: false,
      },
    },
    designReferenceRetrieval,
    subject,
  };
}

export function summarizeLlmDesignReferenceResolutions(resolutions = []) {
  const byStatus = {};
  const byIndustry = {};
  let arbitrationBlocked = 0;
  let arbitrationWarningCount = 0;
  for (const item of resolutions || []) {
    byStatus[item.status || 'unknown'] = (byStatus[item.status || 'unknown'] || 0) + 1;
    const industryId = item.industrySpec?.id || item.industrySpec?.industryId || 'unknown';
    byIndustry[industryId] = (byIndustry[industryId] || 0) + 1;
    if (item.designReferenceRetrieval?.industryArbitration?.ok === false) arbitrationBlocked += 1;
    arbitrationWarningCount += item.designReferenceRetrieval?.industryArbitration?.warnings?.length || 0;
  }
  return {
    version: LLM_DESIGN_REFERENCE_RESOLVER_VERSION,
    count: resolutions.length,
    blocked: resolutions.filter((item) => item.ok !== true).length,
    arbitrationBlocked,
    arbitrationWarningCount,
    byStatus,
    byIndustry,
    safety: {
      llmIndustryAuthoritative: true,
      regexMayOverride: false,
      refpackIndexMayOverride: false,
      executesExternalAction: false,
    },
  };
}
