import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateModuleDocumentation } from '../../docs/tools/validate-module-documentation.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

function copyFile(sourceRoot, targetRoot, relative) {
  const source = path.join(sourceRoot, relative);
  const target = path.join(targetRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-module-docs-'));
  const registryPath = 'docs/system/truth/modules.v1.json';
  const indexPath = 'docs/modules/module-documentation.v1.json';
  copyFile(ROOT, root, registryPath);
  copyFile(ROOT, root, indexPath);
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, registryPath), 'utf8'));
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, indexPath), 'utf8'));
  for (const [moduleId, entry] of Object.entries(index.modules)) {
    copyFile(ROOT, root, entry.specPath);
    copyFile(ROOT, root, entry.manifestPath);
    for (const configuredPath of registry.modules[moduleId].paths) {
      const target = path.join(root, configuredPath);
      if (path.extname(configuredPath)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'fixture\n');
      } else {
        fs.mkdirSync(target, { recursive: true });
      }
    }
  }
  for (const relative of [
    'docs/system/truth/work-items.v2.json',
    'docs/system/schemas/modules-v1.schema.json',
    'docs/system/schemas/work-items-v2.schema.json',
    'docs/modules/schemas/module-documentation-index-v1.schema.json',
    'docs/modules/schemas/module-documentation-manifest-v1.schema.json',
  ]) copyFile(ROOT, root, relative);
  return root;
}

test('live repository has complete one-to-one module documentation', () => {
  const result = validateModuleDocumentation({ root: ROOT });
  assert.equal(result.ok, true, result.failures.join('\n'));
  assert.equal(result.report.registryModules, 32);
  assert.equal(result.report.specifications, 32);
  assert.equal(result.report.manifests, 32);
});

test('missing required section fails closed', () => {
  const root = createFixture();
  try {
    const index = JSON.parse(fs.readFileSync(path.join(root, 'docs/modules/module-documentation.v1.json'), 'utf8'));
    const entry = index.modules['module.submission-port'];
    const spec = fs.readFileSync(path.join(root, entry.specPath), 'utf8').replace('## Failure, recovery, and idempotency', '## Removed failure section');
    fs.writeFileSync(path.join(root, entry.specPath), spec);
    const result = validateModuleDocumentation({ root });
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /missing heading/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('authority-specific safety language and registry parity fail closed', () => {
  const root = createFixture();
  try {
    const index = JSON.parse(fs.readFileSync(path.join(root, 'docs/modules/module-documentation.v1.json'), 'utf8'));
    const entry = index.modules['module.commit-sequencer'];
    const manifest = JSON.parse(fs.readFileSync(path.join(root, entry.manifestPath), 'utf8'));
    manifest.authorityClass = 'read_only';
    fs.writeFileSync(path.join(root, entry.manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
    const result = validateModuleDocumentation({ root });
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /authorityClass mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function changeJson(root, relative, mutate) {
  const file = path.join(root, relative);
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const replacement = mutate(value);
  fs.writeFileSync(file, `${JSON.stringify(replacement === undefined ? value : replacement)}\n`);
}

const WRITER_MANIFEST = 'docs/modules/manifests/commit-sequencer.v1.json';
const WRITER_SPEC = 'docs/modules/specs/commit-sequencer.md';
const hostileCases = [
  ['null registry', (root) => changeJson(root, 'docs/system/truth/modules.v1.json', () => null), /schema/],
  ['null module entry', (root) => changeJson(root, 'docs/modules/module-documentation.v1.json', (value) => {
    value.modules['module.commit-sequencer'] = null;
  }), /schema/],
  ['empty closed-world inventory', (root) => {
    changeJson(root, 'docs/system/truth/modules.v1.json', (value) => { value.modules = {}; });
    changeJson(root, 'docs/modules/module-documentation.v1.json', (value) => { value.modules = {}; });
  }, /schema/],
  ['missing specification path', (root) => changeJson(root, 'docs/modules/module-documentation.v1.json', (value) => {
    delete value.modules['module.commit-sequencer'].specPath;
  }), /schema/],
  ['mandatory section substitution', (root) => changeJson(root, 'docs/modules/module-documentation.v1.json', (value) => {
    value.requiredSections[1] = 'Different heading';
  }), /schema/],
  ['non-array implementation paths', (root) => changeJson(root, WRITER_MANIFEST, (value) => {
    value.implementationPaths = 'rust/crates/hepta-campaign-writer';
  }), /schema/],
  ['unknown authority extension', (root) => changeJson(root, WRITER_MANIFEST, (value) => {
    value.privilegedOverride = true;
  }), /schema/],
  ['numeric boolean disguise', (root) => changeJson(root, WRITER_MANIFEST, (value) => {
    value.rollout.productionActivation = 0;
  }), /schema/],
  ['production activation', (root) => changeJson(root, WRITER_MANIFEST, (value) => {
    value.rollout.productionActivation = true;
  }), /schema/],
  ['implicit resource capacity', (root) => changeJson(root, WRITER_MANIFEST, (value) => {
    value.resourceProfile.implicitCapacityAllowed = true;
  }), /schema/],
  ['unbounded child concurrency', (root) => changeJson(root, WRITER_MANIFEST, (value) => {
    value.resourceProfile.unboundedChildConcurrencyAllowed = true;
  }), /schema/],
  ['missing rollback requirement', (root) => changeJson(root, WRITER_MANIFEST, (value) => {
    delete value.rollout.rollbackTargetRequired;
  }), /schema/],
  ['weakened safety counters', (root) => changeJson(root, WRITER_MANIFEST, (value) => {
    value.sloProfile.zeroToleranceSafetyCountersRequired = false;
  }), /schema/],
  ['static activation drift', (root) => changeJson(root, WRITER_MANIFEST, (value) => {
    value.rollout.currentStaticActivation = 'authoritative';
  }), /static activation mismatch/],
  ['writer mutual-exclusion removal', (root) => changeJson(root, WRITER_MANIFEST, (value) => {
    value.rollout.mutualExclusionRequired = false;
  }), /mutual exclusion/],
  ['side-effect authority escalation', (root) => changeJson(root, WRITER_MANIFEST, (value) => {
    value.sideEffectClasses.push('submission');
  }), /authority ceiling/],
  ['owner role exchange', (root) => changeJson(root, WRITER_MANIFEST, (value) => {
    value.ownerTeams.reverse();
  }), /owner role order/],
  ['unknown work item', (root) => {
    changeJson(root, 'docs/system/truth/modules.v1.json', (value) => {
      value.modules['module.commit-sequencer'].workItemIds.push('UNKNOWN-001');
    });
    changeJson(root, WRITER_MANIFEST, (value) => { value.workItemIds.push('UNKNOWN-001'); });
  }, /unknown work item/],
  ['specification activation drift', (root) => {
    const file = path.join(root, WRITER_SPEC);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('staticActivation: disabled', 'staticActivation: authoritative'));
  }, /specification staticActivation mismatch/],
  ['empty mandatory section', (root) => {
    const file = path.join(root, WRITER_SPEC);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/## Inputs and outputs[\s\S]*?(?=## State and authority)/, '## Inputs and outputs\n\n'));
  }, /empty section/],
  ['heading hidden inside a code fence', (root) => {
    const file = path.join(root, WRITER_SPEC);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## Inputs and outputs', '```text\n## Inputs and outputs\n```'));
  }, /missing heading/],
  ['duplicate mandatory heading', (root) => fs.appendFileSync(path.join(root, WRITER_SPEC), '\n## Inputs and outputs\nDuplicated.\n'), /duplicate heading/],
  ['oversized specification', (root) => fs.appendFileSync(path.join(root, WRITER_SPEC), 'x'.repeat(1024 * 1024)), /byte limit/],
  ['duplicate raw JSON key', (root) => {
    const file = path.join(root, WRITER_MANIFEST);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('{', '{"schemaVersion":1,'));
  }, /duplicate JSON property/],
  ['unindexed symbolic document', (root) => fs.symlinkSync(path.join(root, WRITER_SPEC), path.join(root, 'docs/modules/specs/unindexed.md')), /symbolic module document/],
];

for (const [name, mutate, expected] of hostileCases) {
  test(`module documentation rejects ${name}`, () => {
    const root = createFixture();
    try {
      mutate(root);
      const result = validateModuleDocumentation({ root });
      assert.equal(result.ok, false, name);
      assert.match(result.failures.join('\n'), expected);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('module document reads reject an intermediate symlink rather than traversing it', () => {
  const root = createFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-module-docs-outside-'));
  try {
    fs.renameSync(path.join(root, 'docs/modules/specs'), path.join(outside, 'specs'));
    fs.symlinkSync(path.join(outside, 'specs'), path.join(root, 'docs/modules/specs'));
    const result = validateModuleDocumentation({ root });
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /symbolic link in repository path/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('implementation projection is deterministic and preserves pending work without qualification', () => {
  const first = validateModuleDocumentation({ root: ROOT });
  const second = validateModuleDocumentation({ root: ROOT });
  assert.deepEqual(first, second);
  const projection = first.report.implementationProjection;
  assert.equal(projection.coverageMeaning, 'structural_documentation_only');
  assert.equal(Object.keys(projection.modules).length, 32);
  const scheduler = projection.modules['module.scheduler-core'];
  assert.equal(scheduler.staticImplementationState, 'source_implemented');
  assert.ok(scheduler.pendingSourceWorkItemIds.includes('SCH-001'));
  assert.equal(scheduler.referencedWorkStates['SCH-004'], 'source_implemented');
  assert.ok(scheduler.codeRoots.includes('rust/crates/hepta-control-plane'));
  assert.ok(scheduler.contractRefs.includes('docs/control-plane/GLOBAL_OPTIMIZATION.md'));
  const writer = projection.modules['module.commit-sequencer'];
  assert.ok(writer.blockedExternalWorkItemIds.includes('GAP-HOST-002'));
  for (const row of Object.values(projection.modules)) {
    assert.equal(row.effectiveQualification, 'not_evaluated');
    assert.equal(row.productionActivationVerified, false);
  }
});
