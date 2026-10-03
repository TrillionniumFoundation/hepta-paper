import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditCurrentCoverage } from '../../docs/tools/audit-node-rust-coverage.mjs';
import { renderNodeRustGapReport } from '../../docs/tools/generate-node-rust-gap-report.mjs';
import { assertVerifiedRouteAcceptanceV1, consumeRouteAcceptanceRecordV1, observeRouteAcceptanceV1,
  readRouteAcceptanceRecord, routeAcceptanceRequirementsV1 } from '../../docs/tools/node-rust-route-acceptance.mjs';
import { storeStatusFixtureV1, closeStoreStatusFixtureV1, observeStoreWalFilesV1,
  validateStoreWalReadCoordinationV1, observeStoreClosedWalFilesV1, validateStoreClosedWalReadCoordinationV1 } from '../../docs/tools/node-rust-store-route-acceptance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schema = fs.readFileSync(path.join(root, 'docs/migration/node-rust-route-acceptance.v1.schema.json'), 'utf8');
function validate(value) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-route-schema-test-'));
  try {
    const schemaPath = path.join(directory, 'schema.json'), instancePath = path.join(directory, 'instance.json');
    const instance = JSON.stringify(value);
    assert.ok(Buffer.byteLength(instance) <= 16 * 1024 * 1024);
    fs.writeFileSync(schemaPath, schema, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(instancePath, instance, { flag: 'wx', mode: 0o600 });
    const result = spawnSync('python3', ['docs/rust/tools/strict_json_schema.py', '--schema', schemaPath, '--instance', instancePath], {
      cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    assert.ok([0, 1].includes(result.status), result.stderr || result.error?.message);
    validate.errors = result.stdout || result.stderr;
    return result.status === 0;
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])])) : value;
function rehash(record) {
  const { recordSha256: _oldHash, ...payload } = record;
  record.recordSha256 = `sha256:${createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex')}`;
  return record;
}
let observed, verifiedOwnSummary;
before(async () => { observed = await observeRouteAcceptanceV1(); });

test('every_canonical_route_retains_its_complete_argument_and_effect_contract_and_executable_acceptance_gap', () => {
  const requirements = routeAcceptanceRequirementsV1();
  assert.equal(requirements.length, 57);
  assert.equal(new Set(requirements.map(row => row.routeId)).size, 57);
  for (const row of requirements) {
    assert.match(row.argumentContractSha256, /^sha256:[0-9a-f]{64}$/u);
    assert.ok(row.argumentContract.nodeArgv.length > 0);
    assert.ok(row.remaining.includes('independent-current-subject-replay'));
  }
});

test('ordinary_node_and_rust_canonical_routes_execute_the_complete_readonly_refusal_and_process_recovery_matrix', () => {
  assert.equal(observed.rows.length, 3);
  assert.deepEqual(observed.rows.map(row => row.routeId), ['operator/store', 'operator/workspace', 'verify/repository-assets']);
  for (const row of observed.rows) {
    assert.ok(row.cases.length > 40);
    assert.deepEqual(row.cases.filter(testCase => !testCase.passed), [], row.routeId);
    assert.ok(row.cases.every(testCase => testCase.effectsSatisfied));
    if (row.routeId === 'operator/store') {
      const wal = row.cases.filter(testCase => testCase.caseId.startsWith('live-wal/'));
      assert.equal(wal.length, 5);
      assert.deepEqual(new Set(wal.map(testCase => testCase.readCoordination.firstReader)), new Set(['node', 'native']));
      for (const entry of wal) {
        assert.equal(entry.effectsUnchanged, false);
        assert.equal(entry.readCoordination.databaseWalAndOtherPathsUnchanged, true);
        assert.equal(entry.readCoordination.formatAndAllChecksumsVerified, true);
        assert.ok(entry.readCoordination.physicalObservations.byteChanges.length > 0);
      }
      const closedWal = row.cases.filter(testCase => testCase.caseId.startsWith('closed-wal/'));
      assert.equal(closedWal.length, 30);
      assert.deepEqual(new Set(closedWal.map(testCase => testCase.readCoordination.firstReader)), new Set(['node', 'native']));
      for (const entry of closedWal) {
        assert.equal(entry.effectsUnchanged, false);
        assert.equal(entry.readCoordination.kind, 'SQLiteClosedWalReadCoordinationV1');
        assert.equal(entry.readCoordination.databaseAndOtherPathsUnchanged, true);
        assert.equal(entry.readCoordination.exactEmptyWalAndZeroFrameShmVerified, true);
        assert.ok(entry.readCoordination.physicalObservations.before.files.every(file => file === null));
        assert.ok(entry.readCoordination.physicalObservations.stages.at(-1).files.every(Boolean));
        if (entry.retry) {
          assert.equal(entry.retry.effectsUnchanged, false);
          assert.equal(entry.retry.effectsSatisfied, true);
          assert.deepEqual(entry.retry.node, entry.retry.native);
        }
      }
    } else assert.ok(row.cases.every(testCase => testCase.effectsUnchanged));
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      const recovery = row.cases.find(testCase => testCase.caseId === `unknown-result/${signal}/fresh-retry`);
      assert.equal(recovery.node.signal, signal);
      assert.equal(recovery.native.signal, signal);
      assert.equal(recovery.retry.node.outcome, 'report');
      assert.deepEqual(recovery.retry.node, recovery.retry.native);
      assert.equal(recovery.retry.effectsUnchanged, true);
    }
  }
});

test('schema_valid_json_status_claims_never_become_verified_acceptance_without_current_subject_cli_replay', async () => {
  const fake = structuredClone(observed);
  fake.kind = 'NodeRustRouteAcceptanceRecordV1';
  fake.subject.committedClean = true;
  fake.subject.commit = '0'.repeat(40);
  rehash(fake);
  assert.equal(validate(fake), true, JSON.stringify(validate.errors));
  assert.throws(() => assertVerifiedRouteAcceptanceV1(fake), /not_independently_replayed/u);
  await assert.rejects(() => consumeRouteAcceptanceRecordV1(fake), /subject_not_current_clean_commit/u);
  const report = auditCurrentCoverage();
  report.acceptedParityRows = 2;
  assert.throws(() => renderNodeRustGapReport(report), /cannot establish independent acceptance/u);
});

test('own_consumer_pending_replay_rejects_actual_environment_drift_even_after_restoration', async () => {
  if (!observed.subject.committedClean) return;
  const original = process.env.TZ;
  // The private replay Promise has been installed, but its complete matrix has
  // not started. Two incoming callers still validate their own entire records.
  const first = consumeRouteAcceptanceRecordV1(observed);
  const settledFirst = first.then(value => ({ value }), error => ({ error }));
  let second;
  try {
    process.env.TZ = original === 'Etc/GMT+3' ? 'Etc/GMT+4' : 'Etc/GMT+3';
    second = consumeRouteAcceptanceRecordV1(observed);
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
  await assert.rejects(second, /own_replay_current_inputs_changed/u);
  const initial = await settledFirst;
  assert.match(initial.error?.message || '', /own_replay_current_inputs_changed/u);
  assert.equal(initial.value, undefined);
});

test('current_commit_complete_matrix_consumer_closes_exactly_three_local_behavior_gaps_and_retains_all_routes', async () => {
  if (!observed.subject.committedClean) {
    assert.equal(observed.kind, 'NodeRustRouteBehaviorObservationV1');
    await assert.rejects(() => consumeRouteAcceptanceRecordV1(observed), /record_scope_invalid/u);
    assert.equal(auditCurrentCoverage().acceptedParityRows, 0);
    return;
  }
  assert.equal(validate(observed), true, JSON.stringify(validate.errors));
  const forged = structuredClone(observed);
  forged.rows[0].cases[0].node.stdout.status = 'concurrent_invented_success';
  forged.rows[0].cases[0].native.stdout.status = 'concurrent_invented_success'; rehash(forged);
  assert.equal(validate(forged), true, JSON.stringify(validate.errors));
  const concurrent = await Promise.allSettled([
    consumeRouteAcceptanceRecordV1(observed), consumeRouteAcceptanceRecordV1(structuredClone(observed)),
    consumeRouteAcceptanceRecordV1(forged),
  ]);
  const refusalDiagnostic = result => result.reason
    ? `${result.reason.stack}\nphysicalContextDifferences=${JSON.stringify(result.reason.physicalContextDifferences ?? null)}` : undefined;
  assert.equal(concurrent[0].status, 'fulfilled', refusalDiagnostic(concurrent[0]));
  assert.equal(concurrent[1].status, 'fulfilled', refusalDiagnostic(concurrent[1]));
  assert.equal(concurrent[2].status, 'rejected'); assert.match(concurrent[2].reason.message, /actual_replay_differs/u);
  const acceptance = concurrent[0].value; verifiedOwnSummary = acceptance;
  assert.notEqual(acceptance, concurrent[1].value);
  assert.deepEqual(assertVerifiedRouteAcceptanceV1(concurrent[1].value), acceptance);
  const report = auditCurrentCoverage({ routeAcceptance: acceptance });
  assert.equal(report.acceptedParityRows, 3);
  assert.equal(report.openCommandBehaviorGaps, 54);
  assert.equal(report.commandMappings.commands.length, 57);
  assert.equal(report.commandMappings.acceptedParity, false);
  assert.equal(report.fullReplacementEstablished, false);
  assert.equal(report.productionActivationVerified, false);
  assert.equal(report.nodeRetirementVerified, false);
  assert.ok(Object.values(acceptance.authority).every(value => value === false));
  assert.equal(acceptance.rows.filter(row => row.accepted).length, 3);
  assert.equal(acceptance.rows.filter(row => !row.accepted && row.remaining.length > 0).length, 54);
  const rendered = renderNodeRustGapReport(report);
  assert.match(rendered, /Independently accepted parity rows: \*\*3\*\*/u);
  assert.match(rendered, /Open command gaps: \*\*54\*\*/u);
  assert.equal(rendered.split('\n').filter(line => line.startsWith('| `')).length, 57);
  assert.equal(rendered.split('\n').filter(line => line.includes('| `accepted_local_behavior` |')).length, 3);
  assert.throws(() => renderNodeRustGapReport(structuredClone(report)), /not_independently_replayed/u);
});

test('removed_parameter_refusal_or_recovery_case_and_authority_expansion_fail_before_any_replay', async () => {
  const missing = rehash(structuredClone(observed));
  missing.kind = 'NodeRustRouteAcceptanceRecordV1'; missing.subject.committedClean = true;
  missing.rows[0].cases.pop(); rehash(missing);
  await assert.rejects(() => consumeRouteAcceptanceRecordV1(missing),
    /complete_contract_missing|subject_not_current_clean_commit/u);
  const expanded = structuredClone(observed);
  expanded.kind = 'NodeRustRouteAcceptanceRecordV1'; expanded.subject.committedClean = true;
  expanded.authority.submissionAuthority = true; rehash(expanded);
  assert.equal(validate(expanded), false);
  await assert.rejects(() => consumeRouteAcceptanceRecordV1(expanded), /record_scope_invalid/u);
});

test('forged_success_outputs_with_valid_shape_and_self_hash_are_rejected_by_actual_cli_replay', async () => {
  const forged = structuredClone(observed);
  forged.kind = 'NodeRustRouteAcceptanceRecordV1'; forged.subject.committedClean = true;
  const first = forged.rows[0].cases[0];
  first.node.stdout.status = 'invented_success'; first.native.stdout.status = 'invented_success';
  rehash(forged);
  assert.equal(validate(forged), true, JSON.stringify(validate.errors));
  await assert.rejects(() => consumeRouteAcceptanceRecordV1(forged),
    /actual_replay_differs|subject_not_current_clean_commit/u);
});

test('bounded_record_reader_rejects_alias_and_mutation_prone_inputs_instead_of_executing_them', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-route-record-reader-'));
  try {
    const file = path.join(directory, 'record.json'); fs.writeFileSync(file, JSON.stringify(observed));
    assert.deepEqual(readRouteAcceptanceRecord(file), observed);
    const alias = path.join(directory, 'alias.json'); fs.symlinkSync('record.json', alias);
    assert.throws(() => readRouteAcceptanceRecord(alias), /symlink_refused/u);
    const hardlink = path.join(directory, 'hardlink.json'); fs.linkSync(file, hardlink);
    assert.throws(() => readRouteAcceptanceRecord(file), /file_invalid/u);
    const invalidUtf8 = path.join(directory, 'invalid-utf8.json');
    fs.writeFileSync(invalidUtf8, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
    assert.throws(() => readRouteAcceptanceRecord(invalidUtf8), /encoded data was not valid/u);
    assert.throws(() => readRouteAcceptanceRecord('relative.json'), /path_must_be_absolute/u);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});


test('forged_effect_satisfaction_and_wal_header_or_admitted_range_claims_fail_in_the_actual_consumer', async () => {
  const fakeEffect = structuredClone(observed);
  fakeEffect.kind = 'NodeRustRouteAcceptanceRecordV1'; fakeEffect.subject.committedClean = true;
  const ordinary = fakeEffect.rows.find(row => row.routeId === 'operator/store').cases.find(entry => entry.caseId.startsWith('ready/'));
  ordinary.effectsUnchanged = false; ordinary.effectsSatisfied = true;
  ordinary.readCoordination = { kind: 'SQLiteColdWalReadCoordinationV1' };
  rehash(fakeEffect);
  await assert.rejects(() => consumeRouteAcceptanceRecordV1(fakeEffect), /complete_contract_missing/u);
  for (const mutate of [proof => { proof.allowedByteRanges = [[0, 32768]]; },
    proof => { proof.headerRebuiltWithoutProductWrite = false; }]) {
    const forged = structuredClone(observed);
    forged.kind = 'NodeRustRouteAcceptanceRecordV1'; forged.subject.committedClean = true;
    mutate(forged.rows.find(row => row.routeId === 'operator/store').cases.find(entry => entry.caseId.startsWith('live-wal/')).readCoordination);
    rehash(forged);
    await assert.rejects(() => consumeRouteAcceptanceRecordV1(forged), /cold_wal_claim_invalid/u);
  }
});


test('actual_wal_files_reject_frame_tampering_and_changed_shm_ownership_metadata_or_noncoordination_bytes', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-store-wal-physical-refusal-'));
  try {
    storeStatusFixtureV1(fixture, 'live-wal', process.env);
    const original = observeStoreWalFilesV1(fixture);
    assert.match(original.identity.uid, /^\d+$/u); assert.match(original.identity.gid, /^\d+$/u);
    const walPath = path.join(fixture, original.walPath), shmPath = path.join(fixture, original.shmPath);
    const wal = Buffer.from(original.walBytes); wal[56] ^= 1;
    fs.writeFileSync(walPath, wal);
    assert.throws(() => observeStoreWalFilesV1(fixture), /frame_checksum/u);
    fs.writeFileSync(walPath, original.walBytes);
    const shm = Buffer.from(original.shmBytes); shm[40] ^= 1;
    fs.writeFileSync(shmPath, shm);
    assert.throws(() => observeStoreWalFilesV1(fixture), /shm_header_copies|shm_checksum/u);
    fs.writeFileSync(shmPath, original.shmBytes);
    const before = observeStoreWalFilesV1(fixture);
    fs.chmodSync(shmPath, Number(before.identity.mode) & 0o777 ^ 0o100);
    const changedMode = observeStoreWalFilesV1(fixture);
    assert.throws(() => validateStoreWalReadCoordinationV1(before, changedMode, changedMode, 'node'), /durable_or_other_shm_change/u);
    fs.chmodSync(shmPath, Number(before.identity.mode) & 0o777);
    const other = Buffer.from(before.shmBytes); other[136] ^= 1;
    fs.writeFileSync(shmPath, other);
    const changedOther = observeStoreWalFilesV1(fixture);
    assert.throws(() => validateStoreWalReadCoordinationV1(before, changedOther, changedOther, 'node'), /durable_or_other_shm_change/u);
    fs.writeFileSync(shmPath, original.shmBytes);
  } finally { closeStoreStatusFixtureV1(fixture); fs.rmSync(fixture, { recursive: true, force: true }); }
});


test('closed_wal_creation_refuses_forged_full_file_geometry_ownership_and_namespace_claims', async () => {
  for (const mutate of [proof => { proof.zeroFrameShmSha256 = `sha256:${'0'.repeat(64)}`; },
    proof => { proof.createdFilePaths.push('runtime/arbitrary-output'); },
    proof => { proof.createdOwnershipPermissionsAndIdentityVerified = false; },
    proof => { proof.physicalObservations.stages[0].files[0].path = 'runtime/foreign-output'; },
    proof => { proof.physicalObservations.stages[0].files[0].identity.size = '4096'; },
    proof => { proof.physicalObservations.stages[0].files[1].sha256 = `sha256:${'0'.repeat(64)}`; },
    proof => { proof.physicalObservations.stages[0].files[1].identity.uid = '0'; },
    proof => { proof.physicalObservations.stages[0].files[1].identity.gid = '0'; },
    proof => { proof.physicalObservations.stages[0].files[1].identity.mode = '33152'; },
    proof => { proof.physicalObservations.stages[0].files[1].identity.ino = '0'; },
    proof => { proof.physicalObservations.stages[0].parent.names.push('foreign-output'); },
    proof => { proof.physicalObservations.stages[0].parent.times.mtimeNs = '0'; }]) {
    const forged = structuredClone(observed);
    forged.kind = 'NodeRustRouteAcceptanceRecordV1'; forged.subject.committedClean = true;
    mutate(forged.rows.find(row => row.routeId === 'operator/store').cases.find(entry => entry.caseId.startsWith('closed-wal/')).readCoordination);
    rehash(forged);
    await assert.rejects(() => consumeRouteAcceptanceRecordV1(forged), /closed_wal_claim_invalid/u);
  }
});

test('actual_closed_wal_objects_refuse_nonempty_wal_shm_byte_mutation_file_aliases_and_changed_parent_namespace', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-store-closed-wal-refusal-'));
  try {
    const prepared = storeStatusFixtureV1(fixture, 'closed-wal', process.env);
    const before = observeStoreClosedWalFilesV1(fixture);
    const output = spawnSync(process.execPath, [...prepared.node, '--'], {
      cwd: prepared.cwd, env: { ...process.env, ...prepared.environment }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(output.status, 0, output.stderr);
    const original = observeStoreClosedWalFilesV1(fixture);
    const wal = path.join(fixture, original.coordinationPaths[0]), shm = path.join(fixture, original.coordinationPaths[1]);
    const bytes = fs.readFileSync(shm), altered = Buffer.from(bytes); altered[136] = 1;
    fs.writeFileSync(shm, altered);
    assert.throws(() => observeStoreClosedWalFilesV1(fixture), /closed_zero_frame_shm_bytes/u);
    fs.writeFileSync(shm, bytes);
    fs.writeFileSync(wal, 'unexpected product frame');
    assert.throws(() => observeStoreClosedWalFilesV1(fixture), /held_file/u);
    fs.writeFileSync(wal, Buffer.alloc(0));
    const originalMode = fs.statSync(shm).mode & 0o777;
    fs.chmodSync(shm, originalMode ^ 0o020);
    assert.throws(() => observeStoreClosedWalFilesV1(fixture), /closed_created_ownership_or_mode/u);
    fs.chmodSync(shm, originalMode);
    const link = path.join(fixture, 'shm-hardlink'); fs.linkSync(shm, link);
    assert.throws(() => observeStoreClosedWalFilesV1(fixture), /held_file/u); fs.unlinkSync(link);
    fs.writeFileSync(path.join(fixture, 'runtime/foreign-output'), 'unrelated');
    const changed = observeStoreClosedWalFilesV1(fixture);
    assert.throws(() => validateStoreClosedWalReadCoordinationV1(before,
      [{ reader: 'node', phase: 'complete', state: changed }], 'node'), /closed_other_namespace_changed/u);
  } finally { closeStoreStatusFixtureV1(fixture); fs.rmSync(fixture, { recursive: true, force: true }); }
});


test('whole_record_schema_rejects_malformed_runtime_outcomes_environment_and_physical_diagnostics_before_replay', async () => {
  for (const mutate of [record => { record.runtime.unrecognizedAuthority = true; },
    record => { record.rows[0].cases[0].node.outcome = 'unrecognized'; },
    record => { record.rows[0].cases[0].environment.HEPTA_PAPER_RUNTIME_ROOT = 42; },
    record => { record.rows[0].cases.find(entry => entry.caseId.startsWith('closed-wal/')).readCoordination.physicalObservations.before.foreign = true; }]) {
    const forged = structuredClone(observed);
    forged.kind = 'NodeRustRouteAcceptanceRecordV1'; forged.subject.committedClean = true;
    mutate(forged); rehash(forged);
    await assert.rejects(() => consumeRouteAcceptanceRecordV1(forged), /record_schema_invalid/u);
  }
});

test('different_route_selection_runs_its_own_matrix_without_revoking_the_current_prior_summary', async () => {
  if (!observed.subject.committedClean) {
    assert.equal(verifiedOwnSummary, undefined); return;
  }
  const selected = rehash({ ...structuredClone(observed), rows: observed.rows
    .filter(row => row.routeId === 'operator/workspace').map(row => structuredClone(row)) });
  assert.equal(validate(selected), true, JSON.stringify(validate.errors));
  const forged = structuredClone(selected);
  forged.rows[0].cases[0].node.stdout.status = 'different_selection_invented_success';
  forged.rows[0].cases[0].native.stdout.status = 'different_selection_invented_success'; rehash(forged);
  const outcomes = await Promise.allSettled([
    consumeRouteAcceptanceRecordV1(selected), consumeRouteAcceptanceRecordV1(structuredClone(selected)),
    consumeRouteAcceptanceRecordV1(forged),
  ]);
  assert.equal(outcomes[0].status, 'fulfilled', outcomes[0].reason?.stack);
  assert.equal(outcomes[1].status, 'fulfilled', outcomes[1].reason?.stack);
  assert.equal(outcomes[2].status, 'rejected'); assert.match(outcomes[2].reason.message, /actual_replay_differs/u);
  assert.deepEqual(outcomes[0].value.acceptedRouteIds, ['operator/workspace']);
  assert.notEqual(outcomes[0].value, outcomes[1].value);
  assert.deepEqual(assertVerifiedRouteAcceptanceV1(outcomes[1].value), outcomes[0].value);
  assert.deepEqual(assertVerifiedRouteAcceptanceV1(verifiedOwnSummary).acceptedRouteIds,
    ['operator/store', 'operator/workspace', 'verify/repository-assets']);
});

test('verified_own_summary_is_revoked_by_current_input_drift_and_restoration_does_not_revive_it', () => {
  if (!observed.subject.committedClean) return;
  assert.ok(verifiedOwnSummary);
  const original = process.env.TZ;
  try {
    process.env.TZ = original === 'Etc/GMT+3' ? 'Etc/GMT+4' : 'Etc/GMT+3';
    assert.throws(() => assertVerifiedRouteAcceptanceV1(verifiedOwnSummary), /not_independently_replayed/u);
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
  assert.throws(() => assertVerifiedRouteAcceptanceV1(verifiedOwnSummary), /not_independently_replayed/u);
});
