import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qualificationRoot = path.join(repositoryRoot, 'docs/rust/qualification');

const expectedPackages = {
  'EXT-HOST-CGROUP-001': ['GAP-HOST-001', 'independent-linux-review-v1.schema.json'],
  'EXT-HOST-STORAGE-001': ['GAP-HOST-002', 'external-host-storage-package-v1.schema.json'],
  'EXT-KEY-OWNER-001': ['GAP-KEY-001', 'external-key-owner-drill-v1.schema.json'],
  'EXT-CODEX-ROLE-001': ['GAP-CODEX-001', 'authenticated-codex-role-canary-v2.schema.json'],
  'EXT-CUTOVER-SOAK-001': ['GAP-REL-001', 'production-cutover-soak-v1.schema.json'],
  'EXT-AUTHORITY-SET-001': ['GAP-REL-001', 'external-authority-set-v1.schema.json'],
};

const supportSchemas = [
  'hepta-broker-qualification-evidence-v1.schema.json',
  'external-qualification-closure-request-v1.schema.json',
  'external-qualification-closure-receipt-v1.schema.json',
  'qualification-trust-store-v1.schema.json',
  'external-qualification-closure-request-v2.schema.json',
  'external-qualification-closure-receipt-v2.schema.json',
  'research-qualification-request-v3.schema.json',
  'research-qualification-receipt-v3.schema.json',
  'research-qualification-request-v4.schema.json',
  'research-qualification-receipt-v4.schema.json',
];

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

function readSchema(name) {
  return JSON.parse(fs.readFileSync(path.join(qualificationRoot, name), 'utf8'));
}

// This checks executable registration, not Rust behavior by source spelling.
// The existing artifact job runs the native package; exact-source jobs execute
// these exact selectors against their own immutable source subjects.
function requireNativeOwners(evidence, names) {
  const bundle = evidence.bundles['production-composition-source'];
  for (const [file, selector] of names) {
    const name = selector.split('::').at(-1);
    const owner = bundle.files.find((item) => item.path === file && item.role === 'test');
    assert.ok(owner?.symbols.some((symbol) => symbol.kind === 'test' && symbol.name === name),
      `missing native test owner: ${selector}`);
    const commands = bundle.verificationCommands.filter((command) => command.args.includes(selector));
    assert.equal(commands.length, 1, `missing or ambiguous native command: ${selector}`);
    const command = commands[0];
    assert.equal(command.program, 'cargo');
    assert.equal(command.workdir, 'rust');
    assert.equal(command.expectedExitCode, 0);
    assert.deepEqual(command.expectedTargets, [file]);
    assert.deepEqual(command.args, ['test', '--locked', '-p', 'hepta-qualification-ingest',
      '--lib', selector, '--', '--exact', '--nocapture']);
  }
}

function checkNativeRegistration(names) {
  const evidence = JSON.parse(read('docs/system/evidence/rust-functional-source-closure-v1.json'));
  requireNativeOwners(evidence, names);
  for (const [, selector] of names) {
    for (const change of ['missing', 'wrong-package', 'nonzero-success']) {
      const mutated = structuredClone(evidence);
      const bundle = mutated.bundles['production-composition-source'];
      const command = bundle.verificationCommands.find((item) => item.args.includes(selector));
      if (change === 'missing') bundle.verificationCommands = bundle.verificationCommands.filter((item) => item !== command);
      else if (change === 'wrong-package') command.args[3] = 'unrelated-package';
      else command.expectedExitCode = 1;
      assert.throws(() => requireNativeOwners(mutated, names), `${selector}:${change}`);
    }
  }
}

function assertStrictSchema(name, schema) {
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', name);
  assert.equal(schema.type, 'object', name);
  assert.equal(schema.additionalProperties, false, name);
  const version = schema.properties.schemaVersion || schema.properties.version;
  const versionMatch = /-v([1234])\.schema\.json$/u.exec(name);
  assert.ok(versionMatch, `unsupported versioned schema ${name}`);
  assert.equal(version?.const, Number(versionMatch[1]), name);
  assert.ok(Array.isArray(schema.required) && schema.required.length > 0, name);
}

function validatePackageSchema(packageId, name, schema) {
  assertStrictSchema(name, schema);
  assert.equal(schema.properties.packageId?.const, packageId, name);
  assert.deepEqual(schema.properties.decision, { const: 'approved' }, name);
  for (const required of ['packageId', 'repository', 'decision']) {
    assert.ok(schema.required.includes(required), `${name}: missing required ${required}`);
  }
}

function validateMapping(mapping, externalGaps) {
  assert.deepEqual(
    Object.keys(mapping).sort(),
    ['packages', 'program', 'schemaVersion', 'status'],
  );
  assert.equal(mapping.schemaVersion, 1);
  assert.equal(mapping.program, 'hepta-paper-rust-rewrite');
  assert.equal(mapping.status, 'canonical_external_package_map');
  assert.equal(mapping.packages.length, 6);
  assert.deepEqual(
    new Set(mapping.packages.map((row) => row.packageId)),
    new Set(Object.keys(expectedPackages)),
  );
  const covered = new Set();
  for (const row of mapping.packages) {
    const expected = expectedPackages[row.packageId];
    assert.ok(expected, row.packageId);
    const [gapId, schema] = expected;
    assert.deepEqual(
      Object.keys(row).sort(),
      ['automaticActivation', 'executor', 'gapId', 'issue', 'packageId', 'schemas'],
    );
    assert.equal(row.gapId, gapId, row.packageId);
    assert.equal(row.issue, externalGaps[gapId], row.packageId);
    assert.deepEqual(row.schemas, row.packageId === 'EXT-CODEX-ROLE-001'
      ? [schema, 'authenticated-codex-role-canary-v1.schema.json'] : [schema], row.packageId);
    assert.match(row.executor, /^[a-z][a-z0-9_]{2,127}$/);
    assert.equal(row.automaticActivation, false);
    covered.add(gapId);
  }
  assert.deepEqual(covered, new Set(Object.keys(externalGaps)));
}

test('external qualification package schemas preserve strict required fields under hostile deletion', () => {
  for (const name of supportSchemas) assertStrictSchema(name, readSchema(name));

  for (const [packageId, [, name]] of Object.entries(expectedPackages)) {
    const schema = readSchema(name);
    validatePackageSchema(packageId, name, schema);
    for (const field of ['packageId', 'repository', 'decision']) {
      const hostile = structuredClone(schema);
      hostile.required = hostile.required.filter((value) => value !== field);
      assert.throws(
        () => validatePackageSchema(packageId, name, hostile),
        new RegExp(`missing required ${field}`),
      );
    }
  }
});

test('signed payload rejection has exact executable native owners, not source token proofs', () => {
  const file = 'rust/crates/hepta-qualification-ingest/src/qualification_closure/tests/joint_closure.rs';
  checkNativeRegistration([
    [file, 'qualification_closure::tests::joint_closure::valid_individual_signatures_with_cross_package_drift_never_create_a_ledger'],
    [file, 'qualification_closure::tests::joint_closure::invalid_real_envelope_signature_fails_before_replay_creation'],
    [file, 'qualification_closure::tests::joint_closure::genuine_outer_signature_cannot_hide_invalid_nested_authority_signature'],
  ]);
});

test('non-activation, replay and clock semantics have exact executable native owners', () => {
  const file = 'rust/crates/hepta-qualification-ingest/src/qualification_closure/tests/joint_closure.rs';
  checkNativeRegistration([
    [file, 'qualification_closure::tests::joint_closure::cross_package_drift_does_not_advance_existing_nonce_trust_or_clock_state'],
    [file, 'qualification_closure::tests::joint_closure::genuine_seven_package_closure_preserves_receipt_bytes_and_exact_replay'],
    [file, 'qualification_closure::tests::joint_closure::genuine_changed_and_partial_replays_keep_existing_conflict_semantics'],
    [file, 'qualification_closure::tests::joint_closure::single_maintainer_does_not_relax_signatures_cross_package_binding_or_replay_clock'],
  ]);
});

test('external package mapping and versioned schemas reject gap or schema substitution', () => {
  const truth = JSON.parse(read('docs/rust/current-status.v1.json'));
  const externalGaps = Object.fromEntries(
    truth.gaps.filter((row) => row.external === true).map((row) => [row.id, row.issue]),
  );
  const mapping = JSON.parse(read('docs/rust/qualification/external-package-map.v1.json'));
  validateMapping(mapping, externalGaps);

  for (const row of mapping.packages) {
    const hostileGap = structuredClone(mapping);
    const selectedGap = hostileGap.packages.find((candidate) => candidate.packageId === row.packageId);
    selectedGap.gapId = selectedGap.gapId === 'GAP-REL-001' ? 'GAP-HOST-002' : 'GAP-REL-001';
    assert.throws(() => validateMapping(hostileGap, externalGaps));

    const hostileSchema = structuredClone(mapping);
    hostileSchema.packages.find((candidate) => candidate.packageId === row.packageId).schemas = ['substituted.schema.json'];
    assert.throws(() => validateMapping(hostileSchema, externalGaps));
  }

  const legacy = readSchema('external-qualification-closure-request-v1.schema.json');
  assert.deepEqual(new Set(legacy.$defs.packageId.enum),
    new Set([...Object.keys(expectedPackages), 'EXT-GOV-MAIN-001']));
});

test('closure request receipt and authority signature schemas preserve replay and trust semantics', () => {
  const authority = readSchema('external-authority-set-v1.schema.json');
  assert.deepEqual(authority.$defs.signature, {
    type: 'string',
    pattern: '^[A-Za-z0-9_-]{86}$',
  });

  const request = readSchema('external-qualification-closure-request-v1.schema.json');
  assert.ok(!Object.hasOwn(request.properties, 'nowUnixMs'));
  assert.ok(request.required.includes('replayLedger'));
  const envelopeRequired = new Set(request.properties.envelopes.items.required);
  assert.ok(envelopeRequired.has('payloadPath'));
  assert.ok(envelopeRequired.has('payloadOwnerUid'));

  const receipt = readSchema('external-qualification-closure-receipt-v1.schema.json');
  assert.deepEqual(receipt.properties.payloadSemantics, { const: 'strict_package_v1' });
  assert.deepEqual(receipt.properties.replayProtection, { const: 'durable_sqlite_v2' });
  assert.deepEqual(receipt.properties.clockRollbackProtection, { const: true });
  assert.deepEqual(receipt.properties.replayLedgerSchemaVersion, { const: 2 });
  assert.deepEqual(receipt.properties.replayLedgerCommitted, { const: true });

  const hostile = structuredClone(receipt);
  hostile.properties.replayProtection.const = 'durable_sqlite_v1';
  assert.notDeepEqual(hostile.properties.replayProtection, { const: 'durable_sqlite_v2' });
});

test('current qualification documents project every package and preserve non-activation semantics', () => {
  const protocol = read('docs/qualification/EXTERNAL_AUTHORITY.md');
  const model = read('docs/qualification/QUALIFICATION_MODEL.md');
  for (const [packageId, [gapId, schema]] of Object.entries(expectedPackages)) {
    assert.ok(protocol.includes(packageId), packageId);
    assert.ok(protocol.includes(gapId), gapId);
    assert.ok(protocol.includes(schema), schema);
  }
  for (const token of [
    'strict_package_v1',
    'durable_sqlite_v2',
    'automaticActivation',
    'productionActivation',
    'derived_only',
  ]) {
    assert.ok(protocol.includes(token) || model.includes(token), token);
  }
});


test('single-maintainer V2 drops only human repository approval and preserves strict V1 history', () => {
  const oldRequest = readSchema('external-qualification-closure-request-v1.schema.json');
  const oldReceipt = readSchema('external-qualification-closure-receipt-v1.schema.json');
  const request = readSchema('external-qualification-closure-request-v2.schema.json');
  const receipt = readSchema('external-qualification-closure-receipt-v2.schema.json');
  assert.equal(oldRequest.properties.envelopes.minItems, 7);
  assert.ok(oldReceipt.properties.authorityGroups.required.includes('governance'));
  assert.equal(request.properties.envelopes.minItems, 6);
  assert.equal(request.properties.envelopes.maxItems, 6);
  assert.deepEqual(new Set(request.$defs.packageId.enum), new Set(Object.keys(expectedPackages)));
  assert.deepEqual(receipt.$defs.packageId, request.$defs.packageId);
  assert.equal(request.properties.envelopes.allOf.length, 6);
  assert.equal(receipt.properties.packages.allOf.length, 6);
  assert.equal(receipt.properties.version.const, 2);
  assert.equal(receipt.properties.kind.const, 'ExternalQualificationClosureReceiptV2');
  assert.equal(Object.hasOwn(receipt.properties.authorityGroups.properties, 'governance'), false);
  assert.equal(receipt.properties.authorityGroups.required.length, 4);
  for (const field of ['automaticActivation', 'productionActivation', 'sourceStatusUnchanged',
    'payloadSemantics', 'replayProtection', 'replayLedgerCommitted', 'clockRollbackProtection']) {
    assert.deepEqual(receipt.properties[field], oldReceipt.properties[field], field);
  }
  const oldGovernance = readSchema('protected-main-ruleset-evidence-v1.schema.json');
  assert.equal(oldGovernance.properties.pullRequestPolicy.properties.requiredApprovingReviewCount.minimum, 1);
});


test('V2 executable schema rejects missing, repeated, legacy and unknown package profiles', () => {
  const schema = read('docs/rust/qualification/external-qualification-closure-request-v2.schema.json');
  const valid = {
    version: 2, repository: 'TrillionniumFoundation/hepta-paper',
    commit: 'a'.repeat(40), tree: 'b'.repeat(40), consumerUid: 1000,
    trustStore: { path: '/authority/trust.json', ownerUid: 0 },
    replayLedger: { path: '/consumer/replay.sqlite', ownerUid: 1000 },
    envelopes: Object.keys(expectedPackages).map((packageId, index) => ({
      packageId, path: `/authority/envelope-${index}.json`, ownerUid: 0,
      payloadPath: `/authority/payload-${index}.json`, payloadOwnerUid: 0,
    })),
  };
  const rows = [{ name: 'valid', schema, instance: JSON.stringify(valid) }];
  for (const [name, mutate] of [
    ['missing', (value) => value.envelopes.pop()],
    ['duplicate', (value) => { value.envelopes[1].packageId = value.envelopes[0].packageId; }],
    ['legacy', (value) => { value.envelopes[0].packageId = 'EXT-GOV-MAIN-001'; }],
    ['version', (value) => { value.version = 1; }],
    ['unknown', (value) => { value.skipAuthorityChecks = true; }],
  ]) {
    const value = structuredClone(valid);
    mutate(value);
    rows.push({ name, schema, instance: JSON.stringify(value) });
  }
  const result = spawnSync('python3', ['docs/rust/tools/strict_json_schema.py', '--batch-stdin'], {
    cwd: repositoryRoot, input: JSON.stringify(rows), encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(new Set(report.failures.map((failure) => failure.name)),
    new Set(['missing', 'duplicate', 'legacy', 'version', 'unknown']), JSON.stringify(report));
});


test('research V3 schemas reject full-scope substitution and missing packages', () => {
  const schema = read('docs/rust/qualification/research-qualification-request-v3.schema.json');
  const request = JSON.parse(schema);
  const receipt = readSchema('research-qualification-receipt-v3.schema.json');
  const ids = Object.keys(expectedPackages).filter((id) => id !== 'EXT-AUTHORITY-SET-001');
  assert.deepEqual(new Set(request.$defs.packageId.enum), new Set(ids));
  assert.deepEqual(receipt.$defs.packageId, request.$defs.packageId);
  assert.equal(receipt.properties.kind.const, 'ResearchQualificationReceiptV3');
  assert.equal(receipt.properties.productionActivation.const, false);
  assert.equal(receipt.properties.automaticActivation.const, false);
  assert.ok(receipt.required.includes('researchWorkflowProfile'));
  const profileSchema = receipt.properties.researchWorkflowProfile;
  assert.deepEqual(profileSchema.properties.version.enum, [1, 2]);
  assert.equal(profileSchema.properties.stage.const, 'canary');
  assert.equal(profileSchema.properties.automaticActivation.const, false);
  assert.equal(profileSchema.properties.productionActivation.const, false);
  assert.equal(profileSchema.properties.releaseAuthority.const, false);
  assert.equal(profileSchema.properties.submissionAuthority.const, false);
  const valid = {
    version: 3, repository: 'TrillionniumFoundation/hepta-paper',
    commit: 'a'.repeat(40), tree: 'b'.repeat(40), consumerUid: 1000,
    trustStore: { path: '/authority/trust.json', ownerUid: 0 },
    replayLedger: { path: '/consumer/replay.sqlite', ownerUid: 1000 },
    envelopes: ids.map((packageId, index) => ({ packageId,
      path: `/authority/envelope-${index}.json`, ownerUid: 0,
      payloadPath: `/authority/payload-${index}.json`, payloadOwnerUid: 0 })),
  };
  const sha = `sha256:${'a'.repeat(64)}`;
  const validReceipt = {
    version: 3, kind: 'ResearchQualificationReceiptV3',
    status: 'research_only_qualification_set_verified',
    repository: 'TrillionniumFoundation/hepta-paper',
    commit: 'a'.repeat(40), tree: 'b'.repeat(40),
    packages: ids.map((packageId, index) => ({
      packageId, payloadHash: sha, authorityDomainId: `authority-${index}`,
      signerKeyId: `key-${index}`, nonce: `nonce-${index}`, signingMessageHash: sha,
    })),
    authorityGroups: {
      target_host: ['authority-0', 'authority-1'], key_owner: ['authority-2'],
      codex_account: ['authority-3'], release_and_cutover: ['authority-4'],
    },
    allPackagesVerified: true, automaticActivation: false, productionActivation: false,
    sourceStatusUnchanged: true, payloadSemantics: 'strict_package_v1',
    clockRollbackProtection: true, replayLedgerSchemaVersion: 2,
    trustStoreGeneration: 7, trustStoreHash: sha,
    researchWorkflowProfile: {
      version: 1, stage: 'canary', repository: 'TrillionniumFoundation/hepta-paper',
      commit: 'a'.repeat(40), tree: 'b'.repeat(40), qualificationBindingHash: sha,
      qualificationTrustStoreGeneration: 7, qualificationExpiresAtUnixMs: 1_800_000_000_000,
      qualifiedCodexRuntimeIdentityHash: sha, automaticActivation: false,
      productionActivation: false, releaseAuthority: false, submissionAuthority: false,
    },
    replayProtection: 'durable_sqlite_v2', replayLedgerCommitted: true, receiptHash: sha,
  };
  const rows = [
    { name: 'valid', schema, instance: JSON.stringify(valid) },
    { name: 'valid-receipt', schema: JSON.stringify(receipt), instance: JSON.stringify(validReceipt) },
  ];
  const currentReceipt = structuredClone(validReceipt);
  currentReceipt.researchWorkflowProfile.version = 2;
  currentReceipt.researchWorkflowProfile.qualifiedCodexRoleRuntimeIdentityHashesV2 = {
    author: sha, reviewer: 'sha256:' + 'b'.repeat(64),
  };
  rows.push({ name: 'valid-role-v2-receipt', schema: JSON.stringify(receipt), instance: JSON.stringify(currentReceipt) });
  for (const [name, mutate] of [
    ['missing', (value) => value.envelopes.pop()],
    ['duplicate', (value) => { value.envelopes[1].packageId = value.envelopes[0].packageId; }],
    ['publication', (value) => { value.envelopes[0].packageId = 'EXT-AUTHORITY-SET-001'; }],
    ['full-profile', (value) => { value.version = 2; }],
    ['extra-authority', (value) => { value.productionActivation = true; }],
  ]) {
    const value = structuredClone(valid);
    mutate(value);
    rows.push({ name, schema, instance: JSON.stringify(value) });
  }
  for (const [name, mutate] of [
    ['receipt-stage', (value) => { value.researchWorkflowProfile.stage = 'established'; }],
    ['receipt-release', (value) => { value.researchWorkflowProfile.releaseAuthority = true; }],
    ['receipt-submission', (value) => { value.researchWorkflowProfile.submissionAuthority = true; }],
    ['receipt-missing-profile', (value) => { delete value.researchWorkflowProfile; }],
  ]) {
    const value = structuredClone(validReceipt);
    mutate(value);
    rows.push({ name, schema: JSON.stringify(receipt), instance: JSON.stringify(value) });
  }
  for (const [name, mutate] of [
    ['role-map-missing', (value) => { delete value.researchWorkflowProfile.qualifiedCodexRoleRuntimeIdentityHashesV2; }],
    ['role-map-legacy', (value) => { value.researchWorkflowProfile.version = 1; }],
    ['role-map-unknown-version', (value) => { value.researchWorkflowProfile.version = 3; }],
    ['role-map-missing-reviewer', (value) => { delete value.researchWorkflowProfile.qualifiedCodexRoleRuntimeIdentityHashesV2.reviewer; }],
    ['role-map-unknown-role', (value) => { value.researchWorkflowProfile.qualifiedCodexRoleRuntimeIdentityHashesV2.other = sha; }],
  ]) {
    const value = structuredClone(currentReceipt); mutate(value);
    rows.push({ name, schema: JSON.stringify(receipt), instance: JSON.stringify(value) });
  }
  const result = spawnSync('python3', ['docs/rust/tools/strict_json_schema.py', '--batch-stdin'], {
    cwd: repositoryRoot, input: JSON.stringify(rows), encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(new Set(report.failures.map((failure) => failure.name)),
    new Set(['missing', 'duplicate', 'publication', 'full-profile', 'extra-authority',
      'receipt-stage', 'receipt-release', 'receipt-submission', 'receipt-missing-profile',
      'role-map-missing', 'role-map-legacy', 'role-map-unknown-version',
      'role-map-missing-reviewer', 'role-map-unknown-role']));
});

test('research V4 requires four safety packages and rejects cutover or publication authority', () => {
  const request = readSchema('research-qualification-request-v4.schema.json');
  const receipt = readSchema('research-qualification-receipt-v4.schema.json');
  const ids = Object.keys(expectedPackages).filter((id) =>
    id !== 'EXT-AUTHORITY-SET-001' && id !== 'EXT-CUTOVER-SOAK-001');
  assert.deepEqual(new Set(request.$defs.packageId.enum), new Set(ids));
  assert.deepEqual(receipt.$defs.packageId, request.$defs.packageId);
  assert.equal(receipt.properties.kind.const, 'ResearchQualificationReceiptV4');
  assert.deepEqual(new Set(receipt.properties.authorityGroups.required),
    new Set(['target_host', 'key_owner', 'codex_account']));
  const valid = {
    version: 4, repository: 'TrillionniumFoundation/hepta-paper',
    commit: 'a'.repeat(40), tree: 'b'.repeat(40), consumerUid: 1000,
    trustStore: { path: '/authority/trust.json', ownerUid: 0 },
    replayLedger: { path: '/consumer/replay.sqlite', ownerUid: 1000 },
    envelopes: ids.map((packageId, index) => ({ packageId,
      path: `/authority/envelope-${index}.json`, ownerUid: 0,
      payloadPath: `/authority/payload-${index}.json`, payloadOwnerUid: 0 })),
  };
  const rows = [{ name: 'valid', schema: JSON.stringify(request), instance: JSON.stringify(valid) }];
  for (const [name, mutate] of [
    ...ids.map((id, index) => [`missing-${id}`, (value) => value.envelopes.splice(index, 1)]),
    ['cutover', (value) => { value.envelopes[0].packageId = 'EXT-CUTOVER-SOAK-001'; }],
    ['publication', (value) => { value.envelopes[0].packageId = 'EXT-AUTHORITY-SET-001'; }],
    ['governance', (value) => { value.envelopes[0].packageId = 'EXT-GOV-MAIN-001'; }],
    ['old-profile', (value) => { value.version = 3; }],
    ['grant', (value) => { value.releaseAuthority = true; }],
  ]) {
    const value = structuredClone(valid);
    mutate(value);
    rows.push({ name, schema: JSON.stringify(request), instance: JSON.stringify(value) });
  }
  const result = spawnSync('python3', ['docs/rust/tools/strict_json_schema.py', '--batch-stdin'], {
    cwd: repositoryRoot, input: JSON.stringify(rows), encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(new Set(report.failures.map((failure) => failure.name)),
    new Set([...ids.map((id) => `missing-${id}`), 'cutover', 'publication', 'governance', 'old-profile', 'grant']));
});
