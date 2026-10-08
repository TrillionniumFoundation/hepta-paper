import assert from 'node:assert/strict';
import test from 'node:test';

import {
  embeddedFormalEvidenceBlockers,
} from '../../paper-domain/research/formal-certificate-embedded-evidence-verifier.mjs';

const hash = (character) => `sha256:${character.repeat(64)}`;

test('embedded formal evidence rejects duplicate source paths and hashes', () => {
  const source = {
    path: 'Formal.lean',
    hash: hash('a'),
    sourceReadReceiptHash: hash('b'),
    artifactWriteReceipt: null,
  };
  const blockers = embeddedFormalEvidenceBlockers({
    verifierKind: 'lean',
    sourceRecords: [source, { ...source, path: 'Other.lean' }],
  });
  assert.ok(blockers.includes('formal_certificate_intake_embedded_source_hash_duplicate'));

  const pathBlockers = embeddedFormalEvidenceBlockers({
    verifierKind: 'lean',
    sourceRecords: [source, { ...source, hash: hash('c') }],
  });
  assert.ok(pathBlockers.includes('formal_certificate_intake_embedded_source_path_duplicate'));

  const executionBlockers = embeddedFormalEvidenceBlockers({
    verifierKind: 'lean',
    sourceRecords: [source],
    executionReceipt: { sourceHashes: [hash('a'), hash('a')] },
  });
  assert.ok(executionBlockers.includes(
    'formal_certificate_intake_embedded_execution_source_hash_duplicate',
  ));
});
