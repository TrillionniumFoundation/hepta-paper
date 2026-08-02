import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeText } from './text-utils.mjs';
import { readScopedFileSync } from './scoped-file-identity.mjs';
import { hashBytes } from '../record-hash.mjs';
export { isPathWithin as pathWithin } from './path-utils.mjs';

export function toPosixPath(value) { return normalizeText(value).replace(/\\/g, '/'); }
export function relativePath(root, candidate) {
  if (!candidate) return null;
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return toPosixPath(rel || '.');
}
export async function pathStat(candidate) { try { return await fsp.stat(candidate); } catch { return null; } }
export async function fileExists(candidate) { return Boolean((await pathStat(candidate))?.isFile()); }
export async function dirExists(candidate) { return Boolean((await pathStat(candidate))?.isDirectory()); }
export async function readTextIfExists(candidate) { return (await fileExists(candidate)) ? fsp.readFile(candidate, 'utf8') : null; }
export async function readJsonIfExists(candidate) {
  const text = await readTextIfExists(candidate);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}
export async function listDirSafe(candidate) { try { return await fsp.readdir(candidate, { withFileTypes: true }); } catch { return []; } }
export async function ensureDir(candidate) { await fsp.mkdir(candidate, { recursive: true }); return candidate; }
export function sha256Text(value) { return hashBytes(String(value ?? '')); }
export async function sha256File(candidate) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(candidate);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return `sha256:${hash.digest('hex')}`;
}
export function sha256FileSync(candidate, { prefix = true } = {}) {
  const hash = hashBytes(fs.readFileSync(candidate));
  return prefix ? hash : hash.slice('sha256:'.length);
}

function stableRegularFileSnapshot(stat) {
  return JSON.stringify({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    nlink: String(stat.nlink),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  });
}

export function sha256StableFileSyncNoFollow(candidate, {
  prefix = true,
  readBufferBytes = 1024 * 1024,
} = {}) {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
    throw new Error('stable_file_hash_no_follow_unavailable');
  }
  if (!Number.isSafeInteger(readBufferBytes)
    || readBufferBytes < 4 * 1024
    || readBufferBytes > 16 * 1024 * 1024) {
    throw new Error('stable_file_hash_read_buffer_invalid');
  }
  const descriptor = fs.openSync(
    candidate,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error('stable_file_hash_regular_file_required');
    const beforeSnapshot = stableRegularFileSnapshot(before);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(readBufferBytes);
    let totalBytes = 0n;
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      totalBytes += BigInt(bytesRead);
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (stableRegularFileSnapshot(after) !== beforeSnapshot
      || totalBytes !== after.size) {
      throw new Error('stable_file_hash_file_changed_during_read');
    }
    let pathAfter;
    try {
      pathAfter = fs.lstatSync(candidate, { bigint: true });
    } catch (error) {
      throw new Error('stable_file_hash_path_changed_during_read', { cause: error });
    }
    if (!pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || stableRegularFileSnapshot(pathAfter) !== beforeSnapshot) {
      throw new Error('stable_file_hash_path_changed_during_read');
    }
    const digest = hash.digest('hex');
    return prefix ? `sha256:${digest}` : digest;
  } finally {
    fs.closeSync(descriptor);
  }
}
export async function fileRecord(root, candidate, role = 'artifact') {
  const read = readScopedFileSync({ scopeRoot: root, candidate });
  if (read.status !== 'scoped_file_read_verified') return null;
  const stat = await pathStat(candidate);
  return { role, path: relativePath(root, candidate), filename: path.basename(candidate), sizeBytes: read.bytes, mtimeMs: Math.trunc(stat.mtimeMs), hash: read.hash, scopedFileReadReceiptHash: read.scopedFileReadReceiptHash };
}
export async function walkFiles(root, { maxDepth = 4, maxFiles = 2000, ignoreDirNames = ['.git', '.lake', 'node_modules', '__pycache__'], includeHidden = false, match = null } = {}) {
  const out = [];
  const ignored = new Set(ignoreDirNames);
  async function visit(dir, depth) {
    if (out.length >= maxFiles || depth > maxDepth) return;
    for (const entry of await listDirSafe(dir)) {
      if (out.length >= maxFiles) return;
      if (!includeHidden && entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!ignored.has(entry.name)) await visit(full, depth + 1); }
      else if (entry.isFile() && (!match || match(full, entry.name))) out.push(full);
    }
  }
  if (await dirExists(root)) await visit(root, 0);
  return out;
}
