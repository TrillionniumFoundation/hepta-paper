import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

function appendTail(current, chunk, limit) {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  return next.length <= limit ? next : next.subarray(next.length - limit);
}

export function runBoundedChildProcess({
  spawnImpl = spawn,
  executable,
  args = [],
  cwd,
  env = process.env,
  stdin = null,
  timeoutMs,
  signal = null,
  maximumCapturedBytes = 1024 * 1024,
  killGraceMs = 5000,
} = {}) {
  if (!executable || !cwd || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('bounded child process requires executable, cwd and positive timeoutMs');
  }
  return new Promise((resolve) => {
    const useProcessGroup = process.platform !== 'win32';
    const child = spawnImpl(executable, args, {
      cwd,
      env: { ...env },
      stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
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
    const kill = (signalName) => {
      if (useProcessGroup && child.pid) {
        try { process.kill(-child.pid, signalName); return; } catch { /* already exited */ }
      }
      child.kill(signalName);
    };
    const terminate = () => {
      kill('SIGTERM');
      hardKill ||= setTimeout(() => kill('SIGKILL'), killGraceMs);
      hardKill.unref?.();
    };
    const abort = () => { aborted = true; terminate(); };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    const finish = ({ exitCode, childSignal, error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
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
      });
    };
    signal?.addEventListener('abort', abort, { once: true });
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
