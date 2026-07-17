import crypto from 'node:crypto';
import { assertIdGeneratorPort } from '../../paper-ports/id-generator-port.mjs';

export function createRandomIdGenerator() {
  return assertIdGeneratorPort(Object.freeze({
    version: 1,
    kind: 'RandomUuidGeneratorAdapter',
    next(namespace = 'id') {
      return `${String(namespace || 'id')}:${crypto.randomUUID()}`;
    },
  }));
}
