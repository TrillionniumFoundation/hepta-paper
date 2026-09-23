import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createReviewerPrincipalRecoveryPorts,
} from '../../paper-adapters/automation/reviewer-principal-recovery-ports.mjs';
import {
  buildResearchPrincipalDescriptor,
  buildResearchPrincipalPool,
} from '../../paper-domain/research/research-principal-pool-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord(
  'ReviewerPrincipalRecoveryPortsTest',
  { label },
);

function agentReceipt(label = 'review') {
  const payload = Object.freeze({
    version: 1,
    kind: 'AgentExecutionReceipt',
    status: 'agent_execution_completed',
    structuredOutput: Object.freeze({
      status: 'approved',
      label,
    }),
  });
  return Object.freeze({
    ...payload,
    agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload),
  });
}

function principal(ordinal) {
  return buildResearchPrincipalDescriptor({
    principalId: `reviewer-${ordinal}`,
    roles: ['formal-review', 'independent-review'],
    provider: `provider-${ordinal}`,
    modelIdentityHash: H(`model:${ordinal}`),
    providerAccountIdentityHash: H(`account:${ordinal}`),
    credentialRootIdentityHash: H(`credential:${ordinal}`),
    credentialConfigIdentityHash: H(`credential-config:${ordinal}`),
    trustDomainIdentityHash: H(`trust-domain:${ordinal}`),
    capabilityReceiptHash: H(`capability:${ordinal}`),
    signerIdentityHash: H(`signer:${ordinal}`),
  });
}

function signedReceipt({ subjectHash, principal: selected }) {
  return Object.freeze({
    version: 2,
    kind: 'SignedReviewerReceipt',
    subjectHash,
    principalId: selected.principalId,
    principalDescriptorHash: selected.principalDescriptorHash,
    researchPrincipalPoolHash: selected.researchPrincipalPoolHash,
    signerIdentityHash: selected.signerIdentityHash,
    signedReviewerReceiptHash: H(`signed:${subjectHash}`),
    signatureVerificationReceiptHash: H(`verified:${subjectHash}`),
  });
}

function fixture({
  executorResolution = Object.freeze({
    status: 'completed',
    receipt: agentReceipt(),
  }),
  signerResolution = null,
  verifySignedReceipt = null,
} = {}) {
  const principals = Object.freeze([principal(1), principal(2)]);
  const pool = buildResearchPrincipalPool({
    poolId: 'recovery-reviewer-pool',
    principals,
    minimumReviewerTrustDomains: 2,
  });
  const calls = {
    executor: [],
    signer: [],
  };
  const executors = new Map(principals.map((selected) => [
    selected.principalId,
    Object.freeze({
      crashRecoveryReady: true,
      recoveryConfigurationIdentityHash:
        H(`executor-recovery:${selected.principalId}`),
      recoveryOutcomeCryptographicAuthorityReady: true,
      recoveryOutcomeVerificationPolicyHash:
        H(`executor-policy:${selected.principalId}`),
      async lookup(input) {
        calls.executor.push(Object.freeze({ method: 'lookup', input }));
        return executorResolution;
      },
      async resume(input) {
        calls.executor.push(Object.freeze({ method: 'resume', input }));
        return executorResolution;
      },
      async execute(input) {
        calls.executor.push(Object.freeze({ method: 'execute', input }));
        return agentReceipt(`execute:${selected.principalId}`);
      },
    }),
  ]));
  const signers = new Map(principals.map((selected) => [
    selected.principalId,
    Object.freeze({
      crashRecoveryReady: true,
      recoveryConfigurationIdentityHash:
        H(`signer-recovery:${selected.principalId}`),
      recoveryOutcomeCryptographicAuthorityReady: true,
      recoveryOutcomeVerificationPolicyHash:
        H(`signer-policy:${selected.principalId}`),
      async lookup(input) {
        calls.signer.push(Object.freeze({ method: 'lookup', input }));
        return signerResolution || Object.freeze({
          status: 'completed',
          receipt: signedReceipt({
            subjectHash: input.subjectHash,
            principal: input.principal,
          }),
        });
      },
      async resume(input) {
        calls.signer.push(Object.freeze({ method: 'resume', input }));
        return signerResolution || Object.freeze({
          status: 'completed',
          receipt: signedReceipt({
            subjectHash: input.subjectHash,
            principal: input.principal,
          }),
        });
      },
      async sign(input) {
        calls.signer.push(Object.freeze({ method: 'sign', input }));
        return signedReceipt({
          subjectHash: input.subjectHash,
          principal: input.principal,
        });
      },
    }),
  ]));
  const trustInspection = Object.freeze({
    trustSetHash: H('trust-set'),
    signatureVerificationPolicyHash: H('signature-policy'),
    principalInspections: Object.freeze(principals.map((selected, index) => (
      Object.freeze({
        principalId: selected.principalId,
        identitySeparationReceipt: Object.freeze({ status: 'verified' }),
        identityReferenceSubjects: Object.freeze([
          Object.freeze({ subjectHash: H(`identity-reference:${index}`) }),
        ]),
      })
    ))),
  });
  const verifySignedReviewerReceipt = verifySignedReceipt || (
    ({ receipt, expected }) => Boolean(
      receipt
      && receipt.subjectHash === expected.subjectHash
      && receipt.principalId === expected.principalId
      && receipt.principalDescriptorHash
        === expected.principalDescriptorHash
      && receipt.researchPrincipalPoolHash
        === expected.researchPrincipalPoolHash
      && receipt.signerIdentityHash === expected.signerIdentityHash
    )
  );
  return {
    pool,
    executors,
    signers,
    trustInspection,
    verifySignedReviewerReceipt,
    calls,
  };
}

function createPorts(selected = fixture()) {
  const result = createReviewerPrincipalRecoveryPorts({
    pool: selected.pool,
    verifiedExecutors: selected.executors,
    verifiedSigners: selected.signers,
    trustInspection: selected.trustInspection,
    verifySignedReviewerReceipt: selected.verifySignedReviewerReceipt,
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockers, []);
  assert.match(
    result.reviewerRecoveryPort.configurationIdentityHash,
    /^sha256:[0-9a-f]{64}$/,
  );
  assert.match(
    result.signerRecoveryPort.recoveryOutcomeVerificationPolicyHash,
    /^sha256:[0-9a-f]{64}$/,
  );
  return { ...selected, ...result };
}

function reviewRequest() {
  return Object.freeze({
    role: 'formal-review',
    instructions: 'Review the exact formal evidence.',
    context: Object.freeze({
      nodeId: 'formal-review-node',
      attemptId: 'formal-review-attempt',
      campaignId: 'formal-review-campaign',
    }),
  });
}

test('reviewer recovery port executes, looks up, resumes, and rejects forged outcomes', async () => {
  const selected = createPorts();
  const request = reviewRequest();
  const signal = new AbortController().signal;
  const executionRequest = Object.freeze({
    ...request,
    instructions: 'Execute the exact formal review.',
  });
  const executed = await selected.reviewerRecoveryPort.execute({
    operationId: H('reviewer-operation'),
    idempotencyKey: H('reviewer-idempotency'),
    request,
    executionRequest,
    signal,
  });
  assert.equal(selected.reviewerRecoveryPort.verifyReceipt({
    request,
    receipt: executed,
  }), true);
  assert.equal(selected.calls.executor.at(-1).input.instructions,
    executionRequest.instructions);
  assert.equal(selected.calls.executor.at(-1).input.signal, signal);

  const lookedUp = await selected.reviewerRecoveryPort.lookup({
    operationId: H('reviewer-operation'),
    idempotencyKey: H('reviewer-idempotency'),
    request,
    signal,
  });
  assert.equal(lookedUp.status, 'completed');
  assert.equal(selected.reviewerRecoveryPort.verifyReceipt({
    request,
    receipt: lookedUp.receipt,
  }), true);

  const resumed = await selected.reviewerRecoveryPort.resume({
    operationId: H('reviewer-operation'),
    idempotencyKey: H('reviewer-idempotency'),
    request,
    executionRequest,
    signal,
  });
  assert.equal(resumed.status, 'completed');
  assert.equal(
    selected.calls.executor.at(-1).input.executionRequest,
    executionRequest,
  );
  assert.equal(selected.reviewerRecoveryPort.verifyReceipt({
    request,
    receipt: Object.freeze({
      ...resumed.receipt,
      reviewerTrustDomainIdentityHash: H('forged-trust-domain'),
    }),
  }), false);

  const badRaw = fixture({
    executorResolution: Object.freeze({
      status: 'completed',
      receipt: Object.freeze({
        ...agentReceipt('forged'),
        agentExecutionReceiptHash: H('forged-agent-receipt'),
      }),
    }),
  });
  await assert.rejects(() => createPorts(badRaw).reviewerRecoveryPort.lookup({
    operationId: H('bad-reviewer-operation'),
    idempotencyKey: H('bad-reviewer-idempotency'),
    request,
  }), /reviewer_recovery_agent_receipt_invalid/);
});

test('reviewer recovery preserves nonterminal states and rejects ambiguous resolutions', async () => {
  for (const status of ['in_progress', 'not_found']) {
    const selected = createPorts(fixture({
      executorResolution: Object.freeze({ status, receipt: null }),
    }));
    assert.deepEqual(
      await selected.reviewerRecoveryPort.lookup({
        operationId: H(`reviewer-operation:${status}`),
        idempotencyKey: H(`reviewer-idempotency:${status}`),
        request: reviewRequest(),
      }),
      { status, receipt: null },
    );
  }

  for (const resolution of [
    null,
    Object.freeze({ status: 'unknown', receipt: null }),
    Object.freeze({ status: 'in_progress', receipt: agentReceipt('ambiguous') }),
  ]) {
    const selected = createPorts(fixture({
      executorResolution: resolution,
    }));
    await assert.rejects(() => selected.reviewerRecoveryPort.resume({
      operationId: H('ambiguous-reviewer-operation'),
      idempotencyKey: H('ambiguous-reviewer-idempotency'),
      request: reviewRequest(),
    }), /reviewer_recovery_resolution_invalid/);
  }
});

test('signer recovery binds unsigned receipt and covers lookup, resume, and execute', async () => {
  const selected = createPorts();
  const review = reviewRequest();
  const unsignedReviewerReceipt =
    await selected.reviewerRecoveryPort.execute({
      operationId: H('unsigned-operation'),
      idempotencyKey: H('unsigned-idempotency'),
      request: review,
      executionRequest: review,
    });
  const request = Object.freeze({
    reviewRequest: review,
    unsignedReviewerReceipt,
  });
  const signal = new AbortController().signal;

  const executed = await selected.signerRecoveryPort.execute({
    operationId: H('signer-operation'),
    idempotencyKey: H('signer-idempotency'),
    request,
    signal,
  });
  assert.equal(selected.signerRecoveryPort.verifyReceipt({
    request,
    receipt: executed,
  }), true);
  assert.equal(selected.calls.signer.at(-1).input.signal, signal);
  assert.equal(
    selected.calls.signer.at(-1).input.principal.identitySeparationReceipt
      .status,
    'verified',
  );

  for (const method of ['lookup', 'resume']) {
    const resolution = await selected.signerRecoveryPort[method]({
      operationId: H(`signer-operation:${method}`),
      idempotencyKey: H(`signer-idempotency:${method}`),
      request,
      signal,
    });
    assert.equal(resolution.status, 'completed');
    assert.equal(selected.signerRecoveryPort.verifyReceipt({
      request,
      receipt: resolution.receipt,
    }), true);
  }
  assert.equal(selected.signerRecoveryPort.verifyReceipt({
    request,
    receipt: Object.freeze({
      ...executed,
      unsignedAgentExecutionReceiptHash: H('forged-unsigned-hash'),
    }),
  }), false);
  assert.equal(selected.signerRecoveryPort.verifyReceipt({
    request: Object.freeze({
      ...request,
      unsignedReviewerReceipt: agentReceipt('wrong-unsigned-shape'),
    }),
    receipt: executed,
  }), false);
});

test('signer recovery rejects invalid signatures and ambiguous nonterminal receipts', async () => {
  const invalidVerifier = createPorts(fixture({
    verifySignedReceipt: () => false,
  }));
  const review = reviewRequest();
  const unsignedReviewerReceipt =
    await invalidVerifier.reviewerRecoveryPort.execute({
      operationId: H('invalid-signature-unsigned-operation'),
      idempotencyKey: H('invalid-signature-unsigned-idempotency'),
      request: review,
      executionRequest: review,
    });
  const request = Object.freeze({
    reviewRequest: review,
    unsignedReviewerReceipt,
  });
  await assert.rejects(() => invalidVerifier.signerRecoveryPort.execute({
    operationId: H('invalid-signature-operation'),
    idempotencyKey: H('invalid-signature-idempotency'),
    request,
  }), /reviewer_recovery_signed_receipt_invalid/);

  const ambiguous = createPorts(fixture({
    signerResolution: Object.freeze({
      status: 'not_found',
      receipt: signedReceipt({
        subjectHash: H('ambiguous-subject'),
        principal: Object.freeze({
          principalId: 'reviewer-1',
          principalDescriptorHash: H('descriptor'),
          researchPrincipalPoolHash: H('pool'),
          signerIdentityHash: H('signer'),
        }),
      }),
    }),
  }));
  const ambiguousUnsigned =
    await ambiguous.reviewerRecoveryPort.execute({
      operationId: H('ambiguous-unsigned-operation'),
      idempotencyKey: H('ambiguous-unsigned-idempotency'),
      request: review,
      executionRequest: review,
    });
  await assert.rejects(() => ambiguous.signerRecoveryPort.lookup({
    operationId: H('ambiguous-signer-operation'),
    idempotencyKey: H('ambiguous-signer-idempotency'),
    request: Object.freeze({
      reviewRequest: review,
      unsignedReviewerReceipt: ambiguousUnsigned,
    }),
  }), /reviewer_recovery_resolution_invalid/);
});

test('recovery readiness fails closed for every missing executor and signer capability', () => {
  for (const [collection, field] of [
    ['executors', 'crashRecoveryReady'],
    ['executors', 'recoveryConfigurationIdentityHash'],
    ['executors', 'recoveryOutcomeCryptographicAuthorityReady'],
    ['executors', 'recoveryOutcomeVerificationPolicyHash'],
    ['executors', 'lookup'],
    ['executors', 'resume'],
    ['signers', 'crashRecoveryReady'],
    ['signers', 'recoveryConfigurationIdentityHash'],
    ['signers', 'recoveryOutcomeCryptographicAuthorityReady'],
    ['signers', 'recoveryOutcomeVerificationPolicyHash'],
    ['signers', 'lookup'],
    ['signers', 'resume'],
  ]) {
    const selected = fixture();
    const target = selected[collection];
    const [principalId, capability] = target.entries().next().value;
    const changed = { ...capability };
    delete changed[field];
    target.set(principalId, Object.freeze(changed));
    const result = createReviewerPrincipalRecoveryPorts({
      pool: selected.pool,
      verifiedExecutors: selected.executors,
      verifiedSigners: selected.signers,
      trustInspection: selected.trustInspection,
      verifySignedReviewerReceipt: selected.verifySignedReviewerReceipt,
    });
    assert.equal(result.ready, false, `${collection}.${field}`);
    assert.equal(result.reviewerRecoveryPort, null);
    assert.equal(result.signerRecoveryPort, null);
    assert.ok(result.blockers.includes(
      collection === 'executors'
        ? 'formal_domain_qualification_reviewer_lookup_resume_required'
        : 'formal_domain_qualification_signer_lookup_resume_required',
    ));
  }

  const blockedBeforeTrustComposition = fixture();
  const [principalId, executor] =
    blockedBeforeTrustComposition.executors.entries().next().value;
  const executorWithoutLookup = { ...executor };
  delete executorWithoutLookup.lookup;
  blockedBeforeTrustComposition.executors.set(
    principalId,
    Object.freeze(executorWithoutLookup),
  );
  assert.deepEqual(createReviewerPrincipalRecoveryPorts({
    pool: blockedBeforeTrustComposition.pool,
    verifiedExecutors: blockedBeforeTrustComposition.executors,
    verifiedSigners: blockedBeforeTrustComposition.signers,
    trustInspection: null,
    verifySignedReviewerReceipt: null,
  }), {
    ready: false,
    reviewerRecoveryPort: null,
    signerRecoveryPort: null,
    blockers: [
      'formal_domain_qualification_reviewer_lookup_resume_required',
    ],
  });

  const selected = fixture();
  const independentOnly = selected.pool.principals.map((candidate) => (
    buildResearchPrincipalDescriptor({
      ...candidate,
      roles: ['independent-review'],
    })
  ));
  const pool = buildResearchPrincipalPool({
    poolId: 'no-formal-reviewer-pool',
    principals: independentOnly,
    minimumReviewerTrustDomains: 2,
  });
  const result = createReviewerPrincipalRecoveryPorts({
    pool,
    verifiedExecutors: selected.executors,
    verifiedSigners: selected.signers,
    trustInspection: selected.trustInspection,
    verifySignedReviewerReceipt: selected.verifySignedReviewerReceipt,
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers, [
    'formal_domain_qualification_reviewer_lookup_resume_required',
    'formal_domain_qualification_signer_lookup_resume_required',
  ]);
});
