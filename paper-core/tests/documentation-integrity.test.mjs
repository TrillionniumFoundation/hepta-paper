import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  REQUIRED_MODULE_HEADINGS,
  inspectDocumentationIntegrity,
  inspectLocalMarkdownTarget,
  inspectMarkdownDocument,
} from '../bin/documentation-integrity.mjs';

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

test('documentation contract rejects an undersized module with missing headings', () => {
  const blockers = inspectMarkdownDocument({
    relativePath: 'example/README.md',
    text: '# example\n\n## Purpose\nsmall\n',
    minimumBytes: 1_500,
    requiredHeadings: REQUIRED_MODULE_HEADINGS,
  });
  assert.ok(blockers.includes('documentation_too_small:example/README.md'));
  assert.ok(blockers.includes(
    'documentation_heading_missing:example/README.md:## Responsibilities',
  ));
  assert.ok(blockers.includes(
    'documentation_heading_missing:example/README.md:## Change rules',
  ));
});

test('local Markdown target rejects workspace escape and missing files', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-doc-links-'));
  try {
    fs.mkdirSync(path.join(fixture, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'docs', 'source.md'), '# source\n');
    assert.match(
      inspectLocalMarkdownTarget({
        workspaceRoot: fixture,
        sourcePath: 'docs/source.md',
        rawTarget: '../../outside.md',
      }),
      /^documentation_link_escape:/u,
    );
    assert.match(
      inspectLocalMarkdownTarget({
        workspaceRoot: fixture,
        sourcePath: 'docs/source.md',
        rawTarget: 'missing.md',
      }),
      /^documentation_link_missing:/u,
    );
    fs.writeFileSync(path.join(fixture, 'docs', 'target.md'), '# target\n');
    assert.equal(inspectLocalMarkdownTarget({
      workspaceRoot: fixture,
      sourcePath: 'docs/source.md',
      rawTarget: 'target.md#section',
    }), null);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('repository documentation closes every declared coverage and link requirement', () => {
  const report = inspectDocumentationIntegrity({ workspaceRoot });
  assert.equal(report.status, 'documentation_integrity_ready');
  assert.equal(report.ready, true);
  assert.deepEqual(report.blockers, []);
  assert.ok(report.checkedFiles.includes('README.md'));
  assert.ok(report.checkedFiles.includes('paper-domain/README.md'));
  assert.ok(report.checkedFiles.includes('docs/security/threat-model.md'));
});
