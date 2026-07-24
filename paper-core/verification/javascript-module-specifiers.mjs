function isIdentifierStart(character) {
  return /[A-Za-z_$]/.test(character || '');
}
function isIdentifierPart(character) {
  return /[A-Za-z0-9_$]/.test(character || '');
}

function tokenizeModuleSource(source) {
  const tokens = [];
  const text = String(source || '');
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '/' && next === '/') {
      index += 2;
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index = Math.min(text.length, index + 2);
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      let value = '';
      let escaped = false;
      index += 1;
      while (index < text.length) {
        const current = text[index];
        if (escaped) {
          value += `\\${current}`;
          escaped = false;
          index += 1;
          continue;
        }
        if (current === '\\') {
          escaped = true;
          index += 1;
          continue;
        }
        if (current === quote) {
          index += 1;
          break;
        }
        value += current;
        index += 1;
      }
      tokens.push(Object.freeze({ type: 'string', value, escaped }));
      continue;
    }
    if (character === '`') {
      index += 1;
      let escaped = false;
      while (index < text.length) {
        const current = text[index];
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current === '`') {
          index += 1;
          break;
        }
        index += 1;
      }
      tokens.push(Object.freeze({ type: 'template', value: null }));
      continue;
    }
    if (isIdentifierStart(character)) {
      const start = index;
      index += 1;
      while (isIdentifierPart(text[index])) index += 1;
      tokens.push(Object.freeze({ type: 'identifier', value: text.slice(start, index) }));
      continue;
    }
    tokens.push(Object.freeze({ type: 'punctuator', value: character }));
    index += 1;
  }
  return tokens;
}

function relativeStringToken(token) {
  if (token?.type !== 'string' || token.escaped || !token.value.startsWith('.')) return null;
  return token.value;
}

export function relativeModuleSpecifiers(source) {
  const tokens = tokenizeModuleSource(source);
  const specifiers = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'identifier' || !['import', 'export'].includes(token.value)) continue;
    const immediate = relativeStringToken(tokens[index + 1]);
    if (token.value === 'import' && immediate) {
      specifiers.push(immediate);
      continue;
    }
    if (token.value === 'import' && tokens[index + 1]?.value === '(') {
      const dynamic = relativeStringToken(tokens[index + 2]);
      if (dynamic && tokens[index + 3]?.value === ')') specifiers.push(dynamic);
      continue;
    }
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const candidate = tokens[cursor];
      if (candidate.value === ';') break;
      if (candidate.type === 'identifier' && ['import', 'export'].includes(candidate.value)) break;
      if (candidate.type === 'identifier' && candidate.value === 'from') {
        const from = relativeStringToken(tokens[cursor + 1]);
        if (from) specifiers.push(from);
        break;
      }
    }
  }
  return Object.freeze([...new Set(specifiers)]);
}
