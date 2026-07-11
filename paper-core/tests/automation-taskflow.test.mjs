import assert from 'node:assert/strict';
import test from 'node:test';
import { advancePaperCampaignTaskFlow, linkPaperCampaignChildSessions, startPaperCampaignTaskFlow } from '../../paper-application/orchestration/paper-campaign-taskflow.mjs';

function fake() {
  const calls = [];
  const flow = (revision, stateJson, status = 'running') => ({ flowId: 'flow', revision, stateJson, status });
  return {
    calls,
    createManaged: (input) => (calls.push(['createManaged', input]), flow(1, input.stateJson)),
    runTask: (input) => (calls.push(['runTask', input]), { created: true }),
    setWaiting: (input) => (calls.push(['setWaiting', input]), { applied: true, flow: flow(input.expectedRevision + 1, input.stateJson, 'waiting') }),
    resume: (input) => (calls.push(['resume', input]), { applied: true, flow: flow(input.expectedRevision + 1, input.stateJson) }),
    finish: (input) => (calls.push(['finish', input]), { applied: true, flow: flow(input.expectedRevision + 1, input.stateJson, 'finished') }),
    fail: (input) => (calls.push(['fail', input]), { applied: true, flow: flow(input.expectedRevision + 1, input.stateJson, 'failed') }),
    requestCancel: (input) => (calls.push(['requestCancel', input]), { applied: true, flow: flow(input.expectedRevision + 1, input.stateJson, 'cancelling') }),
    cancel: (input) => (calls.push(['cancel', input]), { applied: true, flow: flow(input.expectedRevision + 1, input.stateJson, 'cancelled') }),
    getTaskSummary() {},
  };
}

const snapshot = (status = 'running') => ({ campaignId: 'c', paperId: 'p', campaignPlanHash: 'sha256:plan', status, completedNodes: status === 'completed' ? 10 : 2, totalNodes: 10, failedNodes: 0 });

test('TaskFlow mirrors native campaign state without owning DAG decisions', () => {
  const taskFlow = fake();
  const started = startPaperCampaignTaskFlow({ taskFlow, snapshot: snapshot(), enabled: true, childTask: { childSessionKey: 'child', runId: 'run', task: 'execute native campaign' } });
  assert.equal(started.status, 'campaign_taskflow_waiting');
  assert.deepEqual(taskFlow.calls.map(([name]) => name), ['createManaged', 'runTask', 'setWaiting']);
  const finished = advancePaperCampaignTaskFlow({ taskFlow, currentFlow: started.flow, snapshot: snapshot('completed') });
  assert.equal(finished.status, 'campaign_taskflow_finished');
  assert.equal(advancePaperCampaignTaskFlow({ taskFlow, currentFlow: started.flow, snapshot: snapshot('cancelled') }).status, 'campaign_taskflow_cancelled');
  assert.equal(advancePaperCampaignTaskFlow({ taskFlow, currentFlow: started.flow, snapshot: snapshot('stopped') }).status, 'campaign_taskflow_stopped');
  assert.throws(() => advancePaperCampaignTaskFlow({ taskFlow, currentFlow: started.flow, snapshot: { ...snapshot(), campaignPlanHash: 'changed' } }), /identity must remain fixed/);
});

test('TaskFlow links OpenClaw child sessions without owning node state', () => {
  const taskFlow = fake();
  const linked = linkPaperCampaignChildSessions({ taskFlow, flowId: 'flow', nodes: [
    { node_id: 'n1', kind: 'writer', status: 'completed', result: { sessionKey: 'agent:main:child-1', childSessionId: 'uuid-1', openClawRunId: 'run-1' } },
    { node_id: 'n2', kind: 'compile', status: 'completed', result: {} },
  ] });
  assert.equal(linked.linkedCount, 1);
  assert.equal(taskFlow.calls.filter(([name]) => name === 'runTask').length, 1);
  assert.equal(taskFlow.calls.find(([name]) => name === 'runTask')[1].runtime, 'cli');
  assert.equal(taskFlow.calls.find(([name]) => name === 'runTask')[1].childSessionKey, 'agent:main:child-1');
});
