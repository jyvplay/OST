import assert from 'node:assert/strict';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt177-beam-status');
try {
 await test('real availability is scoped to Remote Playback, not all receivers',{},async()=>{
  await fx.windows('beam');const ctx=await fx.context(),page=await ctx.newPage();try{
   await fx.ready(page,'beam');await page.locator('[data-shell-ready="true"]').waitFor();const root=page.locator('[data-win-id="w1"]');
   const badge=root.getByText('Remote Playback receivers:',{exact:false});await badge.waitFor();assert.match((await badge.innerText()).replace(/\s+/g,' ').trim(),/^Remote Playback receivers:\s*(unknown|none reported|at least one)$/);
   for(const label of ['Remote Playback (AirPlay / Cast picker)','Presentation API (cast a Fusion page)','Second screen / extended display','Document picture-in-picture (always on top)','Peer screen share (our own Miracast analog)','AirPlay audio (RAOP/ALAC) direct','Google Cast (castv2) direct','AirPlay screen mirroring (FairPlay)','DLNA / UPnP','Miracast','Act as an AirPlay / Cast receiver'])assert.equal(await root.getByText(label,{exact:true}).count(),1,label);
   assert.match(await root.innerText(),/unknown targets require\s+confirmation on first use/i);assert.equal(await root.getByLabel('Media to cast').count(),1);assert.equal(await root.getByTestId('beam-filter').count(),1);assert.equal(await root.getByTestId('beam-copy-sessions').count(),1);
  }finally{await ctx.close();}
 });
}finally{await fx.close();finish();}
