import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const releaseEvidenceTest = path.join(
  repositoryRoot,
  'paper-core/tests/release-evidence-selection.test.mjs',
);

test('the non-Ed25519 rejection fixture never regresses to a weak RSA key', () => {
  const source = fs.readFileSync(releaseEvidenceTest, 'utf8');
  assert.equal(
    source.includes("crypto.generateKeyPairSync('rsa', { modulusLength: 1024 })"),
    false,
  );
  assert.equal(
    source.includes("crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })"),
    true,
  );
});
