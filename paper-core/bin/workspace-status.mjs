#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { resolveWorkspaceLayout } from '../src/workspace-layout.mjs';

const layout = resolveWorkspaceLayout();
const real = (candidate) => {
  try { return fs.realpathSync(candidate); } catch { return path.resolve(candidate); }
};
const report = {
  ...layout,
  workspaceRealPath: real(layout.workspaceRoot),
  assetRealPath: real(layout.assetRoot),
  runtimeRealPath: real(layout.runtimeRoot),
  legacyRealPath: real(layout.legacyRoot),
  workspacePresent: fs.existsSync(layout.workspaceRoot),
  assetRootPresent: fs.existsSync(layout.assetRoot),
  runtimeRootPresent: fs.existsSync(layout.runtimeRoot),
  nativeStorePresent: fs.existsSync(path.join(layout.runtimeRoot, 'hepta-paper.sqlite')),
  status: layout.physicallyDecoupled ? 'hepta_workspace_physically_decoupled' : 'hepta_workspace_paths_overlap',
};
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (process.argv.includes('--require-decoupled') && !layout.physicallyDecoupled) process.exitCode = 2;
