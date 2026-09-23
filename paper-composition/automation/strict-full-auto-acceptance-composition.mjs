import path from 'node:path';

import { StrictFullAutoAcceptanceCommandRunner } from '../../paper-adapters/automation/strict-full-auto-acceptance-command-runner.mjs';
import { StrictFullAutoAcceptanceRepository } from '../../paper-adapters/automation/strict-full-auto-acceptance-repository.mjs';
import { StrictFullAutoAcceptanceOrchestrator } from '../../paper-application/automation/strict-full-auto-acceptance-orchestrator.mjs';
import {
  composeAutonomousResearchPristineRuntimeInspector,
} from './autonomous-research-pristine-runtime-state-composition.mjs';

export function composeStrictFullAutoAcceptance({
  workspaceRoot,
  configurationPath,
  environment = process.env,
  repository = null,
  commandRunner = null,
  pristineRuntimeInspector,
  clock,
  now,
} = {}) {
  const resolvedRoot = path.resolve(workspaceRoot);
  const selectedPristineRuntimeInspector = pristineRuntimeInspector === undefined
    ? composeAutonomousResearchPristineRuntimeInspector({
      workspaceRoot: resolvedRoot,
      authorityProcessConfigurationPath:
        environment.HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_PROCESS_CONFIG
        || undefined,
      authorityConfigurationPath:
        environment.HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_CONFIG || null,
      ...(clock ? { clock } : {}),
    })
    : pristineRuntimeInspector;
  return new StrictFullAutoAcceptanceOrchestrator({
    repository: repository || new StrictFullAutoAcceptanceRepository({
      configurationPath,
      pristineRuntimeInspector: selectedPristineRuntimeInspector,
      ...(clock ? { clock } : {}),
    }),
    commandRunner: commandRunner || new StrictFullAutoAcceptanceCommandRunner({
      workspaceRoot: resolvedRoot,
      environment,
    }),
    now,
  });
}
