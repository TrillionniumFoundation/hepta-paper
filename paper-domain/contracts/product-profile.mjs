import { PAPER_CORE_VERSION } from './primitives.mjs';

export const PAPER_CHANNEL_IDS = Object.freeze({
  PAPER_FACTORY: 'paper_factory',
});
export const PAPER_PRODUCT_IDS = Object.freeze({
  MANUSCRIPT_PRODUCTION: 'paper_manuscript_production',
});

export const PAPER_OUTPUT_MODES = Object.freeze({
  MANUSCRIPT_PACKAGE: 'manuscript_package',
  VENUE_HANDOFF: 'venue_handoff',
});

export const PAPER_ACTIONS = Object.freeze({
  INVENTORY_SCAN: 'paper.inventory.scan',
  PROPOSAL_GENERATE: 'paper.proposal.generate',
  LATEX_BUILD: 'paper.latex.build',
  SOURCE_PACKAGE: 'paper.source.package',
  RESEARCH_VERIFY: 'paper.research.verify',
  REFEREE_REVISE: 'paper.referee.revise',
  VENUE_DRY_RUN: 'paper.venue.dry_run',
  REVIEWED_SUBMIT: 'paper.venue.reviewed_submit',
});

export const PAPER_WORKFLOW_STAGES = Object.freeze({
  INVENTORY_READY: 'inventory_ready',
  SOURCE_READY: 'source_ready',
  BUILD_READY: 'build_ready',
  RESEARCH_VERIFIED: 'research_verified',
  PACKAGE_READY: 'package_ready',
  READINESS_GATE_READY: 'readiness_gate_ready',
  HANDOFF_READY: 'handoff_ready',
  SUBMITTED_VERIFIED: 'submitted_verified',
  BLOCKED: 'blocked',
});

export const PAPER_PRODUCT_PROFILE = Object.freeze({
  version: PAPER_CORE_VERSION,
  productLineId: PAPER_PRODUCT_IDS.MANUSCRIPT_PRODUCTION,
  workflowId: 'paper_production',
  label: 'Paper production',
  defaultOutputMode: PAPER_OUTPUT_MODES.MANUSCRIPT_PACKAGE,
  channelPolicy: {
    supportedChannels: [PAPER_CHANNEL_IDS.PAPER_FACTORY],
    externalSubmissionBlockedUntilReviewedApproval: true,
    directExternalActionsBlocked: [PAPER_ACTIONS.REVIEWED_SUBMIT],
  },
  requiredGates: [
    'paper_inventory',
    'source_workspace_binding',
    'latex_build_or_existing_pdf',
    'typed_claim_scope_contract',
    'typed_proof_obligation_contract',
    'typed_evidence_matrix_contract',
    'reproducibility_contract',
    'research_claim_evidence_scan',
    'source_package_hash',
    'venue_submission_plan',
    'fresh_venue_evidence_bundle',
    'submission_replay_guard',
    'fresh_local_dry_run_receipt',
    'explicit_reviewed_submit_approval',
  ],
  qualityGates: [
    'main_tex_discovered',
    'compiled_pdf_or_build_plan',
    'source_zip_or_package_plan',
    'claim_evidence_or_manual_review',
    'venue_metadata_resolved',
  ],
  safety: {
    importsOldControlPlane: false,
    executesExternalSubmission: false,
    writesInsideLegacyPaperFactory: false,
  },
});
