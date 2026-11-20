import assert from 'node:assert/strict';
import {expect} from 'playwright/test';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt194-files-typeahead');
const dir=`/Documents/tt194-${Date.now()}-${process.pid}`;
try {
 await fx.api('POST','/api/fs',{op:'mkdir',path:dir});
 for(const name of ['alpha.txt','alpine.txt','beta.txt','bravo.txt','briar.txt','charlie.txt','delta.txt','echo.txt','foxtrot.txt'])await fx.api('POST','/api/fs',{op:'write',path:`${dir}/${name}`,content:name});
 const current=await fx.api<{row:{revision:number}}>('GET','/api/state?id=default');
 await fx.api('PUT','/api/state',{id:'default',revision:Number(current.row?.revision ?? 0)+1000,state:{windows:[{id:'w1',module:'files',title:'files',x:20,y:16,w:1400,h:900,z:10,workspace:1,props:{path:dir}}],focus:'w1',workspaces:[{id:1,name:'Main'}],activeWorkspace:1,nextZ:30}});
 const ctx=await fx.context({viewport:{width:1500,height:1000}});
 try {
  const page=await ctx.newPage();await fx.ready(page,'files');const win=page.locator('[data-win-id="w1"]');await win.locator(`[data-cwd="${dir}"]`).first().waitFor();
  const row=(name:string)=>win.locator(`[role="option"][data-path="${dir}/${name}"]`);
  await test('type-ahead finds prefixes, cycles and preserves multi-selection',{},async()=>{
   await row('alpha.txt').click();await row('alpine.txt').click({modifiers:['Control']});
   await page.keyboard.press('b');await expect(row('beta.txt')).toBeFocused();
   await expect(row('alpha.txt')).toHaveAttribute('aria-selected','true');await expect(row('alpine.txt')).toHaveAttribute('aria-selected','true');await expect(row('beta.txt')).toHaveAttribute('aria-selected','false');
   await page.keyboard.press('r');await expect(row('bravo.txt')).toBeFocused();
   await page.keyboard.press('Escape');await page.keyboard.press('b');await expect(row('briar.txt')).toBeFocused();
   await page.keyboard.press('b');await expect(row('beta.txt')).toBeFocused();
   await page.keyboard.press('Control+a');await expect(win.getByTestId('files-selcount')).toContainText('9 selected');
  });
  await test('grid and filtered results, no-match and shortcuts remain usable',{},async()=>{
   await win.getByRole('button',{name:'Grid',exact:true}).click();await row('alpha.txt').click();
   await page.keyboard.press('z');await expect(row('alpha.txt')).toBeFocused();
   const composingPrevented=await row('alpha.txt').evaluate(el=>!el.dispatchEvent(new KeyboardEvent('keydown',{key:'b',bubbles:true,cancelable:true,isComposing:true})));
   assert.equal(composingPrevented,false);await expect(row('alpha.txt')).toBeFocused();
   await page.keyboard.press('Alt+b');await expect(row('alpha.txt')).toBeFocused();
   await page.keyboard.press('Escape');await page.keyboard.press('b');await expect(row('beta.txt')).toBeFocused();
   await page.keyboard.press(' ');await expect(row('beta.txt')).toHaveAttribute('aria-selected','true');
   await page.keyboard.press('Control+f');const filter=win.getByRole('textbox',{name:'Quick filter'});await expect(filter).toBeFocused();await filter.fill('br');
   await expect(win.locator('[role="option"][data-path]')).toHaveCount(2);
   await row('bravo.txt').focus();await page.keyboard.press('b');await expect(row('briar.txt')).toBeFocused();
   assert.equal(await filter.inputValue(),'br');
  });
 } finally{await ctx.close();}
}finally{try{await fx.api('POST','/api/fs',{op:'purge',path:dir});}finally{await fx.close();finish();}}
