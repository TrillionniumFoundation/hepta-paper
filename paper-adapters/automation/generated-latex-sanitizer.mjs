import fs from 'node:fs';
import path from 'node:path';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';

function protectLatexComments(source) {
  const comments = [];
  let tokenPrefix = '\uE000HEPTA-COMMENT-';
  while (source.includes(tokenPrefix)) tokenPrefix += 'X';
  let masked = '';
  let cursor = 0;
  while (cursor < source.length) {
    const newline = source.indexOf('\n', cursor);
    const lineEnd = newline < 0 ? source.length : newline;
    const line = source.slice(cursor, lineEnd);
    let commentOffset = -1;
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] !== '%') continue;
      let precedingBackslashes = 0;
      for (let previous = index - 1; previous >= 0 && line[previous] === '\\'; previous -= 1) {
        precedingBackslashes += 1;
      }
      if (precedingBackslashes % 2 === 0 && !/\d/.test(line[index - 1] || '')) {
        commentOffset = index;
        break;
      }
    }
    if (commentOffset < 0) {
      masked += line;
    } else {
      const token = `${tokenPrefix}${comments.length.toString(36)}\uE001`;
      comments.push(Object.freeze({ token, content: line.slice(commentOffset) }));
      masked += `${line.slice(0, commentOffset)}${token}`;
    }
    if (newline >= 0) masked += '\n';
    cursor = newline < 0 ? source.length : newline + 1;
  }
  return Object.freeze({
    masked,
    restore(value) {
      let restored = String(value);
      for (const comment of comments) {
        const first = restored.indexOf(comment.token);
        if (first < 0 || restored.indexOf(comment.token, first + comment.token.length) >= 0) {
          throw new Error('generated_latex_comment_protection_token_invalid');
        }
        restored = `${restored.slice(0, first)}${comment.content}${restored.slice(first + comment.token.length)}`;
      }
      if (restored.includes(tokenPrefix)) {
        throw new Error('generated_latex_comment_protection_token_residual');
      }
      return restored;
    },
  });
}

export function sanitizeGeneratedLatex({ workspacePath, manuscriptPath } = {}) {
  const workspace = path.resolve(workspacePath || '');
  const manuscript = path.resolve(workspace, manuscriptPath || 'main.tex');
  if (path.isAbsolute(manuscriptPath || '') || !isPathWithin(workspace, manuscript)) {
    throw new Error('generated latex manuscript must stay inside workspace');
  }
  const before = fs.readFileSync(manuscript, 'utf8');
  let literalNewlineReplacements = 0;
  let tableRowTerminatorReplacements = 0;
  let markdownBoldReplacements = 0;
  let markdownInlineCodeReplacements = 0;
  let missingPackageInsertions = 0;
  let jsonControlEscapeReplacements = 0;
  let textttSpecialCharacterEscapes = 0;
  let uppercaseIdentifierUnderscoreEscapes = 0;
  let numericPercentEscapes = 0;
  let inlineMathBackslashCollapses = 0;
  let invalidSectionEnvironmentClosuresRemoved = 0;
  let unterminatedTextStyleClosuresInserted = 0;
  let orphanTrailingMathDelimitersRemoved = 0;
  const commentProtection = protectLatexComments(before);
  let after = commentProtection.masked.replace(/\\n(?=\s*\\hline)/g, () => {
    tableRowTerminatorReplacements += 1;
    return '\\\\\n';
  });
  after = after.replace(/\\n(?=[^a-z@]|$)/g, () => {
    literalNewlineReplacements += 1;
    return '\n';
  });
  const jsonBackspaceCommand = new RegExp(
    `${String.fromCharCode(8)}(?=(?:ar|egin|eta)\\b)`,
    'g',
  );
  after = after.replace(jsonBackspaceCommand, () => {
    jsonControlEscapeReplacements += 1;
    return '\\b';
  });
  after = after.replace(/\t(?=(?:ext(?:bf|it|tt|sc)?|imes|heta|au)\b)/g, () => {
    jsonControlEscapeReplacements += 1;
    return '\\t';
  });
  after = after.replace(/\f(?=rac\b)/g, () => {
    jsonControlEscapeReplacements += 1;
    return '\\f';
  });
  after = after.replace(/`([^`\n]+)`/g, (_match, content) => {
    markdownInlineCodeReplacements += 1;
    return `\\texttt{${content}}`;
  });
  after = after.replace(/\\texttt\{([^{}\n]*)\}/g, (_match, content) => {
    const escaped = content.replace(/(?<!\\)([_#%&])/g, (character) => {
      textttSpecialCharacterEscapes += 1;
      return `\\${character}`;
    });
    return `\\texttt{${escaped}}`;
  });
  after = after.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, (identifier) => identifier.replace(
    /_/g,
    () => {
      uppercaseIdentifierUnderscoreEscapes += 1;
      return '\\_';
    },
  ));
  after = after.replace(/(?<=\d)(?<!\\)%/g, () => {
    numericPercentEscapes += 1;
    return '\\%';
  });
  after = after.replace(
    /\\(textbf|textit|texttt|emph)\{([^{}\n]*?)(?=\\end\{(?:itemize|enumerate|document)\})/g,
    (_match, command, content) => {
      unterminatedTextStyleClosuresInserted += 1;
      return `\\${command}{${content}}`;
    },
  );
  after = after.split('\n').map((line) => {
    const dollarCount = (line.match(/(?<!\\)\$/g) || []).length;
    if (dollarCount % 2 === 1 && /(?<!\\)\$\s*$/.test(line)) {
      orphanTrailingMathDelimitersRemoved += 1;
      return line.replace(/(?<!\\)\$\s*$/, '').trimEnd();
    }
    return line;
  }).join('\n');
  after = after.replace(/\$([^$\n]*)\$/g, (match, content) => {
    const normalized = content.replace(/\\\\(?=[A-Za-z@])/g, () => {
      inlineMathBackslashCollapses += 1;
      return '\\';
    });
    return normalized === content ? match : `$${normalized}$`;
  });
  after = after.replace(/^\s*\\end\{(?:sub)*section\}\s*$/gm, () => {
    invalidSectionEnvironmentClosuresRemoved += 1;
    return '';
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
  after = commentProtection.restore(after);
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
    markdownInlineCodeReplacements,
    missingPackageInsertions,
    jsonControlEscapeReplacements,
    textttSpecialCharacterEscapes,
    uppercaseIdentifierUnderscoreEscapes,
    numericPercentEscapes,
    inlineMathBackslashCollapses,
    invalidSectionEnvironmentClosuresRemoved,
    unterminatedTextStyleClosuresInserted,
    orphanTrailingMathDelimitersRemoved,
    beforeHash: hashBytes(before),
    afterHash: hashBytes(after),
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, generatedLatexSanitizerReceiptHash: hashRecord('GeneratedLatexSanitizerReceipt', payload) });
}
