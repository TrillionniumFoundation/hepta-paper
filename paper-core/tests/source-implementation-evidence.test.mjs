import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  parseStrictJson,
  verifyRepositorySourceEvidence,
} from '../bin/verify-source-implementation-evidence.mjs';

function command(root, ...args) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function authorityClaims() {
  return {
    targetHostQualified: false,
    externalAuthorityGranted: false,
    productionActivated: false,
    writerCutoverAuthorized: false,
    nodeRetirementAuthorized: false,
  };
}

function createFixture(mutator = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-source-evidence-'));
  command(root, 'git', 'init', '--quiet');
  command(root, 'git', 'config', 'user.name', 'Hepta Source Evidence Test');
  command(root, 'git', 'config', 'user.email', 'source-evidence@example.invalid');

  write(root, 'src/feature.mjs', 'export function feature() { return 1; }\n');
  write(root, 'src/orphan.mjs', 'export function orphanFeature() { return 2; }\n');
  write(root, 'test/feature.test.mjs', [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { feature } from '../src/feature.mjs';",
    "test('feature_test', () => assert.equal(feature(), 1));",
    '',
  ].join('\n'));
  write(root, 'test/orphan.test.mjs', [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { orphanFeature } from '../src/orphan.mjs';",
    "test('orphan_test', () => assert.equal(orphanFeature(), 2));",
    '',
  ].join('\n'));
  write(root, 'docs/system/truth/work-items.v2.json', JSON.stringify({
    schemaVersion: 2,
    items: {
      'TEST-001': {
        type: 'implementation',
        priority: 'P0',
        state: 'source_implemented',
        moduleId: 'module.example',
        capabilityIds: ['CAP-EXAMPLE'],
        ownerTeam: 'TEAM-TEST',
        dependencies: [],
        evidenceTier: 'source',
      },
    },
  }));
  write(root, 'docs/system/truth/modules.v1.json', JSON.stringify({
    schemaVersion: 1,
    modules: { 'module.example': { state: 'source_implemented' } },
  }));
  write(root, 'docs/system/truth/capabilities.v1.json', JSON.stringify({
    schemaVersion: 1,
    capabilities: { 'CAP-EXAMPLE': { state: 'source_implemented' } },
  }));

  const implementationBlob = command(root, 'git', 'hash-object', 'src/feature.mjs');
  const testBlob = command(root, 'git', 'hash-object', 'test/feature.test.mjs');
  const orphanImplementationBlob = command(root, 'git', 'hash-object', 'src/orphan.mjs');
  const orphanTestBlob = command(root, 'git', 'hash-object', 'test/orphan.test.mjs');
  const evidence = {
    $schema: '../schemas/source-implementation-evidence-v1.schema.json',
    schemaVersion: 1,
    kind: 'RepositorySourceImplementationEvidenceV1',
    repository: 'TrillionniumFoundation/hepta-paper',
    subjectPolicy: 'current_clean_git_head_tree_and_exact_blobs',
    promotionPolicy: 'semantic_registry_binding_plus_exact_git_blobs_plus_executable_owner_tests',
    registries: {
      workItems: 'docs/system/truth/work-items.v2.json',
      modules: 'docs/system/truth/modules.v1.json',
      capabilities: 'docs/system/truth/capabilities.v1.json',
    },
    bundles: {
      'example-source': {
        description: 'Synthetic executable source evidence.',
        files: [
          {
            path: 'src/feature.mjs',
            role: 'implementation',
            gitBlob: implementationBlob,
            mode: '100644',
            language: 'javascript',
            symbols: [{ kind: 'function', name: 'feature' }],
          },
          {
            path: 'test/feature.test.mjs',
            role: 'test',
            gitBlob: testBlob,
            mode: '100644',
            language: 'javascript',
            symbols: [{ kind: 'test', name: 'feature_test' }],
          },
        ],
        verificationCommands: [{
          program: 'node',
          args: ['--test', 'test/feature.test.mjs'],
          workdir: '.',
          expectedExitCode: 0,
          timeoutSeconds: 30,
          expectedTargets: ['test/feature.test.mjs'],
        }],
      },
    },
    records: {
      'TEST-001': {
        workItemId: 'TEST-001',
        moduleId: 'module.example',
        capabilityIds: ['CAP-EXAMPLE'],
        evidenceTier: 'source',
        bundleIds: ['example-source'],
        promotionRequested: false,
        authorityClaims: authorityClaims(),
      },
    },
  };
  mutator(evidence, root, { orphanImplementationBlob, orphanTestBlob });
  write(
    root,
    'docs/system/evidence/repository-source-implementation-v1.json',
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  command(root, 'git', 'add', '.');
  command(root, 'git', 'commit', '--quiet', '-m', 'fixture');
  return {
    root,
    head: command(root, 'git', 'rev-parse', 'HEAD'),
    tree: command(root, 'git', 'rev-parse', 'HEAD^{tree}'),
  };
}

function assertRejected(mutator, pattern) {
  const fixture = createFixture(mutator);
  assert.throws(
    () => verifyRepositorySourceEvidence({
      root: fixture.root,
      execute: false,
      expectedHead: fixture.head,
      expectedTree: fixture.tree,
    }),
    pattern,
  );
}

test('strict JSON rejects duplicate decoded keys and non-JSON numbers', () => {
  assert.throws(() => parseStrictJson('{"a":1,"a":2}'), /duplicate_key:a/u);
  assert.throws(() => parseStrictJson('{"a":NaN}'), /unexpected_token/u);
  assert.throws(() => parseStrictJson('{"a":1e9999}'), /non_finite_number/u);
});

test('exact source evidence executes a typed owner test and emits no authority', () => {
  const fixture = createFixture();
  const receipt = verifyRepositorySourceEvidence({
    root: fixture.root,
    execute: true,
    expectedHead: fixture.head,
    expectedTree: fixture.tree,
  });
  assert.equal(receipt.status, 'repository_source_evidence_verified');
  assert.equal(receipt.source.head, fixture.head);
  assert.equal(receipt.source.tree, fixture.tree);
  assert.equal(receipt.commandObservations.length, 1);
  assert.equal(receipt.commandObservations[0].status, 0);
  assert.deepEqual(receipt.promotions, []);
  assert.deepEqual(receipt.authorityClaims, authorityClaims());
});

test('module identity must be a registered string', () => {
  assertRejected((evidence) => {
    evidence.records['TEST-001'].moduleId = 1;
  }, /string_required/u);
});

test('bundle requires distinct implementation and test roles', () => {
  assertRejected((evidence) => {
    evidence.bundles['example-source'].files[1].role = 'implementation';
  }, /bundle_roles_incomplete/u);
});

test('regular executable source scripts are bound by exact Git mode', () => {
  const fixture = createFixture((evidence, root) => {
    fs.chmodSync(path.join(root, 'src/feature.mjs'), 0o755);
    evidence.bundles['example-source'].files[0].mode = '100755';
  });
  const receipt = verifyRepositorySourceEvidence({
    root: fixture.root,
    execute: false,
    expectedHead: fixture.head,
    expectedTree: fixture.tree,
  });
  assert.equal(receipt.status, 'repository_source_evidence_verified');
});

test('unsupported tracked modes remain rejected', () => {
  assertRejected((evidence) => {
    evidence.bundles['example-source'].files[0].mode = '100600';
  }, /file_mode_invalid/u);
});

test('duplicate canonical paths are rejected', () => {
  assertRejected((evidence) => {
    evidence.bundles['example-source'].files[1] = {
      ...evidence.bundles['example-source'].files[0],
      symbols: [{ kind: 'function', name: 'feature' }],
    };
  }, /duplicate_evidence_path/u);
});

test('traversal, aliases and symlink-shaped paths are rejected before access', () => {
  assertRejected((evidence) => {
    evidence.bundles['example-source'].files[0].path = '../src/feature.mjs';
  }, /path_not_canonical/u);
});

test('record references must resolve and every bundle must be referenced', () => {
  assertRejected((evidence) => {
    evidence.records['TEST-001'].bundleIds = ['missing-source'];
  }, /unknown_bundle_reference/u);
  assertRejected((evidence, _root, blobs) => {
    evidence.bundles.orphan = {
      description: 'Valid but unreferenced evidence bundle.',
      files: [
        {
          path: 'src/orphan.mjs',
          role: 'implementation',
          gitBlob: blobs.orphanImplementationBlob,
          mode: '100644',
          language: 'javascript',
          symbols: [{ kind: 'function', name: 'orphanFeature' }],
        },
        {
          path: 'test/orphan.test.mjs',
          role: 'test',
          gitBlob: blobs.orphanTestBlob,
          mode: '100644',
          language: 'javascript',
          symbols: [{ kind: 'test', name: 'orphan_test' }],
        },
      ],
      verificationCommands: [{
        program: 'node',
        args: ['--test', 'test/orphan.test.mjs'],
        workdir: '.',
        expectedExitCode: 0,
        timeoutSeconds: 30,
        expectedTargets: ['test/orphan.test.mjs'],
      }],
    };
  }, /orphan_bundle/u);
});

test('commands are closed typed argv and cannot invoke a shell', () => {
  assertRejected((evidence) => {
    evidence.bundles['example-source'].verificationCommands[0].program = 'bash';
  }, /command_program_not_allowlisted/u);
});

test('source evidence cannot manufacture external or production authority', () => {
  assertRejected((evidence) => {
    evidence.records['TEST-001'].authorityClaims.productionActivated = true;
  }, /authority_claim_forbidden/u);
});

test('promotion requests must start from an exact design-ready registry record', () => {
  assertRejected((evidence) => {
    evidence.records['TEST-001'].promotionRequested = true;
  }, /promotion_source_state_invalid/u);
});

test('work-item keys, modules, capabilities and source state are closed-world', () => {
  assertRejected((evidence) => {
    evidence.records['OTHER-001'] = {
      ...evidence.records['TEST-001'],
      workItemId: 'TEST-001',
    };
  }, /record_key_mismatch/u);
  assertRejected((evidence) => {
    evidence.records['TEST-001'].capabilityIds = ['CAP-UNKNOWN'];
  }, /unknown_capability/u);
});

// These exercise the actual verifier process boundary. The synthetic Cargo
// executable tests transcript policy only; it is not Rust execution evidence.
function executableCargoFixture(t, transcript) {
  const fixture = createFixture((evidence, root) => {
    write(root, 'rust/tests/selected.rs', '#[test]\nfn selected_owner_test() {}\n');
    const bundle = evidence.bundles['example-source'];
    bundle.files[1] = {
      path: 'rust/tests/selected.rs', role: 'test', mode: '100644', language: 'rust',
      gitBlob: command(root, 'git', 'hash-object', 'rust/tests/selected.rs'),
      symbols: [{ kind: 'test', name: 'selected_owner_test' }],
    };
    bundle.verificationCommands[0] = {
      program: 'cargo', workdir: 'rust', expectedExitCode: 0, timeoutSeconds: 10,
      args: ['test', '--locked', '-p', 'fixture', 'selected_owner_test', '--', '--exact', '--nocapture'],
      expectedTargets: ['rust/tests/selected.rs'],
    };
  });
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-test-transcript-'));
  const launcher = path.join(bin, 'cargo');
  fs.writeFileSync(launcher, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(transcript)});\n`, { mode: 0o700 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    fs.rmSync(bin, { recursive: true, force: true });
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  return fixture;
}

const zeroCargoSummary = 'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 12 filtered out; finished in 0.00s\n';
const oneCargoSummary = 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n';

for (const [name, transcript] of [
  ['empty output', ''],
  ['zero selected tests', zeroCargoSummary],
  ['ignored selected test', 'test selected_owner_test ... ignored\ntest result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s\n'],
  ['different test', `test another_owner_test ... ok\n${oneCargoSummary}`],
  ['duplicate selected tests', `test selected_owner_test ... ok\n${oneCargoSummary}test selected_owner_test ... ok\n${oneCargoSummary}`],
  ['success text without summary', 'test selected_owner_test ... ok\n'],
  ['zero summary after success text', `test selected_owner_test ... ok\n${zeroCargoSummary}`],
]) {
  test(`zero-exit Cargo ${name} cannot produce accepted evidence`, (t) => {
    const fixture = executableCargoFixture(t, transcript);
    const receipt = path.join(os.tmpdir(), `hepta-rejected-receipt-${path.basename(fixture.root)}.json`);
    assert.throws(() => verifyRepositorySourceEvidence({ root: fixture.root, execute: true, receipt }),
      /verification_test_execution_incomplete/u);
    assert.equal(fs.existsSync(receipt), false, 'failure must not publish an acceptance receipt');
  });
}

test('Cargo exact selected execution permits other binaries with zero matching tests', (t) => {
  const fixture = executableCargoFixture(t,
    `${zeroCargoSummary}\u001b[32mtest selected_owner_test ... ok\u001b[0m\n${oneCargoSummary}${zeroCargoSummary}`);
  const receipt = verifyRepositorySourceEvidence({ root: fixture.root, execute: true });
  assert.equal(receipt.commandObservations.length, 1);
  assert.equal(receipt.commandObservations[0].status, 0);
  assert.deepEqual(receipt.authorityClaims, authorityClaims());
});

for (const [name, body] of [
  ['skipped', "test('feature_test', { skip: true }, () => {});"],
  ['todo', "test('feature_test', { todo: true }, () => {});"],
  ['no registered test', "if (false) test('feature_test', () => {});"],
]) {
  test(`actual Node ${name} cannot produce accepted owner-test evidence`, (t) => {
    const fixture = createFixture((evidence, root) => {
      write(root, 'test/feature.test.mjs', `import test from 'node:test';\n${body}\n`);
      evidence.bundles['example-source'].files[1].gitBlob = command(root, 'git', 'hash-object', 'test/feature.test.mjs');
    });
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    assert.throws(() => verifyRepositorySourceEvidence({ root: fixture.root, execute: true }),
      /verification_test_execution_incomplete/u);
  });
}
