import {writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {launchChromium} from './browser-launch.mts';
const browser=await launchChromium();const context=await browser.newContext();const page=await context.newPage();await page.goto('about:blank');
const rows=execFileSync('ps',['-eo','pid=,ppid=,pgid=,sid=,args='],{encoding:'utf8'}).trim().split('\n').map(s=>{const m=s.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);return m&&{pid:+m[1],ppid:+m[2],pgid:+m[3],sid:+m[4],args:m[5]};}).filter(Boolean);
const child=rows.find(r=>r?.ppid===process.pid&&r.args.includes('chromium'));if(!child)throw new Error('real Chromium child not observed');
writeFileSync(process.argv[2],JSON.stringify(child));await new Promise(()=>{});
