export const ANALYSIS_SCIENTIFIC_VERDICTS = Object.freeze(['positive', 'negative', 'inconclusive']);

function unique(values) {
  return [...new Set(values)];
}

export function deriveAnalysisScientificOutcome(hypotheses, { powerSatisfied }) {
  const findings = [];
  if (!powerSatisfied) {
    findings.push('analysis_predeclared_power_design_unsatisfied');
    findings.push('analysis_independent_unit_count_insufficient');
  }
  const evaluated = hypotheses.map((row) => {
    const uncertaintyReasons = [
      ...(!powerSatisfied ? ['analysis_independent_unit_count_insufficient'] : []),
      ...(!row.assumptionAccepted ? [`analysis_assumption_diagnostic_failed:${row.hypothesisId}`] : []),
    ];
    if (row.acceptanceRequired) findings.push(...uncertaintyReasons);
    if (row.acceptanceRequired && !row.sensitivityAccepted) {
      findings.push(`analysis_outlier_sensitivity_failed:${row.hypothesisId}`);
    }
    const scientificVerdict = uncertaintyReasons.length
      ? 'inconclusive'
      : row.accepted ? 'positive' : 'negative';
    if (row.acceptanceRequired && scientificVerdict === 'negative') {
      findings.push(`analysis_confirmatory_hypothesis_not_supported:${row.hypothesisId}`);
    }
    return Object.freeze({ ...row, scientificVerdict, scientificUncertaintyReasons: Object.freeze(uncertaintyReasons) });
  });
  const required = evaluated.filter((row) => row.acceptanceRequired);
  const verdict = required.some((row) => row.scientificVerdict === 'inconclusive')
    ? 'inconclusive'
    : required.every((row) => row.scientificVerdict === 'positive') ? 'positive' : 'negative';
  return Object.freeze({ hypotheses: Object.freeze(evaluated), verdict, findings: Object.freeze(unique(findings)) });
}
