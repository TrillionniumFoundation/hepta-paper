// Isolated test fixture only; no private key bytes or real deployment is emitted.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { productionOracleProfile } from './production-record-hash-v1.mjs';
import { createLocalAutonomousResearchStateAuthority } from '../../paper-adapters/automation/local-autonomous-research-state-authority-runtime.mjs';
import * as schema from '../../paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs';
import { autonomousResearchOnlineMutationSignedPayload } from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
productionOracleProfile();
if(!input.configurationPath.startsWith('/tmp/hepta-native-authority-')) throw Error('isolated_fixture_required');
const original=JSON.parse(fs.readFileSync(input.configurationPath,'utf8'));
const configuration={...original,stateDatabasePath:path.join(path.dirname(input.configurationPath),'node-authority.sqlite')};
const nodePath=path.join(path.dirname(input.configurationPath),'node-configuration.json');
fs.writeFileSync(nodePath,JSON.stringify(configuration),{mode:0o600});
const authority=createLocalAutonomousResearchStateAuthority({configurationPath:nodePath,clock:{now:()=>new Date(input.now)}});
try {
 const publicKey=crypto.createPublicKey(fs.readFileSync(original.privateKeyPath));
 const verifySignature=receipt=>crypto.verify(null,Buffer.from(autonomousResearchOnlineMutationSignedPayload(receipt)),publicKey,Buffer.from(receipt.signature,'base64'));
 const shared={trust:authority.trust,now:new Date(input.now),verifySignature};
 const accepted=[
  schema.verifyAutonomousResearchOnlineSchemaTransitionReservation({...shared,request:input.reserve,receipt:input.reservation}),
  schema.verifyAutonomousResearchOnlineSchemaTransitionFinalization({...shared,request:input.finalize,reservation:input.reservation,receipt:input.finalization}),
  schema.verifyAutonomousResearchOnlineSchemaTransitionObservation({...shared,request:input.observe,receipt:input.observation}),
 ];
 const reservation=authority.handle(input.reserve);
 process.stdout.write(JSON.stringify({accepted,reservation})+'\n');
} finally { authority.close(); }
