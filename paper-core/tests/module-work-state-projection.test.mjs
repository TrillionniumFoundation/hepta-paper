import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWorkStateProjection } from '../../docs/tools/validate-module-documentation.mjs';

const record = { workItemIds: ['MIG-003', 'LEGACY-REPLAY-001'] };
const work = { 'MIG-003': { state: 'source_implemented' }, 'LEGACY-REPLAY-001': { state: 'blocked_external' } };
const valid = '## Open blockers\n\n- `MIG-003` — `source_implemented`\n- `LEGACY-REPLAY-001` — `blocked_external`\n';
const validate = (source) => validateWorkStateProjection('module.compatibility-kernel', record, source, work);

test('exact current source and external states are accepted without promoting qualification', () => {
  assert.deepEqual(validate(valid), []);
  assert.deepEqual(work['LEGACY-REPLAY-001'], { state: 'blocked_external' });
});
for (const [name, value, pattern] of [
  ['stale source state', valid.replace('source_implemented', 'design_ready'), /differs from source_implemented/],
  ['fabricated authority', valid.replace('blocked_external', 'production_active'), /differs from blocked_external/],
  ['missing row', valid.replace('- `MIG-003` — `source_implemented`\n', ''), /missing projected/],
  ['duplicate row', `${valid}- \`MIG-003\` — \`source_implemented\`\n`, /duplicate projected/],
  ['unknown row', `${valid}- \`FAKE-001\` — \`source_implemented\`\n`, /unknown projected/],
  ['unrelated known row', valid.replace('MIG-003', 'LEGACY-REPLAY-001'), /duplicate projected/],
  ['malformed row', valid.replace('—', ':'), /malformed work-state/],
  ['duplicate section', `${valid}\n${valid}`, /missing unique/],
  ['heading hidden inside fence', `\x60\x60\x60text\n${valid}\x60\x60\x60\n`, /missing unique/],
]) {
  test(`module state projection rejects ${name}`, () => assert.match(validate(value).join('\n'), pattern));
}
