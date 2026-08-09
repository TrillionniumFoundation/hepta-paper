import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';
import {
  extractMarkerDelimitedManuscriptSurfaces,
  literalManuscriptIncludes,
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

function includeSyntax(source, options = {}) {
  return literalManuscriptIncludes({
    masked: Buffer.from(source, 'utf8').toString('latin1'),
    relative: 'main.tex',
    blockerPrefix: 'fixture',
    ...options,
  });
}

test('shared literal include reader fails closed on malformed groups and unsafe paths', () => {
  const malformed = [{
    source: '\\input dynamic',
    blocker: 'fixture_include_not_literal:main.tex:0',
  }, {
    source: '\\input{unterminated',
    blocker: 'fixture_include_not_literal:main.tex:0',
  }, {
    source: '\\include{{nested}}',
    blocker: 'fixture_include_not_literal:main.tex:0',
  }, {
    source: '\\input{/absolute}',
    blocker: 'fixture_include_path_invalid:main.tex:/absolute',
  }, {
    source: '\\input{../escape}',
    blocker: 'fixture_include_path_invalid:main.tex:../escape',
  }, {
    source: '\\include{bad name}',
    blocker: 'fixture_include_path_invalid:main.tex:bad name',
  }];
  for (const { source, blocker } of malformed) {
    const parsed = includeSyntax(source);
    assert.deepEqual(parsed.includes, [], source);
    assert.deepEqual(parsed.blockers, [blocker], source);
    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(Object.isFrozen(parsed.includes), true);
    assert.equal(Object.isFrozen(parsed.blockers), true);
  }

  const recovered = includeSyntax('\\input{{nested}}\n\\include{valid}');
  assert.deepEqual(recovered.blockers, [
    'fixture_include_not_literal:main.tex:0',
  ]);
  assert.deepEqual(recovered.includes, [{
    path: 'valid.tex',
    byteStart: Buffer.byteLength('\\input{{nested}}\n'),
    byteEnd: Buffer.byteLength('\\input{{nested}}\n\\include{valid}'),
  }]);
});

test('shared literal include reader preserves normalized paths and UTF-8 CRLF byte offsets', () => {
  const prefix = 'α\r\n';
  const command = '\\input {../shared/claim}';
  const source = `${prefix}${command}\r\n`;
  const parsed = includeSyntax(source, { relative: 'sections/main.tex' });
  assert.deepEqual(parsed.blockers, []);
  assert.deepEqual(parsed.includes, [{
    path: 'shared/claim.tex',
    byteStart: Buffer.byteLength(prefix),
    byteEnd: Buffer.byteLength(prefix) + Buffer.byteLength(command),
  }]);

  const extensions = includeSyntax('\\input{chapter}\\include{appendix.tex}', {
    relative: 'book/main.tex',
  });
  assert.deepEqual(extensions.blockers, []);
  assert.deepEqual(extensions.includes.map(({ path: included }) => included), [
    'book/chapter.tex',
    'book/appendix.tex',
  ]);
});

test('shared literal include reader ignores escaped commands without hiding later literals', () => {
  const escaped = includeSyntax('\\\\input{ghost}\\n\\input{real}');
  assert.deepEqual(escaped.blockers, []);
  assert.deepEqual(escaped.includes, [{
    path: 'real.tex',
    byteStart: Buffer.byteLength('\\\\input{ghost}\\n'),
    byteEnd: Buffer.byteLength('\\\\input{ghost}\\n\\input{real}'),
  }]);

  const oddBackslashRun = includeSyntax('\\\\\\input{visible}');
  assert.deepEqual(oddBackslashRun.blockers, []);
  assert.deepEqual(oddBackslashRun.includes, [{
    path: 'visible.tex',
    byteStart: 2,
    byteEnd: Buffer.byteLength('\\\\\\input{visible}'),
  }]);
});

test('shared literal include reader preserves all three caller result shapes', () => {
  const source = '\\input{part}';
  const byteEnd = Buffer.byteLength(source);
  const cases = [{
    label: 'empirical claim universe',
    mapInclude: ({ path: included, byteStart }) => ({
      path: included,
      offset: byteStart,
    }),
    expected: { path: 'part.tex', offset: 0 },
  }, {
    label: 'empirical assertion universe',
    mapInclude: ({ path: included, byteStart, byteEnd: end }) => ({
      path: included,
      offset: byteStart,
      end,
    }),
    expected: { path: 'part.tex', offset: 0, end: byteEnd },
  }, {
    label: 'formal claim universe',
    mapInclude: ({ path: included, byteStart, byteEnd: end }) => ({
      manuscriptPath: included,
      byteStart,
      byteEnd: end,
    }),
    expected: { manuscriptPath: 'part.tex', byteStart: 0, byteEnd },
  }];
  for (const { label, mapInclude, expected } of cases) {
    const parsed = includeSyntax(source, { mapInclude });
    assert.deepEqual(parsed.blockers, [], label);
    assert.deepEqual(parsed.includes, [expected], label);
    assert.equal(Object.isFrozen(parsed.includes[0]), true, label);
  }
});

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
