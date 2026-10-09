import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function moduleDocument(name) {
  return fs.readFileSync(new URL(`../../docs/modules/${name}.md`, import.meta.url), 'utf8');
}

test('module reviewer guidance scopes independence to evidence contracts without staffing gates', () => {
  const model = moduleDocument('MODULE_MODEL');
  const template = moduleDocument('MODULE_TEMPLATE');
  const conformance = moduleDocument('MODULE_CONFORMANCE');

  for (const source of [model, template, conformance]) {
    assert.match(source, /independentReviewerTeam/u);
    assert.match(source, /no\s+(?:ordinary\s+PR|human)\s+approval count or staffing quota/u);
    assert.match(source, /explicitly requires independent\s+scientific or operational evidence/u);
  }
  for (const source of [template, conformance]) {
    assert.ok(source.includes('(MODULE_MODEL.md#10-ownership-model)'));
  }
  assert.ok(model.includes('(../governance/OWNERSHIP_AND_REVIEW.md)'));
  assert.ok(model.includes('(../qualification/EXTERNAL_AUTHORITY.md)'));
  for (const gap of ['GAP-HOST-001', 'GAP-HOST-002', 'GAP-KEY-001', 'GAP-CODEX-001', 'GAP-REL-001']) {
    assert.ok(model.includes(`\`${gap}\``), gap);
  }
  assert.match(conformance, /^producer identity\nindependent reviewer identity where explicitly required by the evidence contract$/mu);
  assert.doesNotMatch(conformance, /^producer and independent reviewer identity$/mu);
});
