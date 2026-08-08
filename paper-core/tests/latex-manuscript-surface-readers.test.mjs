import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';
import {
  extractMarkerDelimitedManuscriptSurfaces,
} from '../../paper-adapters/research-verify/latex-manuscript-reader-support.mjs';
import {
  extractFormalSupportSurfaces,
} from '../../paper-adapters/research-verify/formal-support-surface-reader.mjs';
import {
  extractEvidenceBoundManuscriptSurfaces,
} from '../../paper-adapters/research-verify/evidence-bound-manuscript-surface-reader.mjs';
import {
  readEmpiricalClaimUniverse,
} from '../../paper-adapters/research-verify/empirical-claim-universe-reader.mjs';

const FILE_HASH = `sha256:${'1'.repeat(64)}`;

function manuscriptRead(content) {
  return Object.freeze({
    content: Buffer.from(content, 'utf8'),
    hash: FILE_HASH,
  });
}

test('shared marker reader preserves byte ranges, UTF-8 content hashes, and marker state', () => {
  const beginLine = 'FIXTURE_BEGIN {"id":"surface"}\r\n';
  const bodyLine = '  Body α  \r\n';
  const endLine = 'FIXTURE_END surface\r\n';
  const read = manuscriptRead(`${beginLine}${bodyLine}${endLine}`);
  const extracted = extractMarkerDelimitedManuscriptSurfaces({
    relative: 'main.tex',
    read,
    beginPattern: /^FIXTURE_BEGIN\s+(\{.*\})$/,
    endPattern: /^FIXTURE_END\s+([a-z]+)$/,
    markerToken: /FIXTURE_(?:BEGIN|END)/,
    blockerPrefix: 'fixture',
    bodyInvalidSuffix: 'body_invalid',
    declarationValid: (declaration) => declaration?.id === 'surface',
    declarationIdentity: (declaration) => declaration.id,
    declarationTransform: Object.freeze,
    bodyValid: ({ text }) => text === 'Body α',
  });
  assert.deepEqual(extracted.blockers, []);
  assert.equal(extracted.surfaces.length, 1);
  assert.deepEqual(extracted.surfaces[0], {
    declaration: { id: 'surface' },
    manuscriptPath: 'main.tex',
    manuscriptFileHash: FILE_HASH,
    markerByteStart: 0,
    markerByteEnd: read.content.length,
    manuscriptByteStart: Buffer.byteLength(beginLine) + 2,
    manuscriptByteEnd: Buffer.byteLength(beginLine) + Buffer.byteLength('  Body α'),
    manuscriptContentHash: hashBytes(Buffer.from('Body α', 'utf8')),
    text: 'Body α',
  });

  const invalidSource = [
    'FIXTURE_BEGIN {"id":"surface"}',
    'FIXTURE_BEGIN {"id":"surface"}',
    'Body',
    'FIXTURE_END wrong',
    'FIXTURE_END surface',
    'FIXTURE_BEGIN {"id":"surface"}',
    '',
  ].join('\n');
  const invalid = extractMarkerDelimitedManuscriptSurfaces({
    relative: 'nested.tex',
    read: manuscriptRead(invalidSource),
    beginPattern: /^FIXTURE_BEGIN\s+(\{.*\})$/,
    endPattern: /^FIXTURE_END\s+([a-z]+)$/,
    markerToken: /FIXTURE_(?:BEGIN|END)/,
    blockerPrefix: 'fixture',
    bodyInvalidSuffix: 'body_invalid',
    declarationValid: (declaration) => declaration?.id === 'surface',
    declarationIdentity: (declaration) => declaration.id,
    bodyValid: () => true,
  });
  assert.deepEqual(invalid.surfaces, []);
  assert.deepEqual(invalid.blockers, [
    `fixture_marker_nested:nested.tex:${invalidSource.indexOf('FIXTURE_BEGIN', 1)}`,
    `fixture_marker_id_mismatch:nested.tex:${invalidSource.indexOf('FIXTURE_END wrong')}`,
    `fixture_marker_end_unpaired:nested.tex:${invalidSource.indexOf('FIXTURE_END surface')}`,
    `fixture_marker_unterminated:nested.tex:${invalidSource.lastIndexOf('FIXTURE_BEGIN')}`,
  ]);
});

test('all research surface readers retain their exact fail-closed marker errors', (t) => {
  const cases = [{
    label: 'formal support',
    begin: '% HEPTA_FORMAL_SUPPORT_BEGIN not-json',
    end: '% HEPTA_FORMAL_SUPPORT_END orphan',
    extract: (read) => extractFormalSupportSurfaces({
      relative: 'main.tex',
      read,
      trustedAuthority: null,
    }),
    prefix: 'autonomous_formal_support',
  }, {
    label: 'evidence-bound prose',
    begin: '% HEPTA_EVIDENCE_BOUND_PROSE_BEGIN not-json',
    end: '% HEPTA_EVIDENCE_BOUND_PROSE_END orphan',
    extract: (read) => extractEvidenceBoundManuscriptSurfaces({
      relative: 'main.tex',
      read,
      trustedManuscriptIr: null,
    }),
    prefix: 'evidence_bound_manuscript',
  }];
  for (const fixture of cases) {
    t.test(fixture.label, () => {
      const content = `${fixture.begin}\n${fixture.end}\n`;
      const result = fixture.extract(manuscriptRead(content));
      assert.deepEqual(result.blockers, [
        `${fixture.prefix}_marker_malformed:main.tex:0`,
        `${fixture.prefix}_marker_end_unpaired:main.tex:${fixture.begin.length + 1}`,
      ]);
    });
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-marker-reader-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const empiricalBegin = '% HEPTA_EMPIRICAL_CLAIM_BEGIN not-json';
  fs.writeFileSync(path.join(root, 'main.tex'), [
    empiricalBegin,
    '% HEPTA_EMPIRICAL_CLAIM_END orphan',
    '',
  ].join('\n'));
  const empirical = readEmpiricalClaimUniverse({ sourceRoot: root });
  assert.deepEqual(empirical.blockers, [
    'empirical_claim_universe_marker_malformed:main.tex:0',
    `empirical_claim_universe_marker_end_unpaired:main.tex:${empiricalBegin.length + 1}`,
    'empirical_claim_universe_claims_missing',
  ]);
});
