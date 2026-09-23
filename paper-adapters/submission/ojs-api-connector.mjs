import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { assertOjsClientPort } from '../../paper-ports/ojs-client-port.mjs';
import {
  assertSubmissionIdentityResolverPort,
} from '../../paper-ports/submission-identity-resolver-port.mjs';
import { assertSubmissionConnectorPort } from '../../paper-ports/submission-connector-port.mjs';
import {
  assertSubmissionCommitPermitAuthorityPort,
} from '../../paper-ports/submission-commit-permit-authority-port.mjs';
import {
  getSubmissionConnectorFamily,
} from '../../paper-domain/submission/submission-connector-family-registry.mjs';
import {
  materializeOjsContributors,
  verifyOjsSubmissionPlan,
} from '../../paper-domain/submission/ojs-submission-plan.mjs';
import { verifySubmissionPortalBinding } from '../../paper-domain/submission/submission-portal-binding.mjs';

function assertAssets(envelope, assets) {
  if (!Array.isArray(assets) || assets.length !== envelope.files.length) {
    throw new Error('ojs_submission_assets_invalid');
  }
  const byId = new Map(assets.map((asset) => [asset.fileId, asset]));
  if (byId.size !== assets.length) throw new Error('ojs_submission_assets_invalid');
  return Object.freeze(envelope.files.map((file) => {
    const asset = byId.get(file.fileId);
    if (!Buffer.isBuffer(asset?.bytes)
      || asset.bytes.length !== file.sizeBytes
      || hashBytes(asset.bytes) !== file.sha256) {
      throw new Error('ojs_submission_asset_hash_mismatch');
    }
    return Object.freeze({ ...file, bytes: asset.bytes });
  }));
}

function remoteIdentity(value) {
  const submissionId = Number(value?.id ?? value?.submissionId);
  const publicationId = Number(
    value?.currentPublicationId
      ?? value?.currentPublication?.id
      ?? value?.publications?.[0]?.id,
  );
  if (!Number.isSafeInteger(submissionId) || submissionId < 1
    || !Number.isSafeInteger(publicationId) || publicationId < 1) {
    throw new Error('ojs_remote_submission_identity_invalid');
  }
  return Object.freeze({ submissionId, publicationId });
}

function observationToken(observation) {
  return hashRecord('OjsRemoteSubmissionVersion', observation);
}

function submitted(observation) {
  return (observation?.submissionProgress === null
      || observation?.submissionProgress === '')
    && typeof observation?.dateSubmitted === 'string'
    && Number.isFinite(Date.parse(observation.dateSubmitted));
}

function receipt({
  plan,
  operation,
  providerResponses,
  observation = null,
  externalActionPerformed,
} = {}) {
  const identity = observation ? remoteIdentity(observation) : {
    submissionId: null,
    publicationId: null,
  };
  const payload = {
    version: 1,
    kind: 'OjsConnectorReceipt',
    status: operation === 'validate'
      ? 'ojs_plan_validated'
      : operation === 'draft'
        ? 'ojs_remote_draft_observed'
        : 'ojs_remote_submission_observed',
    operation,
    venueId: plan.venueId,
    targetInstanceId: plan.targetInstanceId,
    submissionEnvelopeHash: plan.submissionEnvelopeHash,
    portalBindingHash: plan.portalBindingHash,
    ojsSubmissionPlanHash: plan.ojsSubmissionPlanHash,
    remoteSubmissionId: identity.submissionId,
    remotePublicationId: identity.publicationId,
    remoteVersionToken: observation ? observationToken(observation) : null,
    remoteRawStatus: observation?.status ?? null,
    remoteSubmissionProgress: observation?.submissionProgress ?? null,
    providerResponseHashes: Object.freeze(providerResponses.map((response) => (
      hashRecord('OjsProviderResponse', response)
    ))),
    providerObservationHash: observation
      ? hashRecord('OjsProviderObservation', observation) : null,
    externalActionPerformed: externalActionPerformed === true,
    readAfterWriteVerified: observation !== null,
    independentExecutionAttestationVerified: false,
    productionEligible: false,
  };
  return Object.freeze({
    ...payload,
    ojsConnectorReceiptHash: hashRecord('OjsConnectorReceipt', payload),
  });
}

async function materialize({
  identityResolver,
  plan,
  envelope,
  portalBinding,
  assets = null,
} = {}) {
  const resolvedAuthors = await identityResolver.resolveAuthors({
    targetInstanceId: portalBinding.targetInstanceId,
    portalOrigin: portalBinding.portalOrigin,
    authors: envelope.authors,
  });
  return Object.freeze({
    contributors: materializeOjsContributors(plan, { resolvedAuthors }),
    assets: assets === null ? null : assertAssets(envelope, assets),
  });
}

export function createOjsApiConnector({
  client: suppliedClient,
  identityResolver: suppliedIdentityResolver,
  commitPermitAuthority,
  clock = { now: () => new Date() },
} = {}) {
  const client = assertOjsClientPort(suppliedClient);
  const identityResolver =
    assertSubmissionIdentityResolverPort(suppliedIdentityResolver);
  const permitAuthority =
    assertSubmissionCommitPermitAuthorityPort(commitPermitAuthority);
  if (typeof clock?.now !== 'function') {
    throw new Error('ojs_connector_authority_or_clock_invalid');
  }
  const family = getSubmissionConnectorFamily('ojs-rest-v1');
  const verify = ({ plan, envelope, baseTargetProfile, portalBinding }) => {
    if (!verifyOjsSubmissionPlan(plan, {
      envelope, baseTargetProfile, portalBinding,
    })) throw new Error('ojs_submission_plan_invalid');
  };
  const read = async ({ remoteSubmissionId, signal = null } = {}) => {
    if (!Number.isSafeInteger(remoteSubmissionId) || remoteSubmissionId < 1) {
      throw new Error('ojs_remote_submission_identity_invalid');
    }
    const observation = await client.getSubmission({
      submissionId: remoteSubmissionId,
      signal,
    });
    const identity = remoteIdentity(observation);
    if (identity.submissionId !== remoteSubmissionId) {
      throw new Error('ojs_remote_submission_observation_invalid');
    }
    return Object.freeze({
      status: 'ojs_remote_submission_observed',
      remoteSubmissionId: identity.submissionId,
      remotePublicationId: identity.publicationId,
      remoteVersionToken: observationToken(observation),
      remoteRawStatus: observation.status ?? null,
      remoteSubmissionProgress: observation.submissionProgress ?? null,
      submitted: submitted(observation),
      observationHash: hashRecord('OjsProviderObservation', observation),
      observation,
      externalActionPerformed: false,
    });
  };
  return assertSubmissionConnectorPort(Object.freeze({
    version: 1,
    kind: 'SubmissionConnectorPort',
    connectorId: 'hepta-ojs-api-v1',
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
    async probeReadiness({ portalBinding, baseTargetProfile, signal = null } = {}) {
      if (!verifySubmissionPortalBinding(portalBinding, {
        baseTargetProfile,
        observedAt: clock.now().toISOString(),
      })) throw new Error('ojs_portal_binding_invalid');
      const instance = await client.probe({ signal });
      const schema = await client.getSubmissionSchema({ signal });
      const schemaFingerprintHash = hashRecord('OjsSubmissionSchema', schema);
      if (schemaFingerprintHash !== portalBinding.schemaFingerprintHash) {
        throw new Error('ojs_submission_schema_drift');
      }
      return Object.freeze({
        status: 'ojs_readiness_observed_not_production_qualified',
        instanceObservationHash: hashRecord('OjsInstanceObservation', instance),
        schemaFingerprintHash,
        externalActionPerformed: false,
        productionEligible: false,
      });
    },
    async discoverProfile({ signal = null } = {}) {
      const schema = await client.getSubmissionSchema({ signal });
      return Object.freeze({
        status: 'ojs_submission_schema_discovered',
        schema,
        schemaFingerprintHash: hashRecord('OjsSubmissionSchema', schema),
        externalActionPerformed: false,
      });
    },
    async validate(input = {}) {
      verify(input);
      if (input.plan.operation !== 'validate') {
        throw new Error('ojs_validation_plan_required');
      }
      const prepared = await materialize({
        ...input, assets: input.assets, identityResolver,
      });
      const response = await client.validatePlan({
        plan: input.plan,
        contributors: prepared.contributors,
        assets: prepared.assets,
        signal: input.signal || null,
      });
      if (response?.valid !== true) {
        const error = new Error('ojs_plan_validation_rejected');
        error.autonomousSubmissionOutcome = 'explicit_failure';
        throw error;
      }
      return receipt({
        plan: input.plan,
        operation: 'validate',
        providerResponses: [response],
        externalActionPerformed: false,
      });
    },
    async createDraft(input = {}) {
      verify(input);
      if (input.plan.operation !== 'draft') {
        throw new Error('ojs_draft_plan_required');
      }
      const prepared = await materialize({
        ...input, assets: input.assets, identityResolver,
      });
      const created = await client.createSubmission({
        locale: input.plan.locale,
        sectionId: input.plan.sectionId,
        userGroupId: input.plan.userGroupId,
        signal: input.signal || null,
      });
      const identity = remoteIdentity(created);
      const publication = await client.updatePublication({
        submissionId: identity.submissionId,
        publicationId: identity.publicationId,
        metadata: input.plan.publicationMetadata,
        declarations: input.plan.declarationAnswers,
        dynamicAnswers: input.plan.dynamicAnswers,
        signal: input.signal || null,
      });
      const contributors = await client.replaceContributors({
        submissionId: identity.submissionId,
        publicationId: identity.publicationId,
        contributors: prepared.contributors,
        signal: input.signal || null,
      });
      const files = await client.uploadFiles({
        submissionId: identity.submissionId,
        files: prepared.assets,
        signal: input.signal || null,
      });
      const saved = await client.saveForLater({
        submissionId: identity.submissionId,
        signal: input.signal || null,
      });
      const observation = await client.getSubmission({
        submissionId: identity.submissionId,
        signal: input.signal || null,
      });
      const observedIdentity = remoteIdentity(observation);
      if (observedIdentity.submissionId !== identity.submissionId
        || observedIdentity.publicationId !== identity.publicationId
        || submitted(observation)) {
        throw new Error('ojs_draft_read_after_write_failed');
      }
      return receipt({
        plan: input.plan,
        operation: 'draft',
        providerResponses: [created, publication, contributors, files, saved],
        observation,
        externalActionPerformed: true,
      });
    },
    async uploadAssets(input = {}) {
      verify(input);
      const selected = assertAssets(input.envelope, input.assets);
      return Object.freeze({
        status: 'ojs_assets_staged',
        assetManifestHash: input.envelope.assetManifestHash,
        fileCount: selected.length,
        externalActionPerformed: false,
      });
    },
    async fillMetadata(input = {}) {
      verify(input);
      const prepared = await materialize({
        ...input, assets: null, identityResolver,
      });
      return Object.freeze({
        status: 'ojs_metadata_materialized',
        publicationMetadata: input.plan.publicationMetadata,
        contributors: prepared.contributors,
        metadataProjectionHash: hashRecord('OjsMetadataProjection', {
          publicationMetadata: input.plan.publicationMetadata,
          contributors: prepared.contributors,
          declarationAnswers: input.plan.declarationAnswers,
          dynamicAnswers: input.plan.dynamicAnswers,
        }),
        externalActionPerformed: false,
      });
    },
    async preview(input = {}) {
      verify(input);
      return Object.freeze({
        status: 'ojs_preview_ready',
        ojsSubmissionPlanHash: input.plan.ojsSubmissionPlanHash,
        submissionEnvelopeHash: input.envelope.submissionEnvelopeHash,
        externalActionPerformed: false,
      });
    },
    async commit(input = {}) {
      verify(input);
      if (input.plan.operation !== 'commit') {
        throw new Error('ojs_commit_plan_required');
      }
      permitAuthority.consume({
        permit: input.commitPermit,
        operation: 'commit',
        submissionEnvelopeHash: input.envelope.submissionEnvelopeHash,
        portalBindingHash: input.portalBinding.submissionPortalBindingHash,
        planHash: input.plan.ojsSubmissionPlanHash,
        commitAuthorizationHash: input.plan.commitAuthorizationHash,
      });
      const before = await client.getSubmission({
        submissionId: input.plan.remoteSubmissionId,
        signal: input.signal || null,
      });
      const identity = remoteIdentity(before);
      if (identity.publicationId !== input.plan.remotePublicationId
        || observationToken(before) !== input.plan.remoteVersionToken
        || submitted(before)) {
        const error = new Error('ojs_commit_concurrency_or_state_conflict');
        error.autonomousSubmissionOutcome = 'explicit_failure';
        throw error;
      }
      const response = await client.submitSubmission({
        submissionId: identity.submissionId,
        signal: input.signal || null,
      });
      const observation = await client.getSubmission({
        submissionId: identity.submissionId,
        signal: input.signal || null,
      });
      if (!submitted(observation)) {
        throw new Error('ojs_commit_read_after_write_failed');
      }
      return receipt({
        plan: input.plan,
        operation: 'commit',
        providerResponses: [response],
        observation,
        externalActionPerformed: true,
      });
    },
    getReceipt: read,
    getStatus: read,
    reconcile: read,
  }));
}
