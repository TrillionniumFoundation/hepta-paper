// Test-only fixed-plan/source oracle. No authority is activated and no database
// is opened here. Rust tests create isolated stores and sign temporary receipts.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES as roles } from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import { AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS as schema } from '../../paper-adapters/automation/autonomous-research-online-authority-journal.mjs';
import { autonomousResearchOnlineWriterOperationManifestHash } from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import { RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_MUTATION_PLANS as plans,
  RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_OPERATION_ID as operationId,
  RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_WRITER_ID as writerId,
  RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_WRITER_PLAN_HASH as writerHash,
  RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_DATABASE_ROLE as role,
} from '../../paper-adapters/automation/runtime-image-reproducibility-publication-mutation-plan.mjs';
assert.equal(process.version, 'v22.23.1');
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
const protocol = 'external-linearizable-reserve-apply-finalize-v1';
if (request.operation === 'fixture') {
  const manifest = { version: 1, kind: 'AutonomousResearchOnlineWriterCoverageManifest', manifestId: 'image-online-native-fixture-v1', protocol,
    requiredDatabaseRoles: [...roles].sort(),
    writers: [{ writerId, databaseRoles: [role], operationIds: [operationId], implementationHash: writerHash, protocol }],
    operations: roles.map(current => ({ operationId: current === role ? operationId : `${current}.commit.v1`, databaseRole: current,
      sourceFile: `paper-adapters/automation/${current}-writer.mjs`, entrypoint: `${current}.commit`, mutationClass: 'business-dml',
      protocolStatus: current === role ? 'coordinator-integrated-reserve-apply-finalize-v1' : 'uncovered-no-coordinator-integration', coordinatorIntegrated: current === role })),
    coverage: { requiredRoleCount: 10, coveredRoleCount: 1, coveredDatabaseRoles: [role], percent: 10 },
  };
  process.stdout.write(JSON.stringify({ plans, writerHash, manifest, manifestHash: autonomousResearchOnlineWriterOperationManifestHash(manifest), schema }));
} else if (request.operation === 'mirrorHash') {
  process.stdout.write(JSON.stringify(hashRecord('RuntimeImageReproducibilityMirrorSideEffectReservation', request.value)));
} else if (request.operation === 'publicationHash') {
  process.stdout.write(JSON.stringify(hashRecord('RuntimeImageReproducibilityReceiptPublication', request.value)));
} else throw new Error('test_oracle_operation_invalid');
