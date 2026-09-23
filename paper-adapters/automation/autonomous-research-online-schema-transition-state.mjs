import crypto from 'node:crypto';

import {
  autonomousResearchOnlineSchemaTransitionReceiptHash,
} from '../../paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function buildAutonomousResearchOnlineSchemaTransitionReserveRequest(plan, requestedAt) {
  return Object.freeze({
    version: plan.version,
    kind: 'AutonomousResearchOnlineSchemaTransitionReserveRequest',
    protocol: plan.protocol,
    ...(plan.version === 2 ? {
      transitionMode: plan.transitionMode,
      sourceWriterManifestHash: plan.sourceWriterManifestHash,
      prePristineRuntimeStateHash: plan.prePristineRuntimeStateHash,
    } : {}),
    scopeId: plan.scopeId,
    databaseScopeHash: plan.databaseScopeHash,
    writerManifestHash: plan.writerManifestHash,
    stateDatabaseManifestHash: plan.stateDatabaseManifestHash,
    transitionInventoryHash: plan.transitionInventoryHash,
    schemaBundleHash: plan.schemaBundleHash,
    authorityJournalSchemaContractId: plan.authorityJournalSchemaContractId,
    authorityJournalSchemaHash: plan.authorityJournalSchemaHash,
    markerSchemaHash: plan.markerSchemaHash,
    transitionId: plan.transitionId,
    instances: plan.instances,
    requestedAt,
    requestedLeaseMs: plan.requestedLeaseMs,
    requiredExecutionWindowMs: plan.requiredExecutionWindowMs,
  });
}

export function buildAutonomousResearchOnlineSchemaTransitionFinalizeRequest({
  plan,
  reservation,
  inventory,
  installations,
  postPristineRuntimeStateHash,
  completedAt,
}) {
  return Object.freeze({
    version: plan.version,
    kind: 'AutonomousResearchOnlineSchemaTransitionFinalizeRequest',
    protocol: plan.protocol,
    scopeId: plan.scopeId,
    databaseScopeHash: plan.databaseScopeHash,
    writerManifestHash: plan.writerManifestHash,
    transitionId: plan.transitionId,
    transitionInventoryHash: plan.transitionInventoryHash,
    schemaBundleHash: plan.schemaBundleHash,
    reservationId: reservation.reservationId,
    reservationReceiptHash: autonomousResearchOnlineSchemaTransitionReceiptHash(reservation),
    postInventoryHash: inventory.inventoryHash,
    postPristineRuntimeStateHash,
    installations,
    completedAt,
  });
}

export function buildAutonomousResearchOnlineSchemaTransitionObserveRequest({
  plan,
  finalization,
  postInventoryHash,
  postPristineRuntimeStateHash,
  requestedAt,
  nonce = `schema-transition:${crypto.randomUUID()}`,
}) {
  return Object.freeze({
    version: plan.version,
    kind: 'AutonomousResearchOnlineSchemaTransitionObserveRequest',
    protocol: plan.protocol,
    ...(plan.version === 2 ? {
      transitionMode: plan.transitionMode,
      sourceWriterManifestHash: plan.sourceWriterManifestHash,
    } : {}),
    scopeId: plan.scopeId,
    databaseScopeHash: plan.databaseScopeHash,
    writerManifestHash: plan.writerManifestHash,
    transitionId: plan.transitionId,
    transitionInventoryHash: plan.transitionInventoryHash,
    schemaBundleHash: plan.schemaBundleHash,
    finalizationReceiptHash:
      autonomousResearchOnlineSchemaTransitionReceiptHash(finalization),
    postInventoryHash,
    postPristineRuntimeStateHash,
    nonce,
    requestedAt,
  });
}

export function buildAutonomousResearchOnlineSchemaTransitionAuditReceipt({
  plan,
  reserveRequest,
  reservation,
  finalizeRequest,
  finalization,
  observeRequest,
  observation,
  inventory,
  installations,
}) {
  const base = Object.freeze({
    version: plan.version,
    kind: 'AutonomousResearchOnlineSchemaTransitionAuditReceipt',
    status: 'autonomous_research_online_schema_transition_ready',
    protocol: plan.protocol,
    transitionId: plan.transitionId,
    planHash: plan.planHash,
    databaseScopeHash: plan.databaseScopeHash,
    writerManifestHash: plan.writerManifestHash,
    ...(plan.version === 2 ? {
      transitionMode: plan.transitionMode,
      sourceWriterManifestHash: plan.sourceWriterManifestHash,
      authorityConfigurationActivated: true,
    } : {}),
    transitionInventoryHash: plan.transitionInventoryHash,
    schemaBundleHash: plan.schemaBundleHash,
    postInventoryHash: inventory.inventoryHash,
    postPristineRuntimeStateHash: observeRequest.postPristineRuntimeStateHash,
    reserveRequest,
    reservation,
    finalizeRequest,
    finalization,
    observeRequest,
    observation,
    installations,
    completedAt: finalization.finalizedAt,
    externalAuthorityVerified: true,
    crossDatabaseAtomicityClaimed: false,
    recoveryProtocol: 'external-authority-state-machine-idempotent-phases-v1',
  });
  return Object.freeze({
    ...base,
    schemaTransitionReceiptHash: hashRecord(
      'AutonomousResearchOnlineSchemaTransitionAuditReceipt', base,
    ),
  });
}

export function autonomousResearchOnlineSchemaTransitionPlanHashValid(plan) {
  const base = Object.fromEntries(Object.entries(plan || {}).filter(([key]) => (
    !['transitionId', 'planHash'].includes(key)
  )));
  return plan?.planHash === hashRecord('AutonomousResearchOnlineSchemaTransitionPlan', base);
}
