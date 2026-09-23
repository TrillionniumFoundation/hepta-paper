// Isolated test-only Ed25519 signing; the actual incumbent schema fixture,
// executor, audit builder and historical verifier supply the expected records.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fixture, createAuthority, controlledClock, transitionInput, stateDatabaseManifest }
  from '../../paper-core/tests/support/autonomous-research-online-schema-transition-fixture.mjs';
import { planAutonomousResearchOnlineSchemaTransition, executeAutonomousResearchOnlineSchemaTransition }
  from '../../paper-adapters/automation/autonomous-research-online-schema-transition.mjs';
import { resolveAutonomousResearchStateDatabaseInventory }
  from '../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';
import { validateAutonomousResearchOnlineSchemaTransitionAuditReceipt }
  from '../../paper-adapters/automation/autonomous-research-online-schema-transition-completion.mjs';
import { createAutonomousResearchOnlineMutationReceiptVerifier }
  from '../../paper-adapters/automation/autonomous-research-online-mutation-authority.mjs';
import * as contract from '../../paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs';
import { autonomousResearchOnlineMutationSignedPayload }
  from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { productionOracleProfile } from './production-record-hash-v1.mjs';

let runtime;
function create(root) {
  if (!root.startsWith('/tmp/hepta-native-schema-checkpoint-')) throw new Error('isolated_fixture_required');
  const generated = fixture({after(){}});
  const runtimeRoot = path.join(root, 'runtime');
  fs.renameSync(generated.runtimeRoot, runtimeRoot); fs.rmdirSync(generated.parent);
  const raw = createAuthority(runtimeRoot), clock = controlledClock();
  const pair = crypto.generateKeyPairSync('ed25519');
  const sign = value => {
    const body = {...value}; delete body.signature;
    return {...body, signature:crypto.sign(null, Buffer.from(autonomousResearchOnlineMutationSignedPayload(body)), pair.privateKey).toString('base64')};
  };
  const write = (name, value) => {
    const target = path.join(root,name);
    fs.writeFileSync(target, JSON.stringify(value), {mode:0o600}); return target;
  };
  const publicKeyPath = write('public.json', {version:1,kind:'AutonomousResearchOnlineMutationAuthorityPublicKey',authorityId:raw.client.trust.authorityId,keyId:raw.client.trust.keyId,algorithm:'ed25519',publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'})});
  const configurationPath = write('authority.json', {...raw.client.trust,kind:'AutonomousResearchOnlineMutationAuthorityConfiguration',publicKeyPath,publicKeySha256:hashBytes(fs.readFileSync(publicKeyPath))});
  const verifier = createAutonomousResearchOnlineMutationReceiptVerifier({configurationPath});
  const verify = (name, options) => contract[name]({...options,trust:verifier.trust,verifySignature:verifier.verifySignedReceipt});
  const client = {trust:verifier.trust,
    reserveSchemaTransition: options => sign(raw.client.reserveSchemaTransition(options)),
    finalizeSchemaTransition: options => sign(raw.client.finalizeSchemaTransition(options)),
    observeSchemaTransition: options => sign(raw.client.observeSchemaTransition(options)),
    verifyStoredReservation: options => verify('verifyAutonomousResearchOnlineSchemaTransitionReservation',options),
    verifyHistoricalReservation: options => verify('verifyAutonomousResearchOnlineSchemaTransitionReservation',{...options,now:new Date(options.receipt.issuedAt)}),
    verifyHistoricalFinalization: options => verify('verifyAutonomousResearchOnlineSchemaTransitionFinalization',{...options,now:new Date(options.receipt.finalizedAt)}),
    verifyHistoricalObservation: options => verify('verifyAutonomousResearchOnlineSchemaTransitionObservation',{...options,now:new Date(options.receipt.observedAt)}),
  };
  const input = transitionInput({runtimeRoot},clock,{client});
  const planned = planAutonomousResearchOnlineSchemaTransition(input);
  const execution = executeAutonomousResearchOnlineSchemaTransition({...input,expectedTransitionId:planned.plan.transitionId});
  if (execution.status !== 'autonomous_research_online_schema_transition_ready') throw new Error('actual_schema_execution_failed');
  const inventory = resolveAutonomousResearchStateDatabaseInventory({runtimeRoot,manifest:stateDatabaseManifest});
  const auditPath = path.join(runtimeRoot,'autonomous-research/online-schema-transition/FINAL.json');
  const audit = JSON.parse(fs.readFileSync(auditPath,'utf8'));
  validateAutonomousResearchOnlineSchemaTransitionAuditReceipt({receipt:audit,inventory,writerManifest:input.writerManifest,authorityClient:client});
  const checkpointRoot = path.join(root,'checkpoint');
  fs.mkdirSync(checkpointRoot,{mode:0o700}); fs.mkdirSync(path.join(checkpointRoot,'databases'),{mode:0o700});
  fs.writeFileSync(path.join(checkpointRoot,'POST_INVENTORY.json'),JSON.stringify(inventory),{mode:0o600});
  inventory.instances.forEach((instance,index) => {
    const source = path.join(runtimeRoot,instance.sourceRelativePath);
    const target = path.join(checkpointRoot,'databases',`${String(index).padStart(3,'0')}.sqlite`);
    fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL); fs.chmodSync(target,0o600);
    if (instance.walFileIdentity !== null) {
      fs.copyFileSync(`${source}-wal`,`${target}-wal`,fs.constants.COPYFILE_EXCL); fs.chmodSync(`${target}-wal`,0o600);
    }
  });
  const after = resolveAutonomousResearchStateDatabaseInventory({runtimeRoot,manifest:stateDatabaseManifest});
  if (inventory.inventoryHash !== after.inventoryHash) throw new Error('source_changed_during_checkpoint_fixture');
  runtime = {input,client,inventory,auditPath,checkpointRoot,runtimeRoot};
  return {runtimeRoot,checkpointRoot,configurationPath,configurationFileHash:hashBytes(fs.readFileSync(configurationPath)),stateDatabaseManifest,writerManifest:input.writerManifest,originalInventory:inventory,audit,profile:productionOracleProfile()};
}
for await (const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})) {
  try {
    const input = JSON.parse(line); let value;
    if (input.operation === 'fixture') value = create(input.root);
    else if (input.operation === 'validate') {
      const inventory = input.current ? resolveAutonomousResearchStateDatabaseInventory({runtimeRoot:runtime.runtimeRoot,manifest:stateDatabaseManifest}) : JSON.parse(fs.readFileSync(path.join(runtime.checkpointRoot,'POST_INVENTORY.json'),'utf8'));
      value = validateAutonomousResearchOnlineSchemaTransitionAuditReceipt({receipt:JSON.parse(fs.readFileSync(runtime.auditPath,'utf8')),inventory,writerManifest:runtime.input.writerManifest,authorityClient:runtime.client});
    } else if (input.operation === 'bad-signature') {
      const value = JSON.parse(fs.readFileSync(runtime.auditPath,'utf8'));
      value.reservation.signature = 'invalid'; delete value.schemaTransitionReceiptHash;
      value.schemaTransitionReceiptHash = hashRecord('AutonomousResearchOnlineSchemaTransitionAuditReceipt',value);
      fs.writeFileSync(runtime.auditPath,JSON.stringify(value));
    } else throw new Error('unknown_operation');
    process.stdout.write(JSON.stringify({ok:true,value})+'\n');
  } catch (error) { process.stdout.write(JSON.stringify({ok:false,error:error.message})+'\n'); }
}
