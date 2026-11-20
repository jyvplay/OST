import {expect} from 'playwright/test';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt197-files-shortcut');
const dir=`/Documents/tt197-${Date.now()}-${process.pid}`;
const original=(await fx.api<{rows:{key:string,value:string}[]}>('GET','/api/settings')).rows.find(r=>r.key==='shell.shortcutPreset')?.value ?? 'hybrid';
try {
 await fx.api('POST','/api/fs',{op:'mkdir',path:dir});
 for(const name of ['alpha.txt','beta.txt','charlie.txt'])await fx.api('POST','/api/fs',{op:'write',path:`${dir}/${name}`,content:name});
 for(const preset of ['hybrid','windows','mac'] as const){
  await test(`${preset}: palette chord has one effect and non-colliding toggle still works`,{},async()=>{
   await fx.api('PUT','/api/settings',{key:'shell.shortcutPreset',value:preset});
   const state=await fx.api<{row:{revision:number}|null}>('GET','/api/state?id=default');
   await fx.api('PUT','/api/state',{id:'default',revision:Number(state.row?.revision ?? 0)+1000,state:{windows:[{id:'w1',module:'files',title:'files',x:20,y:16,w:1200,h:900,z:10,workspace:1,props:{path:dir}}],focus:'w1',workspaces:[{id:1,name:'Main'}],activeWorkspace:1,nextZ:30}});
   const ctx=await fx.context({viewport:{width:1400,height:1000}});
   try {
    const page=await ctx.newPage();await fx.ready(page,'files');const win=page.locator('[data-win-id="w1"]');await win.locator(`[data-cwd="${dir}"]`).first().waitFor();
    const row=(name:string)=>win.locator(`[role="option"][data-path="${dir}/${name}"]`);
    const palette=page.getByRole('dialog',{name:'Command palette'});
    for(const view of ['List','Grid']){
     await win.getByRole('button',{name:view,exact:true}).click();await row('alpha.txt').click();await page.keyboard.press('Control+ArrowRight');
     await expect(row('beta.txt')).toBeFocused();await expect(row('alpha.txt')).toHaveAttribute('aria-selected','true');await expect(row('beta.txt')).toHaveAttribute('aria-selected','false');
     await page.keyboard.press(preset==='mac'?'Meta+Space':'Control+Space');await expect(palette).toBeVisible();
     await expect(row('alpha.txt')).toHaveAttribute('aria-selected','true');await expect(row('beta.txt')).toHaveAttribute('aria-selected','false');
     await page.keyboard.press('Escape');await expect(palette).toHaveCount(0);await row('beta.txt').focus();
     await page.keyboard.press('Control+Shift+Space');
     await expect(palette).toHaveCount(0);await expect(row('alpha.txt')).toHaveAttribute('aria-selected','true');await expect(row('beta.txt')).toHaveAttribute('aria-selected','true');
     await page.keyboard.press(preset==='mac'?'Meta+Space':'Control+Space');await expect(palette).toBeVisible();
     await expect(row('beta.txt')).toHaveAttribute('aria-selected','true');await page.keyboard.press('Escape');await expect(palette).toHaveCount(0);
     if(preset==='mac') { await row('beta.txt').focus();await page.keyboard.press('Control+Space');await expect(row('beta.txt')).toHaveAttribute('aria-selected','false');await expect(palette).toHaveCount(0); }
    }
    await win.getByRole('textbox',{name:'Quick filter'}).focus();await page.keyboard.press(preset==='mac'?'Meta+Space':'Control+Space');await expect(palette).toBeVisible();
   }finally{await ctx.close();}
  });
 }
}finally{try{await fx.api('PUT','/api/settings',{key:'shell.shortcutPreset',value:original});await fx.api('POST','/api/fs',{op:'purge',path:dir});}finally{await fx.close();finish();}}
