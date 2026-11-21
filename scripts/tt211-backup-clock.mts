import assert from 'node:assert/strict';
import {backupAge, freshnessLabel} from '../src/lib/backup-freshness';
import {backupInventory} from '../src/lib/backup-inventory';
import {pruneClockUncertain, prunePlan} from '../src/lib/prune-plan';
import {makeHarness} from './harness.mts';
const {test,finish}=makeHarness('tt211-backup-clock');
const now=new Date(2025,0,3,12,0,0,0);
const old='fusion-backup-20250101-1200.json', recent='fusion-backup-20250102-1200.json', latest='fusion-backup-20250103-1159.json', future='fusion-backup-20300101-1200.json';
await test('future timestamps do not assert freshness, including one millisecond',{},()=>{
 for(const delta of [1,60000,365*86400000]) { assert.equal(backupAge(now.getTime()+delta,now.getTime()).state,'unknown');assert.match(freshnessLabel(now.getTime()+delta,now.getTime()),/clock|unknown/i); }
 assert.equal(backupAge(now.getTime(),now.getTime()).state,'fresh');
});
await test('invalid current time cannot vouch for freshness',{},()=>{
 assert.equal(backupAge(now.getTime(),NaN).state,'unknown');assert.match(freshnessLabel(now.getTime(),NaN),/clock|unknown/i);
});
await test('future dated copies cannot cause deletion of past copies',{},()=>{
 const names=[old,recent,latest,future];assert.deepEqual(prunePlan(names,2,now),[]);
 assert.equal(backupInventory(names,now).find(e=>e.name===future)?.freshness,'unknown');
});
await test('invalid clock cannot authorize pruning',{},()=>{
 const bad=new Date(NaN);assert.deepEqual(prunePlan([old,recent,latest],2,bad),[]);
});
await test('a backward clock correction invalidates a previously eligible plan',{},()=>{
 const names=[old,recent,latest];assert.deepEqual(prunePlan(names,2,now),[old]);
 const corrected=new Date(2024,0,1);assert.equal(pruneClockUncertain(names,corrected),true);assert.deepEqual(prunePlan(names,2,corrected),[]);
});
await test('normal and unknown filenames retain existing prune semantics',{},()=>{
 const names=[old,recent,latest,'unknown.json'];assert.deepEqual(prunePlan(names,2,now),[old]);
 assert.equal(backupAge(now.getTime()-7*86400000,now.getTime()).state,'stale');
});
finish();
