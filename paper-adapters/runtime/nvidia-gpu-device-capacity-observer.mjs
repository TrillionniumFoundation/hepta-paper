import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import {
  buildNvidiaGpuDeviceCapacityObservation,
} from '../../paper-domain/automation/nvidia-gpu-device-capacity-contract.mjs';
import { normalizeNvidiaGpuDeviceSelector } from './docker-worker-command.mjs';

const MEMORY_MIB = /^\d{1,12}$/;

function parseCapacityRows(value) {
  const rows = [];
  for (const line of String(value || '').split(/\r?\n/).filter(Boolean)) {
    const columns = line.split(',').map((column) => column.trim());
    if (columns.length !== 3) continue;
    const gpuDeviceSelector = normalizeNvidiaGpuDeviceSelector(columns[0]);
    if (!gpuDeviceSelector || !MEMORY_MIB.test(columns[1])
      || !MEMORY_MIB.test(columns[2])) {
      continue;
    }
    const reportedTotalMemoryMiB = Number(columns[1]);
    const reportedFreeMemoryMiB = Number(columns[2]);
    try {
      rows.push(buildNvidiaGpuDeviceCapacityObservation({
        gpuDeviceSelector,
        reportedTotalMemoryMiB,
        reportedFreeMemoryMiB,
      }));
    } catch { /* invalid capacity row is excluded */ }
  }
  return rows;
}

function observeNvidiaGpuDeviceCapacities() {
  const executable = fs.existsSync('/usr/bin/nvidia-smi')
    ? '/usr/bin/nvidia-smi' : 'nvidia-smi';
  const result = spawnSync(executable, [
    '--query-gpu=uuid,memory.total,memory.free',
    '--format=csv,noheader,nounits',
  ], {
    encoding: 'utf8',
    timeout: 5_000,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
  });
  if (result.status !== 0 || result.error || result.signal) return [];
  return parseCapacityRows(result.stdout);
}

export function inspectNvidiaGpuDeviceCapacity(gpuDeviceSelector) {
  const selected = normalizeNvidiaGpuDeviceSelector(gpuDeviceSelector);
  if (!selected) return null;
  const matches = observeNvidiaGpuDeviceCapacities()
    .filter((row) => row.gpuDeviceSelector === selected);
  return matches.length === 1 ? matches[0] : null;
}

export function selectSingleNvidiaGpuDeviceCapacity() {
  const observed = observeNvidiaGpuDeviceCapacities();
  return observed.length === 1 ? observed[0] : null;
}

export { parseCapacityRows as parseNvidiaGpuDeviceCapacityRows };
