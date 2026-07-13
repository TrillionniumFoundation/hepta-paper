import { hashBytes } from '../../workflow-kernel/record-hash.mjs';

export function stripLeanComments(source) {
  const input = String(source || '');
  let output = '';
  let blockDepth = 0;
  let lineComment = false;
  let string = false;
  for (let index = 0; index < input.length; index += 1) {
    const pair = input.slice(index, index + 2);
    if (lineComment) {
      if (input[index] === '\n') { lineComment = false; output += '\n'; } else output += ' ';
      continue;
    }
    if (blockDepth > 0) {
      if (pair === '/-') { blockDepth += 1; output += '  '; index += 1; continue; }
      if (pair === '-/') { blockDepth -= 1; output += '  '; index += 1; continue; }
      output += input[index] === '\n' ? '\n' : ' ';
      continue;
    }
    if (!string && pair === '--') { lineComment = true; output += '  '; index += 1; continue; }
    if (!string && pair === '/-') { blockDepth = 1; output += '  '; index += 1; continue; }
    if (input[index] === '"' && input[index - 1] !== '\\') string = !string;
    output += input[index];
  }
  return output;
}

export function normalizeLeanType(value) {
  let type = String(value || '').replace(/->/g, '→').replace(/\s+/g, ' ').trim();
  while (type.startsWith('(') && type.endsWith(')')) {
    let depth = 0;
    let wraps = true;
    for (let index = 0; index < type.length; index += 1) {
      if (type[index] === '(') depth += 1;
      if (type[index] === ')') depth -= 1;
      if (depth === 0 && index < type.length - 1) { wraps = false; break; }
    }
    if (!wraps) break;
    type = type.slice(1, -1).trim();
  }
  return type.replace(/\s*([,:→(){}\[\]])\s*/g, '$1');
}

function topLevelIndex(source, token) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const closes = new Set(Object.values(pairs));
  const stack = [];
  for (let index = 0; index <= source.length - token.length; index += 1) {
    const char = source[index];
    if (pairs[char]) stack.push(pairs[char]);
    else if (closes.has(char) && stack.at(-1) === char) stack.pop();
    if (!stack.length && source.slice(index, index + token.length) === token) return index;
  }
  return -1;
}

function splitTopLevelArrows(source) {
  const parts = [];
  let rest = String(source || '');
  while (rest) {
    const unicode = topLevelIndex(rest, '→');
    const ascii = topLevelIndex(rest, '->');
    const positions = [unicode, ascii].filter((value) => value >= 0);
    if (!positions.length) break;
    const index = Math.min(...positions);
    const width = rest.startsWith('->', index) ? 2 : 1;
    parts.push(rest.slice(0, index));
    rest = rest.slice(index + width);
  }
  parts.push(rest);
  return parts.map(normalizeLeanType).filter(Boolean);
}

function binderGroups(signature) {
  const groups = [];
  const pairs = { '(': ')', '{': '}', '[': ']' };
  for (let index = 0; index < signature.length; index += 1) {
    const close = pairs[signature[index]];
    if (!close) continue;
    let depth = 1;
    let cursor = index + 1;
    for (; cursor < signature.length && depth > 0; cursor += 1) {
      if (signature[cursor] === signature[index]) depth += 1;
      else if (signature[cursor] === close) depth -= 1;
    }
    if (depth !== 0) break;
    const content = signature.slice(index + 1, cursor - 1);
    const colon = topLevelIndex(content, ':');
    if (colon >= 0) groups.push({ names: content.slice(0, colon).trim().split(/\s+/).filter(Boolean), type: normalizeLeanType(content.slice(colon + 1)) });
    index = cursor - 1;
  }
  return groups;
}

function conclusionFromSignature(signature) {
  const colon = topLevelIndex(signature, ':');
  const result = colon >= 0 ? signature.slice(colon + 1) : signature;
  return splitTopLevelArrows(result).at(-1) || '';
}

export function analyzeLeanTypeContract(signature) {
  const normalizedType = normalizeLeanType(signature).replace(/^:/, '');
  const binders = binderGroups(String(signature || ''));
  const afterColon = topLevelIndex(String(signature || ''), ':');
  const resultType = afterColon >= 0 ? String(signature).slice(afterColon + 1) : String(signature || '');
  const arrows = splitTopLevelArrows(resultType);
  const conclusion = normalizeLeanType(arrows.at(-1) || conclusionFromSignature(signature));
  const premises = [
    ...binders.filter((binder) => !/^(?:Prop|Type(?:\s+\d+)?|Sort(?:\s+\d+)?)$/.test(binder.type)).map((binder) => binder.type),
    ...arrows.slice(0, -1),
  ].map(normalizeLeanType).filter(Boolean);
  const conclusionAssumedAsPremise = Boolean(conclusion && premises.some((premise) => premise === conclusion));
  return Object.freeze({
    normalizedType,
    typeHash: normalizedType ? hashBytes(Buffer.from(normalizedType)) : null,
    premises: [...new Set(premises)],
    conclusion,
    conditional: premises.length > 0,
    conclusionAssumedAsPremise,
    vacuous: conclusion === 'True',
  });
}

function declarationEnd(source, start) {
  const assignment = topLevelIndex(source.slice(start), ':=');
  const where = topLevelIndex(source.slice(start), ' where');
  const candidates = [assignment, where].filter((value) => value >= 0);
  return candidates.length ? start + Math.min(...candidates) : source.length;
}

export function leanSourceDeclarationRecords(source) {
  const text = stripLeanComments(source);
  const records = [];
  const pattern = /\b(?:theorem|lemma)\s+([A-Za-z_][A-Za-z0-9_'.]*)/g;
  for (const match of text.matchAll(pattern)) {
    const start = match.index + match[0].length;
    const end = declarationEnd(text, start);
    const signature = text.slice(start, end).trim();
    const contract = analyzeLeanTypeContract(signature);
    const statement = `${match[0]} ${signature}`.replace(/\s+/g, ' ').trim();
    records.push(Object.freeze({
      name: match[1],
      statement,
      statementHash: hashBytes(Buffer.from(statement)),
      ...contract,
    }));
    pattern.lastIndex = Math.max(pattern.lastIndex, end);
  }
  return records;
}
