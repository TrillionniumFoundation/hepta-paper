import { assertClockPort } from '../../paper-ports/clock-port.mjs';

export function createSystemClock() {
  return assertClockPort(Object.freeze({
    version: 1,
    kind: 'SystemClockAdapter',
    now: () => new Date(),
    nowIso: () => new Date().toISOString(),
  }));
}
