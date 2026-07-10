import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

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

export function nowIso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

export function toPosixPath(value) {
  return normalizeText(value).replace(/\\/g, '/');
}

export function pathWithin(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + path.sep);
}

export function relativePath(root, candidate) {
  if (!candidate) return null;
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return toPosixPath(rel || '.');
}

export async function pathStat(candidate) {
  try {
    return await fsp.stat(candidate);
  } catch {
    return null;
  }
}

export async function fileExists(candidate) {
  const stat = await pathStat(candidate);
  return Boolean(stat?.isFile());
}

export async function dirExists(candidate) {
  const stat = await pathStat(candidate);
  return Boolean(stat?.isDirectory());
}

export async function readTextIfExists(candidate) {
  if (!(await fileExists(candidate))) return null;
  return fsp.readFile(candidate, 'utf8');
}

export async function readJsonIfExists(candidate) {
  const text = await readTextIfExists(candidate);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function listDirSafe(candidate) {
  try {
    return await fsp.readdir(candidate, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function ensureDir(candidate) {
  await fsp.mkdir(candidate, { recursive: true });
  return candidate;
}

export async function writeJsonFile(candidate, value) {
  await ensureDir(path.dirname(candidate));
  await fsp.writeFile(candidate, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export async function writeTextFile(candidate, value) {
  await ensureDir(path.dirname(candidate));
  await fsp.writeFile(candidate, String(value), 'utf8');
}

export function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(String(value ?? ''));
  } catch {
    return fallback;
  }
}

export function sha256Text(value) {
  return 'sha256:' + crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
}

export async function sha256File(candidate) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(candidate);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return 'sha256:' + hash.digest('hex');
}

export async function fileRecord(root, candidate, role = 'artifact') {
  const stat = await pathStat(candidate);
  if (!stat?.isFile()) return null;
  return {
    role,
    path: relativePath(root, candidate),
    filename: path.basename(candidate),
    sizeBytes: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
    hash: await sha256File(candidate),
  };
}

export async function walkFiles(root, {
  maxDepth = 4,
  maxFiles = 2000,
  ignoreDirNames = ['.git', '.lake', 'node_modules', '__pycache__'],
  includeHidden = false,
  match = null,
} = {}) {
  const out = [];
  const ignored = new Set(ignoreDirNames);
  async function visit(dir, depth) {
    if (out.length >= maxFiles || depth > maxDepth) return;
    const entries = await listDirSafe(dir);
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (!includeHidden && entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) await visit(full, depth + 1);
      } else if (entry.isFile()) {
        if (!match || match(full, entry.name)) out.push(full);
      }
    }
  }
  if (await dirExists(root)) await visit(root, 0);
  return out;
}

export function parseMaybeQuoted(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw.slice(1, -1).split(',').map((item) => parseMaybeQuoted(item)).filter(Boolean);
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
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
    if (item) {
      if (current) rows.push(current);
      current = { [item[1]]: parseMaybeQuoted(item[2]) };
      continue;
    }
    const field = line.match(/^    ([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (field && current) {
      current[field[1]] = parseMaybeQuoted(field[2]);
    }
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
    if (section) {
      currentKey = section[1];
      out[currentKey] = {};
      continue;
    }
    const field = line.match(/^    ([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (field && currentKey) {
      out[currentKey][field[1]] = parseMaybeQuoted(field[2]);
    }
  }
  return out;
}

export function firstPresent(values = []) {
  return values.find((value) => value !== null && value !== undefined && value !== '') ?? null;
}

export function sortByMtimeDesc(records = []) {
  return [...records].sort((left, right) => Number(right.mtimeMs || 0) - Number(left.mtimeMs || 0));
}
