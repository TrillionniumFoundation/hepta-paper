export function assertResearchAgendaProducerPort(producer) {
  if (!producer?.producerId || typeof producer.produce !== 'function') {
    throw new Error('ResearchAgendaProducerPort.produce is required');
  }
  return producer;
}
