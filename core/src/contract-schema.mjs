import {
  CHANNEL_IDS,
  CORE_STAGES,
  HUMAN_FEEDBACK_MESSAGE_ACTION_IDS,
  HUMAN_FEEDBACK_CUSTOMER_FACING_ACTION_IDS,
  HUMAN_FEEDBACK_PACKAGE_ROLE_IDS,
  HUMAN_FEEDBACK_PRODUCT_LINE_IDS,
  CUSTOMER_MESSAGE_ACTION_IDS,
  DESIGN_PRODUCTION_CORE_VERSION,
  EXTERNAL_ACTIONS,
  OUTPUT_MODES,
  PRODUCT_LINE_IDS,
} from './contracts.mjs';
import {
  ADAPTER_RUNNER_SDK_PHASES,
  ADAPTER_RUNNER_SDK_STATUS,
  ADAPTER_RUNNER_SDK_VERSION,
} from './adapter-runner-sdk.mjs';
import {
  HUMAN_FEEDBACK_PREVIEW_CLASSES,
  HUMAN_FEEDBACK_REVIEW_TYPES,
  HUMAN_FEEDBACK_CONTRACT_VERSION,
} from './human-feedback-contracts.mjs';
import { digest } from './hash-utils.mjs';

export const CONTRACT_JSON_SCHEMA_VERSION = 1;

const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const SHA256_HASH_SCHEMA = { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' };
const HUMAN_FEEDBACK_SCHEMA_WORKFLOW_IDS = HUMAN_FEEDBACK_PRODUCT_LINE_IDS;
const HUMAN_FEEDBACK_SCHEMA_PACKAGE_ROLE_IDS = HUMAN_FEEDBACK_PACKAGE_ROLE_IDS;

function enumValues(record) {
  return Object.values(record || {}).filter(Boolean);
}

function stringOrNull() {
  return { type: ['string', 'null'] };
}

function objectOrNull() {
  return { type: ['object', 'null'], additionalProperties: true };
}

function refOrNull(ref) {
  return { anyOf: [{ $ref: ref }, { type: 'null' }] };
}

function humanFeedbackRecordCondition() {
  return {
    anyOf: [
      {
        required: ['productLineId'],
        properties: {
          productLineId: { enum: HUMAN_FEEDBACK_SCHEMA_WORKFLOW_IDS },
        },
      },
      {
        required: ['workflowId'],
        properties: {
          workflowId: { enum: HUMAN_FEEDBACK_SCHEMA_WORKFLOW_IDS },
        },
      },
    ],
  };
}

function humanFeedbackPackageRoleCondition() {
  return {
    required: ['packageRole'],
    properties: {
      packageRole: { enum: HUMAN_FEEDBACK_SCHEMA_PACKAGE_ROLE_IDS },
    },
  };
}

function humanFeedbackRoleAliasCondition() {
  return {
    anyOf: ['packageRole', 'reviewType', 'role'].map((field) => ({
      required: [field],
      properties: {
        [field]: { enum: HUMAN_FEEDBACK_SCHEMA_PACKAGE_ROLE_IDS },
      },
    })),
  };
}

function customerMessageHandoffActionCondition() {
  return {
    required: ['action'],
    properties: {
      action: { enum: CUSTOMER_MESSAGE_ACTION_IDS },
    },
  };
}

function humanFeedbackMessageHandoffActionCondition() {
  return {
    required: ['action'],
    properties: {
      action: { enum: HUMAN_FEEDBACK_MESSAGE_ACTION_IDS },
    },
  };
}

function humanFeedbackCustomerFacingHandoffActionCondition() {
  return {
    required: ['action'],
    properties: {
      action: { enum: HUMAN_FEEDBACK_CUSTOMER_FACING_ACTION_IDS },
    },
  };
}

function canonicalCustomerMessageHandoffActionProperties() {
  return {
    action: { const: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE },
  };
}

function evidenceRefSchema() {
  return {
    type: 'object',
    required: ['kind', 'ref'],
    properties: {
      kind: { type: 'string', minLength: 1 },
      ref: { type: 'string', minLength: 1 },
      hash: stringOrNull(),
      notes: stringOrNull(),
    },
    additionalProperties: true,
  };
}

function approvalProvenanceSchema() {
  return {
    $id: '#/$defs/ApprovalProvenance',
    type: 'object',
    required: [
      'source',
      'currentChatId',
      'sourceMessageId',
      'requesterId',
      'capturedAt',
      'intentNonce',
      'approvalNonce',
      'approvalTextHash',
      'explicitApproval',
    ],
    properties: {
      source: { type: 'string', minLength: 1 },
      currentChatId: { type: 'string', minLength: 1 },
      sourceMessageId: { type: 'string', minLength: 1 },
      requesterId: { type: 'string', minLength: 1 },
      capturedAt: { type: 'string', minLength: 1 },
      taskKey: stringOrNull(),
      channelId: stringOrNull(),
      externalId: stringOrNull(),
      action: { enum: enumValues(EXTERNAL_ACTIONS) },
      policy: stringOrNull(),
      preflightEvidenceHash: stringOrNull(),
      intentEvidenceHash: stringOrNull(),
      intentNonce: { type: 'string', minLength: 1 },
      approvalNonce: { type: 'string', minLength: 1 },
      approvalTextHash: SHA256_HASH_SCHEMA,
      explicitApproval: { const: true },
    },
    additionalProperties: true,
  };
}

function approvalPacketSchema() {
  return {
    $id: '#/$defs/ApprovalPacket',
    type: 'object',
    required: [
      'version',
      'kind',
      'action',
      'policy',
      'ok',
      'status',
      'approvalHash',
      'hash',
      'expiresAt',
      'approvalProvenance',
      'createdAt',
      'safety',
    ],
    properties: {
      version: { const: 1 },
      kind: { const: 'ApprovalPacket' },
      action: { enum: enumValues(EXTERNAL_ACTIONS) },
      policy: { type: 'string', minLength: 1 },
      ok: { type: 'boolean' },
      status: { type: 'string', minLength: 1 },
      approvedBy: stringOrNull(),
      requestedBy: stringOrNull(),
      taskKey: stringOrNull(),
      channelId: stringOrNull(),
      externalId: stringOrNull(),
      productLineId: stringOrNull(),
      workflowId: stringOrNull(),
      packageRole: stringOrNull(),
      reviewType: stringOrNull(),
      role: stringOrNull(),
      reason: stringOrNull(),
      budgetUsd: { type: ['number', 'null'] },
      estimatedCostUsd: { type: ['number', 'null'] },
      expiresAt: { type: 'string', minLength: 1 },
      approvalProvenance: refOrNull('#/$defs/ApprovalProvenance'),
      channelTask: objectOrNull(),
      plan: objectOrNull(),
      artifactPackage: objectOrNull(),
      reviewReport: objectOrNull(),
      messagePreview: stringOrNull(),
      evidenceRefs: { type: 'array', items: { $ref: '#/$defs/EvidenceRef' } },
      approvalHash: SHA256_HASH_SCHEMA,
      hash: SHA256_HASH_SCHEMA,
      createdAt: { type: 'string', minLength: 1 },
      safety: {
        type: 'object',
        required: ['packetOnly', 'executesExternalAction', 'sourceSnapshotRedacted'],
        properties: {
          packetOnly: { const: true },
          executesExternalAction: { const: false },
          sourceSnapshotRedacted: { const: true },
        },
        additionalProperties: true,
      },
    },
    allOf: [
      {
        if: {
          required: ['ok'],
          properties: { ok: { const: true } },
        },
        then: {
          required: ['approvedBy', 'approvalProvenance'],
          properties: {
            approvalProvenance: { $ref: '#/$defs/ApprovalProvenance' },
          },
        },
      },
    ],
    additionalProperties: true,
  };
}

function freshEvidenceBundleSchema() {
  return {
    $id: '#/$defs/FreshEvidenceBundle',
    type: 'object',
    required: [
      'version',
      'kind',
      'action',
      'approvalHash',
      'ok',
      'expiresAt',
      'approvalProvenance',
      'state',
      'evidenceHash',
      'hash',
      'createdAt',
      'safety',
    ],
    properties: {
      version: { const: 1 },
      kind: { const: 'FreshEvidenceBundle' },
      action: { enum: enumValues(EXTERNAL_ACTIONS) },
      approvalHash: SHA256_HASH_SCHEMA,
      ok: { type: 'boolean' },
      expiresAt: { type: 'string', minLength: 1 },
      taskKey: stringOrNull(),
      channelId: stringOrNull(),
      externalId: stringOrNull(),
      productLineId: stringOrNull(),
      workflowId: stringOrNull(),
      packageRole: stringOrNull(),
      reviewType: stringOrNull(),
      role: stringOrNull(),
      approvalProvenance: refOrNull('#/$defs/ApprovalProvenance'),
      state: { type: 'object', additionalProperties: true },
      evidenceRefs: { type: 'array', items: { $ref: '#/$defs/EvidenceRef' } },
      evidenceHash: SHA256_HASH_SCHEMA,
      hash: SHA256_HASH_SCHEMA,
      createdAt: { type: 'string', minLength: 1 },
      safety: {
        type: 'object',
        required: ['bundleOnly', 'executesExternalAction', 'sourceSnapshotRedacted'],
        properties: {
          bundleOnly: { const: true },
          executesExternalAction: { const: false },
          sourceSnapshotRedacted: { const: true },
        },
        additionalProperties: true,
      },
    },
    allOf: [
      {
        if: {
          required: ['ok'],
          properties: { ok: { const: true } },
        },
        then: {
          required: ['approvalProvenance'],
          properties: {
            approvalProvenance: { $ref: '#/$defs/ApprovalProvenance' },
          },
        },
      },
    ],
    additionalProperties: true,
  };
}

function humanFeedbackRevisionContractSchema() {
  return {
    $id: '#/$defs/HumanFeedbackRevisionContract',
    type: 'object',
    required: [
      'version',
      'kind',
      'contractHash',
      'taskKey',
      'channelId',
      'externalId',
      'productLineId',
      'workflowId',
      'sourceSnapshot',
      'targetArtifact',
      'baselineInvariantLock',
      'atomicQueue',
      'activeAtomicChange',
      'unchangedRegressionChecklist',
      'previewClass',
      'exitAction',
      'reviewGate',
      'generationPolicy',
      'evidenceRefs',
      'createdAt',
    ],
    properties: {
      version: { const: HUMAN_FEEDBACK_CONTRACT_VERSION },
      kind: { const: 'HumanFeedbackRevisionContract' },
      contractHash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
      taskKey: { type: 'string', minLength: 1 },
      channelId: { enum: enumValues(CHANNEL_IDS) },
      externalId: { type: 'string', minLength: 1 },
      productLineId: { const: PRODUCT_LINE_IDS.HUMAN_FEEDBACK },
      workflowId: { const: PRODUCT_LINE_IDS.HUMAN_FEEDBACK },
      sourceSnapshot: {
        type: 'object',
        required: ['hash', 'refs'],
        properties: {
          hash: SHA256_HASH_SCHEMA,
          refreshedAt: stringOrNull(),
          refs: {
            type: 'array',
            minItems: 1,
            items: {
              allOf: [
                { $ref: '#/$defs/EvidenceRef' },
                {
                  required: ['hash'],
                  properties: { hash: SHA256_HASH_SCHEMA },
                },
              ],
            },
          },
        },
        additionalProperties: true,
      },
      targetArtifact: {
        type: 'object',
        properties: {
          artifactId: stringOrNull(),
          workNo: stringOrNull(),
          worksId: stringOrNull(),
          filename: stringOrNull(),
          path: stringOrNull(),
          hash: { anyOf: [SHA256_HASH_SCHEMA, { type: 'null' }] },
          description: stringOrNull(),
        },
        anyOf: [
          { required: ['artifactId'] },
          { required: ['workNo'] },
          { required: ['worksId'] },
          { required: ['path', 'hash'], properties: { hash: SHA256_HASH_SCHEMA } },
          { required: ['filename', 'hash'], properties: { hash: SHA256_HASH_SCHEMA } },
        ],
        additionalProperties: true,
      },
      baselineInvariantLock: {
        type: 'object',
        required: ['locked'],
        properties: {
          locked: { const: true },
          lockedFacts: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          invariantHashes: { type: 'array', minItems: 1, items: SHA256_HASH_SCHEMA },
          notes: stringOrNull(),
        },
        anyOf: [
          { required: ['lockedFacts'] },
          { required: ['invariantHashes'] },
        ],
        additionalProperties: true,
      },
      atomicQueue: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['id', 'status', 'description'],
          properties: {
            id: { type: 'string', minLength: 1 },
            status: { enum: ['active', 'pending', 'done'] },
            description: { type: 'string', minLength: 1 },
            sourceRef: stringOrNull(),
            targetArtifactId: stringOrNull(),
          },
          allOf: [
            {
              if: {
                properties: { status: { const: 'active' } },
                required: ['status'],
              },
              then: {
                required: ['sourceRef'],
                properties: {
                  sourceRef: { type: 'string', minLength: 1 },
                },
              },
            },
          ],
          additionalProperties: true,
        },
      },
      activeAtomicChange: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', minLength: 1 },
          description: stringOrNull(),
        },
        additionalProperties: true,
      },
      unchangedRegressionChecklist: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
      },
      previewClass: { enum: Object.values(HUMAN_FEEDBACK_PREVIEW_CLASSES) },
      exitAction: { enum: enumValues(EXTERNAL_ACTIONS) },
      reviewGate: {
        anyOf: [
          {
            type: 'object',
            required: ['kind', 'humanFeedbackRevisionContract', 'artifactHashes'],
            properties: {
              kind: { const: 'ReviewReport' },
              ok: { type: 'boolean' },
              decision: { type: 'string' },
              reviewType: { enum: [...HUMAN_FEEDBACK_REVIEW_TYPES] },
              packageRole: { enum: [...HUMAN_FEEDBACK_REVIEW_TYPES] },
              humanFeedbackRevisionContractHash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
              contractHash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
              activeAtomicChangeId: stringOrNull(),
              targetArtifact: { type: 'object', additionalProperties: true },
              humanFeedbackRevisionContract: { $ref: '#/$defs/HumanFeedbackRevisionContract' },
              artifactHashes: {
                type: 'array',
                minItems: 1,
                items: {
                  allOf: [
                    { type: 'object', additionalProperties: true },
                    {
                      required: ['hash'],
                      properties: { hash: SHA256_HASH_SCHEMA },
                    },
                  ],
                },
              },
            },
            additionalProperties: true,
          },
          { type: 'null' },
        ],
      },
      generationPolicy: objectOrNull(),
      evidenceRefs: { type: 'array', items: { $ref: '#/$defs/EvidenceRef' } },
      createdAt: { type: 'string' },
    },
    additionalProperties: true,
  };
}

function safetyBoundary() {
  return {
    readOnly: true,
    executesExternalAction: false,
    providerSpend: false,
    browserAutomation: false,
    upload: false,
    submit: false,
    messaging: false,
    payment: false,
    acceptance: false,
    deployment: false,
    fetchesChannelState: false,
    appliesLocalStateTransition: false,
    grantsExecutionPermission: false,
  };
}

function channelTaskSchema() {
  return {
    $id: '#/$defs/ChannelTask',
    type: 'object',
    required: ['version', 'kind', 'channelId', 'externalId', 'taskKey', 'channelCapabilities', 'evidenceRefs', 'createdAt'],
    properties: {
      version: { const: DESIGN_PRODUCTION_CORE_VERSION },
      kind: { const: 'ChannelTask' },
      channelId: { enum: enumValues(CHANNEL_IDS) },
      externalId: { type: 'string', minLength: 1 },
      taskKey: { type: 'string', minLength: 1 },
      title: stringOrNull(),
      status: stringOrNull(),
      url: stringOrNull(),
      budget: {},
      deadline: stringOrNull(),
      rawCategory: stringOrNull(),
      accountProfile: stringOrNull(),
      sourceSnapshot: objectOrNull(),
      channelCapabilities: { type: 'object', additionalProperties: { enum: [true, false, 'partial'] } },
      evidenceRefs: { type: 'array', items: { $ref: '#/$defs/EvidenceRef' } },
      createdAt: { type: 'string' },
    },
    additionalProperties: true,
  };
}

function creativeBriefSchema() {
  return {
    $id: '#/$defs/CreativeBrief',
    type: 'object',
    required: ['version', 'kind', 'taskKey', 'channelId', 'externalId', 'productLineId', 'requirementText', 'subject', 'attachmentRefs', 'buyerConstraints', 'evidenceRefs', 'createdAt'],
    properties: {
      version: { const: DESIGN_PRODUCTION_CORE_VERSION },
      kind: { const: 'CreativeBrief' },
      taskKey: { type: 'string', minLength: 1 },
      channelId: { enum: enumValues(CHANNEL_IDS) },
      externalId: { type: 'string', minLength: 1 },
      productLineId: { enum: enumValues(PRODUCT_LINE_IDS) },
      title: stringOrNull(),
      requirementText: { type: 'string', minLength: 1 },
      subject: {
        type: 'object',
        required: ['projectText', 'brandText', 'productText', 'mustUseText', 'forbiddenText'],
        properties: {
          projectText: stringOrNull(),
          brandText: stringOrNull(),
          productText: stringOrNull(),
          mustUseText: { type: 'array', items: { type: 'string' } },
          forbiddenText: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: true,
      },
      industrySpec: objectOrNull(),
      attachmentRefs: { type: 'array', items: { $ref: '#/$defs/EvidenceRef' } },
      buyerConstraints: { type: 'array', items: { type: 'string' } },
      referencePolicy: objectOrNull(),
      semanticContract: objectOrNull(),
      evidenceRefs: { type: 'array', items: { $ref: '#/$defs/EvidenceRef' } },
      createdAt: { type: 'string' },
    },
    additionalProperties: true,
  };
}

function productionPlanEnvelopeSchema() {
  return {
    $id: '#/$defs/ProductionPlanEnvelope',
    type: 'object',
    required: ['version', 'kind', 'taskKey', 'channelId', 'externalId', 'productLineId', 'workflowId', 'outputMode', 'artifactCount', 'externalActionPolicy', 'evidenceRefs', 'createdAt'],
    properties: {
      version: { const: DESIGN_PRODUCTION_CORE_VERSION },
      kind: { const: 'ProductionPlanEnvelope' },
      taskKey: { type: 'string', minLength: 1 },
      channelId: { enum: enumValues(CHANNEL_IDS) },
      externalId: { type: 'string', minLength: 1 },
      productLineId: { enum: enumValues(PRODUCT_LINE_IDS) },
      workflowId: { type: 'string', minLength: 1 },
      outputMode: { enum: enumValues(OUTPUT_MODES) },
      artifactCount: { type: ['number', 'null'] },
      workflowProfile: objectOrNull(),
      humanFeedbackRevisionContract: refOrNull('#/$defs/HumanFeedbackRevisionContract'),
      designReferenceSpec: objectOrNull(),
      liveRules: objectOrNull(),
      providerPolicy: objectOrNull(),
      qualityGates: { type: 'array', items: { type: 'string' } },
      externalActionPolicy: {
        type: 'object',
        properties: {
          providerSpendRequiresApproval: { type: 'boolean' },
          modelSpendRequiresApproval: { type: 'boolean' },
          prepareRequiresApproval: { type: 'boolean' },
          submitRequiresApproval: { type: 'boolean' },
          messageRequiresApproval: { type: 'boolean' },
          acceptanceRequiresApproval: { type: 'boolean' },
        },
        additionalProperties: true,
      },
      evidenceRefs: { type: 'array', items: { $ref: '#/$defs/EvidenceRef' } },
      createdAt: { type: 'string' },
    },
    allOf: [
      {
        if: humanFeedbackRecordCondition(),
        then: {
          required: ['humanFeedbackRevisionContract'],
          properties: {
            humanFeedbackRevisionContract: { $ref: '#/$defs/HumanFeedbackRevisionContract' },
          },
        },
      },
    ],
    additionalProperties: true,
  };
}

function artifactSchema() {
  return {
    type: 'object',
    required: ['id', 'role', 'filename', 'path', 'mimeType', 'sizeBytes', 'hash', 'sourceRequestId'],
    properties: {
      id: { type: 'string', minLength: 1 },
      role: { type: 'string' },
      filename: { type: 'string' },
      path: stringOrNull(),
      mimeType: stringOrNull(),
      sizeBytes: { type: ['number', 'null'] },
      hash: stringOrNull(),
      sourceRequestId: stringOrNull(),
    },
    additionalProperties: true,
  };
}

function artifactPackageSchema() {
  return {
    $id: '#/$defs/ArtifactPackage',
    type: 'object',
    required: ['version', 'kind', 'taskKey', 'channelId', 'productLineId', 'workflowId', 'packageRole', 'outputMode', 'artifactCount', 'artifacts', 'submitReady', 'provenance', 'evidenceRefs', 'createdAt'],
    properties: {
      version: { const: DESIGN_PRODUCTION_CORE_VERSION },
      kind: { const: 'ArtifactPackage' },
      taskKey: { type: 'string', minLength: 1 },
      channelId: { enum: enumValues(CHANNEL_IDS) },
      externalId: stringOrNull(),
      productLineId: { enum: enumValues(PRODUCT_LINE_IDS) },
      workflowId: { type: 'string', minLength: 1 },
      packageRole: { type: 'string', minLength: 1 },
      outputMode: { enum: enumValues(OUTPUT_MODES) },
      humanFeedbackRevisionContract: refOrNull('#/$defs/HumanFeedbackRevisionContract'),
      artifactCount: { type: 'number' },
      artifacts: { type: 'array', items: { $ref: '#/$defs/Artifact' } },
      submitReady: { type: 'boolean' },
      provenance: objectOrNull(),
      evidenceRefs: { type: 'array', items: { $ref: '#/$defs/EvidenceRef' } },
      createdAt: { type: 'string' },
    },
    allOf: [
      {
        if: {
          anyOf: [
            humanFeedbackRecordCondition(),
            humanFeedbackPackageRoleCondition(),
          ],
        },
        then: {
          required: ['externalId', 'humanFeedbackRevisionContract', 'artifacts'],
          properties: {
            externalId: { type: 'string', minLength: 1 },
            packageRole: { enum: [...HUMAN_FEEDBACK_REVIEW_TYPES] },
            humanFeedbackRevisionContract: { $ref: '#/$defs/HumanFeedbackRevisionContract' },
            artifacts: {
              type: 'array',
              minItems: 1,
              items: {
                allOf: [
                  { $ref: '#/$defs/Artifact' },
                  {
                    required: ['hash'],
                    properties: { hash: SHA256_HASH_SCHEMA },
                  },
                ],
              },
            },
          },
        },
      },
    ],
    additionalProperties: true,
  };
}

function reviewReportSchema() {
  return {
    $id: '#/$defs/ReviewReport',
    type: 'object',
    required: ['version', 'kind', 'taskKey', 'channelId', 'productLineId', 'workflowId', 'packageRole', 'artifactHashes', 'decision', 'reviewer', 'ok', 'checks', 'blockers', 'evidenceRefs', 'createdAt'],
    properties: {
      version: { const: DESIGN_PRODUCTION_CORE_VERSION },
      kind: { const: 'ReviewReport' },
      taskKey: { type: 'string', minLength: 1 },
      channelId: { enum: enumValues(CHANNEL_IDS) },
      externalId: stringOrNull(),
      productLineId: { enum: enumValues(PRODUCT_LINE_IDS) },
      workflowId: { type: 'string', minLength: 1 },
      packageRole: { type: 'string', minLength: 1 },
      humanFeedbackRevisionContract: refOrNull('#/$defs/HumanFeedbackRevisionContract'),
      artifactHashes: { type: 'array', items: { type: 'object', additionalProperties: true } },
      decision: { type: 'string', minLength: 1 },
      reviewer: { type: 'string', minLength: 1 },
      ok: { type: 'boolean' },
      checks: { type: 'array', items: { type: 'object', additionalProperties: true } },
      blockers: { type: 'array', items: { type: 'string' } },
      evidenceRefs: { type: 'array', items: { $ref: '#/$defs/EvidenceRef' } },
      createdAt: { type: 'string' },
    },
    allOf: [
      {
        if: {
          anyOf: [
            humanFeedbackRecordCondition(),
            humanFeedbackPackageRoleCondition(),
          ],
        },
        then: {
          required: ['externalId', 'humanFeedbackRevisionContract', 'artifactHashes'],
          properties: {
            externalId: { type: 'string', minLength: 1 },
            packageRole: { enum: [...HUMAN_FEEDBACK_REVIEW_TYPES] },
            humanFeedbackRevisionContract: { $ref: '#/$defs/HumanFeedbackRevisionContract' },
            artifactHashes: {
              type: 'array',
              minItems: 1,
              items: {
                allOf: [
                  { type: 'object', additionalProperties: true },
                  {
                    required: ['hash'],
                    properties: { hash: SHA256_HASH_SCHEMA },
                  },
                ],
              },
            },
          },
        },
      },
    ],
    additionalProperties: true,
  };
}

function channelSubmissionSchema() {
  return {
    $id: '#/$defs/ChannelSubmission',
    type: 'object',
    required: ['version', 'kind', 'taskKey', 'channelId', 'externalId', 'action', 'status', 'requiresApproval', 'artifactPackage', 'review', 'evidenceRefs', 'createdAt'],
    properties: {
      version: { const: DESIGN_PRODUCTION_CORE_VERSION },
      kind: { const: 'ChannelSubmission' },
      taskKey: { type: 'string', minLength: 1 },
      channelId: { enum: enumValues(CHANNEL_IDS) },
      externalId: { type: 'string', minLength: 1 },
      action: { enum: enumValues(EXTERNAL_ACTIONS) },
      mode: stringOrNull(),
      status: { type: 'string', minLength: 1 },
      requiresApproval: { type: 'boolean' },
      approval: objectOrNull(),
      prepareEvidence: objectOrNull(),
      artifactPackage: { type: 'object', additionalProperties: true },
      review: objectOrNull(),
      externalResult: objectOrNull(),
      evidenceRefs: { type: 'array', items: { $ref: '#/$defs/EvidenceRef' } },
      createdAt: { type: 'string' },
    },
    additionalProperties: true,
  };
}

function adapterRunnerSdkPhaseSchema() {
  return {
    $id: '#/$defs/AdapterRunnerSdkPhase',
    type: 'object',
    required: [
      'phaseId',
      'runnerSideEffect',
      'coreCanRun',
      'coreGrantsPermission',
      'runnerMustLiveOutsideCore',
      'requiredInputs',
      'requiredRechecks',
      'requiredEvidenceKinds',
      'expectedOutputKind',
      'hashBinding',
    ],
    properties: {
      phaseId: { enum: ADAPTER_RUNNER_SDK_PHASES },
      channelId: stringOrNull(),
      actionId: stringOrNull(),
      taskKey: stringOrNull(),
      externalId: stringOrNull(),
      runnerSideEffect: { type: 'string', minLength: 1 },
      coreCanRun: { const: false },
      coreGrantsPermission: { const: false },
      runnerMustLiveOutsideCore: { const: true },
      requiredInputs: { type: 'array', items: { type: 'string', minLength: 1 } },
      requiredRechecks: { type: 'array', items: { type: 'string', minLength: 1 } },
      requiredEvidenceKinds: { type: 'array', items: { type: 'string', minLength: 1 } },
      actionEvidenceFields: { type: 'array', items: { type: 'string', minLength: 1 } },
      expectedOutputKind: { type: 'string', minLength: 1 },
      hashBinding: {
        type: 'object',
        required: [
          'dispatchEnvelopeHash',
          'assignmentHash',
          'outboxHash',
          'replayGuardHash',
          'manifestHash',
          'previewHash',
          'approvalHash',
          'evidenceHash',
          'approvalProvenanceHash',
        ],
        properties: {
          dispatchEnvelopeHash: stringOrNull(),
          assignmentHash: stringOrNull(),
          outboxHash: stringOrNull(),
          replayGuardHash: stringOrNull(),
          manifestHash: stringOrNull(),
          previewHash: stringOrNull(),
          approvalHash: stringOrNull(),
          evidenceHash: stringOrNull(),
          approvalProvenanceHash: stringOrNull(),
          ledgerHash: stringOrNull(),
        },
        additionalProperties: true,
      },
    },
    additionalProperties: true,
  };
}

function adapterRunnerHandoffSnapshotsObjectSchema() {
  return {
    type: 'object',
    required: ['manifest', 'preview'],
    properties: {
      manifest: {
        type: 'object',
        required: ['kind', 'manifestHash'],
        properties: {
          kind: { const: 'ChannelActionManifest' },
          manifestHash: SHA256_HASH_SCHEMA,
          hash: SHA256_HASH_SCHEMA,
        },
        additionalProperties: true,
      },
      preview: {
        type: 'object',
        required: ['kind', 'previewHash'],
        properties: {
          kind: { const: 'AdapterRunPreview' },
          previewHash: SHA256_HASH_SCHEMA,
          hash: SHA256_HASH_SCHEMA,
        },
        additionalProperties: true,
      },
    },
    additionalProperties: true,
  };
}

function adapterRunnerHandoffSnapshotsSchema() {
  return {
    anyOf: [
      adapterRunnerHandoffSnapshotsObjectSchema(),
      { type: 'null' },
    ],
  };
}

function readySdkContractSnapshotConditionSchema() {
  return {
    allOf: [
      {
        if: {
          required: ['status'],
          properties: { status: { const: ADAPTER_RUNNER_SDK_STATUS.READY } },
        },
        then: {
          properties: { handoffSnapshots: adapterRunnerHandoffSnapshotsObjectSchema() },
        },
      },
      {
        if: {
          required: ['readyForExternalImplementation'],
          properties: { readyForExternalImplementation: { const: true } },
        },
        then: {
          properties: { handoffSnapshots: adapterRunnerHandoffSnapshotsObjectSchema() },
        },
      },
      {
        if: {
          required: ['handoff'],
          properties: {
            handoff: customerMessageHandoffActionCondition(),
          },
        },
        then: {
          properties: {
            handoff: {
              required: ['messagePreview', 'messagePreviewHash'],
              properties: {
                ...canonicalCustomerMessageHandoffActionProperties(),
                messagePreview: { type: 'string', minLength: 1 },
                messagePreviewHash: SHA256_HASH_SCHEMA,
              },
            },
            hashBinding: {
              properties: {
                requiredHashes: {
                  required: ['messagePreviewHash'],
                  properties: {
                    messagePreviewHash: SHA256_HASH_SCHEMA,
                  },
                },
              },
            },
          },
        },
      },
      {
        if: {
          required: ['handoff'],
          properties: {
            handoff: {
              allOf: [
                humanFeedbackCustomerFacingHandoffActionCondition(),
                {
                  anyOf: [
                    humanFeedbackMessageHandoffActionCondition(),
                    {
                      required: ['productLineId'],
                      properties: { productLineId: { enum: HUMAN_FEEDBACK_SCHEMA_WORKFLOW_IDS } },
                    },
                    {
                      required: ['workflowId'],
                      properties: { workflowId: { enum: HUMAN_FEEDBACK_SCHEMA_WORKFLOW_IDS } },
                    },
                    humanFeedbackRoleAliasCondition(),
                    { required: ['humanFeedbackRevisionContractHash'] },
                  ],
                },
              ],
            },
          },
        },
        then: {
          properties: {
            handoff: {
              required: ['humanFeedbackRevisionContractHash'],
              properties: {
                humanFeedbackRevisionContractHash: SHA256_HASH_SCHEMA,
              },
            },
            hashBinding: {
              properties: {
                requiredHashes: {
                  required: ['humanFeedbackRevisionContractHash'],
                  properties: {
                    humanFeedbackRevisionContractHash: SHA256_HASH_SCHEMA,
                  },
                },
              },
            },
          },
        },
      },
    ],
  };
}

function adapterRunnerSdkContractSchema() {
  return {
    $id: '#/$defs/AdapterRunnerSdkContract',
    type: 'object',
    required: [
      'version',
      'kind',
      'sdkId',
      'actor',
      'status',
      'readyForExternalImplementation',
      'handoff',
      'runner',
      'hashBinding',
      'handoffSnapshots',
      'actionEvidenceContract',
      'phases',
      'acceptanceCriteria',
      'blockers',
      'warnings',
      'evidenceRefs',
      'safety',
      'createdAt',
    ],
    properties: {
      version: { const: ADAPTER_RUNNER_SDK_VERSION },
      kind: { const: 'AdapterRunnerSdkContract' },
      sdkId: { type: 'string', minLength: 1 },
      actor: { type: 'string', minLength: 1 },
      status: { enum: enumValues(ADAPTER_RUNNER_SDK_STATUS) },
      readyForExternalImplementation: { type: 'boolean' },
      handoff: {
        type: 'object',
        required: ['channelId', 'actionId', 'action', 'taskKey', 'externalId', 'productLineId', 'workflowId', 'approvalProvenanceHash', 'artifactNames', 'artifactCount'],
        properties: {
          channelId: stringOrNull(),
          actionId: stringOrNull(),
          action: stringOrNull(),
          taskKey: stringOrNull(),
          externalId: stringOrNull(),
          productLineId: stringOrNull(),
          workflowId: stringOrNull(),
          packageRole: stringOrNull(),
          approvalProvenanceHash: stringOrNull(),
          humanFeedbackRevisionContractHash: stringOrNull(),
          messagePreview: stringOrNull(),
          messagePreviewHash: stringOrNull(),
          artifactNames: { type: 'array', items: { type: 'string' } },
          artifactCount: { type: 'number' },
        },
        additionalProperties: true,
      },
      runner: {
        type: 'object',
        required: ['runnerId', 'capabilityHash', 'registryHash', 'selectionHash', 'runnerLocation', 'runnerLocationExternalWorkspace', 'runnerMayExecuteExternalAction'],
        properties: {
          runnerId: stringOrNull(),
          capabilityHash: stringOrNull(),
          registryHash: stringOrNull(),
          selectionHash: stringOrNull(),
          runnerLocation: stringOrNull(),
          runnerLocationExternalWorkspace: { type: 'boolean' },
          runnerMayExecuteExternalAction: { type: 'boolean' },
        },
        additionalProperties: true,
      },
      hashBinding: {
        type: 'object',
        required: ['readinessReportHash', 'dispatchEnvelopeHash', 'assignmentHash', 'requiredHashes'],
        properties: {
          readinessReportHash: stringOrNull(),
          dispatchEnvelopeHash: stringOrNull(),
          assignmentHash: stringOrNull(),
          requiredHashes: {
            type: 'object',
            required: ['outboxHash', 'replayGuardHash', 'manifestHash', 'previewHash', 'approvalHash', 'evidenceHash', 'approvalProvenanceHash'],
            properties: {
              outboxHash: stringOrNull(),
              replayGuardHash: stringOrNull(),
              manifestHash: stringOrNull(),
              previewHash: stringOrNull(),
              approvalHash: stringOrNull(),
              evidenceHash: stringOrNull(),
              approvalProvenanceHash: stringOrNull(),
              humanFeedbackRevisionContractHash: stringOrNull(),
              messagePreviewHash: stringOrNull(),
              ledgerHash: stringOrNull(),
            },
            additionalProperties: true,
          },
        },
        additionalProperties: true,
      },
      handoffSnapshots: adapterRunnerHandoffSnapshotsSchema(),
      actionEvidenceContract: {
        type: 'object',
        required: [
          'action',
          'receiptResultFields',
          'stateProofFields',
          'terminalEvidenceFields',
          'failureEvidenceFields',
          'receiptMustBindPlatformSnapshotHash',
          'receiptMustBindDryRunReplayHash',
          'stateProofMustBindReceiptHash',
        ],
        properties: {
          action: stringOrNull(),
          receiptResultFields: { type: 'array', items: { type: 'string', minLength: 1 } },
          stateProofFields: { type: 'array', items: { type: 'string', minLength: 1 } },
          terminalEvidenceFields: { type: 'array', items: { type: 'string', minLength: 1 } },
          failureEvidenceFields: { type: 'array', items: { type: 'string', minLength: 1 } },
          receiptMustBindPlatformSnapshotHash: { const: true },
          receiptMustBindDryRunReplayHash: { const: true },
          stateProofMustBindReceiptHash: { const: true },
        },
        additionalProperties: true,
      },
      phases: {
        type: 'array',
        minItems: ADAPTER_RUNNER_SDK_PHASES.length,
        items: { $ref: '#/$defs/AdapterRunnerSdkPhase' },
      },
      acceptanceCriteria: { type: 'array', items: { type: 'string', minLength: 1 } },
      blockers: { type: 'array', items: { type: 'object', additionalProperties: true } },
      warnings: { type: 'array', items: { type: 'object', additionalProperties: true } },
      evidenceRefs: { type: 'array', items: { $ref: '#/$defs/EvidenceRef' } },
      safety: {
        type: 'object',
        required: [
          'sdkContractOnly',
          'executesExternalAction',
          'fetchesChannelState',
          'appliesLocalStateTransition',
          'grantsExecutionPermission',
          'readyForExecution',
          'currentChatApprovalStillRequired',
        ],
        properties: {
          sdkContractOnly: { const: true },
          executesExternalAction: { const: false },
          runnerMayExecuteExternalAction: { type: 'boolean' },
          uploads: { const: false },
          submits: { const: false },
          sendsMessages: { const: false },
          acceptsDelivery: { const: false },
          pays: { const: false },
          deploys: { const: false },
          fetchesChannelState: { const: false },
          appliesLocalStateTransition: { const: false },
          grantsExecutionPermission: { const: false },
          readyForExecution: { const: false },
          externalRunnerMustRecheckApproval: { const: true },
          externalRunnerMustRecheckEvidence: { const: true },
          externalRunnerMustRecheckReplayGuard: { const: true },
          externalRunnerMustRecheckChannelState: { const: true },
          currentChatApprovalStillRequired: { const: true },
        },
        additionalProperties: true,
      },
      createdAt: { type: 'string' },
      sdkHash: stringOrNull(),
      hash: stringOrNull(),
    },
    ...readySdkContractSnapshotConditionSchema(),
    additionalProperties: true,
  };
}

export function buildContractJsonSchema({ createdAt = new Date().toISOString() } = {}) {
  const schemas = {
    EvidenceRef: evidenceRefSchema(),
    ApprovalProvenance: approvalProvenanceSchema(),
    ApprovalPacket: approvalPacketSchema(),
    FreshEvidenceBundle: freshEvidenceBundleSchema(),
    HumanFeedbackRevisionContract: humanFeedbackRevisionContractSchema(),
    ChannelTask: channelTaskSchema(),
    CreativeBrief: creativeBriefSchema(),
    ProductionPlanEnvelope: productionPlanEnvelopeSchema(),
    Artifact: artifactSchema(),
    ArtifactPackage: artifactPackageSchema(),
    ReviewReport: reviewReportSchema(),
    ChannelSubmission: channelSubmissionSchema(),
    AdapterRunnerSdkPhase: adapterRunnerSdkPhaseSchema(),
    AdapterRunnerSdkContract: adapterRunnerSdkContractSchema(),
  };
  const snapshot = {
    version: CONTRACT_JSON_SCHEMA_VERSION,
    kind: 'DesignProductionCoreContractJsonSchema',
    createdAt,
    schemaId: 'design-production-core-contracts-v1',
    jsonSchemaDraft: JSON_SCHEMA_DRAFT,
    coreVersion: DESIGN_PRODUCTION_CORE_VERSION,
    enums: {
      channelIds: enumValues(CHANNEL_IDS),
      productLineIds: enumValues(PRODUCT_LINE_IDS),
      outputModes: enumValues(OUTPUT_MODES),
      externalActions: enumValues(EXTERNAL_ACTIONS),
      coreStages: enumValues(CORE_STAGES),
    },
    schemas,
    bundle: {
      $schema: JSON_SCHEMA_DRAFT,
      $id: 'https://local.openclaw/design-production-core/contracts.schema.json',
      title: 'Design Production Core Contracts',
      type: 'object',
      oneOf: Object.keys(schemas).map((name) => ({ $ref: `#/$defs/${name}` })),
      $defs: schemas,
    },
    safety: safetyBoundary(),
  };
  const schemaHash = digest({
    version: snapshot.version,
    kind: snapshot.kind,
    schemaId: snapshot.schemaId,
    coreVersion: snapshot.coreVersion,
    enums: snapshot.enums,
    bundle: snapshot.bundle,
    safety: snapshot.safety,
  });
  return {
    ...snapshot,
    schemaHash,
    hash: schemaHash,
  };
}

export function summarizeContractJsonSchema(snapshot = buildContractJsonSchema()) {
  return {
    version: snapshot.version,
    kind: 'DesignProductionCoreContractJsonSchemaSummary',
    schemaId: snapshot.schemaId,
    schemaHash: snapshot.schemaHash || null,
    schemaCount: Object.keys(snapshot.schemas || {}).length,
    enumCounts: Object.fromEntries(Object.entries(snapshot.enums || {}).map(([key, values]) => [key, values.length])),
    jsonSchemaDraft: snapshot.jsonSchemaDraft,
    safety: snapshot.safety || safetyBoundary(),
  };
}

export function validateContractJsonSchemaSnapshot(snapshot = {}) {
  const blockers = [];
  const semanticHash = typeof snapshot.schemaHash === 'string' ? snapshot.schemaHash.trim() : '';
  const genericHash = typeof snapshot.hash === 'string' ? snapshot.hash.trim() : '';
  if (snapshot.version !== CONTRACT_JSON_SCHEMA_VERSION) blockers.push({ code: 'schema_version_mismatch' });
  if (snapshot.kind !== 'DesignProductionCoreContractJsonSchema') blockers.push({ code: 'schema_kind_mismatch' });
  if (snapshot.coreVersion !== DESIGN_PRODUCTION_CORE_VERSION) blockers.push({ code: 'core_version_mismatch' });
  if (snapshot.bundle?.$schema !== JSON_SCHEMA_DRAFT) blockers.push({ code: 'json_schema_draft_mismatch' });
  for (const schemaName of [
    'EvidenceRef',
    'ApprovalProvenance',
    'ApprovalPacket',
    'FreshEvidenceBundle',
    'HumanFeedbackRevisionContract',
    'ChannelTask',
    'CreativeBrief',
    'ProductionPlanEnvelope',
    'Artifact',
    'ArtifactPackage',
    'ReviewReport',
    'ChannelSubmission',
    'AdapterRunnerSdkPhase',
    'AdapterRunnerSdkContract',
  ]) {
    if (!snapshot.schemas?.[schemaName]) blockers.push({ code: `schema_missing_${schemaName}` });
    if (!snapshot.bundle?.$defs?.[schemaName]) blockers.push({ code: `bundle_def_missing_${schemaName}` });
  }
  const enumExpectations = {
    channelIds: enumValues(CHANNEL_IDS),
    productLineIds: enumValues(PRODUCT_LINE_IDS),
    outputModes: enumValues(OUTPUT_MODES),
    externalActions: enumValues(EXTERNAL_ACTIONS),
    coreStages: enumValues(CORE_STAGES),
  };
  for (const [key, expected] of Object.entries(enumExpectations)) {
    const actual = snapshot.enums?.[key] || [];
    const missing = expected.filter((item) => !actual.includes(item));
    if (missing.length) blockers.push({ code: `enum_missing_${key}`, notes: missing.join(', ') });
  }
  if (snapshot.safety?.executesExternalAction !== false) blockers.push({ code: 'schema_claims_external_action' });
  if (snapshot.safety?.fetchesChannelState !== false) blockers.push({ code: 'schema_claims_channel_fetch' });
  const recomputed = buildContractJsonSchema({ createdAt: snapshot.createdAt || '1970-01-01T00:00:00.000Z' });
  if (!semanticHash) blockers.push({ code: 'schema_hash_required' });
  if (!genericHash) blockers.push({ code: 'schema_generic_hash_required' });
  if (semanticHash && genericHash && semanticHash !== genericHash) {
    blockers.push({ code: 'schema_hash_alias_mismatch' });
  }
  if (semanticHash && semanticHash !== recomputed.schemaHash) {
    blockers.push({ code: 'schema_hash_mismatch' });
  }
  return {
    version: CONTRACT_JSON_SCHEMA_VERSION,
    kind: 'DesignProductionCoreContractJsonSchemaValidation',
    ok: blockers.length === 0,
    status: blockers.length ? 'blocked_contract_json_schema_validation' : 'pass_contract_json_schema_validation',
    schemaHash: snapshot.schemaHash || null,
    recomputedSchemaHash: recomputed.schemaHash,
    blockers,
    summary: summarizeContractJsonSchema(snapshot),
    safety: safetyBoundary(),
    validationHash: digest({
      version: CONTRACT_JSON_SCHEMA_VERSION,
      status: blockers.length ? 'blocked_contract_json_schema_validation' : 'pass_contract_json_schema_validation',
      schemaHash: snapshot.schemaHash || null,
      recomputedSchemaHash: recomputed.schemaHash,
      blockers,
    }),
  };
}
