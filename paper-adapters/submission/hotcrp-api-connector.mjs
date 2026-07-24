import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { assertHotCrpClientPort } from '../../paper-ports/hotcrp-client-port.mjs';
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
  materializeHotCrpPaperObject,
  verifyHotCrpSubmissionPlan,
} from '../../paper-domain/submission/hotcrp-submission-plan.mjs';
import { verifySubmissionPortalBinding } from '../../paper-domain/submission/submission-portal-binding.mjs';

function assertAssets(envelope, assets) {
  if (!Array.isArray(assets) || assets.length !== envelope.files.length) {
    throw new Error('hotcrp_submission_assets_invalid');
  }
  const byId = new Map(assets.map((asset) => [asset.fileId, asset]));
  if (byId.size !== assets.length) throw new Error('hotcrp_submission_assets_invalid');
  for (const file of envelope.files) {
    const asset = byId.get(file.fileId);
    if (!Buffer.isBuffer(asset?.bytes)
      || asset.bytes.length !== file.sizeBytes
      || hashBytes(asset.bytes) !== file.sha256) {
      throw new Error('hotcrp_submission_asset_hash_mismatch');
    }
  }
  return Object.freeze(envelope.files.map((file) => Object.freeze({
    ...file,
    bytes: byId.get(file.fileId).bytes,
  })));
}

function responseValid(response, { dryRun = false } = {}) {
  const messages = Array.isArray(response?.message_list) ? response.message_list : [];
  if (response?.ok !== true || response?.valid !== true
    || (dryRun && response?.dry_run !== true)
    || response?.conflict === true
    || messages.some((message) => Number(message?.status) >= 2)) {
    const error = new Error('hotcrp_provider_response_rejected');
    error.autonomousSubmissionOutcome = 'explicit_failure';
    throw error;
  }
  return response;
}

function remotePaperId(response) {
  const value = Number(response?.pid ?? response?.paper?.pid);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('hotcrp_remote_paper_identity_invalid');
  }
  return value;
}

function connectorReceipt({
  plan,
  operation,
  response,
  observation = null,
  externalActionPerformed,
} = {}) {
  const paperId = operation === 'validate' ? null : remotePaperId(response);
  const payload = {
    version: 1,
    kind: 'HotCrpConnectorReceipt',
    status: operation === 'validate'
      ? 'hotcrp_dry_run_validated'
      : operation === 'draft'
        ? 'hotcrp_remote_draft_observed'
        : 'hotcrp_remote_submission_observed',
    operation,
    venueId: plan.venueId,
    targetInstanceId: plan.targetInstanceId,
    submissionEnvelopeHash: plan.submissionEnvelopeHash,
    portalBindingHash: plan.portalBindingHash,
    hotCrpSubmissionPlanHash: plan.hotCrpSubmissionPlanHash,
    idempotencyKey: plan.idempotencyKey,
    remotePaperId: paperId,
    remoteStatus: observation?.status || response?.paper?.status || null,
    providerResponseHash: hashRecord('HotCrpProviderResponse', response),
    providerObservationHash: observation
      ? hashRecord('HotCrpProviderObservation', observation) : null,
    externalActionPerformed: externalActionPerformed === true,
    readAfterWriteVerified: observation !== null,
    independentExecutionAttestationVerified: false,
    productionEligible: false,
  };
  return Object.freeze({
    ...payload,
    hotCrpConnectorReceiptHash: hashRecord('HotCrpConnectorReceipt', payload),
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
  const paper = materializeHotCrpPaperObject(plan, { resolvedAuthors });
  return Object.freeze({
    paper,
    assets: assets === null ? null : assertAssets(envelope, assets),
  });
}

export function createHotCrpApiConnector({
  client: suppliedClient,
  identityResolver: suppliedIdentityResolver,
  commitPermitAuthority,
  clock = { now: () => new Date() },
} = {}) {
  const client = assertHotCrpClientPort(suppliedClient);
  const identityResolver =
    assertSubmissionIdentityResolverPort(suppliedIdentityResolver);
  const permitAuthority =
    assertSubmissionCommitPermitAuthorityPort(commitPermitAuthority);
  if (typeof clock?.now !== 'function') {
    throw new Error('hotcrp_connector_clock_invalid');
  }
  const family = getSubmissionConnectorFamily('hotcrp-rest-v1');
  const verify = ({ plan, envelope, baseTargetProfile, portalBinding }) => {
    if (!verifyHotCrpSubmissionPlan(plan, {
      envelope, baseTargetProfile, portalBinding,
    })) throw new Error('hotcrp_submission_plan_invalid');
  };
  const read = async ({ remotePaperId: paperId, signal = null } = {}) => {
    if (!Number.isSafeInteger(paperId) || paperId < 1) {
      throw new Error('hotcrp_remote_paper_identity_invalid');
    }
    const paper = await client.getPaper({ paperId, signal });
    if (Number(paper?.pid) !== paperId || typeof paper?.status !== 'string') {
      throw new Error('hotcrp_remote_paper_observation_invalid');
    }
    return Object.freeze({
      status: 'hotcrp_remote_paper_observed',
      remotePaperId: paperId,
      remoteStatus: paper.status,
      observationHash: hashRecord('HotCrpProviderObservation', paper),
      paper,
      externalActionPerformed: false,
    });
  };
  return assertSubmissionConnectorPort(Object.freeze({
    version: 1,
    kind: 'SubmissionConnectorPort',
    connectorId: 'hepta-hotcrp-api-v1',
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
      })) throw new Error('hotcrp_portal_binding_invalid');
      const account = await client.probe({ signal });
      const schema = await client.getSubmissionSchema({ signal });
      const schemaFingerprintHash = hashRecord('HotCrpSubmissionSchema', schema);
      if (schemaFingerprintHash !== portalBinding.schemaFingerprintHash) {
        throw new Error('hotcrp_submission_schema_drift');
      }
      return Object.freeze({
        status: 'hotcrp_readiness_observed_not_production_qualified',
        accountObservationHash: hashRecord('HotCrpAccountObservation', account),
        schemaFingerprintHash,
        externalActionPerformed: false,
        productionEligible: false,
      });
    },
    async discoverProfile({ signal = null } = {}) {
      const schema = await client.getSubmissionSchema({ signal });
      return Object.freeze({
        status: 'hotcrp_submission_schema_discovered',
        schema,
        schemaFingerprintHash: hashRecord('HotCrpSubmissionSchema', schema),
        externalActionPerformed: false,
      });
    },
    async validate(input = {}) {
      verify(input);
      if (input.plan.operation !== 'validate') {
        throw new Error('hotcrp_validation_plan_required');
      }
      const prepared = await materialize({ ...input, identityResolver });
      const response = responseValid(await client.savePaper({
        paper: prepared.paper,
        assets: prepared.assets,
        dryRun: true,
        ifUnmodifiedSince: input.plan.ifUnmodifiedSince,
        signal: input.signal || null,
      }), { dryRun: true });
      return connectorReceipt({
        plan: input.plan,
        operation: 'validate',
        response,
        externalActionPerformed: false,
      });
    },
    async createDraft(input = {}) {
      verify(input);
      if (input.plan.operation !== 'draft') {
        throw new Error('hotcrp_draft_plan_required');
      }
      const prepared = await materialize({ ...input, identityResolver });
      const response = responseValid(await client.savePaper({
        paper: prepared.paper,
        assets: prepared.assets,
        dryRun: false,
        signal: input.signal || null,
      }));
      const paperId = remotePaperId(response);
      const observation = await client.getPaper({
        paperId,
        signal: input.signal || null,
      });
      if (Number(observation?.pid) !== paperId || observation?.status !== 'draft') {
        throw new Error('hotcrp_draft_read_after_write_failed');
      }
      return connectorReceipt({
        plan: input.plan,
        operation: 'draft',
        response,
        observation,
        externalActionPerformed: true,
      });
    },
    async uploadAssets(input = {}) {
      verify(input);
      const selected = assertAssets(input.envelope, input.assets);
      return Object.freeze({
        status: 'hotcrp_atomic_zip_assets_staged',
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
        status: 'hotcrp_metadata_materialized',
        paperObject: prepared.paper,
        paperObjectHash: hashRecord('HotCrpPaperObject', prepared.paper),
        externalActionPerformed: false,
      });
    },
    async preview(input = {}) {
      verify(input);
      return Object.freeze({
        status: 'hotcrp_preview_ready',
        hotCrpSubmissionPlanHash: input.plan.hotCrpSubmissionPlanHash,
        submissionEnvelopeHash: input.envelope.submissionEnvelopeHash,
        externalActionPerformed: false,
      });
    },
    async commit(input = {}) {
      verify(input);
      if (input.plan.operation !== 'commit') {
        throw new Error('hotcrp_commit_plan_required');
      }
      permitAuthority.consume({
        permit: input.commitPermit,
        operation: 'commit',
        submissionEnvelopeHash: input.envelope.submissionEnvelopeHash,
        portalBindingHash: input.portalBinding.submissionPortalBindingHash,
        planHash: input.plan.hotCrpSubmissionPlanHash,
        commitAuthorizationHash: input.plan.commitAuthorizationHash,
      });
      const prepared = await materialize({ ...input, identityResolver });
      const response = responseValid(await client.savePaper({
        paper: prepared.paper,
        assets: prepared.assets,
        dryRun: false,
        ifUnmodifiedSince: input.plan.ifUnmodifiedSince,
        signal: input.signal || null,
      }));
      const paperId = remotePaperId(response);
      const observation = await client.getPaper({
        paperId,
        signal: input.signal || null,
      });
      if (Number(observation?.pid) !== paperId
        || observation?.status !== 'submitted') {
        throw new Error('hotcrp_commit_read_after_write_failed');
      }
      return connectorReceipt({
        plan: input.plan,
        operation: 'commit',
        response,
        observation,
        externalActionPerformed: true,
      });
    },
    getReceipt: read,
    getStatus: read,
    reconcile: read,
  }));
}
