// Stable public facade for the personal local-database boundary. Inspection
// and mutation implementations are separated so each adapter remains within
// the production complexity budget without changing the operator API.
export * from './personal-local-database-inspection.mjs';
export {
  recordPersonalDatabaseAntiRollback,
  createPersonalDatabaseBackup,
  restoreDrillPersonalDatabase,
  clearPersonalDatabaseEmptySidecars,
} from './personal-local-database-mutations.mjs';
