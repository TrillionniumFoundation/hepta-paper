import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export function withArtifactWriteContext(services, callback) {
  return storage.run(services || {}, callback);
}

export function enterArtifactWriteContext(services) {
  storage.enterWith(services || {});
}

export function currentArtifactWriteContext() {
  return storage.getStore() || null;
}
