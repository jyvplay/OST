import {expect} from 'playwright/test';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt198-files-typeahead-recovery');
const dir=`/Documents/tt198-${Date.now()}-${process.pid}`;
try {
 await fx.api('POST','/api/fs',{op:'mkdir',path:dir});
 for(const name of ['alpha.txt','beta.txt','bravo.txt','briar.txt','charlie.txt'])await fx.api('POST','/api/fs',{op:'write',path:`${dir}/${name}`,content:name});
 const current=await fx.api<{row:{revision:number}|null}>('GET','/api/state?id=default');
 await fx.api('PUT','/api/state',{id:'default',revision:Number(current.row?.revision ?? 0)+1000,state:{windows:[{id:'w1',module:'files',title:'files',x:20,y:16,w:1200,h:900,z:10,workspace:1,props:{path:dir}}],focus:'w1',workspaces:[{id:1,name:'Main'}],activeWorkspace:1,nextZ:30}});
 const ctx=await fx.context({viewport:{width:1400,height:1000}});
 try {
  const page=await ctx.newPage();await fx.ready(page,'files');const win=page.locator('[data-win-id="w1"]');await win.locator(`[data-cwd="${dir}"]`).first().waitFor();
  const row=(name:string)=>win.locator(`[role="option"][data-path="${dir}/${name}"]`);
  for(const view of ['List','Grid']) await test(`${view}: no-match does not poison the next prefix`,{},async()=>{
   await win.getByRole('button',{name:view,exact:true}).click();await row('alpha.txt').click();await row('charlie.txt').click({modifiers:['Control']});
   await page.keyboard.press('z');await expect(row('charlie.txt')).toBeFocused();await page.keyboard.press('b');await expect(row('beta.txt')).toBeFocused();
   await expect(row('alpha.txt')).toHaveAttribute('aria-selected','true');await expect(row('charlie.txt')).toHaveAttribute('aria-selected','true');
   await page.keyboard.press('r');await expect(row('bravo.txt')).toBeFocused();
   await page.keyboard.press('z');await expect(row('bravo.txt')).toBeFocused();await page.keyboard.press('b');await expect(row('briar.txt')).toBeFocused();
   await page.keyboard.press('b');await expect(row('beta.txt')).toBeFocused();
  });
  await test('an invalid longer prefix does not jump to its last character',{},async()=>{
   await row('alpha.txt').click();await page.keyboard.press('b');await expect(row('beta.txt')).toBeFocused();
   // Charlie exists, but bc does not: the failed c must not be retried as c.
   await page.keyboard.press('c');await expect(row('beta.txt')).toBeFocused();
   await page.keyboard.press('b');await expect(row('bravo.txt')).toBeFocused();
   await expect(row('alpha.txt')).toHaveAttribute('aria-selected','true');
  });
  await test('filtered results remain the match boundary after a miss',{},async()=>{
   const filter=win.getByRole('textbox',{name:'Quick filter'});await filter.fill('br');
   await expect(win.locator('[role="option"][data-path]')).toHaveCount(2);await row('bravo.txt').click();
   await page.keyboard.press('z');await page.keyboard.press('b');await expect(row('briar.txt')).toBeFocused();await expect(row('bravo.txt')).toHaveAttribute('aria-selected','true');
   await expect(filter).toHaveValue('br');
  });
 }finally{await ctx.close();}
}finally{try{await fx.api('POST','/api/fs',{op:'purge',path:dir});}finally{await fx.close();finish();}}
