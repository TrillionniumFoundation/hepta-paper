import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  assertOpenReviewSubmissionClientPort,
} from '../../paper-ports/openreview-client-port.mjs';
import { assertSubmissionConnectorPort } from '../../paper-ports/submission-connector-port.mjs';
import {
  assertSubmissionCommitPermitAuthorityPort,
} from '../../paper-ports/submission-commit-permit-authority-port.mjs';
import {
  getSubmissionConnectorFamily,
} from '../../paper-domain/submission/submission-connector-family-registry.mjs';
import {
  openReviewNoteEditFromPlan,
  verifyOpenReviewSubmissionPlan,
} from '../../paper-domain/submission/openreview-submission-plan.mjs';
import { verifySubmissionEnvelope } from '../../paper-domain/submission/submission-envelope.mjs';
import { verifySubmissionPortalBinding } from '../../paper-domain/submission/submission-portal-binding.mjs';

function schemaFields(schema, invitation) {
  if (schema?.invitation !== invitation
    || !Array.isArray(schema?.contentFields)
    || schema.contentFields.length === 0
    || new Set(schema.contentFields).size !== schema.contentFields.length
    || schema.contentFields.some((field) => (
      typeof field !== 'string' || !field.trim()
    ))) {
    throw new Error('openreview_invitation_schema_invalid');
  }
  return Object.freeze([...schema.contentFields].sort());
}

function requestFrom(envelope) {
  return Object.freeze({
    kind: 'AutonomousSubmissionRequest',
    requestHash: envelope.requestHash,
    idempotencyKey: hashRecord('OpenReviewEnvelopeIdempotencyKey', {
      submissionEnvelopeHash: envelope.submissionEnvelopeHash,
      venueId: envelope.venueId,
    }),
    compiledPdfHash: envelope.compiledPdfHash,
    venueId: envelope.venueId,
  });
}

function requestFromPlan(plan) {
  return Object.freeze({
    kind: 'AutonomousSubmissionRequest',
    requestHash: plan?.requestHash,
    idempotencyKey: plan?.idempotencyKey,
    compiledPdfHash: plan?.compiledPdfHash,
    venueId: plan?.venueId,
  });
}

function verifyInput({
  plan,
  envelope,
  baseTargetProfile,
  portalBinding,
} = {}) {
  if (!verifySubmissionPortalBinding(portalBinding, {
    baseTargetProfile,
    observedAt: envelope?.createdAt,
  })
    || portalBinding.connectorFamily !== 'openreview-api-v2'
    || !verifySubmissionEnvelope(envelope, {
      portalBindingHash: portalBinding.submissionPortalBindingHash,
    })
    || plan?.requestHash !== envelope.requestHash
    || plan?.compiledPdfHash !== envelope.compiledPdfHash
    || plan?.venueId !== envelope.venueId
    || !plan?.invitation?.startsWith(`${portalBinding.targetInstanceId}/-/`)
    || !verifyOpenReviewSubmissionPlan(plan, {
      request: {
        ...requestFrom(envelope),
        idempotencyKey: plan?.idempotencyKey,
      },
    })) {
    throw new Error('openreview_submission_connector_input_invalid');
  }
}

function noteEdit({ plan, schema, pdfUrl }) {
  const allowedContentFields = schemaFields(schema, plan.invitation);
  const includeHeptaMetadata = [
    'hepta_submission_idempotency_key',
    'hepta_submission_plan_hash',
  ].every((field) => allowedContentFields.includes(field));
  return openReviewNoteEditFromPlan(plan, {
    pdfUrl,
    allowedContentFields,
    includeHeptaMetadata,
  });
}

function receipt({
  plan,
  note,
  operation,
  providerResponse = null,
  externalActionPerformed,
} = {}) {
  const noteId = String(note?.id || '').trim();
  const forumId = String(note?.forum || noteId).trim();
  if (!noteId || !forumId) {
    throw new Error('openreview_remote_note_identity_invalid');
  }
  const payload = {
    version: 1,
    kind: 'OpenReviewSubmissionConnectorReceipt',
    status: operation === 'lookup'
      ? 'openreview_remote_submission_reconciled'
      : 'openreview_remote_submission_observed',
    operation,
    venueId: plan.venueId,
    invitation: plan.invitation,
    requestHash: plan.requestHash,
    idempotencyKey: plan.idempotencyKey,
    openReviewSubmissionPlanHash: plan.openReviewSubmissionPlanHash,
    noteId,
    forumId,
    remoteModificationNumber:
      Number.isSafeInteger(note?.mnumber) ? note.mnumber : null,
    providerResponseHash: providerResponse
      ? hashRecord('OpenReviewProviderResponse', providerResponse) : null,
    providerObservationHash: hashRecord('OpenReviewProviderObservation', note),
    externalActionPerformed: externalActionPerformed === true,
    readAfterWriteVerified: true,
    independentExecutionAttestationVerified: false,
    productionEligible: false,
  };
  return Object.freeze({
    ...payload,
    openReviewSubmissionConnectorReceiptHash:
      hashRecord('OpenReviewSubmissionConnectorReceipt', payload),
  });
}

export function createOpenReviewSubmissionConnector({
  client: suppliedClient,
  commitPermitAuthority,
  clock = { now: () => new Date() },
} = {}) {
  const client = assertOpenReviewSubmissionClientPort(suppliedClient);
  const permitAuthority =
    assertSubmissionCommitPermitAuthorityPort(commitPermitAuthority);
  if (typeof clock?.now !== 'function') {
    throw new Error('openreview_connector_authority_or_clock_invalid');
  }
  const family = getSubmissionConnectorFamily('openreview-api-v2');
  const read = async ({
    plan,
    noteId = null,
    signal = null,
  } = {}) => {
    if (!verifyOpenReviewSubmissionPlan(plan, {
      request: requestFromPlan(plan),
    })) {
      throw new Error('openreview_submission_plan_invalid');
    }
    let note = noteId
      ? await client.getNote({ noteId, signal })
      : await client.findNoteByIdempotencyKey({
        invitation: plan?.invitation,
        idempotencyKey: plan?.idempotencyKey,
        signal,
      });
    if (!note) return null;
    return receipt({
      plan,
      note,
      operation: 'lookup',
      externalActionPerformed: false,
    });
  };
  return assertSubmissionConnectorPort(Object.freeze({
    version: 1,
    kind: 'SubmissionConnectorPort',
    connectorId: 'hepta-openreview-api-v2',
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
    async probeReadiness({
      plan,
      portalBinding,
      baseTargetProfile,
      signal = null,
    } = {}) {
      if (!verifySubmissionPortalBinding(portalBinding, {
        baseTargetProfile,
        observedAt: clock.now().toISOString(),
      })) throw new Error('openreview_portal_binding_invalid');
      const account = await client.probe({ signal });
      const schema = await client.getInvitationSchema({
        invitation: plan.invitation,
        signal,
      });
      schemaFields(schema, plan.invitation);
      const schemaFingerprintHash =
        hashRecord('OpenReviewInvitationSchema', schema);
      if (schemaFingerprintHash !== portalBinding.schemaFingerprintHash) {
        throw new Error('openreview_invitation_schema_drift');
      }
      return Object.freeze({
        status: 'openreview_readiness_observed_not_production_qualified',
        accountObservationHash:
          hashRecord('OpenReviewAccountObservation', account),
        schemaFingerprintHash,
        externalActionPerformed: false,
        productionEligible: false,
      });
    },
    async discoverProfile({ plan, signal = null } = {}) {
      const schema = await client.getInvitationSchema({
        invitation: plan.invitation,
        signal,
      });
      schemaFields(schema, plan.invitation);
      return Object.freeze({
        status: 'openreview_invitation_schema_discovered',
        schema,
        schemaFingerprintHash:
          hashRecord('OpenReviewInvitationSchema', schema),
        externalActionPerformed: false,
      });
    },
    async validate(input = {}) {
      verifyInput(input);
      const edit = noteEdit(input);
      const result = await client.validateContent({
        invitation: input.plan.invitation,
        noteEdit: edit,
        signal: input.signal || null,
      });
      if (result?.valid !== true) {
        const error = new Error('openreview_content_validation_rejected');
        error.autonomousSubmissionOutcome = 'explicit_failure';
        throw error;
      }
      return Object.freeze({
        status: 'openreview_content_validated',
        openReviewSubmissionPlanHash: input.plan.openReviewSubmissionPlanHash,
        validationResponseHash:
          hashRecord('OpenReviewValidationResponse', result),
        externalActionPerformed: false,
      });
    },
    async createDraft(input = {}) {
      verifyInput(input);
      const edit = noteEdit(input);
      return Object.freeze({
        status: 'openreview_local_draft_staged',
        openReviewSubmissionPlanHash: input.plan.openReviewSubmissionPlanHash,
        noteEditHash: hashRecord('OpenReviewNoteEdit', edit),
        remoteDraftCreated: false,
        externalActionPerformed: false,
      });
    },
    async uploadAssets(input = {}) {
      verifyInput(input);
      if (!Buffer.isBuffer(input.pdfBytes)
        || hashBytes(input.pdfBytes) !== input.plan.compiledPdfHash) {
        throw new Error('openreview_submission_asset_hash_mismatch');
      }
      const uploaded = await client.uploadPdf({
        bytes: input.pdfBytes,
        contentHash: input.plan.compiledPdfHash,
        signal: input.signal || null,
      });
      const url = String(uploaded?.url || '');
      if (!/^https:\/\/[^?#]+(?:[?#].*)?$/.test(url)) {
        throw new Error('openreview_pdf_upload_response_invalid');
      }
      return Object.freeze({
        status: 'openreview_pdf_uploaded',
        compiledPdfHash: input.plan.compiledPdfHash,
        pdfUrl: url,
        providerResponseHash:
          hashRecord('OpenReviewPdfUploadResponse', uploaded),
        externalActionPerformed: true,
      });
    },
    async fillMetadata(input = {}) {
      verifyInput(input);
      const edit = noteEdit(input);
      return Object.freeze({
        status: 'openreview_metadata_materialized',
        noteEdit: edit,
        noteEditHash: hashRecord('OpenReviewNoteEdit', edit),
        externalActionPerformed: false,
      });
    },
    async preview(input = {}) {
      verifyInput(input);
      const edit = noteEdit(input);
      return Object.freeze({
        status: 'openreview_preview_ready',
        noteEditHash: hashRecord('OpenReviewNoteEdit', edit),
        openReviewSubmissionPlanHash: input.plan.openReviewSubmissionPlanHash,
        externalActionPerformed: false,
      });
    },
    async commit(input = {}) {
      verifyInput(input);
      if (input.envelope.unknownDeclarationIds.length
        || input.envelope.unknownDynamicFieldIds.length) {
        throw new Error('openreview_commit_metadata_unresolved');
      }
      if (!/^sha256:[0-9a-f]{64}$/.test(
        String(input.commitAuthorizationHash || '').toLowerCase(),
      )) throw new Error('openreview_commit_authorization_invalid');
      permitAuthority.consume({
        permit: input.commitPermit,
        operation: 'commit',
        submissionEnvelopeHash: input.envelope.submissionEnvelopeHash,
        portalBindingHash: input.portalBinding.submissionPortalBindingHash,
        planHash: input.plan.openReviewSubmissionPlanHash,
        commitAuthorizationHash: input.commitAuthorizationHash,
      });
      const existing = await client.findNoteByIdempotencyKey({
        invitation: input.plan.invitation,
        idempotencyKey: input.plan.idempotencyKey,
        signal: input.signal || null,
      });
      if (existing) {
        return receipt({
          plan: input.plan,
          note: existing,
          operation: 'lookup',
          externalActionPerformed: false,
        });
      }
      const edit = noteEdit(input);
      const response = await client.postNoteEdit({
        noteEdit: edit,
        signal: input.signal || null,
      });
      const noteId = String(response?.id || '').trim();
      if (!noteId) throw new Error('openreview_post_response_identity_invalid');
      const observation = await client.getNote({
        noteId,
        signal: input.signal || null,
      });
      if (String(observation?.id || '') !== noteId) {
        throw new Error('openreview_commit_read_after_write_failed');
      }
      return receipt({
        plan: input.plan,
        note: observation,
        operation: 'commit',
        providerResponse: response,
        externalActionPerformed: true,
      });
    },
    getReceipt: read,
    getStatus: read,
    reconcile: read,
  }));
}
