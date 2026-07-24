import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  sanitizeGeneratedLatex,
} from '../../paper-adapters/automation/generated-latex-sanitizer.mjs';

test('generated LaTeX sanitizer converts model newline tokens and table row endings', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-latex-sanitizer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.tex'), '\\begin{tabular}{cc}\nA & B\\n \\hline\n\\end{tabular}\n**Observed**\\nNext \\texttt{data_set.csv} and `Smoke_Benchmark` at 10% noise $\\\\mu$ \u0008ar and HEPTA_EMPIRICAL_CLAIM\\n\\subsection{X}\nbody $\n\\end{subsection}\n\\begin{itemize}\n\\item \\textbf{Specifically *time*.\\end{itemize}\n\\end{document}\n');
  const receipt = sanitizeGeneratedLatex({
    workspacePath: root,
    manuscriptPath: 'main.tex',
  });
  const source = fs.readFileSync(path.join(root, 'main.tex'), 'utf8');
  assert.equal(receipt.tableRowTerminatorReplacements, 1);
  assert.equal(receipt.literalNewlineReplacements, 2);
  assert.equal(receipt.markdownBoldReplacements, 1);
  assert.equal(receipt.markdownInlineCodeReplacements, 1);
  assert.equal(receipt.jsonControlEscapeReplacements, 1);
  assert.equal(receipt.textttSpecialCharacterEscapes, 2);
  assert.equal(receipt.uppercaseIdentifierUnderscoreEscapes, 2);
  assert.equal(receipt.numericPercentEscapes, 1);
  assert.equal(receipt.inlineMathBackslashCollapses, 1);
  assert.equal(receipt.invalidSectionEnvironmentClosuresRemoved, 1);
  assert.equal(receipt.unterminatedTextStyleClosuresInserted, 1);
  assert.equal(receipt.orphanTrailingMathDelimitersRemoved, 1);
  assert.match(source, /A & B\\\\\n \\hline/);
  assert.match(source, /\\textbf\{Observed\}/);
  assert.match(source, /Next \\texttt\{data\\_set\.csv\} and \\texttt\{Smoke\\_Benchmark\} at 10\\% noise \$\\mu\$ \\bar and HEPTA\\_EMPIRICAL\\_CLAIM/);
  assert.match(source, /body\n\n\\begin\{itemize\}/);
  assert.match(source, /\\textbf\{Specifically \*time\*\.\}\\end\{itemize\}/);
  assert.doesNotMatch(source, /\\end\{subsection\}/);
});
