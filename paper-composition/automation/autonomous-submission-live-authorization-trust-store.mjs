import path from 'node:path';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';

export function readCurrentLiveAuthorizationTrustStore(runtimeRoot) {
  const trustRoot = path.join(path.resolve(runtimeRoot), 'trust');
  const candidate = path.join(trustRoot, 'AUTHORITY_TRUST_STORE.json');
  const read = readScopedFileSync({ scopeRoot: trustRoot, candidate });
  if (read.status !== 'scoped_file_read_verified') return null;
  try { return JSON.parse(read.content.toString('utf8')); }
  catch { return null; }
}
