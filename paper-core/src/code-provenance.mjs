import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HEPTA_WORKSPACE_ROOT } from './workspace-layout.mjs';

function git(args, workspaceRoot) {
  const result = spawnSync('git', args, { cwd: workspaceRoot, encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

export function currentCodeProvenance({ workspaceRoot = HEPTA_WORKSPACE_ROOT } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'));
  const commit = process.env.HEPTA_RELEASE_COMMIT || git(['rev-parse', 'HEAD'], workspaceRoot) || null;
  const tags = git(['tag', '--points-at', 'HEAD'], workspaceRoot).split(/\r?\n/).filter(Boolean);
  const dirty = Boolean(git(['status', '--porcelain'], workspaceRoot));
  return Object.freeze({
    version: 1,
    kind: 'CodeProvenance',
    packageVersion: pkg.version,
    commit,
    tags,
    treeDirty: dirty,
    evidenceEnvironment: process.env.HEPTA_EVIDENCE_ENVIRONMENT || 'production',
    evidenceClass: process.env.HEPTA_EVIDENCE_CLASS || 'runtime_unclassified',
  });
}

export function reportPointerIsCurrent(pointer, provenance = currentCodeProvenance()) {
  return pointer?.kind === 'CurrentReportPointer'
    && pointer?.codeProvenance?.commit === provenance.commit
    && pointer?.codeProvenance?.packageVersion === provenance.packageVersion
    && pointer?.reportHash
    && Date.parse(pointer.validUntil || '') > Date.now();
}
