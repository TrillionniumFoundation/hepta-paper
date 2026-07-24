import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCampaignNodeExecutor } from '../../paper-composition/automation/campaign-node-execution-composition.mjs';

test('source-closure empirical and final compile nodes fail closed without invoking a mutating repair', async (t) => {
  for (const fixture of [
    { kind: 'revalidate-empirical-source-seal', language: 'python', entrypoint: 'run.py', source: 'raise RuntimeError("fixture")\n' },
    { kind: 'final-compile', language: 'latex', entrypoint: 'main.tex', source: '\\documentclass{article}\n\\begin{document}fixture\\end{document}\n' },
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `hepta-source-seal-${fixture.language}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'main.tex'), fixture.language === 'latex' ? fixture.source : 'fixture\n');
    if (fixture.language === 'python') fs.writeFileSync(path.join(root, fixture.entrypoint), fixture.source);
    const before = new Map(fs.readdirSync(root).map((name) => [name, fs.readFileSync(path.join(root, name))]));
    fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
    let agentCalls = 0;
    let empiricalCalls = 0;
    const executor = createCampaignNodeExecutor({
      runtimeRoot: path.join(root, 'runtime'),
      empiricalExecutor: {
        async execute() {
          empiricalCalls += 1;
          return {
            status: 'empirical_execution_failed',
            blockers: ['os_sandbox_command_failed'],
            stderrTail: `${fixture.language} source seal fixture failure`,
          };
        },
      },
      agentExecutor: { async execute() { agentCalls += 1; throw new Error('source seal repair must not run'); } },
    });
    const revision = {
      nodeId: `revision-${fixture.language}`,
      kind: 'revise',
      roundIndex: 1,
      status: 'completed',
      result: { changedPaths: [fixture.entrypoint] },
    };
    await assert.rejects(
      () => executor.execute({
        campaign: { campaignId: `campaign-${fixture.language}`, paperId: `paper-${fixture.language}`, spec: { sourceWorkspace: root, languages: [fixture.language] } },
        node: {
          nodeId: `source-seal-${fixture.language}`,
          kind: fixture.kind,
          roundIndex: 1,
          spec: { language: fixture.language, sourceMutationPolicy: 'forbid' },
        },
        allNodes: [revision],
      }),
      new RegExp(`campaign_source_seal_repair_forbidden:${fixture.kind}:${fixture.language === 'latex' ? 'latex' : 'empirical-code'}`),
    );
    assert.equal(empiricalCalls, 1, fixture.language);
    assert.equal(agentCalls, 0, fixture.language);
    for (const [name, content] of before) {
      assert.deepEqual(fs.readFileSync(path.join(root, name)), content, `${fixture.language}:${name}`);
    }
  }
});
