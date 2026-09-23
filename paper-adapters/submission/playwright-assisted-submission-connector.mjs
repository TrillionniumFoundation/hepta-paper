import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  assertSubmissionBrowserSessionPort,
} from '../../paper-ports/submission-browser-session-port.mjs';
import { assertSubmissionConnectorPort } from '../../paper-ports/submission-connector-port.mjs';
import {
  getSubmissionConnectorFamily,
} from '../../paper-domain/submission/submission-connector-family-registry.mjs';
import { verifySubmissionEnvelope } from '../../paper-domain/submission/submission-envelope.mjs';
import { verifySubmissionPortalBinding } from '../../paper-domain/submission/submission-portal-binding.mjs';

function verifyInput({
  envelope,
  baseTargetProfile,
  portalBinding,
} = {}, observedAt = null) {
  if (!verifySubmissionPortalBinding(portalBinding, {
    baseTargetProfile,
    observedAt: observedAt || envelope?.createdAt,
  })
    || portalBinding.connectorFamily !== 'playwright-assisted-draft-v1'
    || !verifySubmissionEnvelope(envelope, {
      portalBindingHash: portalBinding.submissionPortalBindingHash,
    })
    || envelope.venueId !== portalBinding.venueId
    || envelope.dynamicAnswers.some((answer) => (
      answer.schemaFingerprintHash !== portalBinding.schemaFingerprintHash
    ))) {
    throw new Error('playwright_submission_connector_input_invalid');
  }
}

function assets(envelope, supplied) {
  if (!Array.isArray(supplied) || supplied.length !== envelope.files.length) {
    throw new Error('playwright_submission_assets_invalid');
  }
  const byId = new Map(supplied.map((asset) => [asset.fileId, asset]));
  if (byId.size !== supplied.length) {
    throw new Error('playwright_submission_assets_invalid');
  }
  return Object.freeze(envelope.files.map((file) => {
    const asset = byId.get(file.fileId);
    if (!Buffer.isBuffer(asset?.bytes)
      || asset.bytes.length !== file.sizeBytes
      || hashBytes(asset.bytes) !== file.sha256) {
      throw new Error('playwright_submission_asset_hash_mismatch');
    }
    return Object.freeze({ ...file, bytes: asset.bytes });
  }));
}

async function humanHandoffIfRequired(browser, result, context) {
  if (result?.captchaRequired !== true
    && result?.mfaRequired !== true
    && result?.humanActionRequired !== true) return null;
  const handoff = await browser.handoffToHuman({
    ...context,
    reason: result.captchaRequired
      ? 'captcha'
      : result.mfaRequired ? 'mfa' : 'portal-human-action',
  });
  return Object.freeze({
    status: 'submission_browser_human_handoff_required',
    reason: result.captchaRequired
      ? 'captcha'
      : result.mfaRequired ? 'mfa' : 'portal-human-action',
    handoffReference: handoff?.handoffReference || null,
    externalActionPerformed: result.externalActionPerformed === true,
    finalCommitPerformed: false,
  });
}

export function createPlaywrightAssistedSubmissionConnector({
  browser: suppliedBrowser,
  clock = { now: () => new Date() },
} = {}) {
  const browser = assertSubmissionBrowserSessionPort(suppliedBrowser);
  if (typeof clock?.now !== 'function') {
    throw new Error('playwright_submission_connector_clock_invalid');
  }
  const family = getSubmissionConnectorFamily('playwright-assisted-draft-v1');
  const read = async ({
    remoteDraftId,
    portalBinding,
    signal = null,
  } = {}) => {
    if (!remoteDraftId || !portalBinding?.targetInstanceId) {
      throw new Error('playwright_remote_draft_identity_invalid');
    }
    const observation = await browser.getStatus({
      remoteDraftId,
      targetInstanceId: portalBinding.targetInstanceId,
      signal,
    });
    return Object.freeze({
      status: 'submission_browser_remote_draft_observed',
      remoteDraftId,
      remoteRawStatus: observation?.status || null,
      observationHash:
        hashRecord('SubmissionBrowserProviderObservation', observation),
      observation,
      externalActionPerformed: false,
      finalCommitPerformed: false,
    });
  };
  return assertSubmissionConnectorPort(Object.freeze({
    version: 1,
    kind: 'SubmissionConnectorPort',
    connectorId: 'hepta-playwright-assisted-draft-v1',
    connectorFamily: family.connectorFamily,
    submissionConnectorFamilyHash: family.submissionConnectorFamilyHash,
    networkPolicy: 'provider-scoped',
    credentialIsolation: true,
    finalCommitRequiresSingleUsePermit: true,
    finalCommitRequiresHumanReview: true,
    unknownDeclarationsBlockCommit: true,
    blindCommitRetryPermitted: false,
    captchaBypassPermitted: false,
    independentExecutionAttestationRequired: true,
    independentExecutionAttestationSupported: false,
    productionEligible: false,
    async probeReadiness(input = {}) {
      verifyInput(input, clock.now().toISOString());
      const result = await browser.probe({
        portalOrigin: input.portalBinding.portalOrigin,
        submissionRoute: input.portalBinding.submissionRoute,
        signal: input.signal || null,
      });
      const handoff = await humanHandoffIfRequired(browser, result, {
        operation: 'probe',
        targetInstanceId: input.portalBinding.targetInstanceId,
      });
      if (handoff) return handoff;
      if (result?.ready !== true || result?.externalActionPerformed === true) {
        throw new Error('playwright_submission_readiness_probe_invalid');
      }
      return Object.freeze({
        status: 'submission_browser_readiness_observed_not_production_qualified',
        readinessObservationHash:
          hashRecord('SubmissionBrowserReadinessObservation', result),
        externalActionPerformed: false,
        finalCommitPerformed: false,
        productionEligible: false,
      });
    },
    async discoverProfile(input = {}) {
      const schema = await browser.discoverForm({
        portalOrigin: input.portalBinding?.portalOrigin,
        submissionRoute: input.portalBinding?.submissionRoute,
        signal: input.signal || null,
      });
      return Object.freeze({
        status: 'submission_browser_form_schema_discovered',
        schema,
        schemaFingerprintHash:
          hashRecord('BrowserSubmissionFormSchema', schema),
        externalActionPerformed: false,
        finalCommitPerformed: false,
      });
    },
    async validate(input = {}) {
      verifyInput(input);
      const schema = await browser.discoverForm({
        portalOrigin: input.portalBinding.portalOrigin,
        submissionRoute: input.portalBinding.submissionRoute,
        signal: input.signal || null,
      });
      const schemaFingerprintHash =
        hashRecord('BrowserSubmissionFormSchema', schema);
      if (schemaFingerprintHash !== input.portalBinding.schemaFingerprintHash) {
        throw new Error('submission_browser_form_schema_drift');
      }
      return Object.freeze({
        status: 'submission_browser_schema_validated',
        schemaFingerprintHash,
        externalActionPerformed: false,
        finalCommitPerformed: false,
      });
    },
    async createDraft(input = {}) {
      verifyInput(input);
      const result = await browser.createDraft({
        targetInstanceId: input.portalBinding.targetInstanceId,
        portalOrigin: input.portalBinding.portalOrigin,
        submissionRoute: input.portalBinding.submissionRoute,
        envelopeHash: input.envelope.submissionEnvelopeHash,
        signal: input.signal || null,
      });
      const handoff = await humanHandoffIfRequired(browser, result, {
        operation: 'createDraft',
        targetInstanceId: input.portalBinding.targetInstanceId,
      });
      if (handoff) return handoff;
      const remoteDraftId = String(result?.remoteDraftId || '').trim();
      if (!remoteDraftId || result?.finalCommitPerformed === true) {
        throw new Error('submission_browser_draft_response_invalid');
      }
      return Object.freeze({
        status: 'submission_browser_remote_draft_created',
        remoteDraftId,
        providerResponseHash:
          hashRecord('SubmissionBrowserDraftResponse', result),
        externalActionPerformed: true,
        finalCommitPerformed: false,
        productionEligible: false,
      });
    },
    async uploadAssets(input = {}) {
      verifyInput(input);
      const selected = assets(input.envelope, input.assets);
      const result = await browser.uploadFiles({
        remoteDraftId: input.remoteDraftId,
        files: selected,
        signal: input.signal || null,
      });
      const handoff = await humanHandoffIfRequired(browser, result, {
        operation: 'uploadAssets',
        remoteDraftId: input.remoteDraftId,
      });
      if (handoff) return handoff;
      if (result?.finalCommitPerformed === true) {
        throw new Error('submission_browser_final_commit_forbidden');
      }
      return Object.freeze({
        status: 'submission_browser_assets_uploaded',
        remoteDraftId: input.remoteDraftId,
        assetManifestHash: input.envelope.assetManifestHash,
        providerResponseHash:
          hashRecord('SubmissionBrowserUploadResponse', result),
        externalActionPerformed: true,
        finalCommitPerformed: false,
      });
    },
    async fillMetadata(input = {}) {
      verifyInput(input);
      const result = await browser.fillFields({
        remoteDraftId: input.remoteDraftId,
        metadata: {
          title: input.envelope.title,
          abstract: input.envelope.abstract,
          articleType: input.envelope.articleType,
          keywords: input.envelope.keywords,
          authors: input.envelope.authors,
          declarations: input.envelope.declarations,
          reviewerPreferences: input.envelope.reviewerPreferences,
          dynamicAnswers: input.envelope.dynamicAnswers,
        },
        signal: input.signal || null,
      });
      const handoff = await humanHandoffIfRequired(browser, result, {
        operation: 'fillMetadata',
        remoteDraftId: input.remoteDraftId,
      });
      if (handoff) return handoff;
      if (result?.finalCommitPerformed === true) {
        throw new Error('submission_browser_final_commit_forbidden');
      }
      return Object.freeze({
        status: 'submission_browser_metadata_filled',
        remoteDraftId: input.remoteDraftId,
        metadataHash: input.envelope.metadataHash,
        providerResponseHash:
          hashRecord('SubmissionBrowserMetadataResponse', result),
        externalActionPerformed: true,
        finalCommitPerformed: false,
      });
    },
    async preview(input = {}) {
      verifyInput(input);
      const result = await browser.capturePreview({
        remoteDraftId: input.remoteDraftId,
        signal: input.signal || null,
      });
      if (result?.finalCommitPerformed === true
        || !result?.previewEvidenceHash) {
        throw new Error('submission_browser_preview_invalid');
      }
      return Object.freeze({
        status: 'submission_browser_review_page_ready',
        remoteDraftId: input.remoteDraftId,
        previewEvidenceHash: result.previewEvidenceHash,
        providerResponseHash:
          hashRecord('SubmissionBrowserPreviewResponse', result),
        externalActionPerformed: false,
        finalCommitPerformed: false,
      });
    },
    async commit() {
      throw new Error('submission_browser_final_commit_human_only');
    },
    getReceipt: read,
    getStatus: read,
    async reconcile(input = {}) {
      const result = await browser.reconcile({
        remoteDraftId: input.remoteDraftId,
        targetInstanceId: input.portalBinding?.targetInstanceId,
        signal: input.signal || null,
      });
      return Object.freeze({
        status: 'submission_browser_remote_draft_reconciled',
        remoteDraftId: input.remoteDraftId,
        remoteRawStatus: result?.status || null,
        observationHash:
          hashRecord('SubmissionBrowserProviderObservation', result),
        observation: result,
        externalActionPerformed: false,
        finalCommitPerformed: false,
      });
    },
  }));
}
