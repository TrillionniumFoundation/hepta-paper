import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeDescriptorFullySync } from '../../workflow-kernel/runtime/file-descriptor-utils.mjs';

export function fsyncDirectorySync(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

export function writeDurableJsonSync(candidate, value, { mode = 0o600 } = {}) {
  const destination = path.resolve(candidate);
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.${path.basename(destination)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      mode,
    );
    writeDescriptorFullySync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, destination);
    fsyncDirectorySync(parent);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}
