import { normalizeText } from '../../workflow-kernel/runtime/text-utils.mjs';
import { AGENT_REPAIR_BEGIN, AGENT_REPAIR_END } from './repair-shared.mjs';

export function sourceLocatorPath(locator = '') {
  const text = normalizeText(locator);
  if (!text) return null;
  return text.replace(/:\d+(?::\d+)?$/, '');
}

function latexEscapeText(value = '') {
  return normalizeText(value)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([#$%&_{}])/g, '\\$1')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}');
}

function stableIssueSummary(issue = {}, index = 0) {
  const risk = normalizeText(issue.riskClass || 'referee repair');
  const fix = normalizeText(issue.proposedFix || issue.objection || 'repair requested');
  const verification = normalizeText(issue.verification || '');
  return [
    `\\item \\textbf{${latexEscapeText(risk)}} (${latexEscapeText(issue.id || `issue-${index + 1}`)}): ${latexEscapeText(fix)}`,
    verification ? ` Verification: ${latexEscapeText(verification)}` : '',
  ].join('');
}

export function repairNotesLatex({ paperId, openIssues = [] } = {}) {
  const proofReady = openIssues.some((issue) => /proof|theorem|claim-boundary/i.test([
    issue.riskClass,
    issue.proposedFix,
    issue.objection,
  ].join(' ')));
  const terminologyReady = openIssues.some((issue) => /translation|terminology|caption|semantic|top-level/i.test([
    issue.riskClass,
    issue.proposedFix,
    issue.objection,
  ].join(' ')));
  return [
    '',
    AGENT_REPAIR_BEGIN,
    '\\section*{Agent Referee Repair Notes}',
    `This agent-applied repair records the local, evidence-bounded response to the open referee queue for \\texttt{${latexEscapeText(paperId)}}. It does not introduce new empirical claims, theorem claims, or venue-submission readiness beyond the artifacts and claim boundaries already present in the source package.`,
    '',
    proofReady ? [
      '\\paragraph{Proof and claim-boundary repair.}',
      'Any theorem-level, proof-sketch, or certificate-dependent language remains conditional on the listed local proof obligations, evidence manifests, and post-repair verification. Claims without a recorded certificate are treated as assumptions, limitations, or repair targets rather than submit-ready conclusions.',
    ].join('\n') : '',
    terminologyReady ? [
      '\\paragraph{Terminology and design-consistency repair.}',
      'Terminology, abstract wording, captions, metrics, and top-level contribution framing are read against the local evidence anchors only. Where an anchor does not entail the broader wording, the intended reading is narrowed to the executed artifact, stated protocol, and documented limitation.',
    ].join('\n') : '',
    '\\paragraph{Open referee items addressed by this repair pass.}',
    '\\begin{itemize}',
    ...openIssues.slice(0, 16).map(stableIssueSummary),
    '\\end{itemize}',
    '\\paragraph{Post-repair gate.}',
    'This source mutation is not a final referee-resolution proof by itself. The repair still requires a fresh build, package rewrite, research/evidence recheck, issue-resolution proof, and repair reconciliation before any issue may be closed or submission readiness advanced.',
    AGENT_REPAIR_END,
    '',
  ].filter((line) => line !== '').join('\n');
}

export function insertRepairNotes(original = '', notes = '') {
  if (original.includes(AGENT_REPAIR_BEGIN)) return null;
  const marker = '\\end{document}';
  const index = original.lastIndexOf(marker);
  if (index < 0) {
    return original.endsWith('\n') ? `${original}${notes}\n` : `${original}\n${notes}\n`;
  }
  return `${original.slice(0, index).replace(/\s*$/, '\n\n')}${notes}\n${original.slice(index)}`;
}
