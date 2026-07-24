import {
  createAutonomousResearchRuntimeRefresh,
} from '../../paper-application/automation/autonomous-research-runtime-refresh.mjs';
import {
  executeAutomationRuntimeReconciliation,
} from '../../paper-adapters/automation/automation-runtime-reconciler.mjs';
import {
  openExistingWritablePaperStore,
} from '../../paper-adapters/persistence/store-provider.mjs';
import {
  openAutonomousResearchExternallyFencedPaperStore,
} from '../bootstrap/campaign-execution-context-bootstrap.mjs';
import {
  composeAutomationReconcilerReceiptLedger,
} from '../bootstrap/receipt-ledger-composition.mjs';
import {
  composeRuntimeImageReproducibilityStatus,
  composeRuntimeImageReproducibilityVerification,
  createRuntimeImageReproducibilityReceiptRepository,
} from './runtime-image-reproducibility-composition.mjs';

export function resolveAutonomousResearchSupervisorRuntimeRefreshPolicy(
  environment,
  supplied = {},
) {
  const configured = (field, name) => supplied[field]
    ?? environment[`HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_${name}`];
  return Object.freeze({
    maximumAttemptsPerEpoch: configured(
      'maximumAttemptsPerEpoch', 'MAXIMUM_REFRESH_ATTEMPTS_PER_EPOCH',
    ),
    maximumCostUsdPerEpoch: configured(
      'maximumCostUsdPerEpoch', 'MAXIMUM_REFRESH_COST_USD_PER_EPOCH',
    ),
    budgetEpochMs: configured('budgetEpochMs', 'REFRESH_BUDGET_EPOCH_MS'),
    leaseMs: configured('leaseMs', 'REFRESH_LEASE_MS'),
    baseBackoffMs: configured('baseBackoffMs', 'REFRESH_BASE_BACKOFF_MS'),
    maximumBackoffMs: configured('maximumBackoffMs', 'REFRESH_MAXIMUM_BACKOFF_MS'),
    renewalLeadMs: configured('renewalLeadMs', 'REFRESH_RENEWAL_LEAD_MS'),
    actionSafetyMarginMs: configured(
      'actionSafetyMarginMs', 'REFRESH_ACTION_SAFETY_MARGIN_MS',
    ),
  });
}

export function composeAutonomousResearchSupervisorRuntime({
  root,
  runtimeRoot,
  environment,
  clock,
  scheduler,
  random,
  runtimeRefreshStateRepository,
  runtimeReproducibilityOverrides,
  mutationCoordinator,
  requireFullyAutonomous,
  receiptPointerRepository,
  reconcileRuntimeOverride,
} = {}) {
  const readRuntimeReproducibilityStatus = runtimeReproducibilityOverrides.readStatus
    || (({ now }) => composeRuntimeImageReproducibilityStatus({
      runtimeRoot,
      repositoryRoot: root,
      environment,
      now,
    }));
  const publishRuntimeReproducibility = runtimeReproducibilityOverrides.publish
    || (({ signal: refreshSignal }) => composeRuntimeImageReproducibilityVerification({
      action: 'publish',
      runtimeRoot,
      repositoryRoot: root,
      environment,
      clock,
      signal: refreshSignal,
      publicationMutationCoordinator: mutationCoordinator,
      publicationOfflineProvision: !requireFullyAutonomous,
      requireExternallyFencedPublication: requireFullyAutonomous,
    }));
  const recoverRuntimePublication = requireFullyAutonomous
    ? (() => createRuntimeImageReproducibilityReceiptRepository({
      runtimeRoot,
      receiptPath: environment.HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_RECEIPT || null,
      mutationCoordinator,
      offlineProvision: false,
      requireExternallyFencedMutations: true,
    }).recoverPendingPublication())
    : null;
  const runtimeRefresh = createAutonomousResearchRuntimeRefresh({
    stateRepository: runtimeRefreshStateRepository,
    readStatus: readRuntimeReproducibilityStatus,
    publish: publishRuntimeReproducibility,
    recoverPendingPublication: recoverRuntimePublication,
    clock,
    scheduler,
    random,
  });

  const reconcileAutomationRuntime = reconcileRuntimeOverride || (() => {
    const reconciliationStore = requireFullyAutonomous
      ? openAutonomousResearchExternallyFencedPaperStore({
        root,
        runtimeRoot,
        mutationCoordinator,
      })
      : openExistingWritablePaperStore({ root, runtimeRoot });
    try {
      return executeAutomationRuntimeReconciliation({
        store: reconciliationStore,
        clock,
        receiptLedger: composeAutomationReconcilerReceiptLedger({
          store: reconciliationStore,
          clock,
        }),
      });
    } finally { reconciliationStore.close(); }
  });
  const reconcileRuntimeMirror = runtimeReproducibilityOverrides.reconcileMirror
    || (() => createRuntimeImageReproducibilityReceiptRepository({
      runtimeRoot,
      receiptPath: environment.HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_RECEIPT || null,
      mutationCoordinator,
      offlineProvision: !requireFullyAutonomous,
      requireExternallyFencedMutations: requireFullyAutonomous,
    }).reconcileMirror());
  const reconcileRuntime = async ({ now } = {}) => {
    const fullResearchQualificationMirror = requireFullyAutonomous
      ? receiptPointerRepository.recoverPendingPublication()
      : receiptPointerRepository.reconcileMirror();
    const runtimeReproducibilityMirror = requireFullyAutonomous
      ? await recoverRuntimePublication()
      : await reconcileRuntimeMirror();
    return Object.freeze({
      fullResearchQualificationMirror,
      runtimeReproducibilityMirror,
      automationRuntime: await reconcileAutomationRuntime({ now }),
      runtimeReproducibility: runtimeRefreshStateRepository
        .reconcileStaleRefreshLease({ now: now || clock.now() }),
    });
  };

  return Object.freeze({ runtimeRefresh, reconcileRuntime });
}
