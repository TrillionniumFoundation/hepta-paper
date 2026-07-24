import path from 'node:path';

import { StrictFullAutoAcceptanceCommandRunner } from '../../paper-adapters/automation/strict-full-auto-acceptance-command-runner.mjs';
import { StrictFullAutoAcceptanceRepository } from '../../paper-adapters/automation/strict-full-auto-acceptance-repository.mjs';
import { StrictFullAutoAcceptanceOrchestrator } from '../../paper-application/automation/strict-full-auto-acceptance-orchestrator.mjs';

export function composeStrictFullAutoAcceptance({
  workspaceRoot,
  configurationPath,
  environment = process.env,
  repository = null,
  commandRunner = null,
  now,
} = {}) {
  const resolvedRoot = path.resolve(workspaceRoot);
  return new StrictFullAutoAcceptanceOrchestrator({
    repository: repository || new StrictFullAutoAcceptanceRepository({ configurationPath }),
    commandRunner: commandRunner || new StrictFullAutoAcceptanceCommandRunner({
      workspaceRoot: resolvedRoot,
      environment,
    }),
    now,
  });
}
