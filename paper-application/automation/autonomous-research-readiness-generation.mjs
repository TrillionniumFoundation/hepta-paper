import {
  buildDeterministicAutonomousHypothesisDraft,
  selectMachineGeneratedAutonomousResearchAgenda,
  selectDeterministicAutonomousResearchAgenda,
} from '../../paper-domain/automation/autonomous-research-proposal-contract.mjs';
import {
  verifyAutonomousResearchAgendaProductionReceipt,
} from '../../paper-domain/automation/autonomous-research-agenda-production-contract.mjs';
import {
  assertResearchAgendaProducerPort,
} from '../../paper-ports/research-agenda-producer-port.mjs';

export async function generateAutonomousResearchHypothesis({
  hypothesisGenerator,
  paperId,
  objective,
  protocolFamily,
  researchAgendaIr = null,
} = {}) {
  if (!hypothesisGenerator) {
    return Object.freeze({
      draft: buildDeterministicAutonomousHypothesisDraft({ objective, protocolFamily }),
      principalId: 'hepta-autonomous-hypothesis-generator:v1',
      provider: 'local-deterministic-policy',
      model: null,
      externalActionPerformed: false,
    });
  }
  const generate = typeof hypothesisGenerator.generate === 'function'
    ? hypothesisGenerator.generate.bind(hypothesisGenerator)
    : typeof hypothesisGenerator.produce === 'function'
      ? hypothesisGenerator.produce.bind(hypothesisGenerator)
      : null;
  if (!generate) throw new Error('autonomous_research_hypothesis_generator_invalid');
  const generated = await generate({
    paperId,
    objective,
    protocolFamily,
    researchAgendaIr,
  });
  if (!generated?.draft) {
    throw new Error('autonomous_research_hypothesis_generator_output_missing');
  }
  return Object.freeze({
    draft: generated.draft,
    principalId: generated.principalId,
    provider: generated.provider,
    model: generated.model || null,
    priorArtReceipt: generated.priorArtReceipt || null,
    principalIdentityAttestation: generated.principalIdentityAttestation || null,
    principalIdentityAuthorityEnvelope:
      generated.principalIdentityAuthorityEnvelope || null,
    researchContentProducerReceipt: generated.researchContentProducerReceipt || null,
    dynamicFormalClaimSeed: generated.dynamicFormalClaimSeed || null,
    manuscriptOutline: generated.manuscriptOutline || null,
    externalActionPerformed: Boolean(generated.externalActionPerformed),
  });
}

export async function generateAutonomousResearchAgenda({
  researchAgendaProducer,
  paperId,
  objective,
  protocolFamily,
  datasetAuthorityProtocolFamily,
  selectedAt,
} = {}) {
  if (!researchAgendaProducer) {
    return Object.freeze({
      agendaSelectionReceipt: selectDeterministicAutonomousResearchAgenda({
        paperId,
        objective,
        protocolFamily,
        datasetAuthorityProtocolFamily,
        selectedAt,
      }),
      researchAgendaProducerReceipt: null,
    });
  }
  const producer = assertResearchAgendaProducerPort(researchAgendaProducer);
  const generated = await producer.produce({
    paperId,
    objectiveHint: objective || null,
    protocolFamilyHint: protocolFamily || null,
    datasetAuthorityProtocolFamily,
  });
  const verification = verifyAutonomousResearchAgendaProductionReceipt(
    generated?.researchAgendaProducerReceipt,
    {
      request: generated?.request,
      agentExecutionReceipt: generated?.agentExecutionReceipt,
    },
  );
  if (!verification.valid
    || generated.selectedObjective
      !== generated.researchAgendaProducerReceipt?.selectedObjective
    || generated.selectedProtocolFamily
      !== generated.researchAgendaProducerReceipt?.selectedProtocolFamily) {
    throw new Error(`autonomous_research_agenda_producer_output_invalid:${verification.blockers.join(',')}`);
  }
  return Object.freeze({
    agendaSelectionReceipt: selectMachineGeneratedAutonomousResearchAgenda({
      paperId,
      researchAgendaProducerReceipt: generated.researchAgendaProducerReceipt,
      selectedAt,
    }),
    researchAgendaProducerReceipt: generated.researchAgendaProducerReceipt,
    researchAgendaIr: generated.researchAgendaIr || null,
  });
}
