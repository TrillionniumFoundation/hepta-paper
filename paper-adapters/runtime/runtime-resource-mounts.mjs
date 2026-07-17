import fs from 'node:fs';
import path from 'node:path';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';

function elanRuntimeRoot(executable) {
  const value = path.resolve(String(executable || ''));
  const binMarker = `${path.sep}.elan${path.sep}bin${path.sep}`;
  const binMarkerIndex = value.indexOf(binMarker);
  if (binMarkerIndex >= 0) return value.slice(0, binMarkerIndex + `${path.sep}.elan`.length);
  const marker = `${path.sep}.elan${path.sep}toolchains${path.sep}`;
  const markerIndex = value.indexOf(marker);
  if (markerIndex < 0) return null;
  const toolchainStart = markerIndex + marker.length;
  const toolchainEnd = value.indexOf(path.sep, toolchainStart);
  return toolchainEnd > toolchainStart ? value.slice(0, toolchainEnd) : null;
}

export function executableRuntimePathSupported(executable, sourceRoot) {
  if (!executable) return false;
  if (isPathWithin(sourceRoot, executable)) return true;
  if (['/usr', '/bin', '/lib', '/lib64'].some((root) => isPathWithin(root, executable))) return true;
  return Boolean(elanRuntimeRoot(executable));
}

export function dockerSystemMounts(executable) {
  const mounts = ['/usr', '/bin', '/lib', '/lib64', '/var/lib/texmf', '/etc/texmf']
    .filter((candidate) => fs.existsSync(candidate))
    .flatMap((candidate) => ['--volume', `${candidate}:${candidate}:ro`]);
  const toolchainRoot = elanRuntimeRoot(executable);
  if (toolchainRoot && fs.existsSync(toolchainRoot)) mounts.push('--volume', `${toolchainRoot}:${toolchainRoot}:ro`);
  return mounts;
}

export function bubblewrapRuntimeResourceMounts(executable) {
  const mounts = [];
  const toolchainRoot = elanRuntimeRoot(executable);
  if (toolchainRoot && fs.existsSync(toolchainRoot)) mounts.push('--ro-bind', toolchainRoot, toolchainRoot);
  return mounts;
}
