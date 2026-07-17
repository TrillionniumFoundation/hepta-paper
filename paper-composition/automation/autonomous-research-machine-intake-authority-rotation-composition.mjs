import {
  applyAutonomousResearchMachineIntakeAuthorityRotation as applyRotation,
  planAutonomousResearchMachineIntakeAuthorityRotation as planRotation,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-authority-rotation.mjs';

export function planAutonomousResearchMachineIntakeAuthorityRotation(options) {
  return planRotation(options);
}

export function applyAutonomousResearchMachineIntakeAuthorityRotation(options) {
  return applyRotation(options);
}
