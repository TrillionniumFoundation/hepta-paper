import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deepFreezeJsonValue,
  isDeeplyFrozenJsonValue,
} from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifiedRecordHash,
} from '../../paper-domain/automation/experiment-run-receipt-verification-helpers.mjs';

function record(payload) {
  return {
    ...payload,
    receiptHash: hashRecord('DeepFreezeJsonValueTestReceipt', payload),
  };
}

test('deep JSON freeze recursively seals records and rejects non-JSON containers', () => {
  const value = deepFreezeJsonValue({
    array: [{ nested: true }],
    object: { value: 1 },
  });
  assert.equal(isDeeplyFrozenJsonValue(value), true);
  assert.throws(() => { value.array[0].nested = false; }, TypeError);
  assert.throws(() => deepFreezeJsonValue({ date: new Date() }),
    /deep_freeze_json_value_non_json_container/);
});

test('verified record hash cache never trusts mutable nested state', () => {
  const mutable = record({ nested: { value: 1 } });
  assert.equal(verifiedRecordHash(mutable, {
    kind: 'DeepFreezeJsonValueTestReceipt',
    hashField: 'receiptHash',
  }), mutable.receiptHash);
  mutable.nested.value = 2;
  assert.equal(verifiedRecordHash(mutable, {
    kind: 'DeepFreezeJsonValueTestReceipt',
    hashField: 'receiptHash',
  }), null);

  const immutable = deepFreezeJsonValue(record({ nested: { value: 1 } }));
  assert.equal(verifiedRecordHash(immutable, {
    kind: 'DeepFreezeJsonValueTestReceipt',
    hashField: 'receiptHash',
  }), immutable.receiptHash);
  assert.equal(verifiedRecordHash(immutable, {
    kind: 'DeepFreezeJsonValueTestReceipt',
    hashField: 'receiptHash',
  }), immutable.receiptHash);
});

test('record hashing never memoizes shallow-frozen children or accessors', () => {
  const nested = { value: 1 };
  const shallowFrozen = Object.freeze({ nested });
  const firstNestedHash = hashRecord('ShallowFrozenRecord', shallowFrozen);
  nested.value = 2;
  assert.notEqual(
    hashRecord('ShallowFrozenRecord', shallowFrozen),
    firstNestedHash,
  );

  let accessorValue = 1;
  const accessorRecord = Object.freeze({
    get value() { return accessorValue; },
  });
  const firstAccessorHash = hashRecord('FrozenAccessorRecord', accessorRecord);
  accessorValue = 2;
  assert.notEqual(
    hashRecord('FrozenAccessorRecord', accessorRecord),
    firstAccessorHash,
  );
});
