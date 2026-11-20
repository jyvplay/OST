import {expect} from 'playwright/test';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt196-files-escape');
const dir=`/Documents/tt196-${Date.now()}-${process.pid}`;
try {
 await fx.api('POST','/api/fs',{op:'mkdir',path:dir});
 await fx.api('POST','/api/fs',{op:'mkdir',path:`${dir}/folder`});
 for(const name of ['alpha.txt','beta.txt','charlie.txt']) await fx.api('POST','/api/fs',{op:'write',path:`${dir}/${name}`,content:name});
 const state=await fx.api<{row:{revision:number}|null}>('GET','/api/state?id=default');
 await fx.api('PUT','/api/state',{id:'default',revision:Number(state.row?.revision ?? 0)+1000,state:{windows:[{id:'w1',module:'files',title:'files',x:20,y:16,w:1200,h:900,z:10,workspace:1,props:{path:dir}}],focus:'w1',workspaces:[{id:1,name:'Main'}],activeWorkspace:1,nextZ:30}});
 const ctx=await fx.context({viewport:{width:1400,height:1000}});
 try {
  const page=await ctx.newPage();await fx.ready(page,'files');const win=page.locator('[data-win-id="w1"]');await win.locator(`[data-cwd="${dir}"]`).first().waitFor();
  const row=(name:string)=>win.locator(`[role="option"][data-path="${dir}/${name}"]`);
  for (const view of ['List','Grid']) {
   await test(`${view}: Escape clears selection without losing focused row`,{},async()=>{
    await win.getByRole('button',{name:view,exact:true}).click();
    await row('alpha.txt').click();await row('beta.txt').click({modifiers:['Control']});
    await page.keyboard.press('Escape');await expect(row('beta.txt')).toBeFocused();
    await expect(row('alpha.txt')).toHaveAttribute('aria-selected','false');await expect(row('beta.txt')).toHaveAttribute('aria-selected','false');
    await expect(row('beta.txt')).toHaveAttribute('tabindex','0');
    await page.keyboard.press(' ');await expect(row('beta.txt')).toHaveAttribute('aria-selected','true');
    await page.keyboard.press('Escape');await page.keyboard.press('ArrowRight');await expect(row('charlie.txt')).toBeFocused();
   });
  }
  await test('focus-only movement before Escape does not revert to selected item',{},async()=>{
   await win.getByRole('button',{name:'List',exact:true}).click();await row('alpha.txt').click();
   await page.keyboard.press('Control+ArrowDown');await expect(row('beta.txt')).toBeFocused();
   await expect(row('alpha.txt')).toHaveAttribute('aria-selected','true');await expect(row('beta.txt')).toHaveAttribute('aria-selected','false');
   await page.keyboard.press('Escape');await expect(row('beta.txt')).toHaveAttribute('tabindex','0');
   await page.keyboard.press(' ');await expect(row('beta.txt')).toHaveAttribute('aria-selected','true');
   await expect(row('alpha.txt')).toHaveAttribute('aria-selected','false');
  });
  await test('Escape on the listing background does not invent a focused option',{},async()=>{
   await row('beta.txt').click();const background=win.getByTestId('files-listing');await background.focus();
   await page.keyboard.press('Escape');await expect(row('beta.txt')).toHaveAttribute('aria-selected','false');
   await page.keyboard.press(' ');await expect(row('beta.txt')).toHaveAttribute('aria-selected','false');await expect(background).toBeFocused();
  });
  await test('Enter opens the focused folder immediately after clearing selection',{},async()=>{
   await win.getByRole('button',{name:'List',exact:true}).click();await row('folder').click();await page.keyboard.press('Escape');await page.keyboard.press('Enter');
   await expect(win.locator(`[data-cwd="${dir}/folder"]`).first()).toBeVisible();
  });
 }finally{await ctx.close();}
}finally{try{await fx.api('POST','/api/fs',{op:'purge',path:dir});}finally{await fx.close();finish();}}
