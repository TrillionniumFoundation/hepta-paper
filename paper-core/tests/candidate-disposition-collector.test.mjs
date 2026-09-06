import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  CANDIDATE_DISPOSITION_INPUT_BOUNDARY,
  collectCandidateDispositionBytesV1,
  sealCandidateBatchJsonV1,
} from '../../paper-application/orchestration/candidate-disposition-collector.mjs';

const hashText = (text) => `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
const h = (character = 'a') => `sha256:${character.repeat(64)}`;
const authority = () => ({
  productionAuthorized: false,
  providerAuthorized: false,
  campaignWriterActivated: false,
  releaseAuthorized: false,
  submissionAuthorized: false,
  externalAuthorityClaimed: false,
});
const producers = Object.freeze([
  Object.freeze({ moduleId: 'module.alpha', moduleVersion: '1.0.0', qualificationMetadataHash: h('1') }),
  Object.freeze({ moduleId: 'module.beta', moduleVersion: '1.0.0', qualificationMetadataHash: h('2') }),
]);

function candidate(owner = producers[0], id = 'candidate-a', extra = {}) {
  return {
    candidateId: id,
    candidatePayloadHash: hashText(id),
    planningRequestId: 'planning-request-1',
    stateSnapshotHash: h('3'),
    moduleId: owner.moduleId,
    moduleVersion: owner.moduleVersion,
    capabilityId: 'CAP-MOD-CANDIDATE',
    value: { utility: 1 },
    ...extra,
  };
}

function seal(owner, candidates) {
  return sealCandidateBatchJsonV1({
    inputBoundary: CANDIDATE_DISPOSITION_INPUT_BOUNDARY,
    planningRequestId: 'planning-request-1',
    stateSnapshotHash: h('3'),
    capabilityId: 'CAP-MOD-CANDIDATE',
    moduleId: owner.moduleId,
    moduleVersion: owner.moduleVersion,
    candidates,
    maximumCandidates: 32,
    maximumBatchBytes: 1024 * 1024,
    maximumNodes: 10000,
  });
}

function completeFromBatch(owner, batch, overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'ModuleCandidateDispositionV1',
    moduleId: owner.moduleId,
    moduleVersion: owner.moduleVersion,
    qualificationMetadataHash: owner.qualificationMetadataHash,
    planningRequestId: 'planning-request-1',
    planningRequestHash: h('4'),
    stateSnapshotHash: h('3'),
    capabilityId: 'CAP-MOD-CANDIDATE',
    status: 'candidate_batch_complete',
    completedAt: '2026-09-06T07:59:00Z',
    candidateCount: batch.candidateCount,
    candidateBatchJson: batch.candidateBatchJson,
    candidateBatchByteHash: batch.candidateBatchByteHash,
    emptyReason: batch.candidateCount === 0 ? 'no_candidates' : null,
    failureCode: null,
    externalActionPerformed: false,
    authority: authority(),
    ...overrides,
  };
}

function complete(owner, candidates = [candidate(
  owner, owner.moduleId === 'module.alpha' ? 'candidate-a' : 'candidate-b',
)], overrides = {}) {
  return completeFromBatch(owner, seal(owner, candidates), overrides);
}

function failed(owner, status = 'candidate_batch_failed', failureCode = 'producer_failed') {
  return {
    schemaVersion: 1,
    kind: 'ModuleCandidateDispositionV1',
    moduleId: owner.moduleId,
    moduleVersion: owner.moduleVersion,
    qualificationMetadataHash: owner.qualificationMetadataHash,
    planningRequestId: 'planning-request-1',
    planningRequestHash: h('4'),
    stateSnapshotHash: h('3'),
    capabilityId: 'CAP-MOD-CANDIDATE',
    status,
    completedAt: '2026-09-06T07:59:00Z',
    candidateCount: null,
    candidateBatchJson: null,
    candidateBatchByteHash: null,
    emptyReason: null,
    failureCode,
    externalActionPerformed: false,
    authority: authority(),
  };
}

function request(dispositions, overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'CandidateDispositionCollectionRequestV1',
    inputBoundary: CANDIDATE_DISPOSITION_INPUT_BOUNDARY,
    planningRequestId: 'planning-request-1',
    planningRequestHash: h('4'),
    stateSnapshotHash: h('3'),
    capabilityId: 'CAP-MOD-CANDIDATE',
    moduleQualificationMetadataSetHash: h('5'),
    observedAt: '2026-09-06T08:00:00Z',
    deadline: '2026-09-06T09:00:00Z',
    expectedProducers: [...producers],
    dispositions,
    maximumProducers: 16,
    maximumCandidates: 32,
    maximumBatchBytes: 1024 * 1024,
    maximumTotalBytes: 2 * 1024 * 1024,
    maximumNodes: 10000,
    ...overrides,
  };
}

test('sealer and complete aggregation are deterministic across input order', () => {
  const alpha = complete(producers[0], [
    candidate(producers[0], 'candidate-z'),
    candidate(producers[0], 'candidate-a'),
  ]);
  const beta = complete(producers[1]);
  const left = collectCandidateDispositionBytesV1(request([alpha, beta]));
  const right = collectCandidateDispositionBytesV1(request([beta, alpha], {
    expectedProducers: [...producers].reverse(),
  }));
  assert.equal(left.status, 'candidate_dispositions_complete');
  assert.equal(left.readyForRouting, true);
  assert.equal(left.executionEligible, false);
  assert.equal(left.candidateDispositionCollectionHash,
    right.candidateDispositionCollectionHash);
  assert.deepEqual(left.candidates.map((item) => item.candidateId),
    ['candidate-a', 'candidate-b', 'candidate-z']);
  assert.ok(left.producerDispositions.every(
    (item) => item.candidateBytesValidated === true,
  ));
  assert.ok(Object.values(left.authority).every((value) => value === false));
});

test('missing producer returns incomplete without parsing successful peer bytes', () => {
  const hostile = complete(producers[0]);
  hostile.candidateBatchJson = '{not-json';
  hostile.candidateBatchByteHash = h('9');
  const result = collectCandidateDispositionBytesV1(request([hostile]));
  assert.equal(result.status, 'candidate_dispositions_incomplete');
  assert.equal(result.readyForRouting, false);
  assert.equal(result.candidates, null);
  assert.equal(result.candidateSetInputHash, null);
  assert.equal(result.candidateBatchSetHash, null);
  assert.deepEqual(result.incompleteReasons,
    ['module.beta@1.0.0:producer_missing']);
  assert.equal(result.producerDispositions[0].candidateBytesValidated, false);
});

test('incomplete path still enforces aggregate retained-byte and count ceilings', () => {
  const oversized = complete(producers[0]);
  oversized.candidateBatchJson = 'x'.repeat(2048);
  oversized.candidateBatchByteHash = hashText(oversized.candidateBatchJson);
  assert.throws(() => collectCandidateDispositionBytesV1(request([oversized], {
    maximumBatchBytes: 4096,
    maximumTotalBytes: 1024,
  })), { code: 'candidate_disposition_byte_limit' });

  const counted = complete(producers[0]);
  counted.candidateCount = 2;
  assert.throws(() => collectCandidateDispositionBytesV1(request([counted], {
    maximumCandidates: 1,
  })), { code: 'candidate_disposition_count_invalid' });
});

test('failed, cancelled, timeout and unavailable dispositions publish no partial set', () => {
  for (const [status, failureCode] of [
    ['candidate_batch_failed', 'producer_failed'],
    ['candidate_batch_cancelled', 'producer_cancelled'],
    ['candidate_batch_timeout', 'producer_timeout_unreconciled'],
    ['candidate_batch_unavailable', 'producer_unavailable'],
  ]) {
    const result = collectCandidateDispositionBytesV1(request([
      complete(producers[0]),
      failed(producers[1], status, failureCode),
    ]));
    assert.equal(result.status, 'candidate_dispositions_incomplete');
    assert.equal(result.readyForRouting, false);
    assert.equal(result.candidates, null);
    assert.deepEqual(result.incompleteReasons,
      [`module.beta@1.0.0:${failureCode}`]);
  }
});

test('all producers may explicitly complete with zero candidates', () => {
  const result = collectCandidateDispositionBytesV1(request([
    complete(producers[0], []),
    complete(producers[1], []),
  ]));
  assert.equal(result.status, 'candidate_dispositions_complete');
  assert.equal(result.readyForRouting, true);
  assert.deepEqual(result.candidates, []);
  assert.match(result.candidateSetInputHash, /^sha256:/u);
});

test('duplicate, unexpected and qualification-substituted producers fail', () => {
  const alpha = complete(producers[0]);
  assert.throws(() => collectCandidateDispositionBytesV1(request([alpha, alpha])),
    { code: 'candidate_disposition_duplicate' });
  assert.throws(() => collectCandidateDispositionBytesV1(request([
    alpha,
    { ...complete(producers[1]), moduleId: 'module.extra' },
  ])), { code: 'candidate_disposition_unexpected_producer' });
  assert.throws(() => collectCandidateDispositionBytesV1(request([
    alpha,
    { ...complete(producers[1]), qualificationMetadataHash: h('8') },
  ])), { code: 'candidate_disposition_unexpected_producer' });
  assert.throws(() => collectCandidateDispositionBytesV1(request([alpha], {
    expectedProducers: [producers[0], producers[0]],
  })), { code: 'candidate_expected_producer_duplicate' });
});

test('complete path requires exact byte hash and canonical JSON', () => {
  const badHash = complete(producers[0]);
  badHash.candidateBatchByteHash = h('8');
  assert.throws(() => collectCandidateDispositionBytesV1(request([
    badHash, complete(producers[1]),
  ])), { code: 'candidate_disposition_batch_hash_mismatch' });

  const noncanonical = complete(producers[0]);
  noncanonical.candidateBatchJson = ` ${noncanonical.candidateBatchJson}`;
  noncanonical.candidateBatchByteHash = hashText(noncanonical.candidateBatchJson);
  assert.throws(() => collectCandidateDispositionBytesV1(request([
    noncanonical, complete(producers[1]),
  ])), { code: 'candidate_disposition_batch_canonical_mismatch' });
});

test('duplicate JSON keys cannot survive canonical byte verification', () => {
  const disposition = complete(producers[0]);
  disposition.candidateBatchJson =
    '[{"candidateId":"candidate-a","candidateId":"candidate-x"}]';
  disposition.candidateBatchByteHash = hashText(disposition.candidateBatchJson);
  disposition.candidateCount = 1;
  assert.throws(() => collectCandidateDispositionBytesV1(request([
    disposition, complete(producers[1]),
  ])));
});

test('declared count must equal exact parsed candidate count', () => {
  const disposition = complete(producers[0]);
  disposition.candidateCount = 2;
  assert.throws(() => collectCandidateDispositionBytesV1(request([
    disposition, complete(producers[1]),
  ])), { code: 'candidate_disposition_batch_canonical_mismatch' });
});

test('candidate owner and planning subject cannot be spliced', () => {
  const betaBatch = seal(producers[1], [candidate(producers[1], 'candidate-x')]);
  const wrongOwnerDisposition = completeFromBatch(producers[0], betaBatch);
  assert.throws(() => collectCandidateDispositionBytesV1(request([
    wrongOwnerDisposition, complete(producers[1]),
  ])), { code: 'candidate_batch_candidate_subject_mismatch' });

  const wrongSnapshotCandidate = candidate(producers[0], 'candidate-x', {
    stateSnapshotHash: h('7'),
  });
  const source = JSON.stringify([wrongSnapshotCandidate]);
  const wrongSnapshotDisposition = {
    ...complete(producers[0]),
    candidateBatchJson: source,
    candidateBatchByteHash: hashText(source),
    candidateCount: 1,
  };
  assert.throws(() => collectCandidateDispositionBytesV1(request([
    wrongSnapshotDisposition, complete(producers[1]),
  ])));

  assert.throws(() => collectCandidateDispositionBytesV1(request([
    { ...complete(producers[0]), planningRequestHash: h('7') },
    complete(producers[1]),
  ])), { code: 'candidate_disposition_subject_mismatch' });
});

test('per-batch, aggregate-byte, node and total-candidate limits are hard', () => {
  const alpha = complete(producers[0], [candidate(producers[0], 'candidate-a', {
    value: { text: 'x'.repeat(2300) },
  })]);
  const beta = complete(producers[1], [candidate(producers[1], 'candidate-b', {
    value: { text: 'y'.repeat(2300) },
  })]);
  assert.throws(() => collectCandidateDispositionBytesV1(request([alpha, beta], {
    maximumBatchBytes: 4096,
    maximumTotalBytes: 4096,
  })), { code: 'candidate_disposition_byte_limit' });
  assert.throws(() => collectCandidateDispositionBytesV1(request([
    complete(producers[0]), complete(producers[1]),
  ], { maximumCandidates: 1 })), { code: 'candidate_disposition_candidate_limit' });
  assert.throws(() => collectCandidateDispositionBytesV1(request([
    complete(producers[0]), complete(producers[1]),
  ], { maximumNodes: 1 })), { code: 'candidate_batch_structure_limit' });
});

test('authority, external action, future completion and expired request deny', () => {
  for (const override of [
    { authority: { ...authority(), productionAuthorized: true } },
    { externalActionPerformed: true },
    { completedAt: '2026-09-06T08:00:01Z' },
  ]) {
    assert.throws(() => collectCandidateDispositionBytesV1(request([
      { ...complete(producers[0]), ...override },
      complete(producers[1]),
    ])));
  }
  assert.throws(() => collectCandidateDispositionBytesV1(request([], {
    observedAt: '2026-09-06T10:00:00Z',
    deadline: '2026-09-06T09:00:00Z',
    expectedProducers: [],
  })), { code: 'candidate_disposition_request_invalid' });
});

test('accessors and sparse arrays are rejected without getter execution', () => {
  let calls = 0;
  const accessor = Object.defineProperty(complete(producers[0]),
    'candidateBatchJson', {
      enumerable: true,
      get() { calls += 1; return '[]'; },
    });
  assert.throws(() => collectCandidateDispositionBytesV1(request([
    accessor, complete(producers[1]),
  ])), { code: 'candidate_disposition_invalid' });
  assert.equal(calls, 0);

  const sparse = [];
  sparse.length = 2;
  sparse[1] = complete(producers[1]);
  assert.throws(() => collectCandidateDispositionBytesV1(request(sparse)),
    { code: 'candidate_dispositions_invalid' });
});

test('isolated surrogates deny while special keys and valid pairs stay visible', () => {
  const invalid = candidate();
  Object.defineProperty(invalid.value, '\ud800', { enumerable: true, value: 'invalid' });
  assert.throws(() => seal(producers[0], [invalid]));

  const valid = candidate();
  Object.defineProperty(valid.value, '__proto__', {
    enumerable: true,
    value: { key: '😀' },
  });
  const batch = seal(producers[0], [valid]);
  assert.match(batch.candidateBatchJson, /__proto__/u);
  const parsed = JSON.parse(batch.candidateBatchJson);
  assert.ok(Object.hasOwn(parsed[0].value, '__proto__'));
});

test('caller mutation after sealing does not alter disposition bytes', () => {
  const original = candidate();
  const batch = seal(producers[0], [original]);
  const disposition = completeFromBatch(producers[0], batch);
  original.value.utility = 999;
  const result = collectCandidateDispositionBytesV1(request([
    disposition, complete(producers[1]),
  ]));
  assert.equal(result.candidates[0].value.utility, 1);
  assert.throws(() => { result.candidates[0].value.utility = 7; }, TypeError);
  assert.throws(() => { result.producerDispositions.push('x'); }, TypeError);
});

test('zero expected producers is an explicit complete empty collection', () => {
  const result = collectCandidateDispositionBytesV1(request([], {
    expectedProducers: [],
  }));
  assert.equal(result.status, 'candidate_dispositions_complete');
  assert.equal(result.expectedProducerCount, 0);
  assert.equal(result.receivedProducerCount, 0);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.readyForRouting, true);
});

test('failure disposition cannot smuggle candidate bytes', () => {
  const bad = { ...failed(producers[1]), candidateBatchJson: '[]' };
  assert.throws(() => collectCandidateDispositionBytesV1(request([
    complete(producers[0]), bad,
  ])), { code: 'candidate_disposition_failure_shape_invalid' });
});

test('partial status never validates or credits successful candidate bytes', () => {
  const alpha = complete(producers[0]);
  alpha.candidateBatchJson = '[]';
  alpha.candidateBatchByteHash = hashText('[]');
  alpha.candidateCount = 1;
  const result = collectCandidateDispositionBytesV1(request([
    alpha,
    failed(producers[1], 'candidate_batch_timeout', 'producer_timeout_unreconciled'),
  ]));
  assert.equal(result.status, 'candidate_dispositions_incomplete');
  assert.equal(result.producerDispositions[0].candidateBytesValidated, false);
  assert.equal(result.candidates, null);
});

test('sealer output is canonical and insensitive to candidate order', () => {
  const left = seal(producers[0], [
    candidate(producers[0], 'candidate-z'),
    candidate(producers[0], 'candidate-a'),
  ]);
  const right = seal(producers[0], [
    candidate(producers[0], 'candidate-a'),
    candidate(producers[0], 'candidate-z'),
  ]);
  assert.equal(left.candidateBatchJson, right.candidateBatchJson);
  assert.equal(left.candidateBatchByteHash, right.candidateBatchByteHash);
});

test('nested JSON depth is rejected before full semantic consumption', () => {
  const disposition = complete(producers[0]);
  const deep = `${'['.repeat(50)}0${']'.repeat(50)}`;
  disposition.candidateBatchJson = deep;
  disposition.candidateBatchByteHash = hashText(deep);
  disposition.candidateCount = 1;
  assert.throws(() => collectCandidateDispositionBytesV1(request([
    disposition, complete(producers[1]),
  ])), { code: 'candidate_batch_structure_limit' });
});
