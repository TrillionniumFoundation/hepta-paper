import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { generateChangeImpact } from '../../docs/tools/generate-change-impact.mjs';

function writeJson(root, relative, value) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value)}\n`);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-impact-'));
  writeJson(root, 'docs/system/truth/modules.v1.json', {schemaVersion:1,modules:{'module.alpha':{paths:['src/alpha'],capabilityIds:['CAP-A'],authority:'prepared_result_only',owners:['TEAM-A','TEAM-B','TEAM-C'],dependencies:[],workItemIds:['A-001'],qualification:'source'}}});
  writeJson(root, 'docs/system/truth/capabilities.v1.json', {schemaVersion:1,capabilities:{'CAP-A':{moduleIds:['module.alpha'],workItemIds:['A-001'],externalBlockerIds:[]}}});
  writeJson(root, 'docs/system/truth/work-items.v2.json', {schemaVersion:2,items:{'A-001':{moduleId:'module.alpha',capabilityIds:['CAP-A']}}});
  writeJson(root, 'docs/system/truth/milestones.v1.json', {schemaVersion:1,milestones:{G1:{workItemIds:['A-001']}}});
  writeJson(root, 'docs/system/truth/risks.v2.json', {schemaVersion:2,risks:{'RISK-1':{milestones:['G1']}}});
  writeJson(root, 'docs/system/truth/evidence-bindings.v1.json', {schemaVersion:1,bindings:{'CAP-A':{moduleIds:['module.alpha'],workItemIds:['A-001'],externalBlockerIds:[],canonicalWorkloadIds:['WL-A'],contractPaths:['docs/modules/specs/alpha.md'],validationPaths:['tests/alpha.test.mjs'],requiredSourceContexts:['alpha-check']}}});
  writeJson(root, 'docs/system/truth/canonical-workloads.v1.json', {schemaVersion:1,workloads:[{workloadId:'WL-A'}]});
  writeJson(root, 'docs/modules/module-documentation.v1.json', {schemaVersion:1,modules:{'module.alpha':{specPath:'docs/modules/specs/alpha.md',manifestPath:'docs/modules/manifests/alpha.v1.json'}}});
  return root;
}

test('maps one implementation change through module capability work milestone risk and evidence', () => {
  const root = fixture();
  try {
    const result = generateChangeImpact({root, changedPaths:['src/alpha/lib.mjs'], base:'base', head:'head'});
    assert.deepEqual(result.changedModuleIds, ['module.alpha']);
    assert.deepEqual(result.changedCapabilityIds, ['CAP-A']);
    assert.deepEqual(result.changedWorkItemIds, ['A-001']);
    assert.deepEqual(result.changedMilestoneIds, ['G1']);
    assert.deepEqual(result.changedRiskIds, ['RISK-1']);
    assert.deepEqual(result.changedEvidenceBindingIds, ['CAP-A']);
    assert.deepEqual(result.canonicalWorkloadIds, ['WL-A']);
    assert.deepEqual(result.requiredWorkflowContexts, ['alpha-check']);
    assert.equal(result.grantsAuthority, false);
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
});

test('common module protocol change conservatively reaches every module', () => {
  const root = fixture();
  try {
    const result = generateChangeImpact({root, changedPaths:['docs/modules/MODULE_PROTOCOL.md']});
    assert.deepEqual(result.changedModuleIds, ['module.alpha']);
    assert.equal(result.emptyImpact, false);
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
});

test('unregistered documentation path reports an explicit empty impact', () => {
  const root = fixture();
  try {
    const result = generateChangeImpact({root, changedPaths:['notes/unrelated.txt']});
    assert.equal(result.emptyImpact, true);
    assert.deepEqual(result.changedModuleIds, []);
    assert.match(result.rollbackDisposition[0], /no registered module/);
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
});
