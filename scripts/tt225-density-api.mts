import assert from 'node:assert/strict';
import { densityApi } from './density-api.mts';
import { makeHarness } from './harness.mts';
if (process.env.TT89_DISPOSABLE_DATABASE !== '1' || !process.env.DATABASE_URL || !process.env.BASE) throw new Error('exclusive disposable database and BASE required');
const base=process.env.BASE, id=`session:tt225-${process.pid}-${Date.now()}`, {test,finish}=makeHarness('tt225-density-api');
try {
 await test('real rejected stale PUT is surfaced, newer row survives',{},async()=>{
  await densityApi(base,'PUT','/api/state',{id,revision:10,state:{marker:'new'}});
  await assert.rejects(densityApi(base,'PUT','/api/state',{id,revision:9,state:{marker:'old'}}),/failed \(409\)/);
  const row=(await densityApi<{row:{revision:number;state:{marker:string}}}>(base,'GET','/api/state?id='+encodeURIComponent(id))).row;
  assert.equal(row.revision,10);assert.equal(row.state.marker,'new');
 });
 await test('bad revision 400 fails without changing the actual row',{},async()=>{
  await assert.rejects(densityApi(base,'PUT','/api/state',{id,revision:2147483648,state:{marker:'bad'}}),/failed \(400\)/);
  const row=(await densityApi<{row:{revision:number;state:{marker:string}}}>(base,'GET','/api/state?id='+encodeURIComponent(id))).row;
  assert.equal(row.revision,10);assert.equal(row.state.marker,'new');
 });
} finally {await densityApi(base,'DELETE','/api/state?id='+encodeURIComponent(id));finish();}
