import { hashBytes } from '../../workflow-kernel/record-hash.mjs';

export function normalizeLeanType(value) {
  let type = String(value || '').replace(/->/g, '→').replace(/\s+/g, ' ').trim();
  while (type.startsWith('(') && type.endsWith(')')) {
    let depth = 0;
    let wraps = true;
    for (let index = 0; index < type.length; index += 1) {
      if (type[index] === '(') depth += 1;
      if (type[index] === ')') depth -= 1;
      if (depth === 0 && index < type.length - 1) {
        wraps = false;
        break;
      }
    }
    if (!wraps) break;
    type = type.slice(1, -1).trim();
  }
  return type.replace(/\s*([,:→(){}\[\]])\s*/g, '$1');
}

export function leanTypeIdentity(value) {
  const normalizedType = normalizeLeanType(value).replace(/^:/, '');
  return Object.freeze({
    normalizedType,
    normalizedTypeHash: normalizedType
      ? hashBytes(Buffer.from(normalizedType, 'utf8'))
      : null,
  });
}
