import fs from 'node:fs';

export function writeDescriptorFullySync(descriptor, value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(descriptor, buffer, offset, buffer.length - offset, null);
    if (!written) throw new Error('descriptor_write_made_no_progress');
    offset += written;
  }
  return offset;
}

export function readDescriptorFullySync(descriptor, length, { position = 0 } = {}) {
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('descriptor_read_length_invalid');
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < buffer.length) {
    const readPosition = position === null ? null : position + offset;
    const bytesRead = fs.readSync(descriptor, buffer, offset, buffer.length - offset, readPosition);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return Object.freeze({ buffer, bytesRead: offset });
}
