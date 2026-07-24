import fs from 'node:fs';
import path from 'node:path';
import { assertAgentExecutorPort } from '../../paper-ports/agent-executor-port.mjs';
import { assertResearchAgendaProducerPort } from '../../paper-ports/research-agenda-producer-port.mjs';
import {
  buildAutonomousResearchAgendaProductionReceipt,
  buildAutonomousResearchAgendaProductionRequest,
  verifyAutonomousResearchAgendaProductionReceipt,
} from '../../paper-domain/automation/autonomous-research-agenda-production-contract.mjs';
import {
  verifyAutonomousResearchAgentProductionAuthorityBinding,
} from '../../paper-domain/automation/autonomous-research-agent-production-authority-binding.mjs';
import {
  buildResearchAgendaIr,
  verifyResearchAgendaIr,
} from '../../paper-domain/automation/research-agenda-ir.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';
import {
  assertAgentProductionCacheRoot,
  prepareAgentProductionCacheRoot,
  readAgentProductionCache,
} from './agent-production-cache-safety.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const OUTPUT_KEYS = Object.freeze([
  'blockers', 'checksRun', 'objective', 'protocolFamily', 'status', 'summary',
]);
const GENERIC_OUTPUT_KEYS = Object.freeze([
  ...OUTPUT_KEYS,
  'dataRequirements', 'falsifiers', 'formalTargets', 'negativeBoundaries',
  'primaryClaim', 'priorArtQueryPlan', 'researchQuestion', 'resourceFeasibility',
  'venueConstraints',
].sort());
const PRODUCER_IMPLEMENTATION_HASH = hashBytes(fs.readFileSync(new URL(import.meta.url)));
const PRODUCER_TRANSITIVE_CONTRACT_HASH = hashRecord(
  'AgentResearchAgendaProducerTransitiveContracts',
  Object.freeze([
    '../../paper-domain/automation/autonomous-research-agent-production-authority-binding.mjs',
    '../../paper-domain/automation/autonomous-research-agenda-production-contract.mjs',
    '../../paper-domain/automation/research-agenda-ir.mjs',
    '../../paper-domain/evidence/agent-execution-receipt-contract.mjs',
    './agent-executor-template.mjs',
    './codex-agent-executor.mjs',
    './ollama-structured-agent-executor.mjs',
    './openclaw-agent-executor.mjs',
  ].map((relativePath) => Object.freeze({
    relativePath,
    contentHash: hashBytes(fs.readFileSync(new URL(relativePath, import.meta.url))),
  }))),
);

function agendaFromOutput(output, request) {
  const outputKeys = JSON.stringify(Object.keys(output || {}).sort());
  const genericOutput = outputKeys === JSON.stringify(GENERIC_OUTPUT_KEYS);
  if (!output || typeof output !== 'object' || Array.isArray(output)
    || (!genericOutput && outputKeys !== JSON.stringify(OUTPUT_KEYS))
    || output.status !== 'completed' || typeof output.summary !== 'string'
    || !output.summary.trim() || !Array.isArray(output.checksRun)
    || !Array.isArray(output.blockers) || output.blockers.length) {
    throw new Error('agent_research_agenda_structured_output_blocked');
  }
  const objective = String(output.objective || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const protocolFamily = String(output.protocolFamily || '').trim();
  if (!objective || objective.length > 8_000
    || !request.allowedProtocolFamilies.includes(protocolFamily)
    || (request.datasetAuthorityProtocolFamily
      && protocolFamily !== request.datasetAuthorityProtocolFamily)) {
    throw new Error('agent_research_agenda_selection_invalid');
  }
  return Object.freeze({
    selectedObjective: objective,
    selectedProtocolFamily: protocolFamily,
    semanticInput: genericOutput ? Object.freeze({
      researchQuestion: output.researchQuestion,
      primaryClaim: output.primaryClaim,
      dataRequirements: output.dataRequirements,
      falsifiers: output.falsifiers,
      negativeBoundaries: output.negativeBoundaries,
      formalTargets: output.formalTargets,
      priorArtQueryPlan: output.priorArtQueryPlan,
      venueConstraints: output.venueConstraints,
      resourceFeasibility: output.resourceFeasibility,
    }) : null,
  });
}

function cachePath(cacheRoot, requestHash) {
  const root = path.resolve(cacheRoot);
  const candidate = path.resolve(root, `${requestHash.slice('sha256:'.length)}.json`);
  if (!isPathWithin(root, candidate)) throw new Error('agent_research_agenda_cache_path_invalid');
  return { root, candidate };
}

function cachedResultValid(cached, request) {
  return cached?.request?.requestHash === request.requestHash
    && JSON.stringify(cached.request) === JSON.stringify(request)
    && verifyAutonomousResearchAgendaProductionReceipt(cached.receipt, {
      request: cached.request,
      agentExecutionReceipt: cached.agentExecutionReceipt,
    }).valid
    && (cached.researchAgendaIr === undefined
      || verifyResearchAgendaIr(cached.researchAgendaIr, {
        agendaProductionReceipt: cached.receipt,
      }));
}

function generationInstructions(request) {
  const constraint = request.datasetAuthorityProtocolFamily
    ? `The signed dataset authority hard-constrains protocolFamily to ${request.datasetAuthorityProtocolFamily}.`
    : 'Select exactly one protocolFamily from the allowedProtocolFamilies list.';
  return [
    'Generate one bounded, falsifiable research agenda without human approval.',
    `Allowed protocol families: ${request.allowedProtocolFamilies.join(', ')}.`,
    constraint,
    request.objectiveHint ? `Optional objective hint (do not copy mechanically): ${request.objectiveHint}` : '',
    request.protocolFamilyHint
      ? `Optional family hint (not authority): ${request.protocolFamilyHint}` : '',
    'The objective must identify a concrete intervention/comparison, evaluation population, and bounded empirical question compatible with the selected family.',
    'Do not claim novelty, truth, completed experiments, causal identification, formal proof, universal validity, or venue acceptance.',
    'Return exactly one JSON object with status, summary, checksRun, blockers, objective, protocolFamily, researchQuestion, primaryClaim, dataRequirements, falsifiers, negativeBoundaries, formalTargets, priorArtQueryPlan, venueConstraints, and resourceFeasibility; status must be completed and blockers empty.',
    'primaryClaim must be the exact intended empirical hypothesis statement. formalTargets must contain exactly one item: the exact intended natural-language formal claim statement. These exact strings become immutable downstream claim authority and may not be paraphrased by the content producer.',
    'dataRequirements must define population, intervention, comparator, estimand, requiredVariables, and datasetConstraints. venueConstraints must define paperType, requiredSections, artifactRequired, and anonymousReviewRequired. resourceFeasibility must define maximumWallTimeMs, maximumMemoryBytes, maximumCpuCount, and executionEnvironment.',
  ].filter(Boolean).join(' ');
}

function producerContractHash({ instructions, executorSurfaceHash } = {}) {
  return hashRecord('AgentResearchAgendaProducerContract', {
    version: 1,
    producerImplementationHash: PRODUCER_IMPLEMENTATION_HASH,
    producerTransitiveContractHash: PRODUCER_TRANSITIVE_CONTRACT_HASH,
    executorSurfaceHash,
    instructionsHash: hashBytes(instructions),
    outputKeys: GENERIC_OUTPUT_KEYS,
  });
}

export function createAgentResearchAgendaProducer({
  agentExecutor,
  workspacePath,
  cacheRoot,
  producerId,
  allowedProtocolFamilies,
  productionAuthorityBinding = null,
  clock = { now: () => new Date() },
  maximumOutputTokens = 2048,
  maximumWallTimeMs = 20 * 60 * 1000,
  assertExternalSideEffectReady = null,
} = {}) {
  const executor = assertAgentExecutorPort(agentExecutor);
  const executorSurfaceHash = hashRecord('AgentResearchAgendaProducerExecutorSurface', {
    version: executor.version,
    kind: executor.kind,
    executorId: executor.executorId,
    capabilities: executor.capabilities(),
    executeImplementationHash: hashBytes(Function.prototype.toString.call(executor.execute)),
  });
  const sourceWorkspace = fs.realpathSync(path.resolve(workspacePath || ''));
  const selectedProducerId = String(producerId || '').trim();
  if (!selectedProducerId || !cacheRoot || !Array.isArray(allowedProtocolFamilies)
    || !allowedProtocolFamilies.length || typeof clock?.now !== 'function'
    || (assertExternalSideEffectReady !== null
      && typeof assertExternalSideEffectReady !== 'function')) {
    throw new Error('agent_research_agenda_producer_dependencies_invalid');
  }
  if (productionAuthorityBinding !== null
    && (!verifyAutonomousResearchAgentProductionAuthorityBinding(
      productionAuthorityBinding,
    ) || productionAuthorityBinding.authorPrincipalId !== selectedProducerId)) {
    throw new Error('agent_research_agenda_production_authority_binding_invalid');
  }
  const preparedCache = prepareAgentProductionCacheRoot(cacheRoot);
  const cache = preparedCache.root;
  return assertResearchAgendaProducerPort(Object.freeze({
    version: 1,
    kind: 'AgentResearchAgendaProducer',
    producerId: selectedProducerId,
    async produce({
      paperId,
      objectiveHint = null,
      protocolFamilyHint = null,
      datasetAuthorityProtocolFamily = null,
      signal = null,
    } = {}) {
      const preliminaryRequest = buildAutonomousResearchAgendaProductionRequest({
        paperId,
        objectiveHint,
        protocolFamilyHint,
        datasetAuthorityProtocolFamily,
        allowedProtocolFamilies,
        productionAuthorityBinding,
        maximumOutputTokens,
        maximumWallTimeMs,
      });
      const instructions = generationInstructions(preliminaryRequest);
      const request = buildAutonomousResearchAgendaProductionRequest({
        ...preliminaryRequest,
        producerContractHash: producerContractHash({ instructions, executorSurfaceHash }),
      });
      const target = cachePath(cache, request.requestHash);
      const cached = readAgentProductionCache({
        cacheRoot: cache,
        cacheRootIdentity: preparedCache.identity,
        candidate: target.candidate,
        maximumBytes: 4 * 1024 * 1024,
      });
      if (cachedResultValid(cached, request)) {
        return Object.freeze({
          selectedObjective: cached.receipt.selectedObjective,
          selectedProtocolFamily: cached.receipt.selectedProtocolFamily,
          researchAgendaProducerReceipt: cached.receipt,
          agentExecutionReceipt: cached.agentExecutionReceipt,
          request: cached.request,
          researchAgendaIr: cached.researchAgendaIr || null,
          cacheHit: true,
          externalActionPerformed: false,
        });
      }
      if (assertExternalSideEffectReady) {
        await assertExternalSideEffectReady({
          action: 'research_agenda_producer_execute',
          paperId,
        });
        assertExternalSideEffectReady.assertCurrent?.({
          action: 'research_agenda_producer_execute',
          paperId,
        });
      }
      await assertExternalSideEffectReady?.markStarted?.({
        action: 'research_agenda_producer_execute',
      });
      const agentExecutionReceipt = await executor.execute({
        role: 'research-agenda-producer',
        workspacePath: sourceWorkspace,
        instructions,
        context: {
          paperId,
          agendaProductionRequestHash: request.requestHash,
          idempotencyKey: request.idempotencyKey,
          budgetReservationHash: request.budgetReservationHash,
          productionAuthorityBindingHash:
            productionAuthorityBinding
              ?.autonomousResearchAgentProductionAuthorityBindingHash || null,
          producerContractHash: request.producerContractHash,
          allowedProtocolFamilies: request.allowedProtocolFamilies,
          datasetAuthorityProtocolFamily: request.datasetAuthorityProtocolFamily,
        },
        sandbox: 'read-only',
        outputTokenBudget: request.maximumOutputTokens,
        timeoutMs: request.maximumWallTimeMs,
        signal,
      });
      const agenda = agendaFromOutput(agentExecutionReceipt.structuredOutput, request);
      const now = clock.now();
      const generatedAt = (now instanceof Date ? now : new Date(now)).toISOString();
      const receipt = buildAutonomousResearchAgendaProductionReceipt({
        request,
        ...agenda,
        agentExecutionReceipt,
        producerId: selectedProducerId,
        generatedAt,
      });
      const researchAgendaIr = agenda.semanticInput
        ? buildResearchAgendaIr({
          agendaProductionReceipt: receipt,
          ...agenda.semanticInput,
        }) : null;
      assertAgentProductionCacheRoot(cache, preparedCache.identity);
      writeDurableJsonSync(target.candidate, Object.freeze({
        request,
        agentExecutionReceipt,
        receipt,
        ...(researchAgendaIr ? { researchAgendaIr } : {}),
      }));
      return Object.freeze({
        selectedObjective: agenda.selectedObjective,
        selectedProtocolFamily: agenda.selectedProtocolFamily,
        researchAgendaProducerReceipt: receipt,
        researchAgendaIr,
        agentExecutionReceipt,
        request,
        cacheHit: false,
        externalActionPerformed: false,
      });
    },
  }));
}
