import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const DEFAULT_POLICIES = Object.freeze({
  'automation-workspaces': Object.freeze({ maxBytes: 1024 ** 3, maxAgeMs: 7 * 86400000, keepNewest: 0 }),
  'automation-cache': Object.freeze({ maxBytes: 2 * 1024 ** 3, maxAgeMs: 30 * 86400000, keepNewest: 10 }),
  reports: Object.freeze({ maxBytes: 64 * 1024 ** 2, maxAgeMs: 30 * 86400000, keepNewest: 12 }),
  backups: Object.freeze({ maxBytes: 96 * 1024 ** 2, maxAgeMs: 30 * 86400000, keepNewest: 8 }),
});

function safeNodeKey(value) {
  return String(value || '').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function entryBytes(candidate) {
  const stat = fs.lstatSync(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.size;
  return fs.readdirSync(candidate).reduce((total, name) => total + entryBytes(path.join(candidate, name)), stat.size);
}

function entryHash(candidate) {
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink()) return hashRecord('RuntimeRetentionSymlink', { target: fs.readlinkSync(candidate) });
  if (stat.isFile()) return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex')}`;
  const rows = fs.readdirSync(candidate).sort().map((name) => ({ name, hash: entryHash(path.join(candidate, name)) }));
  return hashRecord('RuntimeRetentionDirectory', rows);
}

function topLevelEntries(root, category) {
  if (!fs.existsSync(root)) return [];
  const names = fs.readdirSync(root);
  return names.filter((name) => category !== 'backups' || !name.endsWith('.sqlite.receipt.json')).map((name) => {
    const candidate = path.join(root, name);
    const stat = fs.lstatSync(candidate);
    const companionPath = category === 'backups' && name.endsWith('.sqlite')
      ? `${candidate}.receipt.json`
      : null;
    const companionPaths = companionPath && fs.existsSync(companionPath) ? [companionPath] : [];
    const companionStats = companionPaths.map((item) => fs.lstatSync(item));
    return {
      name,
      path: candidate,
      companionPaths,
      bytes: entryBytes(candidate) + companionPaths.reduce((total, item) => total + entryBytes(item), 0),
      modifiedAtMs: Math.max(stat.mtimeMs, ...companionStats.map((item) => item.mtimeMs)),
      symbolicLink: stat.isSymbolicLink() || companionStats.some((item) => item.isSymbolicLink()),
    };
  }).sort((left, right) => right.modifiedAtMs - left.modifiedAtMs || left.name.localeCompare(right.name));
}

function retentionEntryHash(entry) {
  if (!entry.companionPaths?.length) return entryHash(entry.path);
  return hashRecord('RuntimeRetentionEntryGroup', [entry.path, ...entry.companionPaths].map((candidate) => ({
    name: path.basename(candidate),
    hash: entryHash(candidate),
  })));
}

export function buildRuntimeRetentionPlan({ runtimeRoot, activeNodeIds = [], workspaceRecords = [], nowMs = Date.now(), policies = {} } = {}) {
  const root = path.resolve(runtimeRoot || '.');
  const activeKeys = activeNodeIds.map(safeNodeKey).filter(Boolean);
  const workspaceByPath = new Map(workspaceRecords.map((record) => [path.resolve(record.workspacePath || record.workspace_path || ''), record]));
  const categories = [];
  const removals = [];
  for (const [category, defaults] of Object.entries(DEFAULT_POLICIES)) {
    const policy = { ...defaults, ...(policies[category] || {}) };
    const entries = topLevelEntries(path.join(root, category), category);
    const protectedNames = new Set(entries.slice(0, Math.max(0, Number(policy.keepNewest || 0))).map((entry) => entry.name));
    if (category === 'reports') for (const entry of entries.filter((item) => item.name === 'details' || /-latest\.(?:json|md)$/.test(item.name))) protectedNames.add(entry.name);
    if (category === 'backups') for (const entry of entries.filter((item) => fs.lstatSync(item.path).isDirectory())) protectedNames.add(entry.name);
    const active = (entry) => category === 'automation-workspaces' && activeKeys.some((key) => entry.name.includes(key));
    const lineageProtected = (entry) => {
      if (category !== 'automation-workspaces') return false;
      const record = workspaceByPath.get(path.resolve(entry.path));
      return !record || String(record.retentionState || record.retention_state || 'protected') !== 'eligible';
    };
    let retainedBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
    const candidates = entries.filter((entry) => !entry.symbolicLink && !protectedNames.has(entry.name) && !active(entry) && !lineageProtected(entry)).sort((left, right) => left.modifiedAtMs - right.modifiedAtMs || left.name.localeCompare(right.name));
    const selected = new Set();
    for (const entry of candidates) {
      if (nowMs - entry.modifiedAtMs <= Number(policy.maxAgeMs)) continue;
      selected.add(entry.path);
      retainedBytes -= entry.bytes;
      removals.push({ category, ...entry, contentHash: retentionEntryHash(entry), reason: 'retention_age_exceeded' });
    }
    for (const entry of candidates) {
      if (retainedBytes <= Number(policy.maxBytes) || selected.has(entry.path)) continue;
      selected.add(entry.path);
      retainedBytes -= entry.bytes;
      removals.push({ category, ...entry, contentHash: retentionEntryHash(entry), reason: 'retention_quota_exceeded' });
    }
    categories.push({
      category,
      entryCount: entries.length,
      activeProtectedCount: entries.filter(active).length,
      lineageProtectedCount: entries.filter(lineageProtected).length,
      unregisteredProtectedCount: category === 'automation-workspaces' ? entries.filter((entry) => !workspaceByPath.has(path.resolve(entry.path))).length : 0,
      bytesBefore: entries.reduce((total, entry) => total + entry.bytes, 0),
      bytesAfter: retainedBytes,
      removalCount: selected.size,
      policy,
    });
  }
  const payload = { version: 1, kind: 'RuntimeRetentionPlan', runtimeRoot: root, categories, removals, createdAt: new Date(nowMs).toISOString() };
  return Object.freeze({ ...payload, runtimeRetentionPlanHash: hashRecord('RuntimeRetentionPlan', payload) });
}

export function executeRuntimeRetentionPlan(plan, { apply = false, workspaceRegistry = null } = {}) {
  const removed = [];
  for (const entry of plan.removals || []) {
    if (apply && fs.existsSync(entry.path)) fs.rmSync(entry.path, { recursive: true, force: true });
    if (apply) for (const companionPath of entry.companionPaths || []) {
      if (fs.existsSync(companionPath)) fs.rmSync(companionPath, { recursive: true, force: true });
    }
    removed.push({
      category: entry.category,
      path: entry.path,
      companionPaths: entry.companionPaths || [],
      bytes: entry.bytes,
      contentHash: entry.contentHash,
      reason: entry.reason,
      removed: Boolean(apply),
    });
  }
  if (apply) workspaceRegistry?.reconcileMissingEligible?.();
  const payload = {
    version: 1,
    kind: 'RuntimeRetentionReceipt',
    status: apply ? 'runtime_retention_applied' : 'runtime_retention_dry_run',
    planHash: plan.runtimeRetentionPlanHash,
    removed,
    bytesEligible: removed.reduce((total, entry) => total + entry.bytes, 0),
    applied: Boolean(apply),
    externalActionPerformed: false,
    createdAt: new Date().toISOString(),
  };
  const receipt = Object.freeze({ ...payload, runtimeRetentionReceiptHash: hashRecord('RuntimeRetentionReceipt', payload) });
  let receiptPath = null;
  if (apply) {
    const receiptRoot = path.join(plan.runtimeRoot, 'retention');
    fs.mkdirSync(receiptRoot, { recursive: true });
    const stamp = receipt.createdAt.replace(/[:.]/g, '-');
    receiptPath = path.join(receiptRoot, `runtime-retention-${stamp}-${crypto.randomUUID()}.json`);
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  }
  return Object.freeze({ ...receipt, receiptPath });
}
