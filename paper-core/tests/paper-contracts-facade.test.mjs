import assert from 'node:assert/strict';
import test from 'node:test';
import * as facade from '../src/paper-contracts.mjs';
import * as product from '../src/contracts/product-profile.mjs';
import * as proposal from '../src/contracts/proposal-contracts.mjs';
import * as research from '../src/contracts/research-contracts.mjs';
import * as workflow from '../src/contracts/workflow-contracts.mjs';
import * as venue from '../src/contracts/venue-contracts.mjs';

test('paper-contracts remains a thin compatibility facade over bounded modules', () => {
  assert.equal(Object.keys(facade).length, 73);
  for (const module of [product, proposal, research, workflow, venue]) {
    for (const [name, value] of Object.entries(module)) assert.equal(facade[name], value, name);
  }
  const brief = proposal.createPaperIdeaBrief({ idea: 'Bounded contract modules' });
  assert.equal(brief.kind, 'PaperIdeaBrief');
  const task = workflow.createPaperTask({ paperId: 'fixture', canonicalDir: 'fixture' });
  assert.equal(task.kind, 'PaperTask');
  const claim = research.createClaimScopeContract({ paperTask: task, claims: ['claim'] });
  assert.equal(claim.kind, 'ClaimScopeContract');
});
