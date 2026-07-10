import {
  CHANNEL_IDS,
  EXTERNAL_ACTIONS,
  OUTPUT_MODES,
  PRODUCT_LINE_IDS,
  canonicalProductLineId,
  uniqueStrings,
} from './contracts.mjs';

export const WORKFLOW_REGISTRY_VERSION = 1;

const DIRECT_EXTERNAL_ACTIONS_BLOCKED = Object.freeze([
  EXTERNAL_ACTIONS.PROVIDER_SPEND,
  EXTERNAL_ACTIONS.MODEL_SPEND,
  EXTERNAL_ACTIONS.LIVE_PREPARE,
  EXTERNAL_ACTIONS.LIVE_SUBMIT,
  EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
  EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  EXTERNAL_ACTIONS.DEPLOYMENT,
]);

const CORE_GATES = Object.freeze({
  SEMANTIC_CONTRACT: 'semantic_contract',
  REFERENCE_ROUTE: 'reference_pack_route',
  GENERATION_MANIFEST: 'generation_manifest',
  PACKAGE_REVIEW: 'package_review',
  FINAL_REVIEW: 'final_review',
  FINAL_VISUAL_REVIEW: 'final_visual_review',
  FRESH_EVIDENCE: 'fresh_evidence_before_external_action',
  CHANNEL_POLICY: 'channel_policy_adapter_gate',
});

const COMMON_SUBJECT_GATES = Object.freeze([
  CORE_GATES.SEMANTIC_CONTRACT,
  CORE_GATES.REFERENCE_ROUTE,
  CORE_GATES.GENERATION_MANIFEST,
  CORE_GATES.PACKAGE_REVIEW,
  CORE_GATES.FINAL_REVIEW,
  CORE_GATES.FINAL_VISUAL_REVIEW,
  CORE_GATES.FRESH_EVIDENCE,
  CORE_GATES.CHANNEL_POLICY,
]);

const COMMON_TEXT_GATES = Object.freeze([
  CORE_GATES.SEMANTIC_CONTRACT,
  CORE_GATES.PACKAGE_REVIEW,
  CORE_GATES.FINAL_REVIEW,
  CORE_GATES.FRESH_EVIDENCE,
  CORE_GATES.CHANNEL_POLICY,
]);

const COMMON_DELIVERY_GATES = Object.freeze([
  'current_artifact_binding',
  CORE_GATES.PACKAGE_REVIEW,
  CORE_GATES.FINAL_REVIEW,
  CORE_GATES.FRESH_EVIDENCE,
  CORE_GATES.CHANNEL_POLICY,
]);

export const HUMAN_FEEDBACK_LOGO_VECTOR_HANDOFF_GATES = Object.freeze([
  'feedback_authoritative_logo_source_lock',
  'model_logo_reconstruction_source_hash',
  'rust_core_vector_package_review',
  'protected_region_effect_geometry_lock',
  'no_effect_mockup_as_vector_source',
]);

export const HUMAN_FEEDBACK_LOGO_VECTOR_HANDOFF_QUALITY_GATES = Object.freeze([
  'exact_wordmark_from_authoritative_source',
  'vector_preview_matches_reconstruction_source',
  'effect_preview_preserves_locked_geometry',
  'no_dimension_watermark_or_ui_drift',
]);

function freezeProfile(profile) {
  return Object.freeze({
    ...profile,
    artifactPolicy: Object.freeze(profile.artifactPolicy || {}),
    semanticPolicy: Object.freeze(profile.semanticPolicy || {}),
    referencePolicy: Object.freeze(profile.referencePolicy || {}),
    requiredGates: Object.freeze(uniqueStrings(profile.requiredGates || [], 64)),
    qualityGates: Object.freeze(uniqueStrings(profile.qualityGates || [], 64)),
    channelPolicy: Object.freeze({
      supportedChannels: Object.freeze(uniqueStrings(profile.channelPolicy?.supportedChannels || [], 12)),
      channelOwnedExternalActions: profile.channelPolicy?.channelOwnedExternalActions !== false,
      platformLimitsFromChannel: profile.channelPolicy?.platformLimitsFromChannel !== false,
      directExternalActionsBlocked: Object.freeze(
        uniqueStrings(profile.channelPolicy?.directExternalActionsBlocked || DIRECT_EXTERNAL_ACTIONS_BLOCKED, 16),
      ),
    }),
    notes: Object.freeze(uniqueStrings(profile.notes || [], 32)),
  });
}

function createProfile({
  productLineId,
  workflowId = productLineId,
  label,
  defaultOutputMode,
  supportedChannels,
  artifactPolicy,
  semanticPolicy = {},
  referencePolicy = {},
  requiredGates = [],
  qualityGates = [],
  notes = [],
}) {
  return freezeProfile({
    version: WORKFLOW_REGISTRY_VERSION,
    productLineId,
    workflowId,
    label,
    defaultOutputMode,
    artifactPolicy,
    semanticPolicy: {
      required: semanticPolicy.required !== false,
      modelBacked: semanticPolicy.modelBacked !== false,
      subjectCritical: semanticPolicy.subjectCritical !== false,
      sourceHashRequired: semanticPolicy.sourceHashRequired !== false,
      ...semanticPolicy,
    },
    referencePolicy: {
      required: referencePolicy.required !== false,
      usesRefpack: referencePolicy.usesRefpack !== false,
      digestOnly: referencePolicy.digestOnly !== false,
      owner: referencePolicy.owner || 'design-production-core',
      ...referencePolicy,
    },
    requiredGates,
    qualityGates,
    channelPolicy: {
      supportedChannels,
      channelOwnedExternalActions: true,
      platformLimitsFromChannel: true,
      directExternalActionsBlocked: DIRECT_EXTERNAL_ACTIONS_BLOCKED,
    },
    notes,
  });
}

const profiles = [
  createProfile({
    productLineId: PRODUCT_LINE_IDS.LOGO_BRAND,
    label: 'Logo and brand identity',
    defaultOutputMode: OUTPUT_MODES.IMAGE_SET,
    supportedChannels: [CHANNEL_IDS.ZBJ, CHANNEL_IDS.EPWK, CHANNEL_IDS.HEPTA, CHANNEL_IDS.MANUAL],
    artifactPolicy: {
      defaultCount: 5,
      minCount: 1,
      maxCount: 10,
      finalReviewExpects: 'expanded_vi_boards_or_vector_brand_package',
      countSource: 'channel_live_rules_or_order_sku',
    },
    requiredGates: COMMON_SUBJECT_GATES,
    qualityGates: [
      'subject_text_consistency',
      'professional_finish',
      'template_filler_absence',
      'strategic_direction_diversity',
      'no_occluding_overlays',
      'industry_application_proof',
    ],
    notes: [
      'Exact brand text and no-copy constraints must be locked before generation.',
      'Provider output is not quality proof; final visual review must judge finish and filler.',
    ],
  }),
  createProfile({
    productLineId: PRODUCT_LINE_IDS.PACKAGING_DESIGN,
    label: 'Packaging and label design',
    defaultOutputMode: OUTPUT_MODES.IMAGE_SET,
    supportedChannels: [CHANNEL_IDS.ZBJ, CHANNEL_IDS.EPWK, CHANNEL_IDS.MANUAL],
    artifactPolicy: {
      defaultCount: 3,
      minCount: 1,
      maxCount: 10,
      finalReviewExpects: 'packaging_views_with_text_lock',
      countSource: 'channel_live_rules_or_order_sku',
    },
    requiredGates: COMMON_SUBJECT_GATES,
    qualityGates: [
      'preserve_buyer_supplied_production_text',
      'no_invented_barcode_qr_contact',
      'dieline_or_container_context',
      'professional_finish',
      'template_filler_absence',
    ],
    notes: [
      'Production, regulatory, barcode, address, phone, license, date, and batch text are separate locks.',
    ],
  }),
  createProfile({
    productLineId: PRODUCT_LINE_IDS.PROPOSAL_BOARD,
    label: 'Proposal board and spatial concept',
    defaultOutputMode: OUTPUT_MODES.PDF_DECK,
    supportedChannels: [CHANNEL_IDS.ZBJ, CHANNEL_IDS.EPWK, CHANNEL_IDS.MANUAL],
    artifactPolicy: {
      defaultCount: 1,
      minCount: 1,
      maxCount: 10,
      finalReviewExpects: 'client_facing_pdf_or_direction_pdfs',
      countSource: 'channel_live_rules_or_order_sku',
    },
    requiredGates: [...COMMON_SUBJECT_GATES, 'pdf_page_render_review', 'proposal_copy_polish'],
    qualityGates: [
      'formal_client_language',
      'page_narrative_coherence',
      'buildability_or_application_proof',
      'no_raw_process_language',
    ],
  }),
  createProfile({
    productLineId: PRODUCT_LINE_IDS.PRESENTATION_DECK,
    label: 'Presentation deck',
    defaultOutputMode: OUTPUT_MODES.PDF_DECK,
    supportedChannels: [CHANNEL_IDS.ZBJ, CHANNEL_IDS.EPWK, CHANNEL_IDS.HEPTA, CHANNEL_IDS.MANUAL],
    artifactPolicy: {
      defaultCount: 1,
      minCount: 1,
      maxCount: 10,
      finalReviewExpects: 'rendered_pdf_pages',
      countSource: 'channel_live_rules_or_order_sku',
    },
    requiredGates: [...COMMON_SUBJECT_GATES, 'pdf_page_render_review', 'proposal_copy_polish'],
    qualityGates: [
      'executive_storyline',
      'slide_hierarchy',
      'no_template_placeholder_content',
      'no_raw_process_language',
    ],
  }),
  createProfile({
    productLineId: PRODUCT_LINE_IDS.CATALOG_BROCHURE,
    label: 'Catalog, brochure, and leaflet',
    defaultOutputMode: OUTPUT_MODES.PDF_DECK,
    supportedChannels: [CHANNEL_IDS.ZBJ, CHANNEL_IDS.EPWK, CHANNEL_IDS.HEPTA, CHANNEL_IDS.MANUAL],
    artifactPolicy: {
      defaultCount: 1,
      minCount: 1,
      maxCount: 10,
      finalReviewExpects: 'rendered_pdf_pages_or_print_ready_images',
      countSource: 'channel_live_rules_or_order_sku',
    },
    requiredGates: [...COMMON_SUBJECT_GATES, 'pdf_page_render_review', 'print_copy_review'],
    qualityGates: [
      'catalog_information_hierarchy',
      'client_facing_copy',
      'no_demo_data_or_template_fillers',
      'print_safe_asset_check',
    ],
  }),
  createProfile({
    productLineId: PRODUCT_LINE_IDS.POSTER_DESIGN,
    label: 'Poster and key visual design',
    defaultOutputMode: OUTPUT_MODES.IMAGE_SET,
    supportedChannels: [CHANNEL_IDS.ZBJ, CHANNEL_IDS.EPWK, CHANNEL_IDS.HEPTA, CHANNEL_IDS.MANUAL],
    artifactPolicy: {
      defaultCount: 5,
      minCount: 1,
      maxCount: 10,
      finalReviewExpects: 'client_facing_poster_or_key_visual_set',
      countSource: 'channel_live_rules_or_order_sku',
    },
    requiredGates: COMMON_SUBJECT_GATES,
    qualityGates: [
      'poster_subject_fidelity',
      'buyer_supported_visible_copy',
      'clear_visual_hierarchy',
      'no_fake_commercial_claims',
      'professional_finish',
      'template_filler_absence',
    ],
    notes: [
      'Poster/KV routes must distinguish visible buyer copy from layout-only terms such as 横版, KV, and KT板.',
      'Buyer attachments are source/reference locks for subject, product shape, and copy; do not invent claims or contacts.',
    ],
  }),
  createProfile({
    productLineId: PRODUCT_LINE_IDS.PRODUCT_DESIGN,
    label: 'Product appearance and industrial design',
    defaultOutputMode: OUTPUT_MODES.IMAGE_SET,
    supportedChannels: [CHANNEL_IDS.ZBJ, CHANNEL_IDS.EPWK, CHANNEL_IDS.MANUAL],
    artifactPolicy: {
      defaultCount: 3,
      minCount: 1,
      maxCount: 10,
      finalReviewExpects: 'product_views_and_application_context',
      countSource: 'channel_live_rules_or_order_sku',
    },
    requiredGates: COMMON_SUBJECT_GATES,
    qualityGates: [
      'form_factor_consistency',
      'material_and_usage_plausibility',
      'multiple_view_coherence',
      'professional_finish',
    ],
  }),
  createProfile({
    productLineId: PRODUCT_LINE_IDS.NAMING_TEXT,
    label: 'Naming and text-form submission',
    defaultOutputMode: OUTPUT_MODES.TEXT_FORM,
    supportedChannels: [CHANNEL_IDS.ZBJ, CHANNEL_IDS.EPWK, CHANNEL_IDS.MANUAL],
    artifactPolicy: {
      defaultCount: 5,
      minCount: 1,
      maxCount: 5,
      finalReviewExpects: 'actual_name_explanation_pairs',
      countSource: 'channel_text_form_schema',
    },
    semanticPolicy: {
      required: true,
      modelBacked: true,
      subjectCritical: true,
      sourceHashRequired: true,
    },
    referencePolicy: {
      required: false,
      usesRefpack: false,
      digestOnly: true,
      owner: 'design-production-core',
    },
    requiredGates: COMMON_TEXT_GATES,
    qualityGates: [
      'actual_name_explanation_pairs',
      'no_meta_only_submission_note',
      'forbidden_word_screen',
      'platform_text_form_schema',
    ],
  }),
  createProfile({
    productLineId: PRODUCT_LINE_IDS.VECTORIZATION,
    label: 'Vectorization and clean asset delivery',
    defaultOutputMode: OUTPUT_MODES.VECTOR_PACKAGE,
    supportedChannels: [CHANNEL_IDS.HEPTA, CHANNEL_IDS.MANUAL],
    artifactPolicy: {
      defaultCount: 1,
      minCount: 1,
      maxCount: 20,
      finalReviewExpects: 'vector_source_package_with_preview',
      countSource: 'order_sku',
    },
    semanticPolicy: {
      required: true,
      modelBacked: false,
      subjectCritical: false,
      sourceHashRequired: true,
    },
    referencePolicy: {
      required: false,
      usesRefpack: false,
      digestOnly: true,
      owner: 'hepta_design',
    },
    requiredGates: [
      'source_asset_hash_lock',
      'vector_quality_review',
      'format_export_manifest',
      'delivery_preview_review',
      CORE_GATES.FRESH_EVIDENCE,
      CORE_GATES.CHANNEL_POLICY,
    ],
    qualityGates: [
      'path_cleanliness',
      'visual_match_to_source',
      'transparent_background_when_expected',
      'svg_pdf_png_export_integrity',
    ],
    notes: [
      'Hepta owns buyer UX and delivery; this profile must not inherit marketplace submit assumptions.',
    ],
  }),
  createProfile({
    productLineId: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
    label: 'Human feedback revision',
    defaultOutputMode: OUTPUT_MODES.MIXED,
    supportedChannels: [CHANNEL_IDS.ZBJ, CHANNEL_IDS.EPWK, CHANNEL_IDS.HEPTA, CHANNEL_IDS.MANUAL],
    artifactPolicy: {
      defaultCount: 1,
      minCount: 1,
      maxCount: 10,
      finalReviewExpects: 'one_atomic_revision_with_baseline_regression',
      countSource: 'feedback_queue',
    },
    semanticPolicy: {
      required: true,
      modelBacked: true,
      subjectCritical: true,
      sourceHashRequired: true,
    },
    referencePolicy: {
      required: false,
      usesRefpack: false,
      digestOnly: true,
      owner: 'originating_product_profile',
    },
    requiredGates: [
      'feedback_history_refresh',
      'feedback_target_artifact_binding',
      'atomic_correction_queue',
      'baseline_invariant_lock',
      ...HUMAN_FEEDBACK_LOGO_VECTOR_HANDOFF_GATES,
      CORE_GATES.PACKAGE_REVIEW,
      CORE_GATES.FINAL_REVIEW,
      CORE_GATES.FRESH_EVIDENCE,
      CORE_GATES.CHANNEL_POLICY,
    ],
    qualityGates: [
      'one_active_correction_per_iteration',
      'unchanged_item_regression_check',
      'customer_preview_or_delivery_classification',
      'feedback_stage_classification',
      ...HUMAN_FEEDBACK_LOGO_VECTOR_HANDOFF_QUALITY_GATES,
    ],
    notes: [
      'Covers post-submit, shortlist, post-win, Hepta, and manual human feedback.',
      'Legacy post_submission_revision routes canonicalize to this profile.',
      'English consumer_feedback intake metadata canonicalizes to this profile.',
      'When feedback selects a logo from a prior image, bind that selected image as the authoritative logo source; model-reconstruct the clean logo before Rust core vectorization if cutout quality is unreliable.',
      'Effect/backplate mockups are customer preview artifacts only unless explicitly selected as the logo source; they must not be reverse-used as vector source.',
      'Backplate or wall-effect revisions must preserve the accepted baseline geometry through protected-region locks and change only the active atomic correction.',
    ],
  }),
  createProfile({
    productLineId: PRODUCT_LINE_IDS.ACCEPTANCE_DELIVERY,
    label: 'Acceptance and final delivery',
    defaultOutputMode: OUTPUT_MODES.MIXED,
    supportedChannels: [CHANNEL_IDS.ZBJ, CHANNEL_IDS.HEPTA, CHANNEL_IDS.MANUAL],
    artifactPolicy: {
      defaultCount: 1,
      minCount: 1,
      maxCount: 20,
      finalReviewExpects: 'current_submit_ready_delivery_artifact',
      countSource: 'delivery_or_acceptance_contract',
    },
    semanticPolicy: {
      required: false,
      modelBacked: false,
      subjectCritical: false,
      sourceHashRequired: true,
    },
    referencePolicy: {
      required: false,
      usesRefpack: false,
      digestOnly: true,
      owner: 'delivery_workspace',
    },
    requiredGates: [
      ...COMMON_DELIVERY_GATES,
      'acceptance_current_artifact_binding',
      'delivery_file_manifest',
      'amount_or_sku_contract',
    ],
    qualityGates: [
      'final_delivery_file_integrity',
      'no_internal_process_language',
      'no_stale_pitch_package_binding',
      'high_resolution_page_inspection_when_pdf',
    ],
  }),
  createProfile({
    productLineId: PRODUCT_LINE_IDS.GENERIC_DESIGN,
    label: 'Generic design fallback',
    defaultOutputMode: OUTPUT_MODES.MIXED,
    supportedChannels: [CHANNEL_IDS.ZBJ, CHANNEL_IDS.EPWK, CHANNEL_IDS.HEPTA, CHANNEL_IDS.MANUAL],
    artifactPolicy: {
      defaultCount: null,
      minCount: 1,
      maxCount: 10,
      finalReviewExpects: 'clarified_product_line_before_external_action',
      countSource: 'clarification_required',
    },
    semanticPolicy: {
      required: true,
      modelBacked: true,
      subjectCritical: true,
      sourceHashRequired: true,
    },
    referencePolicy: {
      required: true,
      usesRefpack: true,
      digestOnly: true,
      owner: 'design-production-core',
    },
    requiredGates: [
      'product_line_clarification',
      CORE_GATES.SEMANTIC_CONTRACT,
      CORE_GATES.PACKAGE_REVIEW,
      CORE_GATES.FINAL_REVIEW,
      CORE_GATES.FRESH_EVIDENCE,
      CORE_GATES.CHANNEL_POLICY,
    ],
    qualityGates: [
      'low_confidence_route_human_or_model_review',
      'no_external_action_until_reclassified',
    ],
  }),
];

export const WORKFLOW_PROFILES = Object.freeze(Object.fromEntries(
  profiles.map((profile) => [profile.productLineId, profile]),
));

export function workflowProfileForProductLine(productLineId, { fallback = true } = {}) {
  const id = canonicalProductLineId(productLineId);
  return WORKFLOW_PROFILES[id] || (fallback ? WORKFLOW_PROFILES[PRODUCT_LINE_IDS.GENERIC_DESIGN] : null);
}

export function workflowProfileForRoute(routeDecision, options = {}) {
  return workflowProfileForProductLine(routeDecision?.productLineId, options);
}

export function workflowProfileForPlan(planLike, options = {}) {
  return workflowProfileForProductLine(planLike?.productLineId || planLike?.workflowId, options);
}

export function compactWorkflowProfile(profile) {
  if (!profile) return null;
  return {
    version: profile.version,
    productLineId: profile.productLineId,
    workflowId: profile.workflowId,
    label: profile.label,
    defaultOutputMode: profile.defaultOutputMode,
    semanticRequired: Boolean(profile.semanticPolicy?.required),
    referenceRequired: Boolean(profile.referencePolicy?.required),
    supportedChannels: profile.channelPolicy?.supportedChannels || [],
    requiredGates: profile.requiredGates || [],
    qualityGates: profile.qualityGates || [],
    directExternalActionsBlocked: profile.channelPolicy?.directExternalActionsBlocked || [],
  };
}

export function validateWorkflowProfile(profile) {
  const issues = [];
  const productLineValues = new Set(Object.values(PRODUCT_LINE_IDS));
  const outputModeValues = new Set(Object.values(OUTPUT_MODES));
  const channelValues = new Set(Object.values(CHANNEL_IDS));

  if (!profile) {
    issues.push({ code: 'profile_missing', message: 'Workflow profile is missing.' });
  } else {
    if (!productLineValues.has(profile.productLineId)) {
      issues.push({ code: 'unknown_product_line', productLineId: profile.productLineId });
    }
    if (!profile.workflowId) issues.push({ code: 'workflow_id_missing', productLineId: profile.productLineId });
    if (!outputModeValues.has(profile.defaultOutputMode)) {
      issues.push({ code: 'unknown_output_mode', productLineId: profile.productLineId });
    }
    if (!profile.requiredGates?.length) {
      issues.push({ code: 'required_gates_missing', productLineId: profile.productLineId });
    }
    if (!profile.qualityGates?.length) {
      issues.push({ code: 'quality_gates_missing', productLineId: profile.productLineId });
    }
    for (const channelId of profile.channelPolicy?.supportedChannels || []) {
      if (!channelValues.has(channelId)) issues.push({ code: 'unknown_supported_channel', productLineId: profile.productLineId, channelId });
    }
    if (profile.channelPolicy?.channelOwnedExternalActions !== true) {
      issues.push({ code: 'channel_owned_external_actions_required', productLineId: profile.productLineId });
    }
    if (!profile.channelPolicy?.directExternalActionsBlocked?.includes(EXTERNAL_ACTIONS.LIVE_SUBMIT)) {
      issues.push({ code: 'live_submit_must_be_channel_blocked', productLineId: profile.productLineId });
    }
  }

  return { ok: issues.length === 0, issues };
}

export function registrySummary() {
  const values = Object.values(WORKFLOW_PROFILES);
  return {
    version: WORKFLOW_REGISTRY_VERSION,
    profileCount: values.length,
    byOutputMode: values.reduce((acc, profile) => {
      acc[profile.defaultOutputMode] = (acc[profile.defaultOutputMode] || 0) + 1;
      return acc;
    }, {}),
    subjectCriticalCount: values.filter((profile) => profile.semanticPolicy?.subjectCritical).length,
    profiles: values.map(compactWorkflowProfile),
  };
}
