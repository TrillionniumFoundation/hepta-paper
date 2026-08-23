import {
  createAutonomousResearchRuntimeRefresh,
} from '../../paper-application/automation/autonomous-research-runtime-refresh.mjs';
import {
  executeAutomationRuntimeReconciliation,
} from '../../paper-adapters/automation/automation-runtime-reconciler.mjs';
import {
  openAutonomousResearchExternallyFencedPaperStore,
} from '../bootstrap/campaign-execution-context-bootstrap.mjs';
import {
  runWithScopedFoundationWriterAsync,
} from '../bootstrap/context-foundation-composition.mjs';
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

  const reconcileAutomationRuntime = (reconciliationStore, { now } = {}) => (
    reconcileRuntimeOverride
      ? reconcileRuntimeOverride({ now })
      : executeAutomationRuntimeReconciliation({
        store: reconciliationStore,
        clock,
        receiptLedger: composeAutomationReconcilerReceiptLedger({
          store: reconciliationStore,
          clock,
        }),
      })
  );
  const reconcileRuntimeMirror = runtimeReproducibilityOverrides.reconcileMirror
    || (() => createRuntimeImageReproducibilityReceiptRepository({
      runtimeRoot,
      receiptPath: environment.HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_RECEIPT || null,
      mutationCoordinator,
      offlineProvision: !requireFullyAutonomous,
      requireExternallyFencedMutations: requireFullyAutonomous,
    }).reconcileMirror());
  const reconcileOperation = async ({ now, reconciliationStore = null } = {}) => {
    const fullResearchQualificationMirror = requireFullyAutonomous
      ? receiptPointerRepository.recoverPendingPublication()
      : receiptPointerRepository.reconcileMirror();
    const runtimeReproducibilityMirror = requireFullyAutonomous
      ? await recoverRuntimePublication()
      : await reconcileRuntimeMirror();
    return Object.freeze({
      fullResearchQualificationMirror,
      runtimeReproducibilityMirror,
      automationRuntime: await reconcileAutomationRuntime(
        reconciliationStore,
        { now },
      ),
      runtimeReproducibility: runtimeRefreshStateRepository
        .reconcileStaleRefreshLease({ now: now || clock.now() }),
    });
  };
  const reconcileRuntime = async ({ now } = {}) => {
    if (reconcileRuntimeOverride) return reconcileOperation({ now });
    return runWithScopedFoundationWriterAsync({
      root,
      runtimeRoot,
      writerId: 'autonomous-research-supervisor-runtime-reconcile',
      rootKind: 'autonomous-research-supervisor-runtime-reconcile',
      serviceOverrides: { clock },
      ...(requireFullyAutonomous ? {
        writableStoreFactory: () =>
          openAutonomousResearchExternallyFencedPaperStore({
            root,
            runtimeRoot,
            mutationCoordinator,
          }),
      } : {}),
    }, async ({ store }) => reconcileOperation({
      now,
      reconciliationStore: store,
    }));
  };

  return Object.freeze({ runtimeRefresh, reconcileRuntime });
}
