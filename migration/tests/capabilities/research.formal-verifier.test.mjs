import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createLakeFormalVerifier } from '../../../paper-adapters/research-verify/lake-formal-verifier.mjs';
import { temporaryDirectory } from './test-support.mjs';

test('research.formal-verifier binds Lake project lock and replays certificate inputs', async (t) => {
  const root = await temporaryDirectory(t);
  await Promise.all([fsp.writeFile(path.join(root, 'lakefile.lean'), 'import Lake\n'), fsp.writeFile(path.join(root, 'lean-toolchain'), 'leanprover/lean4:v4.20.0\n'), fsp.writeFile(path.join(root, 'lake-manifest.json'), '{}\n')]);
  const verifier = createLakeFormalVerifier({ projectRoot: root, commandRunner: { run: async () => ({ ok: true, receiptHash: 'r' }) } });
  const certificate = await verifier.verify();
  assert.equal(certificate.status, 'formal_certificate_verified');
  assert.equal((await verifier.replay({ certificateBundle: certificate })).status, 'formal_certificate_replay_verified');
});
