import readline from 'node:readline';
import {
  buildAutonomousResearchOnlineSchemaTransitionFinalizeRequest,
  buildAutonomousResearchOnlineSchemaTransitionObserveRequest,
} from '/home/qian-qi/Documents/Codex/2026-09-16/trillionniumfoundation-https-github-com-trillionniumfoundation-github/work/latest/paper-adapters/automation/autonomous-research-online-schema-transition-state.mjs';

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  try {
    const input = JSON.parse(line);
    const finalize = buildAutonomousResearchOnlineSchemaTransitionFinalizeRequest(input);
    const observe = buildAutonomousResearchOnlineSchemaTransitionObserveRequest({
      plan: input.plan,
      finalization: input.finalization,
      postInventoryHash: input.postInventoryHash,
      postPristineRuntimeStateHash: input.postPristineRuntimeStateHash,
      nonce: input.nonce,
      requestedAt: input.requestedAt,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, finalize, observe })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  }
}
