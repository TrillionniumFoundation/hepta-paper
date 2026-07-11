import { normalizeText, uniqueStrings } from '../../paper-core/src/runtime/text-utils.mjs';

export const DISCIPLINE_PROFILES = Object.freeze([
  {
    id: 'machine_learning',
    label: 'Machine learning',
    keywords: ['machine learning', 'neurips', 'icml', 'learning', 'neural', 'rl', 'optimization'],
    proposalEmphasis: ['novelty', 'algorithmic contribution', 'experiments', 'ablation', 'reproducibility'],
    defaultSections: ['Introduction', 'Related Work', 'Method', 'Theory or Analysis', 'Experiments', 'Limitations'],
  },
  {
    id: 'statistics',
    label: 'Statistics',
    keywords: ['statistics', 'aos', 'annals of statistics', 'estimator', 'asymptotic', 'inference'],
    proposalEmphasis: ['assumptions', 'identifiability', 'theorem statements', 'proof plan', 'simulation evidence'],
    defaultSections: ['Introduction', 'Model', 'Main Results', 'Proof Sketch', 'Simulations', 'Discussion'],
  },
  {
    id: 'economics_finance',
    label: 'Economics and finance',
    keywords: ['economics', 'finance', 'asset pricing', 'contract', 'equilibrium', 'market'],
    proposalEmphasis: ['economic mechanism', 'identification', 'comparative statics', 'empirical or theoretical support'],
    defaultSections: ['Introduction', 'Model', 'Main Mechanism', 'Results', 'Evidence', 'Implications'],
  },
  {
    id: 'operations_research',
    label: 'Operations research',
    keywords: ['operations research', 'or', 'control', 'queue', 'inventory', 'robust', 'stochastic control'],
    proposalEmphasis: ['modeling primitive', 'policy structure', 'performance guarantee', 'computational validation'],
    defaultSections: ['Introduction', 'Problem Formulation', 'Structural Results', 'Algorithms', 'Experiments', 'Managerial Insights'],
  },
  {
    id: 'mathematics',
    label: 'Mathematics',
    keywords: ['mathematics', 'annals', 'theorem', 'proof', 'lemma', 'geometry', 'analysis'],
    proposalEmphasis: ['precise definitions', 'main theorem', 'proof architecture', 'novel technique'],
    defaultSections: ['Introduction', 'Preliminaries', 'Main Theorem', 'Proof Strategy', 'Proofs', 'Examples'],
  },
]);

export const VENUE_PROFILES = Object.freeze([
  {
    id: 'neurips',
    label: 'NeurIPS',
    keywords: ['neurips', 'nips'],
    requirements: ['clear ML novelty', 'strong experiments or theory', 'reproducibility checklist', 'limitations statement'],
  },
  {
    id: 'aos',
    label: 'Annals of Statistics',
    keywords: ['aos', 'annals of statistics'],
    requirements: ['mathematical rigor', 'statistical contribution', 'complete proof strategy', 'assumption clarity'],
  },
  {
    id: 'or',
    label: 'Operations Research',
    keywords: ['operations research', 'management science', 'or'],
    requirements: ['model relevance', 'theory or algorithmic contribution', 'managerial insight', 'computational evidence'],
  },
  {
    id: 'qje',
    label: 'Quarterly Journal of Economics',
    keywords: ['qje', 'quarterly journal of economics', 'economics', 'political economy'],
    requirements: ['major economics insight', 'credible empirical or theoretical design', 'broad field relevance'],
  },
  {
    id: 'journal_finance',
    label: 'Journal of Finance',
    keywords: ['journal of finance', 'finance', 'asset pricing', 'corporate finance'],
    requirements: ['first-order finance contribution', 'credible empirical or theoretical design', 'clear market relevance'],
  },
  {
    id: 'annals_math',
    label: 'Annals of Mathematics',
    keywords: ['annals of mathematics', 'annals math', 'mathematics', 'pure mathematics'],
    requirements: ['major mathematical theorem', 'complete proof', 'deep novelty'],
  },
  {
    id: 'nature',
    label: 'Nature',
    keywords: ['nature'],
    requirements: ['broad framing', 'high-level novelty', 'clear story', 'strong evidence package'],
  },
  {
    id: 'colt_focs',
    label: 'COLT/FOCS',
    keywords: ['colt', 'focs', 'stoc', 'theory'],
    requirements: ['formal problem statement', 'theorem novelty', 'proof depth', 'positioning against known bounds'],
  },
]);

function tokenText(values = []) {
  return values.map((value) => normalizeText(value).toLowerCase()).filter(Boolean).join(' ');
}

export function pickProfile(profiles, hints, fallbackId) {
  const text = tokenText(hints);
  const tokens = new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
  const scored = profiles.map((profile) => {
    const score = profile.keywords.reduce((sum, keyword) => {
      const normalized = keyword.toLowerCase();
      if (normalized.length <= 4) return sum + (tokens.has(normalized) ? 1 : 0);
      return sum + (text.includes(normalized) ? 1 : 0);
    }, 0);
    return { profile, score };
  }).sort((left, right) => right.score - left.score || left.profile.id.localeCompare(right.profile.id));
  return scored.find((item) => item.score > 0)?.profile
    || profiles.find((profile) => profile.id === fallbackId)
    || profiles[0];
}

export function fallbackVenueIdForDiscipline(profile = {}) {
  if (profile.id === 'statistics') return 'aos';
  if (profile.id === 'operations_research') return 'operations_research';
  if (profile.id === 'mathematics') return 'annals_math';
  if (profile.id === 'economics_finance') return 'qje';
  return 'neurips';
}

export function slugify(value) {
  const slug = normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return slug || 'paper_proposal';
}

function sentence(value) {
  const text = normalizeText(value);
  return text.endsWith('.') ? text : `${text}.`;
}

export function buildDeterministicProposal({ ideaBrief, disciplineProfile, venueProfile }) {
  const title = ideaBrief.title
    || `A ${disciplineProfile.label} Study of ${normalizeText(ideaBrief.idea).slice(0, 80)}`;
  const contributionClaims = uniqueStrings([
    `Define a venue-scoped research question around: ${ideaBrief.idea}`,
    `Establish a ${disciplineProfile.label.toLowerCase()} contribution aligned with ${venueProfile.label}`,
    'Produce a hash-bound evidence, proof, or reproducibility plan before manuscript production',
  ], 8);
  const proofObligations = uniqueStrings([
    ...disciplineProfile.proposalEmphasis
      .filter((item) => /theorem|proof|assumption|guarantee|formal|rigor/i.test(item))
      .map((item) => `Clarify ${item}`),
    'List assumptions and boundary cases before claiming venue readiness',
  ], 8);
  const evidencePlan = uniqueStrings([
    ...disciplineProfile.proposalEmphasis
      .filter((item) => /experiment|evidence|simulation|reproducibility|empirical|validation/i.test(item))
      .map((item) => `Prepare ${item}`),
    ...venueProfile.requirements.map((item) => `Satisfy venue requirement: ${item}`),
  ], 12);
  const requiredArtifacts = uniqueStrings([
    'proposal_review_packet',
    'manuscript_outline',
    'claim_scope_contract',
    'proof_obligation_contract',
    'evidence_matrix_contract',
    'reproducibility_contract',
    'venue_fit_assessment',
  ], 12);
  return {
    tentativeTitle: title,
    abstract: sentence(`${title} proposes to develop ${ideaBrief.idea} for ${venueProfile.label}, with an initial production plan focused on ${disciplineProfile.proposalEmphasis.slice(0, 3).join(', ')}`),
    centralThesis: sentence(`The central thesis is that ${ideaBrief.idea} can be turned into a ${disciplineProfile.label.toLowerCase()} paper if its claims, evidence, and venue fit pass explicit review gates`),
    contributionClaims,
    expectedStructure: disciplineProfile.defaultSections,
    proofObligations,
    evidencePlan,
    reproducibilityPlan: [
      'Record all source, data, code, proof, and package artifacts by hash',
      'Require a reproducibility contract before local dry-run submission readiness',
    ],
    venueFit: `${venueProfile.label}: ${venueProfile.requirements.join('; ')}`,
    noveltyRisk: 'requires_literature_and_competing_claim_scan',
    feasibilityRisk: 'requires_operator_review_before_paper_task_creation',
    requiredArtifacts,
    warnings: ideaBrief.materials.length ? [] : ['initial_materials_not_supplied'],
  };
}

