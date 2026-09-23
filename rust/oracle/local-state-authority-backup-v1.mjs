// Actual incumbent handlers and verifiers with an isolated, supplied test key.
// No fixture key is an installed authority or deployment qualification.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createLocalAutonomousResearchStateAuthorityBackupHandlers } from '../../paper-adapters/automation/local-autonomous-research-state-authority-backup.mjs';
import { autonomousResearchStateBackupAuthoritySignaturePayload as payload, verifyAutonomousResearchStateBackupAuthorityReservation as verifyReserve, verifyAutonomousResearchStateBackupAuthorityFinalization as verifyFinalize, verifyAutonomousResearchStateBackupAuthorityCurrentHead as verifyHead, verifyAutonomousResearchStateBackupAuthorityJournalRange as verifyJournal } from '../../paper-adapters/automation/autonomous-research-state-backup-authority.mjs';
import { productionOracleProfile } from './production-record-hash-v1.mjs';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const key = crypto.createPrivateKey(input.privateKeyPem);
const trust = { version:1, kind:'AutonomousResearchStateBackupAuthorityTrust', authorityId:input.configuration.authorityId, keyId:input.configuration.keyId, publicKey:crypto.createPublicKey(key), maximumReservationLeaseMs:input.configuration.maximumReservationLeaseMs, maximumHeadObservationAgeMs:input.configuration.maximumObservationAgeMs };
let result;
try {
  if (input.operation === 'verify') {
    const fn = {reserve:verifyReserve,finalize:verifyFinalize,head:verifyHead,journal:verifyJournal}[input.type];
    result = {ok:true,value:fn({receipt:input.receipt,request:input.request,reservation:input.reservation,trust,now:input.now})};
  } else {
    const db = new DatabaseSync(':memory:');
    try {
      const source=fs.readFileSync(new URL('../../paper-adapters/automation/local-autonomous-research-state-authority-runtime.mjs',import.meta.url),'utf8');
      const start=source.indexOf('  database.exec(`',source.indexOf('function initializeDatabase('));
      const end=source.indexOf('`);',start);
      if(start<0||end<0)throw new Error('original_schema_fixture_unavailable');
      db.exec(source.slice(start+'  database.exec(`'.length,end));
      for (const table of ['authority_metadata','authority_database_head','authority_mutation','authority_backup_reservation']) {
        for (const row of input.tables[table]) {
          const names=Object.keys(row);
          if(!names.every(name=>/^[a-z_]+$/.test(name)))throw new Error('fixture_columns_invalid');
          db.prepare(`INSERT INTO ${table}(${names.join(',')}) VALUES(${names.map(()=>'?').join(',')})`).run(...names.map(name=>row[name]));
        }
      }
      const handlers=createLocalAutonomousResearchStateAuthorityBackupHandlers({database:db,configuration:input.configuration,clock:{now:()=>new Date(input.now)},signBackup:receipt=>({...receipt,signature:crypto.sign(null,Buffer.from(payload(receipt)),key).toString('base64')})});
      result={ok:true,value:handlers[input.operation](input.request)};
    } finally { db.close(); }
  }
} catch(error) { result={ok:false,error:String(error?.message||error)}; }
process.stdout.write(`${JSON.stringify({profile:productionOracleProfile(),result})}\n`);
