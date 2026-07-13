import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const DEFAULT_POLICIES = Object.freeze({
  'automation-workspaces': Object.freeze({ maxBytes: 1024 ** 3, maxAgeMs: 7 * 86400000, keepNewest: 0 }),
  'automation-cache': Object.freeze({ maxBytes: 2 * 1024 ** 3, maxAgeMs: 30 * 86400000, keepNewest: 10 }),
  reports: Object.freeze({ maxBytes: 512 * 1024 ** 2, maxAgeMs: 90 * 86400000, keepNewest: 20 }),
  backups: Object.freeze({ maxBytes: 1024 ** 3, maxAgeMs: 90 * 86400000, keepNewest: 20 }),
});

function safeNodeKey(value) {
  return String(value || '').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function entryBytes(candidate) {
  const stat = fs.lstatSync(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.size;
  return fs.readdirSync(candidate).reduce((total, name) => total + entryBytes(path.join(candidate, name)), stat.size);
}

function topLevelEntries(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).map((name) => {
    const candidate = path.join(root, name);
    const stat = fs.lstatSync(candidate);
    return { name, path: candidate, bytes: entryBytes(candidate), modifiedAtMs: stat.mtimeMs, symbolicLink: stat.isSymbolicLink() };
  }).sort((left, right) => right.modifiedAtMs - left.modifiedAtMs || left.name.localeCompare(right.name));
}

export function buildRuntimeRetentionPlan({ runtimeRoot, activeNodeIds = [], workspaceRecords = [], nowMs = Date.now(), policies = {} } = {}) {
  const root = path.resolve(runtimeRoot || '.');
  const activeKeys = activeNodeIds.map(safeNodeKey).filter(Boolean);
  const workspaceByPath = new Map(workspaceRecords.map((record) => [path.resolve(record.workspacePath || record.workspace_path || ''), record]));
  const categories = [];
  const removals = [];
  for (const [category, defaults] of Object.entries(DEFAULT_POLICIES)) {
    const policy = { ...defaults, ...(policies[category] || {}) };
    const entries = topLevelEntries(path.join(root, category));
    const protectedNames = new Set(entries.slice(0, Math.max(0, Number(policy.keepNewest || 0))).map((entry) => entry.name));
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
      removals.push({ category, ...entry, reason: 'retention_age_exceeded' });
    }
    for (const entry of candidates) {
      if (retainedBytes <= Number(policy.maxBytes) || selected.has(entry.path)) continue;
      selected.add(entry.path);
      retainedBytes -= entry.bytes;
      removals.push({ category, ...entry, reason: 'retention_quota_exceeded' });
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

export function executeRuntimeRetentionPlan(plan, { apply = false } = {}) {
  const removed = [];
  for (const entry of plan.removals || []) {
    if (apply && fs.existsSync(entry.path)) fs.rmSync(entry.path, { recursive: true, force: true });
    removed.push({ category: entry.category, path: entry.path, bytes: entry.bytes, reason: entry.reason, removed: Boolean(apply) });
  }
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
  const receiptRoot = path.join(plan.runtimeRoot, 'retention');
  fs.mkdirSync(receiptRoot, { recursive: true });
  const stamp = receipt.createdAt.replace(/[:.]/g, '-');
  const receiptPath = path.join(receiptRoot, `runtime-retention-${stamp}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return Object.freeze({ ...receipt, receiptPath });
}
