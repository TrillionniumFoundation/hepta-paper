export function assertResearchContentProducerPort(producer) {
  if (!producer?.producerId || typeof producer.produce !== 'function') {
    throw new Error('ResearchContentProducerPort.produce is required');
  }
  return producer;
}
