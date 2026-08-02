import {
  executeLegacyTerminalActiveResidueSettlement,
  planLegacyTerminalActiveResidueSettlement,
} from '../../paper-adapters/automation/legacy-terminal-active-residue-settlement.mjs';

const LEGACY_TERMINAL_ACTIVE_RESIDUE_MAINTENANCE_SERVICE = Object.freeze({
  execute: executeLegacyTerminalActiveResidueSettlement,
  plan: planLegacyTerminalActiveResidueSettlement,
});

export function composeLegacyTerminalActiveResidueMaintenanceService() {
  return LEGACY_TERMINAL_ACTIVE_RESIDUE_MAINTENANCE_SERVICE;
}
