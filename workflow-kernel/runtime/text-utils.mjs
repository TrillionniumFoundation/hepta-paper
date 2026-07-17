export function normalizeText(value) {
  return String(value ?? '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function uniqueStrings(values = [], limit = 64) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

export function parseMaybeQuoted(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) return raw.slice(1, -1);
  if (raw.startsWith('[') && raw.endsWith(']')) return raw.slice(1, -1).split(',').map((item) => parseMaybeQuoted(item)).filter(Boolean);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}
