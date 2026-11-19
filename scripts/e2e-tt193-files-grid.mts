import assert from 'node:assert/strict';
import {expect} from 'playwright/test';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';

const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt193-files-grid');
const dir=`/Documents/tt193-grid-${Date.now()}-${process.pid}`;
try {
 await fx.api('POST','/api/fs',{op:'mkdir',path:dir});
 for(let i=0;i<41;i++)await fx.api('POST','/api/fs',{op:'write',path:`${dir}/item-${String(i).padStart(2,'0')}.txt`,content:`file ${i}`});
 await test('grid down and up follow measured columns in a wide Files window',{},async()=>{
  const current=await fx.api<{row:{revision:number}}>('GET','/api/state?id=default');
  await fx.api('PUT','/api/state',{id:'default',revision:Number(current.row.revision)+1000,state:{windows:[{id:'w1',module:'files',title:'files',x:20,y:16,w:2800,h:900,z:10,workspace:1,props:{path:dir}}],focus:'w1',workspaces:[{id:1,name:'Main'}],activeWorkspace:1,nextZ:30}});
  const ctx=await fx.context({viewport:{width:2900,height:1000}});
  try {
   const page=await ctx.newPage();await fx.ready(page,'files');const win=page.locator('[data-win-id="w1"]');
   await win.locator(`[data-cwd="${dir}"]`).first().waitFor();await win.getByRole('button',{name:'Grid',exact:true}).click();
   const rows=win.locator('[role="option"][data-path]');await expect(rows).toHaveCount(41);
   const layout=await rows.evaluateAll(elements=>{const boxes=elements.map(el=>el.getBoundingClientRect());const cols=boxes.findIndex(r=>Math.abs(r.top-boxes[0].top)>1);const container=elements[0].parentElement!;return {cols,oldEstimate:Math.round(container.clientWidth/(elements[0] as HTMLElement).offsetWidth),width:container.clientWidth};});
   assert.ok(layout.cols>1 && layout.cols<41,`must have multiple rows: ${JSON.stringify(layout)}`);
   console.log(`    grid geometry: ${JSON.stringify(layout)}`);
   await rows.nth(0).click();await page.keyboard.press('ArrowDown');
   await expect(rows.nth(layout.cols)).toBeFocused();await expect(rows.nth(layout.cols)).toHaveAttribute('aria-selected','true');
   await page.keyboard.press('ArrowUp');await expect(rows.nth(0)).toBeFocused();
   await page.keyboard.press('Control+ArrowDown');await expect(rows.nth(layout.cols)).toBeFocused();
   await expect(rows.nth(0)).toHaveAttribute('aria-selected','true');await expect(rows.nth(layout.cols)).toHaveAttribute('aria-selected','false');
   await page.keyboard.press('End');await expect(rows.nth(40)).toBeFocused();await page.keyboard.press('ArrowDown');await expect(rows.nth(40)).toBeFocused();
   await page.keyboard.press('Home');await page.keyboard.press('Shift+ArrowDown');await expect(rows.nth(layout.cols)).toBeFocused();
   await expect(rows.nth(0)).toHaveAttribute('aria-selected','true');await expect(rows.nth(layout.cols)).toHaveAttribute('aria-selected','true');
  }finally{await ctx.close();}
 });
 await test('narrow grid, one filtered item and list view retain keyboard selection',{},async()=>{
  const current=await fx.api<{row:{revision:number}}>('GET','/api/state?id=default');
  await fx.api('PUT','/api/state',{id:'default',revision:Number(current.row.revision)+1000,state:{windows:[{id:'w1',module:'files',title:'files',x:20,y:16,w:700,h:900,z:10,workspace:1,props:{path:dir}}],focus:'w1',workspaces:[{id:1,name:'Main'}],activeWorkspace:1,nextZ:30}});
  const ctx=await fx.context({viewport:{width:1000,height:1000}});
  try {
   const page=await ctx.newPage();await fx.ready(page,'files');const win=page.locator('[data-win-id="w1"]');
   await win.locator(`[data-cwd="${dir}"]`).first().waitFor();await win.getByRole('button',{name:'Grid',exact:true}).click();
   const rows=win.locator('[role="option"][data-path]');await expect(rows).toHaveCount(41);
   const cols=await rows.evaluateAll(elements=>{const top=elements[0].getBoundingClientRect().top;return elements.findIndex(el=>Math.abs(el.getBoundingClientRect().top-top)>1);});
   assert.ok(cols>1&&cols<10,`expected narrow grid, got ${cols}`);
   await rows.nth(0).click();await page.keyboard.press('ArrowDown');await expect(rows.nth(cols)).toBeFocused();
   await win.getByRole('textbox',{name:'Quick filter'}).fill('item-00');await expect(rows).toHaveCount(1);
   await rows.nth(0).click();await page.keyboard.press('ArrowDown');await expect(rows.nth(0)).toBeFocused();
   await win.getByRole('textbox',{name:'Quick filter'}).fill('');await win.getByRole('button',{name:'List',exact:true}).click();
   await expect(rows).toHaveCount(41);await rows.nth(0).click();await page.keyboard.press('ArrowDown');await expect(rows.nth(1)).toBeFocused();
  }finally{await ctx.close();}
 });
}finally{try{await fx.api('POST','/api/fs',{op:'purge',path:dir});}finally{await fx.close();finish();}}
