import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_EXCLUDED_NAMES = new Set(['.git', 'node_modules', 'runtime', '.artifact-cas']);

export function sha256FileSync(candidate) {
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex');
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
