import { normalizeText, uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import { PAPER_CORE_VERSION, hashPaperRecord, normalizedId } from './primitives.mjs';

export function buildVenueResolutionPacket({
  paperTask,
  submissionIntent = null,
  candidates = [],
  packageReady = false,
  sourceReady = false,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('VenueResolutionPacket requires paperTask');
  const normalizedCandidates = (candidates || []).slice(0, 12).map((candidate, index) => ({
    id: normalizedId(candidate.id || candidate.venue_id || candidate.venueId, `${paperTask.paperId}:venue:${index + 1}`),
    venueId: normalizeText(candidate.venue_id || candidate.venueId || candidate.id || '') || null,
    name: normalizeText(candidate.name || candidate.label || '') || null,
    kind: normalizeText(candidate.kind || '') || null,
    cycle: normalizeText(candidate.cycle || '') || null,
    score: Number.isFinite(Number(candidate.score)) ? Number(candidate.score) : 0,
    reason: normalizeText(candidate.reason || '') || null,
  }));
  const blockers = [];
  const warnings = [];
  const intentStatus = normalizeText(submissionIntent?.status || 'unknown');
  if (intentStatus !== 'needs_venue_decision') warnings.push(`submission_intent_${intentStatus || 'unknown'}`);
  if (!sourceReady) blockers.push('source_not_ready_for_venue_resolution');
  if (!packageReady) blockers.push('package_not_submit_ready_for_venue_resolution');
  if (!normalizedCandidates.length) warnings.push('no_registry_venue_candidate');
  const packet = {
    version: PAPER_CORE_VERSION,
    kind: 'VenueResolutionPacket',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    title: paperTask.title,
    status: blockers.length
      ? 'venue_resolution_waiting_for_local_package'
      : 'manual_venue_decision_required',
    submissionIntent: submissionIntent || null,
    candidateCount: normalizedCandidates.length,
    candidates: normalizedCandidates,
    recommendedOutcome: normalizedCandidates.length
      ? 'operator_select_venue_or_mark_non_submission'
      : 'operator_provide_venue_or_mark_non_submission',
    decisionOptions: [
      'select_existing_registry_venue',
      'add_new_registry_venue',
      'mark_non_submission_archive',
      'keep_pending_manual_decision',
    ],
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(warnings, 32),
    safety: {
      writesRegistry: false,
      writesSqlite: false,
      externalActionPerformed: false,
      choosesVenueAutomatically: false,
    },
    createdAt: createdAt || null,
  };
  return { ...packet, venueResolutionPacketHash: hashPaperRecord('VenueResolutionPacket', packet) };
}

export function buildSubmitReadyPackagePlan({
  paperTask,
  artifactPackage = null,
  buildStatus = null,
  blockers = [],
  warnings = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('SubmitReadyPackagePlan requires paperTask');
  const artifacts = artifactPackage?.artifacts || [];
  const hasPdf = artifacts.some((artifact) => artifact.role === 'compiled_pdf');
  const hasTex = Boolean(paperTask.mainTex) || artifacts.some((artifact) => ['main_tex', 'tex_source'].includes(artifact.role));
  const hasSourceZip = artifacts.some((artifact) => /zip/i.test(artifact.role || artifact.filename || ''));
  const planBlockers = [...(blockers || [])];
  const planWarnings = [...(warnings || [])];
  if (!hasPdf) planBlockers.push('compiled_pdf_required_for_submit_ready_package');
  if (!hasTex) planBlockers.push('tex_source_required_for_submit_ready_package');
  if (!hasSourceZip) planWarnings.push('source_zip_should_be_generated_before_submit');
  const requiredOutputs = [
    'compiled_pdf',
    'source_workspace_zip',
    'PACKAGE_RECORD.json',
    'SHA256SUMS.txt',
  ];
  const plan = {
    version: PAPER_CORE_VERSION,
    kind: 'SubmitReadyPackagePlan',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: artifactPackage?.submitReady
      ? 'submit_ready_package_present'
      : 'submit_ready_package_plan_required',
    artifactPackageHash: artifactPackage?.artifactPackageHash || null,
    buildStatus: normalizeText(buildStatus || artifactPackage?.buildStatus || '') || null,
    hasPdf,
    hasTex,
    hasSourceZip,
    requiredOutputs,
    recommendedCommand: `paper-production-core batch-run --mode local-build --paper ${paperTask.paperId} --execute && paper-production-core batch-run --mode local-package --paper ${paperTask.paperId} --execute`,
    blockers: uniqueStrings(planBlockers, 32),
    warnings: uniqueStrings(planWarnings, 32),
    safety: {
      planOnly: true,
      writesSource: false,
      externalActionPerformed: false,
      executeRequiresExplicitFlag: true,
    },
    createdAt: createdAt || null,
  };
  return { ...plan, submitReadyPackagePlanHash: hashPaperRecord('SubmitReadyPackagePlan', plan) };
}

export function buildVenueRegistryAddPlan({
  paperTask,
  venueResolutionPacket,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !venueResolutionPacket?.kind) {
    throw new Error('VenueRegistryAddPlan requires paperTask and venueResolutionPacket');
  }
  const blockers = [];
  if (venueResolutionPacket.status !== 'manual_venue_decision_required') {
    blockers.push('venue_resolution_not_ready_for_registry_add');
  }
  const slug = normalizeText(paperTask.paperId).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const plan = {
    version: PAPER_CORE_VERSION,
    kind: 'VenueRegistryAddPlan',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: blockers.length ? 'registry_add_plan_blocked' : 'registry_add_plan_requires_operator_target',
    venueResolutionPacketHash: venueResolutionPacket.venueResolutionPacketHash,
    proposedVenueRecordTemplate: {
      venue_id: `manual_${slug || 'venue'}`,
      name: '',
      kind: '',
      cycle: '',
      deadline: '',
      metadata_json: '{}',
    },
    requiredOperatorFields: ['name', 'kind'],
    optionalOperatorFields: ['venue_id', 'cycle', 'deadline', 'metadata_json'],
    decisionOptions: [
      'add_new_registry_venue_then_rerun_venue_resolve',
      'select_existing_registry_venue',
      'mark_non_submission_archive',
      'keep_pending_manual_decision',
    ],
    blockers: uniqueStrings(blockers, 32),
    safety: {
      planOnly: true,
      writesRegistry: false,
      writesSqlite: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || null,
  };
  return { ...plan, venueRegistryAddPlanHash: hashPaperRecord('VenueRegistryAddPlan', plan) };
}

export function buildVenueResolutionOperatorPacket({
  paperTask,
  venueResolutionPacket,
  submitReadyPackagePlan = null,
  venueRegistryAddPlan = null,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !venueResolutionPacket?.kind) {
    throw new Error('VenueResolutionOperatorPacket requires paperTask and venueResolutionPacket');
  }
  const blockers = [];
  if (venueResolutionPacket.status !== 'manual_venue_decision_required') {
    blockers.push('venue_resolution_packet_not_operator_ready');
  }
  if (submitReadyPackagePlan?.status === 'submit_ready_package_plan_required') {
    blockers.push('submit_ready_package_required_before_operator_venue_resolution');
  }
  const hasCandidates = Number(venueResolutionPacket.candidateCount || 0) > 0;
  const packet = {
    version: PAPER_CORE_VERSION,
    kind: 'VenueResolutionOperatorPacket',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: blockers.length ? 'venue_operator_packet_blocked' : 'venue_operator_decision_ready',
    venueResolutionPacketHash: venueResolutionPacket.venueResolutionPacketHash,
    submitReadyPackagePlanHash: submitReadyPackagePlan?.submitReadyPackagePlanHash || null,
    venueRegistryAddPlanHash: venueRegistryAddPlan?.venueRegistryAddPlanHash || null,
    candidateCount: venueResolutionPacket.candidateCount || 0,
    requiredOperatorInputs: hasCandidates
      ? ['selected_venue_id_or_archive_decision', 'decision_rationale', 'operator_id', 'decision_timestamp']
      : ['venue_name_or_archive_decision', 'venue_kind', 'decision_rationale', 'operator_id', 'decision_timestamp'],
    acceptedOutcomes: [
      'select_existing_registry_venue',
      'add_new_registry_venue_then_rerun_venue_resolve',
      'mark_non_submission_archive',
      'keep_pending_manual_decision',
    ],
    acceptanceCriteria: [
      'decision_is_bound_to_venue_resolution_packet_hash',
      'selected_or_added_venue_has_name_and_kind',
      'submit_ready_package_is_present_before_active_submission_reentry',
      'rerun_local_dry_run_after_registry_or_archive_decision',
    ],
    nextCommands: [
      `paper-production-core batch-run --mode venue-resolve --paper ${paperTask.paperId} --write-report`,
      `paper-production-core batch-run --mode local-dry-run --paper ${paperTask.paperId} --write-report`,
    ],
    blockedActions: [
      'auto_select_venue',
      'silent_sqlite_registry_write',
      'external_submit_or_upload',
    ],
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(venueResolutionPacket.warnings || [], 32),
    safety: {
      operatorPacketOnly: true,
      writesRegistry: false,
      writesSqlite: false,
      externalActionPerformed: false,
      choosesVenueAutomatically: false,
    },
    createdAt: createdAt || null,
  };
  return {
    ...packet,
    venueResolutionOperatorPacketHash: hashPaperRecord('VenueResolutionOperatorPacket', packet),
  };
}

export function buildSourceAdaptationPacket({
  paperTask,
  submissionIntent = null,
  sourceWorkspace = null,
  texCandidates = [],
  pdfCandidates = [],
  codeCandidates = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('SourceAdaptationPacket requires paperTask');
  const normalizedTex = (texCandidates || []).slice(0, 32).map((candidate, index) => ({
    id: normalizedId(candidate.id, `${paperTask.paperId}:tex:${index + 1}`),
    path: normalizeText(candidate.path || '') || null,
    filename: normalizeText(candidate.filename || '') || null,
    role: normalizeText(candidate.role || 'tex_candidate') || 'tex_candidate',
    hash: normalizeText(candidate.hash || '') || null,
    score: Number.isFinite(Number(candidate.score)) ? Number(candidate.score) : 0,
    reason: normalizeText(candidate.reason || '') || null,
  }));
  const normalizedPdfs = (pdfCandidates || []).slice(0, 16).map((candidate, index) => ({
    id: normalizedId(candidate.id, `${paperTask.paperId}:pdf:${index + 1}`),
    path: normalizeText(candidate.path || '') || null,
    filename: normalizeText(candidate.filename || '') || null,
    hash: normalizeText(candidate.hash || '') || null,
    sizeBytes: Number.isFinite(Number(candidate.sizeBytes)) ? Number(candidate.sizeBytes) : null,
  }));
  const normalizedCode = (codeCandidates || []).slice(0, 32).map((candidate, index) => ({
    id: normalizedId(candidate.id, `${paperTask.paperId}:code:${index + 1}`),
    path: normalizeText(candidate.path || '') || null,
    filename: normalizeText(candidate.filename || '') || null,
    hash: normalizeText(candidate.hash || '') || null,
  }));
  const blockers = [];
  const warnings = [];
  if (!sourceWorkspace) blockers.push('source_workspace_missing');
  if (!normalizedTex.length) blockers.push('main_tex_candidate_missing');
  if (normalizedPdfs.length && !normalizedTex.length) warnings.push('pdf_present_without_tex_source');
  if (normalizedCode.length && !normalizedTex.length) warnings.push('code_project_present_without_manuscript_source');
  const packet = {
    version: PAPER_CORE_VERSION,
    kind: 'SourceAdaptationPacket',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    title: paperTask.title,
    status: blockers.length
      ? 'manual_source_decision_required'
      : 'main_tex_candidate_review_required',
    submissionIntent: submissionIntent || null,
    sourceWorkspace: normalizeText(sourceWorkspace) || null,
    texCandidateCount: normalizedTex.length,
    pdfCandidateCount: normalizedPdfs.length,
    codeCandidateCount: normalizedCode.length,
    texCandidates: normalizedTex,
    pdfCandidates: normalizedPdfs,
    codeCandidates: normalizedCode,
    recommendedOutcome: normalizedTex.length
      ? 'operator_select_main_tex'
      : 'operator_supply_source_or_mark_non_submission_archive',
    decisionOptions: [
      'select_main_tex',
      'supply_missing_manuscript_source',
      'mark_non_submission_archive',
      'keep_pending_manual_source_decision',
    ],
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(warnings, 32),
    safety: {
      writesSource: false,
      synthesizesMainTex: false,
      externalActionPerformed: false,
      choosesEntryPointAutomatically: false,
    },
    createdAt: createdAt || null,
  };
  return { ...packet, sourceAdaptationPacketHash: hashPaperRecord('SourceAdaptationPacket', packet) };
}

export function buildSourceAdaptationOperatorPacket({
  paperTask,
  sourceAdaptationPacket,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !sourceAdaptationPacket?.kind) {
    throw new Error('SourceAdaptationOperatorPacket requires paperTask and sourceAdaptationPacket');
  }
  const blockers = [];
  if (!['manual_source_decision_required', 'main_tex_candidate_review_required'].includes(sourceAdaptationPacket.status)) {
    blockers.push('source_adaptation_packet_not_operator_ready');
  }
  const hasTexCandidates = Number(sourceAdaptationPacket.texCandidateCount || 0) > 0;
  const packet = {
    version: PAPER_CORE_VERSION,
    kind: 'SourceAdaptationOperatorPacket',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: blockers.length
      ? 'source_operator_packet_blocked'
      : (hasTexCandidates ? 'main_tex_selection_ready' : 'source_material_decision_ready'),
    sourceAdaptationPacketHash: sourceAdaptationPacket.sourceAdaptationPacketHash,
    sourceWorkspace: sourceAdaptationPacket.sourceWorkspace || null,
    candidateSummary: {
      texCandidateCount: sourceAdaptationPacket.texCandidateCount || 0,
      pdfCandidateCount: sourceAdaptationPacket.pdfCandidateCount || 0,
      codeCandidateCount: sourceAdaptationPacket.codeCandidateCount || 0,
    },
    requiredOperatorInputs: hasTexCandidates
      ? ['selected_main_tex_path', 'decision_rationale', 'operator_id', 'decision_timestamp']
      : ['source_material_location_or_archive_decision', 'decision_rationale', 'operator_id', 'decision_timestamp'],
    acceptedOutcomes: [
      'select_existing_main_tex',
      'supply_missing_manuscript_source',
      'mark_non_submission_archive',
      'keep_pending_manual_source_decision',
    ],
    acceptanceCriteria: [
      'decision_is_bound_to_source_adaptation_packet_hash',
      'selected_main_tex_exists_and_is_hash_bound',
      'no_synthesized_main_tex_without_separate_authorization',
      'rerun_local_build_package_and_dry_run_after_source_decision',
    ],
    nextCommands: [
      `paper-production-core batch-run --mode source-adapt --paper ${paperTask.paperId} --write-report`,
      `paper-production-core batch-run --mode local-build --paper ${paperTask.paperId}`,
      `paper-production-core batch-run --mode local-package --paper ${paperTask.paperId}`,
    ],
    blockedActions: [
      'synthesize_main_tex',
      'mutate_source_workspace',
      'mark_source_ready_without_hash_bound_main_tex',
    ],
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(sourceAdaptationPacket.warnings || [], 32),
    safety: {
      operatorPacketOnly: true,
      writesSource: false,
      synthesizesMainTex: false,
      externalActionPerformed: false,
      choosesEntryPointAutomatically: false,
    },
    createdAt: createdAt || null,
  };
  return {
    ...packet,
    sourceAdaptationOperatorPacketHash: hashPaperRecord('SourceAdaptationOperatorPacket', packet),
  };
}
