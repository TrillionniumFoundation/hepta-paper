let clock = () => new Date();

export function installAutonomousResearchMachineIntakeRotationClockTestDouble(nextClock) {
  if (typeof nextClock !== 'function') throw new TypeError('clock function required');
  clock = nextClock;
}

export function readAutonomousResearchMachineIntakeAuthorityRotationClock() {
  return clock();
}
