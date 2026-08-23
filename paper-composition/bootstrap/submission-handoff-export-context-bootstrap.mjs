import {
  createSqliteSubmissionHandoffExportAuthorityQuery,
} from '../../paper-adapters/submission/sqlite-submission-handoff-export-authority-query.mjs';
import {
  buildExecutionContext,
  openScopedPaperStore,
} from './context-foundation-composition.mjs';
import {
  bootstrapSubmissionHandoffContext,
} from './submission-handoff-context-bootstrap.mjs';

export function bootstrapSubmissionHandoffExportContext({
  root,
  runtimeRoot,
  mode = 'submission-handoff-export',
  serviceOverrides = {},
  environment = process.env,
} = {}) {
  if (serviceOverrides.submissionHandoffExportAuthorityQuery) {
    throw new Error(
      'submission_handoff_export_authority_query_override_forbidden',
    );
  }
  const scopedStore = openScopedPaperStore({
    root,
    runtimeRoot,
    readOnly: true,
    allowMissingReadOnlyStore: false,
    serviceOverrides: serviceOverrides.store
      ? { store: serviceOverrides.store } : {},
    rootKind: 'submission-handoff-export',
  });
  const { store } = scopedStore;
  try {
    const clock = serviceOverrides.clock?.now
      ? serviceOverrides.clock
      : Object.freeze({ now: () => new Date() });
    const base = bootstrapSubmissionHandoffContext({
      root,
      runtimeRoot,
      mode,
      environment,
      serviceOverrides: {
        ...serviceOverrides,
        store,
        clock,
      },
    });
    const submissionHandoffExportAuthorityQuery =
      createSqliteSubmissionHandoffExportAuthorityQuery({
        store,
        clock,
        requireCurrentProviderCapabilitySignatureRevalidation: true,
        providerCapabilitySignatureRevalidator:
          serviceOverrides.providerCapabilitySignatureRevalidator || null,
      });
    return buildExecutionContext({
      root,
      runtimeRoot,
      mode,
      execute: false,
      writeReport: false,
      options: {},
      serviceProfile: 'handoff-export',
      capabilities: [
        'submission-handoff-export-authority-read',
        'submission-release-read',
      ],
      services: Object.freeze({
        ...base.services,
        submissionHandoffExportAuthorityQuery,
      }),
    });
  } catch (error) {
    if (scopedStore.owned) store.close?.();
    throw error;
  }
}
