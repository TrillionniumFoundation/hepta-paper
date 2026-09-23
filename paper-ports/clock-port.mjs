export function assertClockPort(clock) {
  if (typeof clock?.now !== 'function') throw new Error('ClockPort.now is required');
  if (typeof clock?.nowIso !== 'function') throw new Error('ClockPort.nowIso is required');
  return clock;
}
