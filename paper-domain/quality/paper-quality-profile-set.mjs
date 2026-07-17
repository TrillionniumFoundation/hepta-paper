const QUALITY_PROFILE_NAMES = new Set([
  'theorem_or_proof',
  'formal_theorem_or_proof',
  'empirical_or_experiment',
  'systems_or_artifact',
  'survey_or_position',
  'external_data_or_human_subjects',
]);

function tokens(value) {
  if (Array.isArray(value)) return value.flatMap(tokens);
  return String(value ?? '').split(/[,+]/);
}

export function normalizePaperQualityProfiles(value, {
  languages = [],
  inferFromPaper = false,
  empiricalEvidenceRequested = false,
} = {}) {
  const normalizedLanguages = [...new Set(languages.map((language) => String(language).trim().toLowerCase()).filter(Boolean))];
  const profiles = [];
  const add = (candidate) => {
    const normalized = String(candidate ?? '').trim();
    if (!normalized) return;
    const canonical = normalized === 'theorem_or_proof' && normalizedLanguages.includes('lean')
      ? 'formal_theorem_or_proof'
      : normalized;
    if (!QUALITY_PROFILE_NAMES.has(canonical)) throw new Error(`campaign_paper_quality_profile_unknown:${normalized}`);
    if (!profiles.includes(canonical)) profiles.push(canonical);
  };
  tokens(value).forEach(add);
  if (inferFromPaper && normalizedLanguages.includes('lean')) add('formal_theorem_or_proof');
  if (inferFromPaper && empiricalEvidenceRequested) add('empirical_or_experiment');
  return Object.freeze(profiles);
}

export function canonicalPaperQualityProfile(value, options = {}) {
  return normalizePaperQualityProfiles(value, options)[0] || null;
}
