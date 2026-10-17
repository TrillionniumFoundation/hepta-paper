// Fixed source SQL and disposable SQLite databases only.
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {schemaTransitionTargetSchema,assertSchemaTransitionTargetObjects,applySchemaTransitionStatements,schemaTransitionExactSchemaHash,autonomousResearchOnlineSchemaTransitionBundleHash} from '../../paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs';
import {AUTONOMOUS_SUBMISSION_HANDOFF_SCHEMA_MIGRATIONS as migrations} from '../../paper-adapters/persistence/autonomous-submission-handoff-store.mjs';
import {productionOracleProfile} from './production-record-hash-v1.mjs';
const migrationRows=db=>db.prepare('SELECT version,name,migration_sha256,applied_at FROM handoff_schema_migrations ORDER BY version;').all().map(row=>({...row}));
const schema=db=>db.prepare("SELECT type,name,tbl_name,coalesce(sql,'') AS sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name,sql;").all().map(row=>({...row}));
function run(input){
  const target=schemaTransitionTargetSchema({role:input.role},{appliedAt:input.appliedAt??null});
  if(input.mode==='target')return{target:{...target,objects:[...target.objects]},bundleHash:autonomousResearchOnlineSchemaTransitionBundleHash()};
  if(input.mode==='migrations')return migrations;
  const database=new DatabaseSync(':memory:');
  try{
    for(const sql of input.setup||[])database.exec(sql);
    const before=schemaTransitionExactSchemaHash(database);
    try{
      if(input.precheck)assertSchemaTransitionTargetObjects(database,target);
      if(input.transaction!==false)database.exec('BEGIN IMMEDIATE;');
      applySchemaTransitionStatements(database,target);
      if(input.repeat)applySchemaTransitionStatements(database,target);
      if(database.isTransaction)database.exec('COMMIT;');
      const quick=database.prepare('PRAGMA quick_check;').all();
      const foreign=database.prepare('PRAGMA foreign_key_check;').all();
      return{ok:true,preSchemaHash:before,expectedPostSchemaHash:schemaTransitionExactSchemaHash(database),objects:schema(database),...(input.role==='submission-handoff'?{migrations:migrationRows(database)}:{}),quickCheck:quick.length===1?Object.values(quick[0])[0]:quick,foreignKeyViolationCount:foreign.length};
    }catch(error){
      if(database.isTransaction)database.exec('ROLLBACK;');
      return{ok:false,error:error.message,...(error.schemaObject?{schemaObject:error.schemaObject}:{}),unchanged:before===schemaTransitionExactSchemaHash(database),objects:schema(database),...(input.role==='submission-handoff'?{migrations:migrationRows(database)}:{})};
    }
  }finally{database.close();}
}
const input=JSON.parse(fs.readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify({profile:productionOracleProfile(),results:input.map(value=>{try{return run(value)}catch(error){return{error:error.message}}})}));
