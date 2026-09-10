import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qualificationRoot = path.join(repositoryRoot, 'docs/rust/qualification');

const expectedPackages = {
  'EXT-GOV-MAIN-001': ['GAP-GOV-003', 'protected-main-ruleset-evidence-v1.schema.json'],
  'EXT-HOST-CGROUP-001': ['GAP-HOST-001', 'independent-linux-review-v1.schema.json'],
  'EXT-HOST-STORAGE-001': ['GAP-HOST-002', 'external-host-storage-package-v1.schema.json'],
  'EXT-KEY-OWNER-001': ['GAP-KEY-001', 'external-key-owner-drill-v1.schema.json'],
  'EXT-CODEX-ROLE-001': ['GAP-CODEX-001', 'authenticated-codex-role-canary-v1.schema.json'],
  'EXT-CUTOVER-SOAK-001': ['GAP-REL-001', 'production-cutover-soak-v1.schema.json'],
  'EXT-AUTHORITY-SET-001': ['GAP-REL-001', 'external-authority-set-v1.schema.json'],
};

const supportSchemas = [
  'hepta-broker-qualification-evidence-v1.schema.json',
  'external-qualification-closure-request-v1.schema.json',
  'external-qualification-closure-receipt-v1.schema.json',
  'qualification-trust-store-v1.schema.json',
];

const payloadTokens = [
  'validate_external_package_payload_v1',
  'DecisionNotApproved',
  'AuthorityMismatch',
  'REQUIRED_GOVERNANCE_DENIALS',
  'REQUIRED_HOST_CGROUP_DRILLS',
  'REQUIRED_STORAGE_FAULTS',
  'REQUIRED_KEY_DRILLS',
  'REQUIRED_AUTHORITY_KINDS',
  'string(root, "decision")? != "approved"',
  'reviewer_matches(',
  'authority_set_subject_hash_v1',
  'HeptaExternalAuthorityReceiptV1',
  'HeptaExternalAuthoritySetReviewV1',
  'verify_authority_signature_v1',
  'current_time_window(',
  'SignatureInvalid',
];

const closureTokens = [
  'validate_external_package_payload_v1(',
  'QualificationPayloadError',
  'PayloadHashMismatch',
  'ReplayConflict',
  'PartialReplay',
  'TrustStoreRollback',
  'TrustStoreFork',
  'ClockRollback',
  'VERIFIER_CLOCK_STATE_SCHEMA',
  'normalize_sql',
  'REPLAY_LEDGER_USER_VERSION: i32 = 2',
  'payload_semantics: "strict_package_v1"',
  'replay_protection: "durable_sqlite_v2"',
  'clock_rollback_protection: true',
  'replay_ledger_schema_version: 2',
  'automatic_activation: false',
  'production_activation: false',
  'source_status_unchanged: true',
  'replay_ledger_committed: true',
  'system_unix_ms()',
];

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

function readSchema(name) {
  return JSON.parse(fs.readFileSync(path.join(qualificationRoot, name), 'utf8'));
}

function requireTokens(source, tokens) {
  for (const token of tokens) assert.ok(source.includes(token), `missing contract token ${token}`);
}

function removeAllOccurrences(source, token) {
  assert.ok(source.includes(token), `cannot mutate absent contract token ${token}`);
  const hostile = source.split(token).join(`removed_${token.length}`);
  assert.ok(!hostile.includes(token), `contract token survived hostile mutation ${token}`);
  return hostile;
}

function assertStrictSchema(name, schema) {
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', name);
  assert.equal(schema.type, 'object', name);
  assert.equal(schema.additionalProperties, false, name);
  const version = schema.properties.schemaVersion || schema.properties.version;
  assert.equal(version?.const, 1, name);
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
  assert.equal(mapping.packages.length, 7);
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
    assert.deepEqual(row.schemas, [schema], row.packageId);
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

test('external qualification payload anti-forgery surface is complete and every marker is mutation-sensitive', () => {
  const source = read('rust/crates/hepta-qualification-ingest/src/package_payload.rs');
  requireTokens(source, payloadTokens);
  for (const token of payloadTokens) {
    const hostile = removeAllOccurrences(source, token);
    assert.throws(() => requireTokens(hostile, payloadTokens), /missing contract token/);
  }
});

test('external qualification closure replay clock ledger and non-activation surface is mutation-sensitive', () => {
  const source = read('rust/crates/hepta-qualification-ingest/src/bin/hepta-qualification-closure.rs');
  requireTokens(source, closureTokens);
  assert.ok(!source.includes('durable_sqlite_v1'));
  assert.ok(!source.includes('request.now_unix_ms'));
  for (const token of closureTokens) {
    const hostile = removeAllOccurrences(source, token);
    assert.throws(() => requireTokens(hostile, closureTokens), /missing contract token/);
  }
});

test('external package mapping and Rust package-id projection reject gap or schema substitution', () => {
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

  const runtime = read('rust/crates/hepta-qualification-ingest/src/lib.rs');
  const projected = new Set([...runtime.matchAll(/=> "(EXT-[A-Z0-9-]+)"/g)].map((match) => match[1]));
  assert.deepEqual(projected, new Set(Object.keys(expectedPackages)));
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
