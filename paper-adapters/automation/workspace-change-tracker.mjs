import fs from 'node:fs';
import path from 'node:path';
import { sha256FileSync as hashFileSync } from '../../workflow-kernel/runtime/file-utils.mjs';

const DEFAULT_EXCLUDED_NAMES = new Set(['.git', 'node_modules', 'runtime', '.artifact-cas', '.hepta-materialization-recovery']);
const SYSTEM_OWNED_MUTATION_PREFIXES = Object.freeze(['automation-results/']);

export function sha256FileSync(candidate) {
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
  return hashFileSync(candidate, { prefix: false });
}

export function createWorkspaceManifest(root, { exclude = null } = {}) {
  const workspace = path.resolve(root);
  const rows = new Map();
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(workspace, absolute).replace(/\\/g, '/');
      if (DEFAULT_EXCLUDED_NAMES.has(entry.name) || exclude?.({ entry, absolute, relative })) continue;
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) rows.set(relative, sha256FileSync(absolute));
    }
  };
  walk(workspace);
  return rows;
}

export function changedWorkspacePaths(before, after) {
  const left = before instanceof Map ? before : new Map(before);
  const right = after instanceof Map ? after : new Map(after);
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter((key) => left.get(key) !== right.get(key))
    .sort();
}

export function readOnlyMutationBlockers({ sandbox, changedPaths }) {
  return sandbox === 'read-only' && changedPaths.length ? ['read_only_agent_modified_workspace'] : [];
}

function normalizedPolicyPath(value) {
  const relative = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return relative && !relative.startsWith('/') && !relative.split('/').some((part) => !part || part === '.' || part === '..')
    ? relative
    : null;
}

export function workspaceMutationPolicyBlockers({ policy = null, changedPaths = [] } = {}) {
  const systemOwnedBlockers = changedPaths.flatMap((value) => {
    const relative = normalizedPolicyPath(value);
    return relative && SYSTEM_OWNED_MUTATION_PREFIXES.some((prefix) => relative.startsWith(prefix))
      ? [`workspace_mutation_system_owned:${relative}`]
      : [];
  });
  if (!policy) return [...new Set(systemOwnedBlockers)];
  const allowedPaths = new Set((policy.allowedPaths || []).map(normalizedPolicyPath).filter(Boolean));
  const allowedPrefixes = (policy.allowedPrefixes || []).map(normalizedPolicyPath).filter(Boolean)
    .map((prefix) => `${prefix.replace(/\/$/, '')}/`);
  const allowedExtensions = new Set((policy.allowedExtensions || []).map((value) => String(value || '').toLowerCase()).filter((value) => /^\.[a-z0-9]+$/.test(value)));
  const forbiddenPaths = new Set((policy.forbiddenPaths || []).map(normalizedPolicyPath).filter(Boolean));
  const forbiddenExtensions = new Set((policy.forbiddenExtensions || []).map((value) => String(value || '').toLowerCase()).filter((value) => /^\.[a-z0-9]+$/.test(value)));
  const blockers = [...systemOwnedBlockers];
  for (const value of changedPaths) {
    const relative = normalizedPolicyPath(value);
    if (!relative) {
      blockers.push(`workspace_mutation_path_invalid:${String(value || 'missing')}`);
      continue;
    }
    const extension = path.posix.extname(relative).toLowerCase();
    if (SYSTEM_OWNED_MUTATION_PREFIXES.some((prefix) => relative.startsWith(prefix))) {
      blockers.push(`workspace_mutation_system_owned:${relative}`);
      continue;
    }
    if (forbiddenPaths.has(relative) || forbiddenExtensions.has(extension)) {
      blockers.push(`workspace_mutation_forbidden:${relative}`);
      continue;
    }
    const allowed = allowedPaths.has(relative)
      || allowedExtensions.has(extension)
      || allowedPrefixes.some((prefix) => relative.startsWith(prefix));
    if (!allowed) blockers.push(`workspace_mutation_not_allowlisted:${relative}`);
  }
  return [...new Set(blockers)];
}
