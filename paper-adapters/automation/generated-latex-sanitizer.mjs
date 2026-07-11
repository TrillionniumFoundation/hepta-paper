import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function sha256(text) {
  return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

export function sanitizeGeneratedLatex({ workspacePath, manuscriptPath } = {}) {
  const workspace = path.resolve(workspacePath || '');
  const manuscript = path.resolve(workspace, manuscriptPath || 'main.tex');
  if (path.isAbsolute(manuscriptPath || '') || (manuscript !== workspace && !manuscript.startsWith(`${workspace}${path.sep}`))) {
    throw new Error('generated latex manuscript must stay inside workspace');
  }
  const before = fs.readFileSync(manuscript, 'utf8');
  let literalNewlineReplacements = 0;
  let tableRowTerminatorReplacements = 0;
  let markdownBoldReplacements = 0;
  let missingPackageInsertions = 0;
  let after = before.replace(/\\n(?=\s*\\hline)/g, () => {
    tableRowTerminatorReplacements += 1;
    return '\\\\\n';
  });
  after = after.replace(/\\n(?=\s|\\(?:end|item|begin|section|subsection)|$)/g, () => {
    literalNewlineReplacements += 1;
    return '\n';
  });
  after = after.replace(/\*\*([^*\n]+)\*\*/g, (_match, content) => {
    markdownBoldReplacements += 1;
    return `\\textbf{${content}}`;
  });
  if (/\\text\{/.test(after) && !/\\usepackage(?:\[[^\]]*\])?\{amsmath\}/.test(after)) {
    after = after.replace(/(\\documentclass(?:\[[^\]]*\])?\{[^}]+\}\s*)/, (_match, documentClass) => {
      missingPackageInsertions += 1;
      return `${documentClass}\\usepackage{amsmath}\n`;
    });
  }
  const changed = after !== before;
  if (changed) {
    const temporary = `${manuscript}.hepta-latex-sanitize-${process.pid}.tmp`;
    fs.writeFileSync(temporary, after);
    fs.renameSync(temporary, manuscript);
  }
  const payload = {
    version: 1,
    kind: 'GeneratedLatexSanitizerReceipt',
    manuscriptPath: path.relative(workspace, manuscript).replace(/\\/g, '/'),
    status: changed ? 'generated_latex_sanitized' : 'generated_latex_unchanged',
    changed,
    literalNewlineReplacements,
    tableRowTerminatorReplacements,
    markdownBoldReplacements,
    missingPackageInsertions,
    beforeHash: sha256(before),
    afterHash: sha256(after),
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, generatedLatexSanitizerReceiptHash: hashRecord('GeneratedLatexSanitizerReceipt', payload) });
}
