import fs from 'node:fs';
import path from 'node:path';
import { evaluateTheoremManuscriptReadiness } from '../../paper-domain/quality/theorem-manuscript-readiness-policy.mjs';
import { analyzeManuscriptSurface } from '../../paper-domain/quality/manuscript-surface-analyzer.mjs';

function firstFile(workspace, candidates) {
  return candidates.find((candidate) => fs.existsSync(path.join(workspace, candidate)) && fs.statSync(path.join(workspace, candidate)).isFile()) || null;
}

function workspaceFile(workspace, relative) {
  const absolute = path.resolve(workspace, relative);
  if (absolute !== workspace && !absolute.startsWith(`${workspace}${path.sep}`)) return null;
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return null;
  const realWorkspace = fs.realpathSync(workspace);
  const real = fs.realpathSync(absolute);
  return real.startsWith(`${realWorkspace}${path.sep}`) ? absolute : null;
}

function latexCorpus(workspace, manuscriptPath) {
  const visited = new Set();
  const graph = [];
  const read = (relative) => {
    const normalized = relative.endsWith('.tex') ? relative : `${relative}.tex`;
    const absolute = workspaceFile(workspace, normalized);
    if (!absolute) return '';
    const canonical = path.relative(workspace, absolute).replace(/\\/g, '/');
    if (visited.has(canonical)) return '';
    visited.add(canonical);
    const text = fs.readFileSync(absolute, 'utf8');
    const withoutComments = text.replace(/(^|[^\\])%.*$/gm, '$1');
    const includes = [...withoutComments.matchAll(/\\(?:input|include)\s*\{([^}]+)\}/g)]
      .map((match) => path.join(path.dirname(canonical), match[1].trim()).replace(/\\/g, '/'));
    graph.push({ path: canonical, includes: [...includes] });
    return [text, ...includes.map(read)].join('\n');
  };
  return { text: read(manuscriptPath), files: [...visited].sort(), graph };
}

function supportingFiles(workspace, prefix) {
  const out = [];
  const walk = (relative = '') => {
    for (const entry of fs.readdirSync(path.join(workspace, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && new RegExp(`^${prefix}`, 'i').test(entry.name)) out.push(child.replace(/\\/g, '/'));
    }
  };
  walk();
  return out.sort();
}

export function runTheoremManuscriptReadinessCheck({ workspacePath, manuscriptPath = 'main.tex', paperId = null, profile = null } = {}) {
  const workspace = path.resolve(workspacePath || '');
  const manuscript = path.resolve(workspace, manuscriptPath);
  if (!manuscript.startsWith(`${workspace}${path.sep}`) || !fs.existsSync(manuscript)) throw new Error('existing manuscript inside workspace is required');
  const proofStatusPath = firstFile(workspace, ['proof_status.md', 'PROOF_STATUS.md']);
  const evidenceManifestPath = firstFile(workspace, ['evidence_manifest.md', 'EVIDENCE_MANIFEST.md']);
  const corpus = latexCorpus(workspace, manuscriptPath);
  const proofStatusText = proofStatusPath ? fs.readFileSync(path.join(workspace, proofStatusPath), 'utf8') : '';
  const evidenceManifestText = evidenceManifestPath ? fs.readFileSync(path.join(workspace, evidenceManifestPath), 'utf8') : '';
  const manuscriptSurfaceAnalysis = analyzeManuscriptSurface({ manuscriptText: corpus.text, proofStatusText, evidenceManifestText });
  return evaluateTheoremManuscriptReadiness({
    paperId,
    profile,
    manuscriptText: corpus.text,
    manuscriptPaths: corpus.files,
    manuscriptIncludeGraph: corpus.graph,
    proofStatusText,
    evidenceManifestText,
    manuscriptSurfaceAnalysis,
    proofStatusPath,
    evidenceManifestPath,
    appendixPaths: supportingFiles(workspace, 'appendix'),
    supplementPaths: [...supportingFiles(workspace, 'supplement'), ...supportingFiles(workspace, 'supplementary')],
  });
}
