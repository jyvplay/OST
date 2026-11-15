import assert from 'node:assert/strict';
import {parseBackupDate, backupFilename} from '../src/lib/backup-name';
import {prunePlan} from '../src/lib/prune-plan';
import {makeHarness} from './harness.mts';
const {test,finish}=makeHarness('tt175-backup-dates');
const name=(y:number,m:number,d:number,h=12,min=0)=>`fusion-backup-${String(y).padStart(4,'0')}${String(m).padStart(2,'0')}${String(d).padStart(2,'0')}-${String(h).padStart(2,'0')}${String(min).padStart(2,'0')}.json`;
await test('calendar boundaries agree with Gregorian arithmetic at noon',{},()=>{
 for(const year of [1,4,99,100,400,1900,2000,2023,2024,2100,2400]) for(let month=1;month<=12;month++) for(let day=1;day<=31;day++){
  const leap=year%4===0&&(year%100!==0||year%400===0);const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1];
  const date=parseBackupDate(name(year,month,day));assert.equal(date!==null,day<=days,name(year,month,day));if(date)assert.equal(date.getFullYear(),year);
 }
});
await test('overflow, malformed input, and DST gap are never prunable',{},()=>{
 const invalid=[name(2023,2,29),name(2024,4,31),name(2024,0,1),name(2024,13,1),name(2024,1,0),name(2024,1,1,24),name(2024,1,1,12,60),'fusion-backup-20240101-1200.enc.json','fusion-backup-20240101-1200.jsonx'];
 if(process.env.TZ==='America/New_York') invalid.push(name(2024,3,10,2,30));
 for(const n of invalid)assert.equal(parseBackupDate(n),null,n);
 const valid=[name(2024,2,29),name(2025,1,1),name(2026,1,1)];assert.deepEqual(prunePlan([...invalid,...valid],2,new Date()),[valid[0]]);
});
await test('normal generated names preserve local calendar time',{},()=>{
 for(const d of [new Date(2024,1,29,13,45),new Date(2026,11,31,23,59)])assert.equal(parseBackupDate(backupFilename(d))?.getTime(),d.getTime());
});
finish();
