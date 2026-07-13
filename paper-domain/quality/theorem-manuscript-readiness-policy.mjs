import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const THEOREM_ENVIRONMENT = /\\begin\{(?:theorem|lemma|proposition|corollary|inputcondition)\}/gi;
const PROOF_ENVIRONMENT = /\\begin\{proof\}(?:\[[^\]]*\])?/gi;
const PROOF_SKELETON = /proof\s+sketch|proof\s+skeleton|sketched|remaining\s+work|still\s+open|conditional\s+proof/gi;
const APPENDIX = /\\appendix|\\begin\{appendices\}/i;
const APPENDIX_WAIVER = /appendix\s+waiv|supplement\s+waiv|appendix\/supplement\s+waiv|appendix\s+or\s+supplement\s+waiv/i;
const EVIDENCE_NEGATIVE_TOKENS = [
  'does not prove',
  'does not establish',
  'does not claim',
  'not claim final',
  'supports only',
  'cannot replace',
  'current status: `blocked`',
  'current status: blocked',
];

function matches(source, pattern) {
  return [...String(source || '').matchAll(pattern)].length;
}

function stillOpenRows(source) {
  const rows = [];
  let inSection = false;
  for (const line of String(source || '').split(/\r?\n/)) {
    const value = line.trim();
    if (/^##\s+Still Open\b/i.test(value)) { inSection = true; continue; }
    if (inSection && /^##\s+/.test(value)) break;
    if (!inSection || !value.startsWith('|') || /---/.test(value)) continue;
    const cells = value.slice(1, value.endsWith('|') ? -1 : undefined).split('|').map((cell) => cell.trim());
    if (!cells[0] || /^item$/i.test(cells[0])) continue;
    rows.push(Object.freeze({ item: cells[0], detail: cells[1] || '' }));
  }
  return rows;
}

function negativeEvidenceLines(source) {
  return String(source || '').split(/\r?\n/)
    .filter((line) => EVIDENCE_NEGATIVE_TOKENS.some((token) => line.toLowerCase().includes(token)))
    .map((line) => line.trim()).slice(0, 20);
}

export function evaluateTheoremManuscriptReadiness({
  paperId = null,
  profile = null,
  manuscriptText = '',
  manuscriptPaths = [],
  manuscriptIncludeGraph = [],
  manuscriptSurfaceAnalysis = null,
  proofStatusText = '',
  evidenceManifestText = '',
  proofStatusPath = null,
  evidenceManifestPath = null,
  appendixPaths = [],
  supplementPaths = [],
} = {}) {
  const theoremStatementCount = matches(manuscriptText, THEOREM_ENVIRONMENT);
  const theoremSurfaceRequired = profile === 'theorem_or_proof' || theoremStatementCount > 0;
  const proofEnvironmentCount = matches(manuscriptText, PROOF_ENVIRONMENT);
  const proofSkeletonMarkerCount = matches(`${manuscriptText}\n${proofStatusText}`, PROOF_SKELETON);
  const openProofObligations = stillOpenRows(proofStatusText);
  const evidenceNegativeBoundaryLines = negativeEvidenceLines(evidenceManifestText);
  const corpus = `${manuscriptText}\n${proofStatusText}\n${evidenceManifestText}`;
  const manuscriptQualitySurfaces = Object.freeze({
    limitationsPresent: /\\section\*?\{limitations?\}/i.test(manuscriptText),
    ethicsReviewPresent: /\\section\*?\{(?:ethics|ethical considerations?)\}/i.test(manuscriptText),
    privacyReviewPresent: /\\section\*?\{privacy\}/i.test(manuscriptText),
    dataRightsPresent: /\\section\*?\{(?:data rights|data governance|data availability)\}/i.test(manuscriptText),
  });
  const appendixOrSupplementPresent = APPENDIX.test(manuscriptText)
    || appendixPaths.length > 0 || supplementPaths.length > 0;
  const appendixOrSupplementWaived = APPENDIX_WAIVER.test(corpus);
  const blockers = [];
  if (theoremSurfaceRequired) {
    if (!String(proofStatusText).trim()) blockers.push('theorem_proof_status_missing');
    if (!String(evidenceManifestText).trim()) blockers.push('theorem_evidence_manifest_missing');
    if (theoremStatementCount === 0) blockers.push('theorem_statement_missing');
    if (proofEnvironmentCount === 0) blockers.push('theorem_proof_environment_missing');
    if (proofSkeletonMarkerCount > 0) blockers.push('theorem_proof_skeleton_present');
    if (openProofObligations.length > 0) blockers.push('theorem_open_proof_obligations_present');
    if (!appendixOrSupplementPresent && !appendixOrSupplementWaived) blockers.push('theorem_appendix_or_supplement_missing');
    if (evidenceNegativeBoundaryLines.length > 0) blockers.push('theorem_evidence_manifest_disclaims_support');
  }
  const passed = blockers.length === 0;
  const payload = {
    version: 1,
    kind: 'TheoremManuscriptReadinessPolicyReport',
    paperId,
    profile,
    applicable: theoremSurfaceRequired,
    passed,
    status: !theoremSurfaceRequired
      ? 'theorem_manuscript_readiness_not_applicable'
      : passed ? 'theorem_manuscript_readiness_passed' : 'theorem_manuscript_readiness_blocked',
    theoremStatementCount,
    manuscriptPaths: [...manuscriptPaths],
    manuscriptIncludeGraph: [...manuscriptIncludeGraph],
    manuscriptSurfaceAnalysisHash: manuscriptSurfaceAnalysis?.manuscriptSurfaceAnalysisHash || null,
    proofEnvironmentCount,
    proofSkeletonMarkerCount,
    openProofObligationCount: openProofObligations.length,
    openProofObligations,
    proofStatusPath,
    evidenceManifestPath,
    appendixPaths: [...appendixPaths],
    supplementPaths: [...supplementPaths],
    appendixOrSupplementPresent,
    appendixOrSupplementWaived,
    evidenceNegativeBoundaryCount: evidenceNegativeBoundaryLines.length,
    evidenceNegativeBoundaryLines,
    manuscriptQualitySurfaces,
    blockers,
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, theoremManuscriptReadinessPolicyHash: hashRecord('TheoremManuscriptReadinessPolicyReport', payload) });
}
