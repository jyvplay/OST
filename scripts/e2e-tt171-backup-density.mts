import assert from 'node:assert/strict';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt171-backup-density');
try{
 await test('Backup default text stays bounded without hiding safety or primary actions',{},async()=>{
  await fx.windows('backup');const ctx=await fx.context(),page=await ctx.newPage();
  try{await fx.ready(page,'backup');await page.locator('[data-shell-ready="true"]').waitFor();const root=page.locator('[data-win-id="w1"]');await root.getByRole('button',{name:'Build data bundle'}).waitFor();
   for(const name of ['Build data bundle','Build config bundle','Choose bundle…','Choose backup to drill…']) assert.equal(await root.getByRole('button',{name,exact:true}).isVisible(),true,name);
   const text=await root.innerText();for(const p of [/preview.*before applying/i,/rollback is not erasure/i,/not.*tasks.*contacts/is,/does not authenticate/i,/losing both/i]) assert.match(text,p);
   const words=await root.evaluate(el=>{let n,words=0;const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);while(n=w.nextNode()){const p=n.parentElement;if(!p)continue;const r=p.getBoundingClientRect(),s=getComputedStyle(p);if(!r.width||!r.height||s.visibility==='hidden'||s.display==='none'||p.closest('details:not([open])'))continue;const t=(n.textContent||'').trim();if(t)words+=t.split(/\s+/).filter(Boolean).length;}return words;});
   console.log(`    Backup ${words} words, bound 440`);assert.ok(words<=440,`Backup ${words} > 440`);
  }finally{await ctx.close();}
 });
 await test('real config snapshot remains buildable and safety boundaries remain visible afterwards',{},async()=>{
  await fx.windows('backup');const ctx=await fx.context(),page=await ctx.newPage();
  try{await fx.ready(page,'backup');await page.locator('[data-shell-ready="true"]').waitFor();const root=page.locator('[data-win-id="w1"]');await root.getByRole('button',{name:'Build config bundle'}).click();await root.getByTestId('backup-report').getByText(/snapshot checksum verified/i).waitFor({timeout:30000});assert.equal(await root.getByRole('button',{name:'Download encrypted'}).isDisabled(),true);const text=await root.innerText();for(const p of [/rollback is not erasure/i,/Plain backups are readable/i,/does not authenticate/i,/losing both/i,/not tasks, contacts/i,/preview.*before applying/i])assert.match(text,p);await root.getByRole('button',{name:'Show contents'}).click();await root.getByTestId('backup-contents').waitFor();}finally{await ctx.close();}
 });
}finally{await fx.close();finish();}
