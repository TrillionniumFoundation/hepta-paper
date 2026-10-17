// Shared source-evidence lexing; actual Cargo owner tests remain required.
function fail(code) { throw new Error(code); }

function blankRange(chars, start, end) {
  for (let i = start; i < end; i += 1) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
}

export function stripRustInertText(source) {
  const chars = source.split(''); // Same UTF-16 offsets as slice and RegExp.index.
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === '/' && chars[i + 1] === '/') {
      const start = i;
      i += 2;
      while (i < chars.length && chars[i] !== '\n') i += 1;
      blankRange(chars, start, i);
      continue;
    }
    if (chars[i] === '/' && chars[i + 1] === '*') {
      const start = i;
      i += 2;
      let depth = 1;
      while (i < chars.length && depth > 0) {
        if (chars[i] === '/' && chars[i + 1] === '*') { depth += 1; i += 2; continue; }
        if (chars[i] === '*' && chars[i + 1] === '/') { depth -= 1; i += 2; continue; }
        i += 1;
      }
      if (depth !== 0) fail('unterminated_block_comment');
      blankRange(chars, start, i);
      continue;
    }
    const rawStart = source.slice(i).match(/^(?:br|r)(#*)"/u);
    if (rawStart) {
      const start = i;
      const hashes = rawStart[1];
      i += rawStart[0].length;
      const close = `"${hashes}`;
      const end = source.indexOf(close, i);
      if (end < 0) fail('unterminated_raw_string');
      i = end + close.length;
      blankRange(chars, start, i);
      continue;
    }
    if (chars[i] === '"' || (chars[i] === 'b' && chars[i + 1] === '"')) {
      const start = i;
      if (chars[i] === 'b') i += 1;
      i += 1;
      while (i < chars.length) {
        if (chars[i] === '\\') { i += 2; continue; }
        if (chars[i] === '"') { i += 1; break; }
        i += 1;
      }
      blankRange(chars, start, i);
      continue;
    }
    if (chars[i] === "'") {
      const lifetime = /^'(?:r#)?[_\p{XID_Start}][_\p{XID_Continue}]*/u.exec(source.slice(i));
      if (lifetime && source[i + lifetime[0].length] !== "'") { i += 1; continue; }
    }
    if (chars[i] === '\'' || (chars[i] === 'b' && chars[i + 1] === '\'')) {
      const start = i;
      if (chars[i] === 'b') i += 1;
      i += 1;
      while (i < chars.length) {
        if (chars[i] === '\\') { i += 2; continue; }
        if (chars[i] === '\'') { i += 1; break; }
        if (chars[i] === '\n') break;
        i += 1;
      }
      blankRange(chars, start, i);
      continue;
    }
    i += 1;
  }
  return chars.join('');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function rustSymbolRegex(symbol) {
  const name = escapeRegex(symbol.name);
  const visibility = String.raw`(?:pub(?:\([^)]*\))?\s+)?`;
  if (symbol.kind === 'test') return new RegExp(String.raw`#\s*\[\s*test\s*\]\s*(?:#\s*\[[^\]]+\]\s*)*${visibility}(?:async\s+)?fn\s+${name}\s*\(`, 'gu');
  if (symbol.kind === 'function') return new RegExp(String.raw`\b${visibility}(?:(?:const|async|safe|unsafe|extern)\s+)*fn\s+${name}\s*(?=\(|<)`, 'gu');
  if (symbol.kind === 'type') return new RegExp(String.raw`\b${visibility}(?:unsafe\s+)?(?:struct|enum|trait|type)\s+${name}\b`, 'gu');
  return new RegExp(String.raw`\b${visibility}(?:const|static)\s+(?:mut\s+)?${name}\b`, 'gu');
}

function functionParametersFollow(live, index) {
  if (live[index] === '(') return true;
  if (live[index] !== '<') return false;
  const stack = ['<'];
  const pair = { ')': '(', ']': '[', '}': '{', '>': '<' };
  for (let i = index + 1; i < live.length; i += 1) {
    const c = live[i];
    // Braced const expressions may contain comparison or shift operators.
    if (stack.at(-1) === '{') {
      if (c === '{') stack.push(c);
      else if (c === '}') stack.pop();
      continue;
    }
    if (c === '>' && live[i - 1] === '-') continue; // Fn(...) -> Output
    if ('<([{'.includes(c)) stack.push(c);
    else if (Object.hasOwn(pair, c)) {
      if (stack.pop() !== pair[c]) return false;
      if (stack.length === 0) return /^\s*\(/u.test(live.slice(i + 1));
    } else if (c === ';' && stack.at(-1) !== '[') return false;
  }
  return false;
}

// Input is offset-preserving stripped source. This does not evaluate cfg,
// expand macros or replace exact compilation, discovery and execution evidence.
export function rustSymbolMatches(live, symbol) {
  const matches = [...live.matchAll(rustSymbolRegex(symbol))];
  return symbol.kind === 'function'
    ? matches.filter((match) => functionParametersFollow(live, match.index + match[0].length))
    : matches;
}

export function rustSymbolCfgGated(live, match) {
  // Test matches include intervening attributes. Functions include qualifiers.
  if (/#\s*\[\s*cfg(?:_attr)?\s*\(/u.test(match[0])) return true;
  let i = match.index - 1;
  for (;;) {
    while (i >= 0 && /\s/u.test(live[i])) i -= 1;
    if (live[i] !== ']') return false;
    const end = i;
    let depth = 1;
    for (i -= 1; i >= 0 && depth > 0; i -= 1) {
      if (live[i] === ']') depth += 1;
      else if (live[i] === '[') depth -= 1;
    }
    if (depth !== 0) return false;
    const begin = i + 1;
    while (i >= 0 && /\s/u.test(live[i])) i -= 1;
    if (live[i] !== '#') return false;
    if (/^\s*cfg(?:_attr)?\s*\(/u.test(live.slice(begin + 1, end))) return true;
    i -= 1;
  }
}
