import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Synchronous fixture only. Never mutate an inherited/shared Cargo target.
export function withPrivateReplayTargetFixture(operation) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-private-replay-target-'));
  const target = path.join(root, 'target');
  const previous = process.env.CARGO_TARGET_DIR;
  try {
    fs.mkdirSync(target, { mode: 0o700 });
    process.env.CARGO_TARGET_DIR = target;
    return operation(target);
  } finally {
    if (previous === undefined) delete process.env.CARGO_TARGET_DIR;
    else process.env.CARGO_TARGET_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
