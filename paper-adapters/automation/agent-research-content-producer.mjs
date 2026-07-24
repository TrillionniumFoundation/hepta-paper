import fs from 'node:fs';
import path from 'node:path';
import { assertAgentExecutorPort } from '../../paper-ports/agent-executor-port.mjs';
import { assertResearchContentProducerPort } from '../../paper-ports/research-content-producer-port.mjs';
import {
  buildAutonomousResearchContentProductionReceipt,
  buildAutonomousResearchContentProductionRequest,
  verifyAutonomousResearchContentProductionReceipt,
} from '../../paper-domain/automation/autonomous-research-content-production-contract.mjs';
import {
  verifyAutonomousResearchAgentProductionAuthorityBinding,
} from '../../paper-domain/automation/autonomous-research-agent-production-authority-binding.mjs';
import {
  selectAutonomousFormalSupportTemplate,
} from '../../paper-domain/automation/autonomous-formal-support-registry.mjs';
import { verifyResearchAgendaIr } from '../../paper-domain/automation/research-agenda-ir.mjs';
import {
  buildDynamicFormalClaimSeed,
} from '../../paper-domain/research/dynamic-formal-claim-seed-contract.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';
import {
  assertAgentProductionCacheRoot,
  prepareAgentProductionCacheRoot,
  readAgentProductionCache,
} from './agent-production-cache-safety.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const EMPIRICAL_HYPOTHESIS_KEYS = Object.freeze([
  'assumptions', 'empiricalObligations', 'negativeBoundaries', 'quantifiers', 'statement',
]);
const PRODUCER_IMPLEMENTATION_HASH = hashBytes(fs.readFileSync(new URL(import.meta.url)));
const PRODUCER_TRANSITIVE_CONTRACT_HASH = hashRecord(
  'AgentResearchContentProducerTransitiveContracts',
  Object.freeze([
    '../../paper-domain/automation/autonomous-formal-support-registry.mjs',
    '../../paper-domain/automation/autonomous-research-agent-production-authority-binding.mjs',
    '../../paper-domain/automation/autonomous-research-content-production-contract.mjs',
    '../../paper-domain/automation/autonomous-research-proposal-contract.mjs',
    '../../paper-domain/automation/research-agenda-claim-binding-contract.mjs',
    '../../paper-domain/automation/research-agenda-ir.mjs',
    '../../paper-domain/evidence/agent-execution-receipt-contract.mjs',
    '../../paper-domain/research/dynamic-formal-claim-seed-contract.mjs',
    './agent-executor-template.mjs',
    './codex-agent-executor.mjs',
    './ollama-structured-agent-executor.mjs',
    './openclaw-agent-executor.mjs',
  ].map((relativePath) => Object.freeze({
    relativePath,
    contentHash: hashBytes(fs.readFileSync(new URL(relativePath, import.meta.url))),
  }))),
);

function assertStructuredContentOutput(output, dynamicFormalClaimsEnabled) {
  const expectedKeys = [
    'blockers', 'checksRun', 'empiricalHypothesis', 'status', 'summary',
    ...(dynamicFormalClaimsEnabled ? ['dynamicFormalClaim'] : []),
  ].sort();
  if (!output || typeof output !== 'object' || Array.isArray(output)
    || JSON.stringify(Object.keys(output).sort()) !== JSON.stringify(expectedKeys)
    || output.status !== 'completed' || typeof output.summary !== 'string'
    || !output.summary.trim() || !Array.isArray(output.checksRun)
    || !Array.isArray(output.blockers) || output.blockers.length) {
    throw new Error('agent_research_content_structured_output_blocked');
  }
}

function normalizedList(value, label) {
  if (!Array.isArray(value) || !value.length || value.length > 16
    || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 2_000)) {
    throw new Error(`agent_research_content_${label}_invalid`);
  }
  const result = value.map((item) => item.normalize('NFKC').replace(/\s+/g, ' ').trim());
  if (new Set(result).size !== result.length) {
    throw new Error(`agent_research_content_${label}_duplicate`);
  }
  return Object.freeze(result);
}

function empiricalHypothesisFromOutput(output) {
  const source = output?.empiricalHypothesis;
  if (!source || JSON.stringify(Object.keys(source).sort())
    !== JSON.stringify(EMPIRICAL_HYPOTHESIS_KEYS)) {
    throw new Error('agent_research_content_empirical_hypothesis_shape_invalid');
  }
  const statement = String(source?.statement || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!statement || statement.length > 8_000) {
    throw new Error('agent_research_content_empirical_statement_invalid');
  }
  return Object.freeze({
    statement,
    assumptions: normalizedList(source.assumptions, 'empirical_assumptions'),
    quantifiers: normalizedList(source.quantifiers, 'empirical_quantifiers'),
    negativeBoundaries: normalizedList(source.negativeBoundaries, 'empirical_negative_boundaries'),
    empiricalObligations: normalizedList(source.empiricalObligations, 'empirical_obligations'),
  });
}

function dynamicFormalClaimFromOutput(output) {
  const source = output?.dynamicFormalClaim;
  const expectedKeys = [
    'allowedImports', 'assumptions', 'leanDeclarationName', 'leanTypeSource',
    'negativeBoundaries', 'proofObligations', 'quantifiers', 'statement',
  ];
  if (!source || JSON.stringify(Object.keys(source).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error('agent_research_content_dynamic_formal_claim_shape_invalid');
  }
  const statement = String(source.statement || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const leanDeclarationName = String(source.leanDeclarationName || '').trim();
  const leanTypeSource = String(source.leanTypeSource || '').trim();
  if (!statement || statement.length > 8_000 || !leanDeclarationName || !leanTypeSource) {
    throw new Error('agent_research_content_dynamic_formal_claim_invalid');
  }
  return Object.freeze({
    statement,
    assumptions: normalizedList(source.assumptions, 'formal_assumptions'),
    quantifiers: normalizedList(source.quantifiers, 'formal_quantifiers'),
    negativeBoundaries: normalizedList(source.negativeBoundaries, 'formal_negative_boundaries'),
    proofObligations: normalizedList(source.proofObligations, 'formal_obligations'),
    leanDeclarationName,
    leanTypeSource,
    allowedImports: normalizedList(source.allowedImports, 'formal_allowed_imports'),
  });
}

function contentFromOutput(output, protocolFamily, dynamicFormalClaimsEnabled) {
  assertStructuredContentOutput(output, dynamicFormalClaimsEnabled);
  const empiricalHypothesis = empiricalHypothesisFromOutput(output);
  if (dynamicFormalClaimsEnabled) {
    const dynamicFormalClaim = dynamicFormalClaimFromOutput(output);
    return Object.freeze({
      draft: Object.freeze({
        empiricalHypothesis,
        formalSupportClaim: Object.freeze({
          statement: dynamicFormalClaim.statement,
          assumptions: dynamicFormalClaim.assumptions,
          quantifiers: dynamicFormalClaim.quantifiers,
          negativeBoundaries: dynamicFormalClaim.negativeBoundaries,
          proofObligations: dynamicFormalClaim.proofObligations,
        }),
      }),
      dynamicFormalClaim,
    });
  }
  const formalTemplate = selectAutonomousFormalSupportTemplate(protocolFamily);
  return Object.freeze({
    draft: Object.freeze({
      empiricalHypothesis,
      formalSupportClaim: Object.freeze({
        statement: formalTemplate.scope.statement,
        assumptions: formalTemplate.scope.assumptions,
        quantifiers: formalTemplate.scope.quantifiers,
        negativeBoundaries: formalTemplate.scope.negativeBoundaries,
        proofObligations: formalTemplate.scope.proofObligations,
      }),
    }),
    dynamicFormalClaim: null,
  });
}

function cachePath(cacheRoot, requestHash) {
  const root = path.resolve(cacheRoot);
  const candidate = path.resolve(root, `${requestHash.slice('sha256:'.length)}.json`);
  if (!isPathWithin(root, candidate)) throw new Error('agent_research_content_cache_path_invalid');
  return { root, candidate };
}

function cachedResultValid(cached, request) {
  if (cached?.request?.requestHash !== request.requestHash) return false;
  if (JSON.stringify(cached.request) !== JSON.stringify(request)) return false;
  const verification = verifyAutonomousResearchContentProductionReceipt(
    cached.receipt,
    {
      request: cached.request,
      draft: cached.draft,
      agentExecutionReceipt: cached.agentExecutionReceipt,
      dynamicFormalClaimSeed: cached.dynamicFormalClaimSeed || null,
    },
  );
  return verification.valid;
}

function generationInstructions({
  protocolFamily,
  objective,
  dynamicFormalClaimsEnabled,
  researchAgendaIr = null,
} = {}) {
  const instructions = [
    'Return a falsifiable empirical hypothesis for the declared machine-authorized research objective.',
    `Protocol family: ${protocolFamily}.`,
    `Objective: ${objective}`,
    'Do not claim novelty, scientific truth, completed experiments, causal identification, universal validity, or formal proof.',
    'The empirical hypothesis must fit the declared protocol and be testable by treatment, control, ablation, fixed metrics, and deterministic replay.',
    'Return one compact JSON object with status, summary, checksRun, blockers, and empiricalHypothesis.',
    'empiricalHypothesis must have exactly statement, assumptions, quantifiers, negativeBoundaries, empiricalObligations; each list must be non-empty and contain plain strings.',
  ];
  if (researchAgendaIr) instructions.push(
    `The immutable ResearchAgendaIR hash is ${researchAgendaIr.researchAgendaIrHash}.`,
    `Copy the empiricalHypothesis.statement exactly from this JSON string without paraphrase: ${JSON.stringify(researchAgendaIr.primaryClaim)}.`,
    'The system will reject any normalized-text mismatch between the agenda, empirical claim, and formal claim.',
  );
  if (researchAgendaIr && dynamicFormalClaimsEnabled) instructions.push(
    `Copy the dynamicFormalClaim.statement exactly from this sole formal target JSON string without paraphrase: ${JSON.stringify(researchAgendaIr.formalTargets[0])}.`,
  );
  if (dynamicFormalClaimsEnabled) instructions.push(
    'Also return dynamicFormalClaim with exactly statement, assumptions, quantifiers, negativeBoundaries, proofObligations, leanDeclarationName, leanTypeSource, allowedImports.',
    'leanTypeSource must be a bounded Lean 4 theorem type only, not a declaration or proof; do not include :=, by, sorry, admit, axiom, unsafe commands, imports, or elaborator commands.',
    'The natural-language formal scope and Lean type must describe the same claim, and the proof obligations must cover the exact declared type.',
  );
  return instructions.join(' ');
}

function producerContractHash({ instructions, dynamicFormalClaimsEnabled,
  capabilityScopeManifestHash, executorSurfaceHash } = {}) {
  return hashRecord('AgentResearchContentProducerContract', {
    version: 1,
    producerImplementationHash: PRODUCER_IMPLEMENTATION_HASH,
    producerTransitiveContractHash: PRODUCER_TRANSITIVE_CONTRACT_HASH,
    executorSurfaceHash,
    instructionsHash: hashBytes(instructions),
    outputKeys: Object.freeze([
      'blockers', 'checksRun',
      ...(dynamicFormalClaimsEnabled ? ['dynamicFormalClaim'] : []),
      'empiricalHypothesis', 'status', 'summary',
    ].sort()),
    empiricalHypothesisKeys: EMPIRICAL_HYPOTHESIS_KEYS,
    dynamicFormalClaimsEnabled: dynamicFormalClaimsEnabled === true,
    capabilityScopeManifestHash,
  });
}

export function createAgentResearchContentProducer({
  agentExecutor,
  workspacePath,
  cacheRoot,
  producerId,
  allowedProtocolFamilies,
  productionAuthorityBinding = null,
  dynamicFormalClaimsEnabled = false,
  capabilityScopeManifestHash = null,
  clock = { now: () => new Date() },
  maximumOutputTokens = 4096,
  maximumWallTimeMs = 20 * 60 * 1000,
  assertExternalSideEffectReady = null,
} = {}) {
  const executor = assertAgentExecutorPort(agentExecutor);
  const executorSurfaceHash = hashRecord('AgentResearchContentProducerExecutorSurface', {
    version: executor.version,
    kind: executor.kind,
    executorId: executor.executorId,
    capabilities: executor.capabilities(),
    executeImplementationHash: hashBytes(Function.prototype.toString.call(executor.execute)),
  });
  const sourceWorkspace = fs.realpathSync(path.resolve(workspacePath || ''));
  const selectedProducerId = String(producerId || '').trim();
  const selectedCapabilityScopeManifestHash = dynamicFormalClaimsEnabled
    ? capabilityScopeManifestHash : null;
  if (!selectedProducerId || !cacheRoot || !Array.isArray(allowedProtocolFamilies)
    || !allowedProtocolFamilies.length || typeof clock?.now !== 'function'
    || (assertExternalSideEffectReady !== null
      && typeof assertExternalSideEffectReady !== 'function')
    || (dynamicFormalClaimsEnabled
      && !SHA256.test(String(selectedCapabilityScopeManifestHash || '')))) {
    throw new Error('agent_research_content_producer_dependencies_invalid');
  }
  if (productionAuthorityBinding !== null
    && (!verifyAutonomousResearchAgentProductionAuthorityBinding(
      productionAuthorityBinding,
    ) || productionAuthorityBinding.authorPrincipalId !== selectedProducerId)) {
    throw new Error('agent_research_content_production_authority_binding_invalid');
  }
  const preparedCache = prepareAgentProductionCacheRoot(cacheRoot);
  const cache = preparedCache.root;
  return assertResearchContentProducerPort(Object.freeze({
    version: 1,
    kind: 'AgentResearchContentProducer',
    producerId: selectedProducerId,
    async produce({
      paperId,
      objective,
      protocolFamily,
      researchAgendaIr = null,
      signal = null,
    } = {}) {
      if (researchAgendaIr !== null
        && (!verifyResearchAgendaIr(researchAgendaIr)
          || researchAgendaIr.paperId !== paperId
          || researchAgendaIr.protocolFamily !== protocolFamily
          || researchAgendaIr.formalTargets.length !== 1)) {
        throw new Error('agent_research_content_research_agenda_ir_invalid');
      }
      const preliminaryRequest = buildAutonomousResearchContentProductionRequest({
        paperId,
        objective,
        protocolFamily,
        allowedProtocolFamilies,
        productionAuthorityBinding,
        maximumOutputTokens,
        maximumWallTimeMs,
      });
      const instructions = generationInstructions({
        protocolFamily: preliminaryRequest.protocolFamily,
        objective: preliminaryRequest.objective,
        dynamicFormalClaimsEnabled,
        researchAgendaIr,
      });
      const currentProducerContractHash = producerContractHash({
        instructions,
        dynamicFormalClaimsEnabled,
        capabilityScopeManifestHash: selectedCapabilityScopeManifestHash,
        executorSurfaceHash,
      });
      const request = buildAutonomousResearchContentProductionRequest({
        ...preliminaryRequest,
        producerContractHash: currentProducerContractHash,
        dynamicFormalClaimsEnabled,
        capabilityScopeManifestHash: selectedCapabilityScopeManifestHash,
      });
      const target = cachePath(cache, request.requestHash);
      const cached = readAgentProductionCache({
        cacheRoot: cache,
        cacheRootIdentity: preparedCache.identity,
        candidate: target.candidate,
        maximumBytes: 8 * 1024 * 1024,
      });
      if (cachedResultValid(cached, request)) {
        return Object.freeze({
          draft: cached.draft,
          principalId: cached.receipt.principalId,
          provider: cached.receipt.provider,
          model: cached.receipt.model,
          researchContentProducerReceipt: cached.receipt,
          agentExecutionReceipt: cached.agentExecutionReceipt,
          dynamicFormalClaimSeed: cached.dynamicFormalClaimSeed || null,
          cacheHit: true,
          externalActionPerformed: false,
        });
      }
      if (assertExternalSideEffectReady) {
        await assertExternalSideEffectReady({
          action: 'research_content_producer_execute',
          paperId,
        });
        assertExternalSideEffectReady.assertCurrent?.({
          action: 'research_content_producer_execute',
          paperId,
        });
      }
      await assertExternalSideEffectReady?.markStarted?.({
        action: 'research_content_producer_execute',
      });
      const agentExecutionReceipt = await executor.execute({
        role: 'research-content-producer',
        workspacePath: sourceWorkspace,
        instructions,
        context: {
          paperId,
          protocolFamily,
          contentProductionRequestHash: request.requestHash,
          idempotencyKey: request.idempotencyKey,
          budgetReservationHash: request.budgetReservationHash,
          productionAuthorityBindingHash:
            productionAuthorityBinding
              ?.autonomousResearchAgentProductionAuthorityBindingHash || null,
          producerContractHash: request.producerContractHash,
          dynamicFormalClaimsEnabled: request.dynamicFormalClaimsEnabled,
          capabilityScopeManifestHash: request.capabilityScopeManifestHash,
          researchAgendaIrHash: researchAgendaIr?.researchAgendaIrHash || null,
        },
        sandbox: 'read-only',
        outputTokenBudget: request.maximumOutputTokens,
        timeoutMs: request.maximumWallTimeMs,
        signal,
      });
      const content = contentFromOutput(
        agentExecutionReceipt.structuredOutput,
        protocolFamily,
        dynamicFormalClaimsEnabled,
      );
      const draft = content.draft;
      const dynamicFormalClaimSeed = content.dynamicFormalClaim
        ? buildDynamicFormalClaimSeed({
          claimKey: `${paperId}:formal-support:1`,
          ...content.dynamicFormalClaim,
          generatorReceiptHash: agentExecutionReceipt.agentExecutionReceiptHash,
          capabilityScopeManifestHash: selectedCapabilityScopeManifestHash,
        })
        : null;
      const now = clock.now();
      const generatedAt = (now instanceof Date ? now : new Date(now)).toISOString();
      const receipt = buildAutonomousResearchContentProductionReceipt({
        request,
        draft,
        agentExecutionReceipt,
        dynamicFormalClaimSeed,
        producerId: selectedProducerId,
        generatedAt,
      });
      const stored = Object.freeze({
        request,
        draft,
        dynamicFormalClaimSeed,
        agentExecutionReceipt,
        receipt,
      });
      assertAgentProductionCacheRoot(cache, preparedCache.identity);
      writeDurableJsonSync(target.candidate, stored);
      return Object.freeze({
        draft,
        principalId: receipt.principalId,
        provider: receipt.provider,
        model: receipt.model,
        researchContentProducerReceipt: receipt,
        agentExecutionReceipt,
        dynamicFormalClaimSeed,
        cacheHit: false,
        externalActionPerformed: false,
      });
    },
  }));
}
