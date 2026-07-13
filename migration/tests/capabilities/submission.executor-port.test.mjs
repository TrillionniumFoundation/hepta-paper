import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSubmissionExecutorPort } from '../../../paper-ports/submission-executor-port.mjs';
import { buildExecutorCapabilities } from '../../../paper-ports/executor-capabilities.mjs';

test('submission.executor-port requires an external provider/account scoped workspace', () => {
  assert.throws(() => assertSubmissionExecutorPort({ executorId: 'e', provider: 'p', accountId: 'a', workspaceRoot: '/x', dispatch() {} }));
  const capabilities = () => buildExecutorCapabilities({ executorId: 'e', sandboxModes: ['provider-workspace'], networkPolicy: 'provider-scoped', externalActions: true, workspaceIsolation: true, receiptKinds: ['SubmissionProviderReceipt'], provider: 'p' });
  assert.ok(assertSubmissionExecutorPort({ executorId: 'e', provider: 'p', accountId: 'a', workspaceRoot: '/x', externalWorkspace: true, capabilities, dispatch() {} }));
});
