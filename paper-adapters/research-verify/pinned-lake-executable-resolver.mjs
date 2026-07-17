import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PRODUCTION_LEAN_TOOLCHAIN } from '../../paper-domain/research/formal-verifier-policy.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';

function elanHome() {
  return path.resolve(process.env.ELAN_HOME || path.join(process.env.HOME || '', '.elan'));
}

export function resolvePinnedLakeExecutable({ toolchain = PRODUCTION_LEAN_TOOLCHAIN } = {}) {
  const home = elanHome();
  const elan = path.join(home, 'bin', 'elan');
  const toolchainsRoot = path.join(home, 'toolchains');
  const blockers = [];
  let executable = null;
  let leanExecutable = null;
  let toolchainRoot = null;
  try {
    const elanStat = fs.lstatSync(elan);
    if (!elanStat.isFile()) blockers.push('formal_elan_launcher_not_regular_file');
    const result = blockers.length ? null : spawnSync(elan, ['which', 'lake'], {
      encoding: 'utf8',
      env: { ...process.env, ELAN_HOME: home, ELAN_TOOLCHAIN: toolchain },
      timeout: 10000,
      windowsHide: true,
    });
    if (!result || result.status !== 0 || result.error) blockers.push('formal_pinned_lake_resolution_failed');
    else executable = path.resolve(String(result.stdout || '').trim());
    const leanResult = blockers.length ? null : spawnSync(elan, ['which', 'lean'], {
      encoding: 'utf8',
      env: { ...process.env, ELAN_HOME: home, ELAN_TOOLCHAIN: toolchain },
      timeout: 10000,
      windowsHide: true,
    });
    if (!leanResult || leanResult.status !== 0 || leanResult.error) blockers.push('formal_pinned_lean_resolution_failed');
    else leanExecutable = path.resolve(String(leanResult.stdout || '').trim());
    if (!executable || !isPathWithin(toolchainsRoot, executable)) blockers.push('formal_pinned_lake_outside_toolchain_root');
    if (!leanExecutable || !isPathWithin(toolchainsRoot, leanExecutable)) blockers.push('formal_pinned_lean_outside_toolchain_root');
    if (executable) {
      const executableStat = fs.lstatSync(executable);
      if (!executableStat.isFile() || executableStat.isSymbolicLink()) blockers.push('formal_pinned_lake_not_regular_file');
      if (executableStat.nlink !== 1) blockers.push('formal_pinned_lake_hardlink_forbidden');
    }
    if (leanExecutable) {
      const leanStat = fs.lstatSync(leanExecutable);
      if (!leanStat.isFile() || leanStat.isSymbolicLink()) blockers.push('formal_pinned_lean_not_regular_file');
      if (leanStat.nlink !== 1) blockers.push('formal_pinned_lean_hardlink_forbidden');
    }
    if (executable && leanExecutable) {
      const lakeRoot = path.dirname(path.dirname(executable));
      const leanRoot = path.dirname(path.dirname(leanExecutable));
      if (lakeRoot !== leanRoot || !isPathWithin(toolchainsRoot, lakeRoot)) blockers.push('formal_pinned_toolchain_root_mismatch');
      else toolchainRoot = lakeRoot;
    }
  } catch {
    blockers.push('formal_pinned_lake_resolution_failed');
  }
  return Object.freeze({
    status: blockers.length ? 'formal_pinned_lake_resolution_blocked' : 'formal_pinned_lake_resolved',
    toolchain,
    executable: blockers.length ? null : executable,
    lakeExecutable: blockers.length ? null : executable,
    leanExecutable: blockers.length ? null : leanExecutable,
    toolchainRoot: blockers.length ? null : toolchainRoot,
    blockers: [...new Set(blockers)],
  });
}
