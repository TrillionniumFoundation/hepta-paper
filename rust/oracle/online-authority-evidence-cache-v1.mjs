// Actual Node passive-cache contract and filesystem oracle. No signature in this
// test fixture grants authority; this cache is explicitly passive status only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createAutonomousResearchOnlineAuthorityEvidenceCache as create,
  assertAutonomousResearchOnlineAuthorityEvidenceCache as validate,
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_CONTRACT_HASH as contractHash,
} from '../../paper-domain/automation/autonomous-research-online-authority-evidence-cache-contract.mjs';
import {
  createAutonomousResearchOnlineAuthorityEvidenceCacheReader as reader,
  createAutonomousResearchOnlineAuthorityEvidenceCacheWriter as writer,
} from '../../paper-adapters/automation/autonomous-research-online-authority-evidence-cache.mjs';
import { verifiedRoot, openScopedDirectoryChain, descriptorEntryPath } from '../../paper-adapters/runtime/scoped-file-materialization-path-io.mjs';
import { acquireTargetLock, releaseTargetLock, bindTargetLockTemporary } from '../../paper-adapters/runtime/scoped-file-materialization-target-lock.mjs';
import { materializationIdentityFromStat as identity } from '../../paper-adapters/runtime/scoped-file-materialization-recovery-record.mjs';
assert.equal(process.version, 'v22.23.1');
if (process.argv[2] === 'lock') {
  const parent = openScopedDirectoryChain(verifiedRoot(process.argv[3]), 'automation-cache/online-authority-evidence-v1', { create: true });
  const lock = acquireTargetLock(parent, 'current.json', 'synthetic-cache-interoperability');
  if (['v5', 'v6'].includes(process.argv[4])) {
    const fd = fs.openSync(descriptorEntryPath(parent.descriptor, lock.stageEntryName), 'wx', 0o600);
    const entry = identity(fs.fstatSync(fd, { bigint: true }));
    bindTargetLockTemporary(parent, lock, 'current.json', entry);
    if (process.argv[4] === 'v6') {
      fs.writeSync(fd, 'synthetic interrupted cache payload');
      fs.fchmodSync(fd, 0o400);
      fs.fsyncSync(fd);
      bindTargetLockTemporary(parent, lock, 'current.json', entry, identity(fs.fstatSync(fd, { bigint: true })));
    }
    fs.closeSync(fd);
  }
  process.stdout.write('locked\n');
  process.stdin.once('data', () => { releaseTargetLock(parent, lock, 'current.json'); fs.closeSync(parent.descriptor); });
} else {
  const requests = JSON.parse(fs.readFileSync(0, 'utf8'));
  const results = requests.map(request => {
    try {
      if (request.operation === 'create') return { ok: create(request.input) };
      if (request.operation === 'validate') return { ok: validate(request.document, request.options) };
      if (request.operation === 'write') return { ok: writer({ runtimeRoot: request.root }).recordActiveAuthorityEvidence(request.input) };
      if (request.operation === 'read') return { ok: reader({ runtimeRoot: request.root }).readPassiveAuthorityEvidence(request.options) };
      throw new Error('unknown fixture operation');
    } catch (error) { return { error: error.message }; }
  });
  process.stdout.write(JSON.stringify({ contractHash, results }));
}
