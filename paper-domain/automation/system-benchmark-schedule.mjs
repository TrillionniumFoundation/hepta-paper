import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { armProtocolFor } from './system-benchmark-arm-protocol.mjs';

export const REQUIRED_SYSTEM_BENCHMARK_ARMS = Object.freeze(['treatment', 'baseline', 'ablation']);

export function buildCampaignBenchmarkSchedule(selector) {
  const cells = [];
  for (const seed of selector?.experimentDesign?.seedSchedule || []) {
    for (let repetition = 1; repetition <= Number(selector?.experimentDesign?.minimumRepetitions || 0); repetition += 1) {
      for (const arm of REQUIRED_SYSTEM_BENCHMARK_ARMS) {
        const identity = { seed: Number(seed), repetition, arm };
        const armProtocol = armProtocolFor(selector?.experimentDesign?.benchmarkHarness?.armProtocolSet, arm);
        cells.push(Object.freeze({
          ...identity,
          armProtocol,
          armProtocolSetHash: selector?.experimentDesign?.benchmarkHarness?.systemBenchmarkArmProtocolSetHash || null,
          systemBenchmarkArmProtocolHash: armProtocol?.systemBenchmarkArmProtocolHash || null,
          cellId: hashRecord('CampaignBenchmarkHarnessCell', {
            benchmarkHarnessHash: selector.experimentDesign.benchmarkHarnessHash,
            systemBenchmarkArmProtocolHash: armProtocol?.systemBenchmarkArmProtocolHash || null,
            ...identity,
          }),
        }));
      }
    }
  }
  return Object.freeze(cells);
}
