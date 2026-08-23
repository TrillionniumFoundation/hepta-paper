// Persistence composition for operator entrypoints. Receipt-ledger services
// remain composed here rather than being re-exported with unrelated adapters.
export { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
export { createReadOnlySqliteStore } from '../../paper-adapters/persistence/sqlite-store.mjs';
export { heptaStorePath } from '../../paper-adapters/persistence/store-paths.mjs';
export {
  createDefaultPaperStore,
  createReadOnlyPaperStore,
  openExistingWritablePaperStore,
  preflightStoreMigrations,
} from '../../paper-adapters/persistence/store-provider.mjs';
export { copySqliteDatabase } from '../../paper-adapters/persistence/sqlite-consistent-copy.mjs';
export {
  createHeptaStoreBackupFileRepository,
} from '../../paper-adapters/persistence/hepta-store-backup-file-repository.mjs';
export { buildSqliteLogicalIntegrityReport } from '../../paper-adapters/persistence/sqlite-logical-integrity.mjs';
export {
  composeAutomationReconcilerReceiptLedger,
  composeLedgerAdministratorServices,
} from './receipt-ledger-composition.mjs';
