import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const BASE_CHILD_ENV_KEYS = Object.freeze([
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
]);

export function restrictedChildEnvironment({
  source = process.env,
  allowedKeys = [],
  overrides = {},
} = {}) {
  const env = {};
  for (const key of [...BASE_CHILD_ENV_KEYS, ...allowedKeys]) {
    if (source[key] !== undefined) env[key] = String(source[key]);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && value !== null) env[key] = String(value);
  }
  return Object.freeze(env);
}

function appendTail(current, chunk, limit) {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  return next.length <= limit ? next : next.subarray(next.length - limit);
}

export function runBoundedChildProcess({
  spawnImpl = spawn,
  executable,
  args = [],
  cwd,
  env = restrictedChildEnvironment(),
  stdin = null,
  timeoutMs,
  signal = null,
  maximumCapturedBytes = 1024 * 1024,
  killGraceMs = 5000,
  inheritedDescriptors = [],
} = {}) {
  if (!executable || !cwd || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('bounded child process requires executable, cwd and positive timeoutMs');
  }
  if (!Array.isArray(inheritedDescriptors)
    || inheritedDescriptors.some((descriptor) => !Number.isSafeInteger(descriptor)
      || descriptor < 0)) {
    throw new Error('bounded child process inherited descriptors invalid');
  }
  if (signal?.aborted) {
    const emptyHash = `sha256:${crypto.createHash('sha256').digest('hex')}`;
    return Promise.resolve({
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      stdoutHash: emptyHash,
      stderrHash: emptyHash,
      stdoutBytes: 0,
      stderrBytes: 0,
      outputTruncated: false,
      error: null,
      timedOut: false,
      aborted: true,
      pid: null,
    });
  }
  return new Promise((resolve) => {
    const useProcessGroup = process.platform !== 'win32';
    const child = spawnImpl(executable, args, {
      cwd,
      env: { ...env },
      stdio: [
        stdin === null ? 'ignore' : 'pipe',
        'pipe',
        'pipe',
        ...inheritedDescriptors,
      ],
      detached: useProcessGroup,
    });
    const stdoutDigest = crypto.createHash('sha256');
    const stderrDigest = crypto.createHash('sha256');
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let hardKill = null;
    let groupPoll = null;
    let pendingOutcome = null;
    let terminationRequested = false;
    let reapDeadline = 0;
    const kill = (signalName) => {
      if (useProcessGroup && child.pid) {
        try { process.kill(-child.pid, signalName); return; } catch { /* already exited */ }
      }
      child.kill(signalName);
    };
    const processGroupAlive = () => {
      if (!useProcessGroup || !child.pid) return false;
      try { process.kill(-child.pid, 0); return true; } catch { return false; }
    };
    const terminate = () => {
      terminationRequested = true;
      kill('SIGTERM');
      reapDeadline = Date.now() + killGraceMs + 1000;
      hardKill ||= setTimeout(() => {
        hardKill = null;
        kill('SIGKILL');
      }, killGraceMs);
    };
    const abort = () => { aborted = true; terminate(); };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    const complete = ({ exitCode, childSignal, error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      if (groupPoll) clearTimeout(groupPoll);
      signal?.removeEventListener('abort', abort);
      resolve({
        exitCode,
        signal: childSignal,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        stdoutHash: `sha256:${stdoutDigest.digest('hex')}`,
        stderrHash: `sha256:${stderrDigest.digest('hex')}`,
        stdoutBytes,
        stderrBytes,
        outputTruncated: stdoutBytes > stdout.length || stderrBytes > stderr.length,
        error,
        timedOut,
        aborted,
        pid: Number.isSafeInteger(child.pid) ? child.pid : null,
      });
    };
    const finish = (outcome) => {
      if (settled) return;
      if (terminationRequested && processGroupAlive()) {
        pendingOutcome ||= outcome;
        if (!groupPoll) {
          const poll = () => {
            groupPoll = null;
            if (!processGroupAlive() || Date.now() >= reapDeadline) complete(pendingOutcome);
            else groupPoll = setTimeout(poll, 20);
          };
          groupPoll = setTimeout(poll, 20);
        }
        return;
      }
      complete(outcome);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout?.on('data', (chunk) => {
      stdoutDigest.update(chunk);
      stdoutBytes += chunk.length;
      stdout = appendTail(stdout, chunk, maximumCapturedBytes);
    });
    child.stderr?.on('data', (chunk) => {
      stderrDigest.update(chunk);
      stderrBytes += chunk.length;
      stderr = appendTail(stderr, chunk, maximumCapturedBytes);
    });
    child.on('error', (error) => finish({ exitCode: null, childSignal: null, error }));
    child.on('close', (exitCode, childSignal) => finish({ exitCode, childSignal, error: null }));
    if (stdin !== null) child.stdin?.end(stdin);
  });
}
