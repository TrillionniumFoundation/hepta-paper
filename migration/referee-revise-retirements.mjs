const CAPSTONE_SYMBOLS = {
  'paperctl_modules/paper_production_referee_repair_closure_prerequisite_remediation_matrix_capstone.py': [
    'build_referee_repair_closure_prerequisite_remediation_matrix_capstone', 'markdown',
  ],
  'paperctl_modules/paper_production_referee_repair_contract_fulfillment_gate_capstone.py': [
    'build_referee_repair_contract_fulfillment_gate_capstone', 'markdown',
  ],
  'paperctl_modules/paper_production_referee_repair_executable_packet_spec_checklist_capstone.py': [
    'build_referee_repair_executable_packet_spec_checklist_capstone', 'markdown',
  ],
  'paperctl_modules/paper_production_referee_repair_packet_material_evidence_candidate_validation_capstone.py': [
    'build_referee_repair_packet_material_evidence_candidate_validation_capstone', 'markdown',
  ],
  'paperctl_modules/paper_production_referee_repair_packet_material_promotion_quarantine_capstone.py': [
    'build_referee_repair_packet_material_promotion_quarantine_capstone', 'markdown',
  ],
  'paperctl_modules/paper_production_referee_repair_packet_material_validation_failure_matrix_capstone.py': [
    'build_referee_repair_packet_material_validation_failure_matrix_capstone', 'markdown',
  ],
  'paperctl_modules/paper_production_referee_repair_packet_materialization_intake_capstone.py': [
    'build_referee_repair_packet_materialization_intake_capstone', 'markdown',
  ],
  'paperctl_modules/paper_production_referee_repair_packet_promotion_evidence_release_separation_ledger_capstone.py': [
    'build_referee_repair_packet_promotion_evidence_release_separation_ledger_capstone', 'markdown',
  ],
  'paperctl_modules/paper_production_referee_repair_packet_promotion_review_authorization_dry_run_ledger_capstone.py': [
    'build_referee_repair_packet_promotion_review_authorization_dry_run_ledger_capstone', 'markdown',
  ],
  'paperctl_modules/paper_production_referee_repair_packet_promotion_review_decision_intake_guard_capstone.py': [
    'expected_manual_promotion_review_decision_path',
    'build_referee_repair_packet_promotion_review_decision_intake_guard_capstone',
    'markdown',
  ],
  'paperctl_modules/paper_production_referee_repair_packet_promotion_review_intake_quarantine_capstone.py': [
    'expected_promotion_review_authorization_path',
    'build_referee_repair_packet_promotion_review_intake_quarantine_capstone',
    'markdown',
  ],
  'paperctl_modules/paper_production_referee_repair_packet_repair_evidence_release_request_envelope_nonclosure_preflight_capstone.py': [
    'expected_repair_evidence_release_request_path',
    'expected_final_nonclosure_authorization_path',
    'build_referee_repair_packet_repair_evidence_release_request_envelope_nonclosure_preflight_capstone',
    'markdown',
  ],
  'paperctl_modules/paper_production_referee_repair_packet_skeleton_inventory_currentness_capstone.py': [
    'build_referee_repair_packet_skeleton_inventory_currentness_capstone', 'markdown',
  ],
  'paperctl_modules/paper_production_referee_repair_request_packet_contract_lint_capstone.py': [
    'build_referee_repair_request_packet_contract_lint_capstone', 'markdown',
  ],
  'paperctl_modules/paper_production_referee_repair_routing_capstone.py': [
    'build_referee_repair_routing_capstone', 'markdown',
  ],
  'paperctl_modules/paper_production_referee_repair_typed_evidence_contract_matrix.py': [
    'build_referee_repair_typed_evidence_contract_matrix', 'markdown', 'report_copy',
  ],
  'paperctl_modules/paper_production_referee_repair_work_order_capstone.py': [
    'build_referee_repair_work_order_capstone', 'markdown',
  ],
  'paperctl_modules/paper_production_referee_revise_loop_capstone.py': [
    'build_referee_revise_loop_capstone', 'markdown',
  ],
};

export const REFEREE_REVISE_EXPLICIT_RETIREMENTS = Object.freeze(
  Object.entries(CAPSTONE_SYMBOLS).map(([sourcePath, publicSymbols]) => Object.freeze({
    sourcePath,
    publicSymbols: Object.freeze([...publicSymbols]),
    disposition: 'retired_generated_referee_control_evidence_surface',
    reason: 'Generated legacy report/control evidence is not an executable repair authority or a hepta-native state transition.',
  })),
);

export function refereeReviseRetirementDisposition(sourcePath) {
  return REFEREE_REVISE_EXPLICIT_RETIREMENTS.find((entry) => entry.sourcePath === sourcePath) || null;
}
