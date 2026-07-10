const RETIREMENTS = [
  {
    sourcePath: 'paperctl_modules/decision_points.py',
    publicSymbols: [
      'decision_point_records',
      'decision_point_by_id',
      'validate_decision_point_record',
      'decision_point_summary',
      'decision_coverage_items',
      'decision_coverage_summary',
    ],
    disposition: 'retired_generated_control_evidence_surface',
    reason: 'Generic decision-catalog reporting is not a venue-resolution runtime dependency.',
  },
  {
    sourcePath: 'paperctl_modules/paper_production_final_settlement_gate.py',
    publicSymbols: ['build_final_settlement_gate', 'markdown'],
    disposition: 'retired_generated_control_evidence_surface',
    reason: 'The legacy final-settlement report is outside the hepta-paper submission control plane.',
  },
  {
    sourcePath: 'paperctl_modules/paper_production_operator_drop_intake_preflight.py',
    publicSymbols: [
      'build_operator_drop_intake_field_fill_row_workbook_expand_preflight',
      'build_operator_drop_intake_field_fill_row_workbook_operator_fill_apply_preflight',
      'build_operator_drop_intake_field_fill_merge_preflight',
      'build_operator_drop_intake_preflight',
    ],
    disposition: 'retired_generated_control_evidence_surface',
    reason: 'CSV operator-drop intake workbooks are not accepted as venue decisions or hepta-native authority.',
  },
  {
    sourcePath: 'paperctl_modules/paper_production_referee_repair_packet_material_inbox_readiness_capstone.py',
    publicSymbols: ['build_referee_repair_packet_material_inbox_readiness_capstone', 'markdown'],
    disposition: 'retired_generated_control_evidence_surface',
    reason: 'The generated legacy readiness report does not select a venue and is not consumed by hepta-paper.',
  },
  {
    sourcePath: 'paperctl_modules/paper_production_referee_repair_packet_readiness_capstone.py',
    publicSymbols: ['build_referee_repair_packet_readiness_capstone', 'markdown'],
    disposition: 'retired_generated_control_evidence_surface',
    reason: 'The generated packet-readiness report does not select a venue and is not consumed by hepta-paper.',
  },
  {
    sourcePath: 'paperctl_modules/paper_production_runner_readiness_gate.py',
    publicSymbols: [
      'build_runner_readiness_gate',
      'runner_readiness_markdown',
      'runner_readiness_report_copy',
    ],
    disposition: 'retired_generated_control_evidence_surface',
    reason: 'The legacy runner gate is superseded by fail-closed hepta preflight gates, not venue scoring.',
  },
];

export const VENUE_RESOLVE_EXPLICIT_RETIREMENTS = Object.freeze(
  RETIREMENTS.map((entry) => Object.freeze({
    ...entry,
    publicSymbols: Object.freeze([...entry.publicSymbols]),
  })),
);

export function venueResolveRetirementDisposition(sourcePath) {
  return VENUE_RESOLVE_EXPLICIT_RETIREMENTS.find((entry) => entry.sourcePath === sourcePath) || null;
}
