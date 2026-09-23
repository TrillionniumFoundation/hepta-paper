// Offline conversion test fixtures only. Existing oracles invoke the actual
// Node authority; no production approval or authority key is synthesized here.
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createSchemaHistoryFixture } from '../schema_history/oracle.mjs';

const [repository, root, scenario] = process.argv.slice(2);
const choices={
  uninitialized:['schema_history','uninitialized'], genesis:['schema_history','genesis'],
  rebind2:['schema_history','rebind2'], multirole:['mutation_history','finalized'],
  'aborted-tail':['mutation_history','tail'], 'pending-mutation':['mutation_history','reserved'],
  'pending-schema':['schema_history','reserved-initial'],
  'pending-rebind':['schema_history','reserved-rebind'],
  'unactivated-rebind':['schema_history','finalized-rebind'],
};
if(scenario==='completed-backup') {
  const fixture=await createSchemaHistoryFixture({repository,root});
  try {
    const {hashBytes}=await import(pathToFileURL(path.join(repository,'workflow-kernel/record-hash.mjs')));
    const at='2026-09-21T01:00:00.000Z';fixture.setNow(at);
    const {authority,configuration}=fixture;
    const reservation=authority.handle({version:1,kind:'AutonomousResearchStateBackupAuthorityReserveRequest',
      inventoryHash:hashBytes(Buffer.from('actual isolated backup inventory')),
      databaseScopeHash:configuration.databaseScopeHash,
      databaseInstanceIds:authority.inspect().databaseHeads.map(h=>h.databaseInstanceId),
      requestedAt:at,maximumLeaseMs:30000});
    const finalization=authority.handle({version:1,kind:'AutonomousResearchStateBackupAuthorityFinalizeRequest',
      reservationId:reservation.reservationId,inventoryHash:reservation.inventoryHash,
      databaseScopeHash:reservation.databaseScopeHash,
      snapshotContentHash:hashBytes(Buffer.from('isolated test snapshot')),requestedAt:at});
    process.stdout.write(JSON.stringify({profile:fixture.profile,configuration,
      publicKeyPem:fixture.publicKeyPem,genesis:fixture.genesis,terminal:authority.inspect(),
      completedBackup:finalization})+'\n');
  } finally {fixture.close();}
} else {
  const choice=choices[scenario];
  if(!choice)throw Error('fixture_scenario_invalid');
  const oracle=fileURLToPath(new URL(`../${choice[0]}/oracle.mjs`,import.meta.url));
  const result=spawnSync(process.execPath,[oracle,repository,root,choice[1]],
    {encoding:'utf8',maxBuffer:8*1024*1024});
  if(result.status!==0)throw Error(result.stderr||'fixture_failed');
  process.stdout.write(result.stdout);
}
