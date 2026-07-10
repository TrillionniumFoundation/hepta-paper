import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSubmissionExecutorPort } from '../../../paper-ports/submission-executor-port.mjs';

test('submission.executor-port requires an external provider/account scoped workspace', () => {
  assert.throws(() => assertSubmissionExecutorPort({ executorId: 'e', provider: 'p', accountId: 'a', workspaceRoot: '/x', dispatch() {} }));
  assert.ok(assertSubmissionExecutorPort({ executorId: 'e', provider: 'p', accountId: 'a', workspaceRoot: '/x', externalWorkspace: true, dispatch() {} }));
});
