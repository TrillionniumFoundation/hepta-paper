import { parseMaybeQuoted } from './text-utils.mjs';

export function safeJsonParse(value, fallback = null) { try { return JSON.parse(String(value ?? '')); } catch { return fallback; } }
export function parseJsonOrThrow(value, errorCode = 'json_value_invalid') {
  try { return JSON.parse(String(value)); }
  catch (cause) {
    const error = new Error(errorCode, { cause });
    error.code = errorCode;
    throw error;
  }
}
export function parseSimpleYamlList(text, key) {
  const lines = String(text || '').split('\n');
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  if (start < 0) return [];
  const rows = [];
  let current = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line) && line.trim() && !line.trim().startsWith('#')) break;
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const item = line.match(/^  - ([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (item) { if (current) rows.push(current); current = { [item[1]]: parseMaybeQuoted(item[2]) }; continue; }
    const field = line.match(/^    ([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (field && current) current[field[1]] = parseMaybeQuoted(field[2]);
  }
  if (current) rows.push(current);
  return rows;
}
export function parseSimpleYamlMap(text, key) {
  const lines = String(text || '').split('\n');
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  if (start < 0) return {};
  const out = {};
  let currentKey = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line) && line.trim() && !line.trim().startsWith('#')) break;
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const section = line.match(/^  ([A-Za-z0-9_.-]+):\s*$/);
    if (section) { currentKey = section[1]; out[currentKey] = {}; continue; }
    const field = line.match(/^    ([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (field && currentKey) out[currentKey][field[1]] = parseMaybeQuoted(field[2]);
  }
  return out;
}
