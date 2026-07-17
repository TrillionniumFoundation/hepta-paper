import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeDescriptorFullySync } from '../../workflow-kernel/runtime/file-descriptor-utils.mjs';
import { fsyncDirectorySync } from './durable-json-repository.mjs';

export function writeDurableTextSync(candidate, value, { mode = 0o600 } = {}) {
  const destination = path.resolve(candidate);
  const parent = path.dirname(destination);
  const temporary = path.join(parent, `.${path.basename(destination)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      mode,
    );
    writeDescriptorFullySync(descriptor, value);
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
