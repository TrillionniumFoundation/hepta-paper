import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { withPrivateReplayTargetFixture } from './support/private-replay-target-fixture.mjs';
for (const original of [undefined, '/an-inherited-target-never-touched']) {
  for (const throws of [false, true]) test(`private target restores ${original ?? 'absent'} environment on ${throws ? 'failure' : 'success'}`, () => {
    const ambient = process.env.CARGO_TARGET_DIR;
    let own;
    try {
      if (original === undefined) delete process.env.CARGO_TARGET_DIR; else process.env.CARGO_TARGET_DIR = original;
      const run = () => withPrivateReplayTargetFixture(target => {
        own = target; assert.notEqual(target, original); assert.equal(process.env.CARGO_TARGET_DIR, target);
        assert.equal(fs.statSync(target).isDirectory(), true);
        fs.writeFileSync(`${target}/only-owned-marker`, 'owned');
        if (throws) throw new Error('original operation failed');
        return 'original result';
      });
      if (throws) assert.throws(run, /original operation failed/); else assert.equal(run(), 'original result');
      assert.equal(process.env.CARGO_TARGET_DIR, original);
      assert.equal(fs.existsSync(own), false);
    } finally {
      if (ambient === undefined) delete process.env.CARGO_TARGET_DIR; else process.env.CARGO_TARGET_DIR = ambient;
    }
  });
}
