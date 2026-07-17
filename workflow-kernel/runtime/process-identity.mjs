import fs from 'node:fs';

function normalizedPid(value) {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function observeProcessIdentity(pidValue) {
  const pid = normalizedPid(pidValue);
  if (!pid) return Object.freeze({ state: 'unknown', pid: null, pidStartTime: null });
  if (process.platform !== 'linux' || !fs.existsSync('/proc')) {
    return Object.freeze({ state: 'unsupported', pid, pidStartTime: null });
  }
  let raw;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') {
      return Object.freeze({ state: 'missing', pid, pidStartTime: null });
    }
    return Object.freeze({ state: 'unknown', pid, pidStartTime: null });
  }
  // The command field is parenthesized and may itself contain spaces or ')'.
  // Field 22 (process start time) is index 19 after the final command ')'.
  const commandEnd = raw.lastIndexOf(')');
  const fields = commandEnd >= 0 ? raw.slice(commandEnd + 1).trim().split(/\s+/) : [];
  const pidStartTime = /^\d+$/.test(fields[19] || '') ? fields[19] : null;
  return Object.freeze({ state: pidStartTime ? 'present' : 'unknown', pid, pidStartTime });
}

export function currentProcessIdentity() {
  const observed = observeProcessIdentity(process.pid);
  return Object.freeze({
    pid: process.pid,
    pidStartTime: observed.state === 'present' ? observed.pidStartTime : null,
  });
}

export function processIdentityIsStale(identity = {}) {
  const pid = normalizedPid(identity.pid);
  if (!pid) return false;
  const observed = observeProcessIdentity(pid);
  if (observed.state === 'missing') return true;
  if (observed.state === 'present') {
    return typeof identity.pidStartTime === 'string' && identity.pidStartTime.length > 0
      ? identity.pidStartTime !== observed.pidStartTime
      : false;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

export function formatProcessIdentitySuffix(identity = currentProcessIdentity()) {
  const pid = normalizedPid(identity.pid);
  if (!pid) throw new Error('process_identity_pid_invalid');
  const pidStartTime = typeof identity.pidStartTime === 'string' && /^\d+$/.test(identity.pidStartTime)
    ? identity.pidStartTime
    : 'unknown';
  return `process:${pid}:${pidStartTime}`;
}

export function parseProcessIdentitySuffix(value) {
  const match = String(value || '').match(/(?:^|:)process:(\d+):(\d+|unknown)$/);
  if (!match) return null;
  const pid = normalizedPid(match[1]);
  if (!pid) return null;
  return Object.freeze({
    pid,
    pidStartTime: match[2] === 'unknown' ? null : match[2],
  });
}
