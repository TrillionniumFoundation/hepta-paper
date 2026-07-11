import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeText } from './text-utils.mjs';

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
  try { return await fsp.stat(candidate); } catch { return null; }
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
  try { return JSON.parse(text); } catch { return null; }
}

export async function listDirSafe(candidate) {
  try { return await fsp.readdir(candidate, { withFileTypes: true }); } catch { return []; }
}

export async function ensureDir(candidate) {
  await fsp.mkdir(candidate, { recursive: true });
  return candidate;
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
      } else if (entry.isFile() && (!match || match(full, entry.name))) {
        out.push(full);
      }
    }
  }
  if (await dirExists(root)) await visit(root, 0);
  return out;
}
