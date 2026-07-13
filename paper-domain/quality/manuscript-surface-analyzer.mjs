import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function lines(source, pattern, kind) {
  return String(source || '').split(/\r?\n/).flatMap((text, index) => pattern.test(text) ? [{ kind, line: index + 1, text: text.trim().slice(0, 500) }] : []);
}

export function analyzeManuscriptSurface({ manuscriptText = '', proofStatusText = '', evidenceManifestText = '' } = {}) {
  const claims = lines(manuscriptText, /\\begin\{(?:theorem|lemma|proposition|corollary)\}|\b(?:we (?:claim|prove|show)|our (?:result|theorem))\b/i, 'claim');
  const proofObligations = lines(`${manuscriptText}\n${proofStatusText}`, /still\s+open|remaining\s+work|proof\s+(?:sketch|skeleton)|conditional\s+proof/i, 'proof_obligation');
  const evidenceReferences = lines(`${manuscriptText}\n${evidenceManifestText}`, /(?:sha256:|evidence|artifact|receipt|dataset|experiment)/i, 'evidence_reference');
  const payload = { version: 1, kind: 'ManuscriptSurfaceAnalysis', claimCount: claims.length, proofObligationCount: proofObligations.length, evidenceReferenceCount: evidenceReferences.length, claims, proofObligations, evidenceReferences, sourceMutationPerformed: false };
  return Object.freeze({ ...payload, manuscriptSurfaceAnalysisHash: hashRecord('ManuscriptSurfaceAnalysis', payload) });
}
